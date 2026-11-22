import assert from "node:assert/strict";
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
import { readSourceTree } from "../src/readers/source.js";
import { syncProject } from "../src/sync.js";
import { VERSION } from "../src/version.js";
import { createFixture, ruleBlock, ruleFile } from "./helpers.js";

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
  const temp = await mkdtemp(path.join(os.tmpdir(), "ctx-syncr-registry-"));
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
  const temp = await mkdtemp(path.join(os.tmpdir(), "ctx-syncr-registry-"));
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
  assert.match(claude[0]?.content ?? "", /<!-- ctx-syncr:generated profile="claude"/);
  assert.match(claude[0]?.content ?? "", /AUTO-GENERATED from \.ai\/ by ctx-syncr/);
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
  assert.match(project.content, /^---\ndescription: "[^"]+"\nalwaysApply: true\n---\n<!-- ctx-syncr:generated profile="cursor"/);
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
  assert.ok(typescript.content.includes('<!-- ctx-syncr:generated profile="cursor"'));
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
    "ctx-syncr.config.json": {
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
  assert.match(files[0]?.content ?? "", /ctx-syncr:generated/);
  assert.match(files[0]?.content ?? "", /# Repository context/);
  assert.deepEqual(renderProfile("cursor", [], config), []);
});

/* -------------------------------------------------------------------------- */
/* End to end: .ai/ on disk -> native files                                   */
/* -------------------------------------------------------------------------- */

const MARKER_NOTICE =
  "<!-- AUTO-GENERATED from .ai/ by ctx-syncr. Do not edit this file: edit the sources and run `ctx-syncr sync`. -->";

function marker(profile: string): string {
  return `<!-- ctx-syncr:generated profile="${profile}" version="${VERSION}" -->`;
}

/** Every file the four adapters are expected to write for {@link aiTree}. */
const OUTPUT_PATHS = [
  "CLAUDE.md",
  ".cursor/rules/project.mdc",
  ".cursor/rules/ts.mdc",
  ".github/copilot-instructions.md",
  ".windsurfrules",
] as const;

/** A source tree exercising targets, priority, globs and `enabled: false`. */
function aiTree(): Record<string, string> {
  return {
    ".ai/00-overview.md": ruleFile(
      "id: overview\ntitle: Overview\ndescription: What the project is.\npriority: 10",
      "# Overview\n\nAlways-on guidance.",
    ),
    ".ai/rules/ts.md": ruleFile(
      'id: ts\ntitle: TypeScript\nglobs: ["**/*.ts"]\ntargets: [claude, cursor]',
      "# TypeScript\n\n- Keep strict mode.",
    ),
    ".ai/rules/copilot-only.md": ruleFile(
      "id: copilot-only\ntitle: Copilot only\ntargets: copilot",
      "# Copilot only\n\nOnly Copilot reads this.",
    ),
    ".ai/rules/draft.md": ruleFile(
      "id: draft\ntitle: Draft\nenabled: false",
      "# Draft\n\nNever reaches any output.",
    ),
  };
}

async function readOutputs(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const relativePath of OUTPUT_PATHS) {
    outputs[relativePath] = await fixture.read(relativePath);
  }
  return outputs;
}

test("reads .ai/ recursively into validated blocks, keeping disabled rules out of outputs", async (t) => {
  const fixture = await createFixture({
    ...aiTree(),
    // Not Markdown: must be ignored by the reader.
    ".ai/notes.txt": "scratch notes",
  });
  t.after(() => fixture.cleanup());

  const config = await loadConfig({ rootDir: fixture.root });
  const source = await readSourceTree({
    rootDir: config.rootDir,
    sourceDir: config.sourceDir,
  });

  assert.deepEqual(
    source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    [],
  );
  assert.equal(source.filesRead, 4);
  assert.deepEqual(
    source.blocks.map((block) => block.id).sort(),
    ["copilot-only", "draft", "overview", "ts"],
  );

  const overview = source.blocks.find((block) => block.id === "overview");
  assert.ok(overview);
  assert.equal(overview.title, "Overview");
  assert.equal(overview.description, "What the project is.");
  assert.equal(overview.priority, 10);
  assert.equal(overview.sourcePath, ".ai/00-overview.md");
  assert.equal(overview.body.trim(), "Always-on guidance.");
  assert.deepEqual(overview.targets, listProfiles());

  const ts = source.blocks.find((block) => block.id === "ts");
  assert.deepEqual(ts?.targets, ["claude", "cursor"]);
  assert.deepEqual(ts?.globs, ["**/*.ts"]);
  assert.equal(ts?.sourcePath, ".ai/rules/ts.md");
  assert.equal(source.blocks.find((block) => block.id === "draft")?.enabled, false);

  const summary = await syncProject({ rootDir: fixture.root });
  assert.equal(summary.valid, true);
  for (const output of Object.values(await readOutputs(fixture))) {
    assert.ok(!output.includes("Never reaches any output."));
    assert.ok(!output.includes("scratch notes"));
  }
});

test("each adapter writes exactly the expected native format from .ai/", async (t) => {
  const fixture = await createFixture(aiTree());
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });

  assert.equal(
    await fixture.read("CLAUDE.md"),
    [
      marker("claude"),
      MARKER_NOTICE,
      "",
      "# Repository context",
      "",
      "## Index",
      "",
      "- [Overview](#overview): What the project is.",
      "- [TypeScript](#typescript)",
      "",
      "## Overview",
      "<!-- source: .ai/00-overview.md -->",
      "",
      "Always-on guidance.",
      "",
      "## TypeScript",
      "<!-- source: .ai/rules/ts.md -->",
      "",
      "- Keep strict mode.",
      "",
    ].join("\n"),
  );

  assert.equal(
    await fixture.read(".cursor/rules/project.mdc"),
    [
      "---",
      'description: "Project-wide rules that always apply."',
      "alwaysApply: true",
      "---",
      marker("cursor"),
      MARKER_NOTICE,
      "",
      "# Project rules",
      "",
      "## Overview",
      "",
      "Always-on guidance.",
      "",
    ].join("\n"),
  );

  assert.equal(
    await fixture.read(".cursor/rules/ts.mdc"),
    [
      "---",
      'description: "Keep strict mode."',
      "globs:",
      '  - "**/*.ts"',
      "alwaysApply: false",
      "---",
      marker("cursor"),
      MARKER_NOTICE,
      "",
      "# TypeScript",
      "",
      "- Keep strict mode.",
      "",
    ].join("\n"),
  );

  assert.equal(
    await fixture.read(".github/copilot-instructions.md"),
    [
      marker("copilot"),
      MARKER_NOTICE,
      "",
      "# Copilot instructions",
      "",
      "## Overview",
      "",
      "Always-on guidance.",
      "",
      "## Copilot only",
      "",
      "Only Copilot reads this.",
      "",
    ].join("\n"),
  );

  assert.equal(
    await fixture.read(".windsurfrules"),
    [
      marker("windsurf"),
      MARKER_NOTICE,
      "",
      "# Windsurf rules",
      "",
      "## Overview",
      "",
      "Always-on guidance.",
      "",
    ].join("\n"),
  );
});

test("output is deterministic across directories, file creation order and line endings", async (t) => {
  const tree = aiTree();
  const reversed = Object.fromEntries(Object.entries(tree).reverse());
  const crlf = Object.fromEntries(
    Object.entries(tree).map(([file, content]) => [
      file,
      content.replace(/\n/g, "\r\n"),
    ]),
  );

  const baseline = await createFixture(tree);
  const reordered = await createFixture(reversed);
  const windows = await createFixture(crlf);
  t.after(() => Promise.all([baseline, reordered, windows].map((f) => f.cleanup())));

  await syncProject({ rootDir: baseline.root });
  await syncProject({ rootDir: reordered.root });
  await syncProject({ rootDir: windows.root });

  const expected = await readOutputs(baseline);
  assert.deepEqual(await readOutputs(reordered), expected);
  assert.deepEqual(await readOutputs(windows), expected);

  for (const [file, content] of Object.entries(expected)) {
    assert.ok(!content.includes(baseline.root), `${file} leaks the repository path`);
    assert.ok(!content.includes("\r"), `${file} contains CRLF`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(content), `${file} contains a timestamp`);
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"), file);
  }
});

test("rendering from disk is idempotent: a second sync changes nothing", async (t) => {
  const fixture = await createFixture(aiTree());
  t.after(() => fixture.cleanup());

  const first = await syncProject({ rootDir: fixture.root });
  assert.equal(first.valid, true);
  assert.deepEqual(
    first.changes.map((change) => [change.path, change.status]),
    OUTPUT_PATHS.map((file) => [file, "created"]).sort(([a], [b]) =>
      String(a).localeCompare(String(b), "en"),
    ),
  );

  const firstOutputs = await readOutputs(fixture);
  const firstMtimes = await Promise.all(
    OUTPUT_PATHS.map(async (file) => (await stat(fixture.absolute(file))).mtimeMs),
  );

  const second = await syncProject({ rootDir: fixture.root });
  assert.equal(second.drift, false);
  assert.ok(second.changes.every((change) => change.status === "unchanged"));
  assert.deepEqual(await readOutputs(fixture), firstOutputs);
  // Unchanged files are not even rewritten.
  assert.deepEqual(
    await Promise.all(
      OUTPUT_PATHS.map(async (file) => (await stat(fixture.absolute(file))).mtimeMs),
    ),
    firstMtimes,
  );

  const check = await syncProject({ rootDir: fixture.root, check: true });
  assert.equal(check.ok, true);
  assert.equal(check.drift, false);
});

test("editing one rule only rewrites the adapters that render it", async (t) => {
  const fixture = await createFixture(aiTree());
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });
  const before = await readOutputs(fixture);

  await fixture.write(
    ".ai/rules/ts.md",
    ruleFile(
      'id: ts\ntitle: TypeScript\nglobs: ["**/*.ts"]\ntargets: [claude, cursor]',
      "# TypeScript\n\n- Keep strict mode.\n- Prefer `unknown` over `any`.",
    ),
  );
  const summary = await syncProject({ rootDir: fixture.root });
  assert.deepEqual(
    summary.changes
      .filter((change) => change.status === "updated")
      .map((change) => change.path),
    [".cursor/rules/ts.mdc", "CLAUDE.md"],
  );

  const after = await readOutputs(fixture);
  assert.notEqual(after["CLAUDE.md"], before["CLAUDE.md"]);
  assert.notEqual(after[".cursor/rules/ts.mdc"], before[".cursor/rules/ts.mdc"]);
  assert.match(after["CLAUDE.md"] ?? "", /Prefer `unknown` over `any`\./);
  for (const untouched of [
    ".cursor/rules/project.mdc",
    ".github/copilot-instructions.md",
    ".windsurfrules",
  ] as const) {
    assert.equal(after[untouched], before[untouched], untouched);
  }
});

test("every adapter stamps its own profile marker on every file it writes", async (t) => {
  const fixture = await createFixture(aiTree());
  t.after(() => fixture.cleanup());
  const summary = await syncProject({ rootDir: fixture.root });

  for (const change of summary.changes) {
    const content = await fixture.read(change.path);
    assert.ok(
      content.includes(marker(change.profile)),
      `${change.path} should carry the ${change.profile} marker`,
    );
    assert.equal(content.split("ctx-syncr:generated").length - 1, 1, change.path);
  }
});
