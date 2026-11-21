import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { syncProject } from "../src/sync.js";
import { createFixture, ruleFile } from "./helpers.js";

function sourceFixture() {
  return createFixture({
    ".ai/overview.md": ruleFile(
      "id: overview\ntitle: Overview\npriority: 10",
      "# Overview\n\nGeneral repository rules.",
    ),
    ".ai/rules/typescript.md": ruleFile(
      [
        "id: typescript",
        "title: TypeScript",
        "globs: [\"**/*.ts\"]",
      ].join("\n"),
      "# TypeScript\n\n- Keep strict mode.",
    ),
  });
}

test("writes every enabled profile, then becomes idempotent", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const first = await syncProject({ rootDir: fixture.root });
  assert.equal(first.valid, true);
  assert.equal(first.ok, true);
  assert.equal(first.drift, true);
  assert.equal(first.blocks, 2);
  assert.deepEqual(first.profiles, ["claude", "cursor", "copilot", "windsurf"]);
  assert.equal(first.changes.length, 5);
  assert.ok(first.changes.every((change) => change.status === "created"));

  for (const relativePath of [
    "CLAUDE.md",
    ".github/copilot-instructions.md",
    ".windsurfrules",
    ".cursor/rules/overview.mdc",
    ".cursor/rules/typescript.mdc",
  ]) {
    assert.equal(await fixture.exists(relativePath), true, relativePath);
  }

  const second = await syncProject({ rootDir: fixture.root });
  assert.equal(second.ok, true);
  assert.equal(second.drift, false);
  assert.ok(second.changes.every((change) => change.status === "unchanged"));
});

test("--check detects drift without writing", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const before = await syncProject({ rootDir: fixture.root, check: true });
  assert.equal(before.ok, false);
  assert.equal(before.drift, true);
  assert.equal(before.valid, true);
  assert.equal(await fixture.exists("CLAUDE.md"), false);

  await syncProject({ rootDir: fixture.root });
  const clean = await syncProject({ rootDir: fixture.root, check: true });
  assert.equal(clean.ok, true);
  assert.equal(clean.drift, false);

  const original = await fixture.read("CLAUDE.md");
  await fixture.write("CLAUDE.md", `${original}\nstale local edit\n`);
  const stale = await syncProject({ rootDir: fixture.root, check: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.drift, true);
  assert.equal(
    stale.changes.find((change) => change.path === "CLAUDE.md")?.status,
    "updated",
  );
  assert.match(await fixture.read("CLAUDE.md"), /stale local edit/);

  await syncProject({ rootDir: fixture.root });
  assert.equal(await fixture.read("CLAUDE.md"), original);
});

test("refuses to overwrite unmanaged files without --force", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());
  await fixture.write("CLAUDE.md", "# Hand-written instructions\n\nKeep me.\n");

  const blocked = await syncProject({ rootDir: fixture.root });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.ok, false);
  assert.equal(
    blocked.diagnostics.some(
      (diagnostic) => diagnostic.code === "build.unmanaged-file",
    ),
    true,
  );
  assert.equal(
    blocked.changes.find((change) => change.path === "CLAUDE.md")?.status,
    "blocked",
  );
  assert.match(await fixture.read("CLAUDE.md"), /Keep me/);
  assert.equal(await fixture.exists(".windsurfrules"), false);

  const forced = await syncProject({ rootDir: fixture.root, force: true });
  assert.equal(forced.valid, true);
  assert.equal(forced.ok, true);
  assert.match(await fixture.read("CLAUDE.md"), /ctx-sync:generated/);
});

test("removes stale generated Cursor rules but preserves handwritten rules", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());
  await fixture.write(
    ".cursor/rules/stale.mdc",
    '<!-- ctx-sync:generated profile="cursor" version="0.1.0" -->\n# Stale\n',
  );
  await fixture.write(".cursor/rules/custom.mdc", "# My custom rule\n\nDo not touch.\n");

  const summary = await syncProject({ rootDir: fixture.root });
  assert.equal(summary.valid, true);
  assert.equal(
    summary.changes.find((change) => change.path === ".cursor/rules/stale.mdc")
      ?.status,
    "removed",
  );
  assert.equal(await fixture.exists(".cursor/rules/stale.mdc"), false);
  assert.equal(await fixture.exists(".cursor/rules/custom.mdc"), true);
  assert.match(await fixture.read(".cursor/rules/custom.mdc"), /Do not touch/);
});

test("profile selection restricts writes and cleanup", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const summary = await syncProject({
    rootDir: fixture.root,
    profiles: ["claude"],
  });
  assert.deepEqual(summary.profiles, ["claude"]);
  assert.equal(await fixture.exists("CLAUDE.md"), true);
  assert.equal(await fixture.exists(".windsurfrules"), false);
  assert.equal(await fixture.exists(".cursor/rules/typescript.mdc"), false);
  assert.equal(await fixture.exists("docs"), false);
});

test("source errors abort the build before any write", async (t) => {
  const fixture = await createFixture({
    ".ai/a.md": ruleFile("id: duplicate", "# A\n\nFirst."),
    ".ai/b.md": ruleFile("id: duplicate", "# B\n\nSecond."),
  });
  t.after(() => fixture.cleanup());

  const summary = await syncProject({ rootDir: fixture.root });
  assert.equal(summary.valid, false);
  assert.equal(summary.ok, false);
  assert.equal(
    summary.diagnostics.some((diagnostic) => diagnostic.code === "source.duplicate-id"),
    true,
  );
  assert.equal(await fixture.exists("CLAUDE.md"), false);
});

test("dry run reports without touching disk", async (t) => {
  const fixture = await sourceFixture();
  t.after(() => fixture.cleanup());

  const summary = await syncProject({ rootDir: fixture.root, dryRun: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.drift, true);
  assert.equal(await fixture.exists("CLAUDE.md"), false);
});

test("use an absolute source override safely", async (t) => {
  const fixture = await createFixture({
    "context/rules.md": ruleFile("id: alternate", "# Alternate\n\nFrom another folder."),
  });
  t.after(() => fixture.cleanup());

  const summary = await syncProject({
    rootDir: fixture.root,
    sourceDir: path.join(fixture.root, "context"),
    profiles: ["claude"],
  });
  assert.equal(summary.valid, true);
  assert.equal(summary.sourceDir, "context");
  const claude = await fixture.read("CLAUDE.md");
  assert.match(claude, /From another folder/);
});
