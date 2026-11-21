import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { SourceError } from "../src/errors.js";
import { readProjectContext } from "../src/readers/index.js";
import { readSourceDirectory } from "../src/readers/sourceReader.js";
import {
  combineMetrics,
  estimateSourceTokens,
  estimateTokens,
  measureText,
} from "../src/readers/tokenEstimator.js";
import { TARGET_PROFILES } from "../src/types.js";
import { createFixture, ruleFile } from "./helpers.js";

function sourceFixture() {
  return createFixture({
    ".ai/architecture.md": ruleFile(
      [
        "priority: 10",
        "targets: [claude, cursor]",
        'files: ["src/**/*.ts", "src/**/*.tsx"]',
      ].join("\n"),
      "# Architecture\n\nKeep domain logic out of adapters.",
    ),
    ".ai/style.md": "# Style\n\nUse two spaces and trailing commas.",
    ".ai/nested/testing.md": ruleFile(
      ["priority: 30", "assistants: cursor", "patterns: tests/**"].join("\n"),
      "# Testing\n\n- Use `node:test`.",
    ),
    ".ai/.drafts/ignored.md": "# Hidden\n\nNever read.",
    ".ai/notes.txt": "not markdown",
  });
}

test("sourceReader reads nested Markdown and accepts metadata aliases", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const source = await readSourceDirectory({ rootDir: fixture.root });

  assert.equal(source.sourceDirRelative, ".ai");
  assert.equal(source.filesRead, 3);
  assert.equal(source.files.length, 3);
  assert.deepEqual(
    source.blocks.map((block) => block.id),
    ["nested-testing", "architecture", "style"],
  );

  const testing = source.blocks[0];
  assert.ok(testing);
  assert.equal(testing.priority, 30);
  assert.deepEqual(testing.targets, ["cursor"]);
  assert.deepEqual(testing.globs, ["tests/**"]);

  const architecture = source.blocks[1];
  assert.ok(architecture);
  assert.equal(architecture.priority, 10);
  assert.deepEqual(architecture.targets, ["claude", "cursor"]);
  assert.deepEqual(architecture.globs, ["src/**/*.ts", "src/**/*.tsx"]);
  assert.equal(architecture.sourcePath, ".ai/architecture.md");
  assert.equal(architecture.relativePath, "architecture.md");

  assert.equal(
    source.files.some((file) => file.path.includes(".drafts")),
    false,
  );
  assert.equal(source.diagnostics.some((item) => item.severity === "error"), false);
});

test("sourceReader rejects a missing or non-directory source path", async (t) => {
  const fixture = await createFixture({
    ".ai-file": "not a directory",
  });
  t.after(() => fixture.cleanup());

  await assert.rejects(
    readSourceDirectory({
      rootDir: fixture.root,
      sourceDir: "missing",
    }),
    (error: unknown) =>
      error instanceof SourceError &&
      error.code === "source.missing" &&
      /Source directory not found/.test(error.message),
  );

  await assert.rejects(
    readSourceDirectory({
      rootDir: fixture.root,
      sourceDir: ".ai-file",
    }),
    (error: unknown) =>
      error instanceof SourceError && error.code === "source.not-directory",
  );
});

test("sourceReader accepts a relative or absolute source override", async (t) => {
  const fixture = await createFixture({
    "context/rules.md": ruleFile(
      "id: alternate\ntargets: all",
      "# Alternate\n\nFrom another folder.",
    ),
  });
  t.after(() => fixture.cleanup());

  const relative = await readSourceDirectory({
    rootDir: fixture.root,
    sourceDir: "context",
  });
  assert.equal(relative.sourceDirRelative, "context");
  assert.equal(relative.blocks[0]?.id, "alternate");
  assert.deepEqual(relative.blocks[0]?.targets, [...TARGET_PROFILES]);

  const absolute = await readSourceDirectory({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, "context"),
  });
  assert.equal(absolute.sourceDir, relative.sourceDir);
  assert.deepEqual(absolute.blocks, relative.blocks);
});

test("tokenEstimator reports files, blocks, totals, and stable metrics", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const source = await readSourceDirectory({ rootDir: fixture.root });
  const first = estimateSourceTokens(source);
  const second = estimateSourceTokens(source);

  assert.deepEqual(first, second);
  assert.equal(first.method, "heuristic-v1");
  assert.equal(first.files.length, 3);
  assert.equal(first.blocks.length, 3);
  assert.deepEqual(
    first.files.map((file) => file.path),
    source.files.map((file) => file.path),
  );
  assert.deepEqual(
    first.blocks.map((block) => block.blockId),
    source.blocks.map((block) => block.id),
  );
  assert.deepEqual(
    first.total,
    combineMetrics(first.files.map((file) => file.metrics)),
  );
  assert.deepEqual(
    first.blockTotal,
    combineMetrics(first.blocks.map((block) => block.metrics)),
  );
  assert.ok(first.total.estimatedTokens > first.blockTotal.estimatedTokens);

  const architecture = first.blocks.find(
    (block) => block.blockId === "architecture",
  );
  assert.ok(architecture);
  assert.deepEqual(
    architecture.metrics,
    measureText(source.blocks[1]?.body ?? ""),
  );
  assert.equal(architecture.enabled, true);
  assert.ok(estimateTokens("Hello world") > 0);
});

test("project reader validates .ai and detects every existing native output", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  await fixture.write("CLAUDE.md", "# Existing Claude\n");
  await fixture.write(".cursor/rules/one.mdc", "one");
  await fixture.write(".cursor/rules/two.mdc", "two");
  await fixture.write(".cursor/rules/notes.txt", "ignored when counting");
  await fixture.write(".github/copilot-instructions.md", "# Copilot\n");
  await fixture.write(".windsurfrules", "Windsurf\n");

  const context = await readProjectContext({ rootDir: fixture.root });

  assert.equal(context.valid, true);
  assert.equal(context.sourceDirRelative, ".ai");
  assert.equal(context.source.blocks.length, 3);
  assert.equal(context.tokens.files.length, 3);
  assert.deepEqual(
    context.existingOutputs.map((output) => output.profile),
    ["claude", "cursor", "copilot", "windsurf"],
  );
  assert.deepEqual(
    context.existingOutputs.map((output) => output.kind),
    ["file", "directory", "file", "file"],
  );
  assert.deepEqual(
    context.existingOutputs.map((output) => output.entries),
    [1, 2, 1, 1],
  );
  assert.equal(
    context.existingOutputs.find((output) => output.profile === "cursor")?.path,
    ".cursor/rules",
  );
});

test("project reader reports no outputs when nothing exists or detection is disabled", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const clean = await readProjectContext({ rootDir: fixture.root });
  assert.deepEqual(clean.existingOutputs, []);
  assert.equal(clean.valid, true);

  await fixture.write("CLAUDE.md", "# Existing\n");
  const disabled = await readProjectContext({
    rootDir: fixture.root,
    detectExistingOutputs: false,
  });
  assert.deepEqual(disabled.existingOutputs, []);
});

test("project reader honors custom output paths", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  await fixture.write("docs/AGENTS.md", "# Agents\n");
  await fixture.write("docs/rules/a.mdc", "a");
  await fixture.write("docs/rules/b.mdc", "b");

  const context = await readProjectContext({
    rootDir: fixture.root,
    outputs: {
      claude: "docs/AGENTS.md",
      cursor: "docs/rules",
    },
  });

  assert.deepEqual(
    context.existingOutputs.map((output) => [output.profile, output.entries]),
    [
      ["claude", 1],
      ["cursor", 2],
    ],
  );
});

test("project reader surfaces missing root and source directories", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  await assert.rejects(
    readProjectContext({ rootDir: path.join(fixture.root, "missing-root") }),
    (error: unknown) =>
      error instanceof SourceError && error.code === "source.root-missing",
  );

  await assert.rejects(
    readProjectContext({ rootDir: fixture.root }),
    (error: unknown) =>
      error instanceof SourceError && error.code === "source.missing",
  );
});
