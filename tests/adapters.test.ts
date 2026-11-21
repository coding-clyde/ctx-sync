import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ADAPTERS,
  getAdapter,
  isTargetProfile,
  listProfiles,
  renderProfile,
} from "../src/adapters/index.js";
import { demoteHeadings } from "../src/adapters/shared.js";
import { loadConfig } from "../src/config.js";
import { createFixture, ruleBlock } from "./helpers.js";

test("registry discovers the built-in adapters from their own files", () => {
  assert.deepEqual(listProfiles(), ["claude", "cursor", "copilot", "windsurf"]);
  assert.equal(getAdapter("claude").defaultOutput, "CLAUDE.md");
  assert.equal(getAdapter("cursor").defaultOutput, ".cursor/rules");
  assert.equal(getAdapter("copilot").defaultOutput, ".github/copilot-instructions.md");
  assert.equal(getAdapter("windsurf").defaultOutput, ".windsurfrules");
  assert.equal(isTargetProfile("claude"), true);
  assert.equal(isTargetProfile("toString"), false);
  assert.equal(isTargetProfile("nope"), false);
  assert.throws(() => getAdapter("nope"), /Unknown profile "nope"/);
  assert.equal(Object.isFrozen(ADAPTERS), true);
});

test("a new assistant is added by creating a single adapter file", async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const temp = await mkdtemp(path.join(os.tmpdir(), "ctx-sync-registry-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await cp(path.join(here, "..", "src"), path.join(temp, "src"), { recursive: true });
  await writeFile(path.join(temp, "package.json"), '{"type":"module"}\n');
  await writeFile(
    path.join(temp, "src", "adapters", "zedAdapter.js"),
    [
      'import { createSingleFileAdapter } from "./shared.js";',
      "export default createSingleFileAdapter({",
      '  id: "zed", label: "Zed", defaultOutput: ".rules", title: "Zed rules",',
      "});",
      "",
    ].join("\n"),
  );

  const registry = (await import(
    pathToFileURL(path.join(temp, "src", "adapters", "index.js")).href
  )) as typeof import("../src/adapters/index.js");
  assert.deepEqual(registry.listProfiles(), [
    "claude",
    "cursor",
    "copilot",
    "windsurf",
    "zed",
  ]);
  assert.equal(registry.isTargetProfile("zed"), true);
  assert.equal(registry.getAdapter("zed").label, "Zed");
});

test("an invalid adapter module fails fast with a clear error", async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const temp = await mkdtemp(path.join(os.tmpdir(), "ctx-sync-registry-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await cp(path.join(here, "..", "src"), path.join(temp, "src"), { recursive: true });
  await writeFile(path.join(temp, "package.json"), '{"type":"module"}\n');
  await writeFile(
    path.join(temp, "src", "adapters", "brokenAdapter.js"),
    "export const adapter = {};\n",
  );
  await assert.rejects(
    import(pathToFileURL(path.join(temp, "src", "adapters", "index.js")).href),
    /brokenAdapter\.js.*default-export|default/,
  );
});

test("single-file adapters render only their target and carry a marker", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });

  const blocks = [
    ruleBlock({ id: "typescript", priority: 10 }),
    ruleBlock({
      id: "copilot-only",
      title: "Copilot only",
      targets: ["copilot"],
      body: "Copilot-specific guidance.",
    }),
    ruleBlock({
      id: "disabled",
      enabled: false,
      title: "Disabled",
      body: "Never rendered.",
    }),
  ];

  const claude = renderProfile("claude", blocks, config);
  assert.equal(claude.length, 1);
  assert.equal(claude[0]?.path, "CLAUDE.md");
  assert.match(claude[0]?.content ?? "", /<!-- ctx-sync:generated profile="claude"/);
  assert.match(claude[0]?.content ?? "", /AUTO-GENERATED from \.ai\/ by ctx-sync/);
  assert.match(claude[0]?.content ?? "", /^# Repository context$/m);
  assert.match(claude[0]?.content ?? "", /^## TypeScript conventions$/m);
  assert.doesNotMatch(claude[0]?.content ?? "", /Copilot only/);
  assert.doesNotMatch(claude[0]?.content ?? "", /Never rendered/);
  assert.equal(claude[0]?.content.endsWith("\n"), true);

  const copilot = renderProfile("copilot", blocks, config);
  assert.equal(copilot[0]?.path, ".github/copilot-instructions.md");
  assert.match(copilot[0]?.content ?? "", /^# Copilot instructions$/m);
  assert.match(copilot[0]?.content ?? "", /## Copilot only/);
  assert.match(copilot[0]?.content ?? "", /profile="copilot"/);
  assert.doesNotMatch(copilot[0]?.content ?? "", /## Index/);

  const windsurf = renderProfile("windsurf", blocks, config);
  assert.equal(windsurf[0]?.path, ".windsurfrules");
  assert.match(windsurf[0]?.content ?? "", /^# Windsurf rules$/m);
  assert.doesNotMatch(windsurf[0]?.content ?? "", /Copilot only/);
});

test("Claude output has a linked index, source comments and nested headings", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });

  const blocks = [
    ruleBlock({
      id: "overview",
      title: "Project overview",
      description: "Derived text that must not reach the index.",
      frontmatter: { description: "What the project is." },
      priority: 10,
      body: "Intro.\n\n## Design constraints\n\n- Node 20.\n\n```md\n## Not a heading\n```",
    }),
    ruleBlock({ id: "a", title: "Same title", description: "Same title", body: "A." }),
    ruleBlock({ id: "b", title: "Same title", description: "", body: "B." }),
  ];
  const [file] = renderProfile("claude", blocks, config);
  const content = file?.content ?? "";

  assert.match(content, /^## Index$/m);
  assert.match(content, /^- \[Project overview\]\(#project-overview\): What the project is\.$/m);
  assert.doesNotMatch(content, /Derived text/);
  assert.match(content, /^- \[Same title\]\(#same-title\)$/m);
  assert.match(content, /^- \[Same title\]\(#same-title-1\)$/m);
  assert.match(content, /^<!-- source: \.ai\/rules\/overview\.md -->$/m);
  assert.match(content, /^### Design constraints$/m);
  assert.match(content, /^## Not a heading$/m);
  assert.ok(content.indexOf("## Index") < content.indexOf("## Project overview"));
  assert.doesNotMatch(
    renderProfile("claude", [], config)[0]?.content ?? "",
    /## Index/,
  );
});

test("demoteHeadings keeps relative structure and skips code fences", () => {
  assert.equal(
    demoteHeadings("# A\n\n## B\n\n~~~\n# code\n~~~", 3),
    "### A\n\n#### B\n\n~~~\n# code\n~~~",
  );
  assert.equal(demoteHeadings("#### Deep", 3), "#### Deep");
  assert.equal(demoteHeadings("# A\n\n##### B", 3), "### A\n\n###### B");
  assert.equal(demoteHeadings("no headings\n#hashtag", 3), "no headings\n#hashtag");
});

test("Cursor merges always-apply rules into project.mdc and scopes the rest", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });

  const blocks = [
    ruleBlock({
      id: "typescript",
      title: "TypeScript rules",
      description: 'Use "strict" mode.',
      globs: ["**/*.ts", "**/*.tsx"],
      alwaysApply: false,
      targets: ["cursor"],
      body: "- Keep strict mode.",
    }),
    ruleBlock({
      id: "overview",
      title: "Overview",
      priority: 50,
      globs: [],
      alwaysApply: true,
      targets: ["cursor"],
      body: "Always loaded.",
    }),
    ruleBlock({
      id: "security",
      title: "Security",
      globs: [],
      alwaysApply: true,
      targets: ["cursor"],
      body: "No secrets.",
    }),
    ruleBlock({ id: "other", targets: ["claude"], body: "Not Cursor." }),
  ];

  const files = renderProfile("cursor", blocks, config);
  assert.deepEqual(
    files.map((file) => file.path),
    [".cursor/rules/project.mdc", ".cursor/rules/typescript.mdc"],
  );
  assert.deepEqual(files.map((file) => file.blockIds), [
    ["overview", "security"],
    ["typescript"],
  ]);

  const project = files[0];
  assert.ok(project);
  assert.match(project.content, /^---\ndescription: "[^"]+"\nalwaysApply: true\n---\n<!-- ctx-sync:generated profile="cursor"/);
  assert.doesNotMatch(project.content, /globs:/);
  assert.match(project.content, /^# Project rules$/m);
  assert.match(project.content, /^## Overview$/m);
  assert.match(project.content, /^## Security$/m);

  const typescript = files[1];
  assert.ok(typescript);
  assert.match(typescript.content, /^---\ndescription: "Use \\"strict\\" mode\."/);
  assert.match(typescript.content, /globs:\n  - "\*\*\/\*\.ts"\n  - "\*\*\/\*\.tsx"/);
  assert.match(typescript.content, /alwaysApply: false/);
  assert.match(typescript.content, /^# TypeScript rules$/m);
  assert.ok(typescript.content.includes('<!-- ctx-sync:generated profile="cursor"'));
});

test("Cursor never lets a rule named 'project' collide with project.mdc", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });
  const files = renderProfile(
    "cursor",
    [
      ruleBlock({ id: "base", targets: ["cursor"], alwaysApply: true }),
      ruleBlock({
        id: "project",
        targets: ["cursor"],
        alwaysApply: false,
        globs: ["src/**"],
      }),
    ],
    config,
  );
  assert.deepEqual(
    files.map((file) => file.path),
    [".cursor/rules/project-rule.mdc", ".cursor/rules/project.mdc"],
  );
  assert.deepEqual(files.map((file) => file.blockIds), [["project"], ["base"]]);
});

test("respects configured output paths and profile selection", async (t) => {
  const fixture = await createFixture({
    "ctx-sync.config.json": {
      profiles: {
        claude: { output: "docs/AGENTS.md" },
        cursor: { output: "docs/cursor-rules" },
      },
    },
  });
  t.after(() => fixture.cleanup());

  const config = await loadConfig({ rootDir: fixture.root });
  const claude = renderProfile("claude", [ruleBlock()], config);
  assert.equal(claude[0]?.path, "docs/AGENTS.md");

  const cursor = renderProfile("cursor", [ruleBlock()], config);
  assert.equal(cursor[0]?.path, "docs/cursor-rules/project.mdc");

  const onlyClaude = await loadConfig({
    rootDir: fixture.root,
    profiles: ["claude"],
  });
  assert.deepEqual(
    onlyClaude.profiles.filter((profile) => profile.enabled).map((profile) => profile.profile),
    ["claude"],
  );
});

test("rendering is deterministic", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });
  const blocks = [
    ruleBlock({ id: "b", priority: 1, globs: ["**/*.ts"], alwaysApply: false }),
    ruleBlock({ id: "a", priority: 1 }),
  ];

  for (const profile of listProfiles()) {
    const first = renderProfile(profile, blocks, config);
    const second = renderProfile(profile, [...blocks].reverse(), config);
    assert.deepEqual(first, second, profile);
  }
});

test("empty profiles still produce a valid header-only file", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });
  const files = renderProfile("claude", [], config);
  assert.equal(files.length, 1);
  assert.match(files[0]?.content ?? "", /ctx-sync:generated/);
  assert.match(files[0]?.content ?? "", /# Repository context/);
  assert.deepEqual(renderProfile("cursor", [], config), []);
});
