import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { SourceError } from "../src/errors.js";
import { readSourceTree } from "../src/readers/source.js";
import { parseRuleFile } from "../src/readers/markdown.js";
import { listProfiles } from "../src/adapters/index.js";
import { createFixture, ruleFile } from "./helpers.js";

test("reads nested rules deterministically and strips the promoted H1", async (t) => {
  const fixture = await createFixture({
    ".ai/rules/a.md": "# Alpha rules\n\nAlpha description.\n\nBody A.",
    ".ai/rules/b.md": ruleFile(
      [
        "id: beta",
        "title: Beta rules",
        "priority: 5",
        "targets: [claude, cursor]",
        'globs: "**/*.ts"',
      ].join("\n"),
      "# Beta heading\n\nBeta description line one\nline two.\n\n## Details\n\nBody B.",
    ),
    ".ai/rules/disabled.md": ruleFile(
      ["id: disabled", "enabled: false", "priority: 50"].join("\n"),
      "# Disabled\n\nNot compiled.",
    ),
    ".ai/.drafts/hidden.md": "# Hidden draft\n\nNo.",
    ".ai/.hidden.md": "# Hidden file\n\nNo.",
    ".ai/node_modules/dep.md": "# Dependency\n\nNo.",
    ".ai/assets/notes.txt": "not markdown",
  });
  t.after(() => fixture.cleanup());

  const source = await readSourceTree({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, ".ai"),
  });

  assert.equal(source.filesRead, 3);
  assert.equal(source.files.length, 3);
  assert.equal(source.sourceDirRelative, ".ai");
  assert.ok(source.files.every((file) => !file.path.includes("hidden")));
  assert.ok(source.files.every((file) => !file.path.includes("node_modules")));

  assert.deepEqual(
    source.blocks.map((block) => block.id),
    ["disabled", "beta", "rules-a"],
  );
  assert.equal(source.blocks[0]?.enabled, false);

  const beta = source.blocks.find((block) => block.id === "beta");
  assert.ok(beta);
  assert.equal(beta.title, "Beta rules");
  assert.equal(beta.description, "Beta description line one line two.");
  assert.deepEqual(beta.targets, ["claude", "cursor"]);
  assert.deepEqual(beta.globs, ["**/*.ts"]);
  assert.equal(beta.alwaysApply, false);
  assert.equal(beta.priority, 5);
  assert.equal(beta.body.startsWith("Beta description line one"), true);
  assert.equal(beta.body.includes("# Beta heading"), false);

  const alpha = source.blocks.find((block) => block.id === "rules-a");
  assert.ok(alpha);
  assert.equal(alpha.title, "Alpha rules");
  assert.deepEqual(alpha.targets, listProfiles());
  assert.equal(alpha.alwaysApply, true);
  assert.equal(source.diagnostics.some((item) => item.severity === "error"), false);
});

test("all is accepted as a targets shorthand", async (t) => {
  const fixture = await createFixture({
    ".ai/all.md": ruleFile("id: all-targets\ntargets: all", "# All\n\nEverything."),
  });
  t.after(() => fixture.cleanup());

  const source = await readSourceTree({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, ".ai"),
  });
  assert.deepEqual(source.blocks[0]?.targets, listProfiles());
});

test("a wrapped list item produces a complete Cursor description", () => {
  const parsed = parseRuleFile({
    path: ".ai/rules/testing.md",
    relativePath: "rules/testing.md",
    absolutePath: "/repo/.ai/rules/testing.md",
    content: [
      "# Testing",
      "",
      "- Use the built-in `node:test` runner and `node:assert/strict`; do not add",
      "  Jest, Vitest, or Mocha.",
      "- Tests live in tests/.",
      "",
      "More text.",
    ].join("\n"),
    order: 0,
  });

  assert.ok(parsed.block);
  assert.equal(
    parsed.block.description,
    "Use the built-in node:test runner and node:assert/strict; do not add Jest, Vitest, or Mocha.",
  );
});

test("truncated Cursor descriptions end on a clean word boundary", () => {
  const paragraph = `${"word ".repeat(40)}instructions.md, and more text follows here.`;
  const parsed = parseRuleFile({
    path: ".ai/rules/long.md",
    relativePath: "rules/long.md",
    absolutePath: "/repo/.ai/rules/long.md",
    content: `# Long rule\n\n${paragraph}`,
    order: 0,
  });

  assert.ok(parsed.block);
  assert.ok(parsed.block.description.length <= 220);
  assert.equal(parsed.block.description.endsWith("instructions.md..."), true);
  assert.equal(parsed.block.description.includes("instructions.md,..."), false);
});

test("reports duplicate ids and keeps only the first block", async (t) => {
  const fixture = await createFixture({
    ".ai/one.md": ruleFile("id: duplicate\ntitle: One", "# One\n\nFirst."),
    ".ai/two.md": ruleFile("id: duplicate\ntitle: Two", "# Two\n\nSecond."),
  });
  t.after(() => fixture.cleanup());

  const source = await readSourceTree({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, ".ai"),
  });

  assert.equal(source.blocks.length, 1);
  assert.equal(source.blocks[0]?.title, "One");
  const duplicate = source.diagnostics.find(
    (diagnostic) => diagnostic.code === "source.duplicate-id",
  );
  assert.ok(duplicate);
  assert.equal(duplicate.severity, "error");
  assert.equal(duplicate.path, ".ai/two.md");
});

test("rejects unknown targets without silently widening the rule", async (t) => {
  const fixture = await createFixture({
    ".ai/rule.md": ruleFile(
      "id: narrow\ntargets: [claude, vscode]",
      "# Narrow\n\nOnly Claude.",
    ),
    ".ai/broken.md": ruleFile(
      "id: invalid\ntargets: [vscode]",
      "# Invalid\n\nNo valid target.",
    ),
  });
  t.after(() => fixture.cleanup());

  const source = await readSourceTree({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, ".ai"),
  });

  const narrow = source.blocks.find((block) => block.id === "narrow");
  assert.deepEqual(narrow?.targets, ["claude"]);
  const invalid = source.blocks.find((block) => block.id === "invalid");
  assert.deepEqual(invalid?.targets, []);
  const unknown = source.diagnostics.filter(
    (diagnostic) => diagnostic.code === "source.unknown-target",
  );
  assert.equal(unknown.length, 2);
  assert.ok(unknown.every((diagnostic) => diagnostic.severity === "error"));
});

test("fatal frontmatter errors never produce a block", async (t) => {
  const fixture = await createFixture({
    ".ai/broken.md": "---\nid: broken\n\n# Missing close",
  });
  t.after(() => fixture.cleanup());

  const source = await readSourceTree({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, ".ai"),
  });

  assert.equal(source.blocks.length, 0);
  assert.equal(source.files.length, 1);
  const error = source.diagnostics.find(
    (diagnostic) => diagnostic.code === "source.frontmatter",
  );
  assert.ok(error);
  assert.equal(error.severity, "error");
});

test("missing source directory is a clear SourceError", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  await assert.rejects(
    readSourceTree({
      rootDir: fixture.root,
      sourceDir: path.join(fixture.root, ".ai"),
    }),
    (error: unknown) =>
      error instanceof SourceError && /Source directory not found/.test(error.message),
  );
});
