import assert from "node:assert/strict";
import test from "node:test";

import { auditProject } from "../src/auditor/index.js";
import { VERSION } from "../src/version.js";
import { createFixture, ruleFile } from "./helpers.js";

const GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

test("builds a complete, deterministic audit report", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": ruleFile(
      "id: overview\ntitle: Overview\ntargets: all",
      "# Overview\n\nGeneral rules for the repository.",
    ),
  });
  t.after(() => fixture.cleanup());

  const now = new Date("2026-01-02T03:04:05.000Z");
  const report = await auditProject({ rootDir: fixture.root, now });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.tool.name, "ctx-syncr");
  assert.equal(report.tool.version, VERSION);
  assert.equal(report.generatedAt, now.toISOString());
  assert.equal(report.source.filesRead, 1);
  assert.equal(report.source.blocks, 1);
  assert.equal(report.tokens.blocks.length, 1);
  assert.equal(report.tokens.profiles.length, 4);
  assert.ok(report.tokens.total.estimatedTokens > 0);
  assert.deepEqual(report.secrets.findings, []);
  assert.equal(report.secrets.severity, "ok");
  assert.equal(report.severity, "ok");
  assert.equal(report.failOn, "warning");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.tokens.profiles.map((profile) => profile.profile),
    ["claude", "cursor", "copilot", "windsurf"],
  );
  assert.ok(report.tokens.profiles.every((profile) => profile.blockCount === 1));
});

test("reports block and profile budget overruns with configured budgets", async (t) => {
  const longBody = "# Long\n\n" + "This rule repeats a sentence. ".repeat(40);
  const fixture = await createFixture({
    ".ai/long.md": ruleFile(
      "id: long\ntitle: Long\nmaxTokens: 3",
      longBody,
    ),
    "ctx-syncr.config.json": {
      tokenBudget: { maxPerProfile: 10, maxPerBlock: 1000 },
    },
  });
  t.after(() => fixture.cleanup());

  const report = await auditProject({ rootDir: fixture.root });
  assert.equal(report.severity, "critical");
  const block = report.tokens.blocks[0];
  assert.ok(block);
  assert.ok(block.metrics.estimatedTokens > 3);
  assert.equal(block.maxTokens, 3);
  assert.equal(block.status, "critical");

  const blockFinding = report.findings.find(
    (finding) => finding.id === "token-block:long",
  );
  assert.equal(blockFinding?.kind, "token-budget");
  assert.equal(blockFinding?.severity, "critical");

  const profileFinding = report.findings.find(
    (finding) => finding.profile === "claude" && finding.kind === "token-budget",
  );
  assert.ok(profileFinding);
  assert.equal(profileFinding.severity, "critical");
});

test("detects secrets in source and generated outputs without leaking them", async (t) => {
  const fixture = await createFixture({
    ".ai/leak.md": ruleFile(
      "id: leak\ntitle: Leak\ntargets: [claude, cursor]",
      `# Leak\n\nDeployment token: ${GITHUB_TOKEN}`,
    ),
  });
  t.after(() => fixture.cleanup());

  const report = await auditProject({ rootDir: fixture.root });
  assert.equal(report.severity, "critical");
  assert.equal(report.secrets.severity, "critical");
  assert.ok(report.secrets.findings.length >= 2);
  assert.ok(
    report.secrets.findings.some((finding) => finding.path === ".ai/leak.md"),
  );
  assert.ok(
    report.secrets.findings.some((finding) => finding.path === "CLAUDE.md"),
  );
  assert.equal(
    report.findings.some((finding) => finding.kind === "secret-exposure"),
    false,
  );

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(GITHUB_TOKEN), false);
});

test("warns when an enabled profile has no matching rules", async (t) => {
  const fixture = await createFixture({
    ".ai/claude-only.md": ruleFile(
      "id: claude-only\ntargets: claude",
      "# Claude only\n\nOnly Claude.",
    ),
  });
  t.after(() => fixture.cleanup());

  const report = await auditProject({ rootDir: fixture.root });
  assert.equal(report.severity, "warning");
  const coverage = report.findings.filter((finding) => finding.kind === "coverage");
  assert.deepEqual(
    coverage.map((finding) => finding.profile),
    ["copilot", "cursor", "windsurf"],
  );
});

test("source errors are critical findings and force a non-zero CLI exit", async (t) => {
  const fixture = await createFixture({
    ".ai/a.md": ruleFile("id: duplicate", "# A\n\nFirst."),
    ".ai/b.md": ruleFile("id: duplicate", "# B\n\nSecond."),
  });
  t.after(() => fixture.cleanup());

  const report = await auditProject({ rootDir: fixture.root, failOn: "never" });
  assert.equal(report.severity, "critical");
  assert.equal(report.failOn, "never");
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.kind === "source" &&
        finding.severity === "critical" &&
        finding.message.includes("Duplicate rule id"),
    ),
  );
});

test("0 disables a token budget", async (t) => {
  const fixture = await createFixture({
    ".ai/rule.md": ruleFile("id: rule", "# Rule\n\nShort."),
    "ctx-syncr.config.json": {
      tokenBudget: { maxPerProfile: 0, maxPerBlock: 0 },
    },
  });
  t.after(() => fixture.cleanup());

  const report = await auditProject({ rootDir: fixture.root });
  assert.equal(report.severity, "ok");
  assert.ok(report.tokens.profiles.every((profile) => profile.status === "ok"));
  assert.equal(report.tokens.blocks[0]?.maxTokens, 0);
});
