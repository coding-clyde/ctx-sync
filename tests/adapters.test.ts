import assert from "node:assert/strict";
import test from "node:test";

import { renderProfile } from "../src/adapters/index.js";
import { loadConfig } from "../src/config.js";
import { TARGET_PROFILE_DEFAULT_OUTPUTS } from "../src/types.js";
import { createFixture, ruleBlock } from "./helpers.js";

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
  assert.equal(claude[0]?.path, TARGET_PROFILE_DEFAULT_OUTPUTS.claude);
  assert.match(claude[0]?.content ?? "", /<!-- ctx-sync:generated profile="claude"/);
  assert.match(claude[0]?.content ?? "", /^# Repository context$/m);
  assert.match(claude[0]?.content ?? "", /## TypeScript conventions/);
  assert.doesNotMatch(claude[0]?.content ?? "", /Copilot only/);
  assert.doesNotMatch(claude[0]?.content ?? "", /Never rendered/);
  assert.equal(claude[0]?.content.endsWith("\n"), true);

  const copilot = renderProfile("copilot", blocks, config);
  assert.equal(copilot[0]?.path, TARGET_PROFILE_DEFAULT_OUTPUTS.copilot);
  assert.match(copilot[0]?.content ?? "", /## Copilot only/);
  assert.match(copilot[0]?.content ?? "", /profile="copilot"/);

  const windsurf = renderProfile("windsurf", blocks, config);
  assert.equal(windsurf[0]?.path, TARGET_PROFILE_DEFAULT_OUTPUTS.windsurf);
});

test("renders Cursor .mdc files with native frontmatter", async (t) => {
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
    ruleBlock({ id: "other", targets: ["claude"], body: "Not Cursor." }),
  ];

  const files = renderProfile("cursor", blocks, config);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((file) => file.path),
    [".cursor/rules/overview.mdc", ".cursor/rules/typescript.mdc"],
  );
  assert.deepEqual(files.map((file) => file.blockIds), [["overview"], ["typescript"]]);

  const typescript = files.find((file) => file.path.endsWith("typescript.mdc"));
  assert.ok(typescript);
  assert.match(typescript.content, /^---\ndescription: "Use \\"strict\\" mode\."/);
  assert.match(typescript.content, /globs:\n  - "\*\*\/\*\.ts"\n  - "\*\*\/\*\.tsx"/);
  assert.match(typescript.content, /alwaysApply: false/);
  assert.match(typescript.content, /# TypeScript rules/);
  assert.ok(typescript.content.includes("<!-- ctx-sync:generated profile=\"cursor\""));

  const overview = files.find((file) => file.path.endsWith("overview.mdc"));
  assert.ok(overview);
  assert.match(overview.content, /alwaysApply: true/);
  assert.doesNotMatch(overview.content, /globs:/);
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
  assert.equal(cursor[0]?.path, "docs/cursor-rules/typescript.mdc");

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

  const first = renderProfile("claude", blocks, config);
  const second = renderProfile("claude", [...blocks].reverse(), config);
  assert.deepEqual(first, second);
});

test("empty profiles still produce a valid header-only file", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const config = await loadConfig({ rootDir: fixture.root });
  const files = renderProfile("claude", [], config);
  assert.equal(files.length, 1);
  assert.match(files[0]?.content ?? "", /ctx-sync:generated/);
  assert.match(files[0]?.content ?? "", /# Repository context/);
});
