import assert from "node:assert/strict";
import test from "node:test";

import { VERSION } from "../src/version.js";
import { createFixture, ruleFile, runCli } from "./helpers.js";

const GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

function basicFixture() {
  return createFixture({
    ".ai/rule.md": ruleFile(
      "id: rule\ntitle: Rule",
      "# Rule\n\nKeep it short and deterministic.",
    ),
  });
}

test("prints help and version", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  const help = await runCli(["--help"], fixture.root);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /ctx-sync build/);

  const version = await runCli(["--version"], fixture.root);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), `ctx-sync ${VERSION}`);
});

test("build writes files and --check detects drift", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const build = await runCli(["build"], fixture.root);
  assert.equal(build.code, 0, build.stderr);
  assert.equal(await fixture.exists("CLAUDE.md"), true);

  const clean = await runCli(["build", "--check"], fixture.root);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /up to date/);

  await fixture.write("CLAUDE.md", `${await fixture.read("CLAUDE.md")}\nedited\n`);
  const stale = await runCli(["build", "--check"], fixture.root);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /stale/);
});

test("build --json emits a parseable summary", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["build", "--json"], fixture.root);
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout) as {
    ok: boolean;
    drift: boolean;
    profiles: string[];
    changes: Array<{ path: string; status: string }>;
  };
  assert.equal(summary.ok, true);
  assert.equal(summary.drift, true);
  assert.deepEqual(summary.profiles, ["claude", "cursor", "copilot", "windsurf"]);
  assert.ok(summary.changes.some((change) => change.path === "CLAUDE.md"));
  assert.doesNotMatch(result.stdout, /\u001B\[/);
});

test("build --dry-run does not write and --profile restricts output", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const dry = await runCli(["build", "--dry-run"], fixture.root);
  assert.equal(dry.code, 0);
  assert.equal(await fixture.exists("CLAUDE.md"), false);

  const limited = await runCli(
    ["build", "--profile", "claude", "--json"],
    fixture.root,
  );
  assert.equal(limited.code, 0, limited.stderr);
  const summary = JSON.parse(limited.stdout) as { profiles: string[] };
  assert.deepEqual(summary.profiles, ["claude"]);
  assert.equal(await fixture.exists("CLAUDE.md"), true);
  assert.equal(await fixture.exists(".windsurfrules"), false);
});

test("audit emits a clean JSON report", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["audit", "--json"], fixture.root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    severity: string;
    source: { blocks: number };
    secrets: { findings: unknown[] };
  };
  assert.equal(report.severity, "ok");
  assert.equal(report.source.blocks, 1);
  assert.deepEqual(report.secrets.findings, []);
});

test("audit fails on secrets without printing them and honors --fail-on never", async (t) => {
  const fixture = await createFixture({
    ".ai/leak.md": ruleFile(
      "id: leak\ntitle: Leak",
      `# Leak\n\nUse this token: ${GITHUB_TOKEN}`,
    ),
  });
  t.after(() => fixture.cleanup());

  const failed = await runCli(["audit", "--json"], fixture.root);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout.includes(GITHUB_TOKEN), false);
  const report = JSON.parse(failed.stdout) as {
    severity: string;
    secrets: { findings: Array<{ fingerprint: string }> };
  };
  assert.equal(report.severity, "critical");
  assert.ok(report.secrets.findings.length > 0);
  assert.ok(report.secrets.findings.every((finding) => finding.fingerprint.length === 16));

  const ignored = await runCli(
    ["audit", "--json", "--fail-on", "never"],
    fixture.root,
  );
  assert.equal(ignored.code, 0);
});

test("--github emits annotations only and never leaks secrets", async (t) => {
  const fixture = await createFixture({
    ".ai/leak.md": ruleFile(
      "id: leak\ntitle: Leak",
      `# Leak\n\nUse this token: ${GITHUB_TOKEN}`,
    ),
  });
  t.after(() => fixture.cleanup());

  const result = await runCli(["audit", "--github"], fixture.root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^::error /m);
  assert.equal(result.stdout.includes(GITHUB_TOKEN), false);

  const cleanFixture = await basicFixture();
  t.after(() => cleanFixture.cleanup());
  const clean = await runCli(["audit", "--github"], cleanFixture.root);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /^::notice /m);
});

test("build --check --github annotates stale outputs", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());
  await runCli(["build"], fixture.root);
  await fixture.write("CLAUDE.md", `${await fixture.read("CLAUDE.md")}\nedited\n`);

  const result = await runCli(["build", "--check", "--github"], fixture.root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^::error .*file=CLAUDE\.md/m);
});

test("rejects invalid commands, profiles, and output modes", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const unknown = await runCli(["deploy"], fixture.root);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);

  const profile = await runCli(["build", "--profile", "vscode"], fixture.root);
  assert.equal(profile.code, 2);
  assert.match(profile.stderr, /Unknown profile/);

  const outputMode = await runCli(
    ["audit", "--json", "--github"],
    fixture.root,
  );
  assert.equal(outputMode.code, 2);
  assert.match(outputMode.stderr, /cannot be combined/);

  const option = await runCli(["build", "--nope"], fixture.root);
  assert.equal(option.code, 2);
  assert.match(option.stderr, /Invalid arguments/);
});

test("build fails safely when a target is unmanaged", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());
  await fixture.write("CLAUDE.md", "# Mine\n");

  const result = await runCli(["build"], fixture.root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Refusing to overwrite unmanaged file/);
  assert.equal(await fixture.read("CLAUDE.md"), "# Mine\n");
});

test("audit without a source directory fails with exit code 2", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["audit"], fixture.root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Source directory not found/);
});
