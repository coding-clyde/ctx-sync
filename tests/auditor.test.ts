import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONTEXT_MAX_TOKENS,
  auditContext,
} from "../src/auditor/contextAuditor.js";
import { formatReport } from "../src/auditor/reporter.js";
import { ConfigError } from "../src/errors.js";
import { syncProject } from "../src/sync.js";
import type { ContextAuditResult, ContextIssue } from "../src/types.js";
import { createFixture, ruleFile, runCli } from "./helpers.js";

const now = new Date("2026-01-02T03:04:05.000Z");

/**
 * Fake credentials are assembled at runtime so that no complete token-shaped
 * string is committed to this repository (secret scanners would flag it).
 */
const SECRETS = {
  "github-token": ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""),
  "anthropic-key": ["sk", "-ant-", "api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm"].join(""),
  "openai-key": ["sk", "-", "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8"].join(""),
  "aws-access-key": ["AKIA", "Q7WXYZ2ABCD3EFGH"].join(""),
  "google-api-key": ["AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"].join(""),
  "stripe-live-key": ["sk", "_live_", "A1b2C3d4E5f6G7h8I9j0"].join(""),
  "private-key": ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join(""),
  "connection-string": ["postgres", "://admin:", "s3cr3tP4ssw0rdX", "@db.internal:5432/app"].join(""),
} as const;

type SecretFamily = keyof typeof SECRETS;

const FRONTMATTER = "id: overview\ntitle: Overview\ntargets: all";

function overviewFile(body = "General rules for the repository."): string {
  return ruleFile(FRONTMATTER, `# Overview\n\n${body}`);
}

function secretIssues(result: ContextAuditResult): ContextIssue[] {
  return result.issues.filter((issue) => issue.category === "secret");
}

/** The part of a secret that must never appear in any report. */
function sensitivePart(family: SecretFamily): string {
  const value = SECRETS[family];
  return family === "connection-string" ? "s3cr3tP4ssw0rdX" : value;
}

/* -------------------------------------------------------------------------- */
/* Valid context                                                              */
/* -------------------------------------------------------------------------- */

test("a valid, synchronized context is ok in check mode", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });

  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });

  assert.equal(result.severity, "ok");
  assert.deepEqual(result.issues, []);
  assert.equal(result.mode, "check");
  assert.equal(result.generatedAt, now.toISOString());
  assert.equal(result.maxTokens, DEFAULT_CONTEXT_MAX_TOKENS);
  assert.equal(DEFAULT_CONTEXT_MAX_TOKENS, 4000);
  assert.ok(result.totalTokens > 0);
  // One source file plus one generated file per assistant.
  assert.equal(result.filesScanned, 1 + 4);
  assert.deepEqual(
    result.assistants.map((assistant) => assistant.profile),
    ["claude", "cursor", "copilot", "windsurf"],
  );
  for (const assistant of result.assistants) {
    assert.ok(assistant.estimatedTokens > 0, assistant.profile);
    assert.ok(assistant.paths.length > 0, assistant.profile);
    assert.equal(assistant.blocks, 1, assistant.profile);
  }
});

test("auditing never writes to disk", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());

  await auditContext({ rootDir: fixture.root, mode: "check", now });
  await auditContext({ rootDir: fixture.root, now });

  for (const file of ["CLAUDE.md", ".windsurfrules", ".github/copilot-instructions.md"]) {
    assert.equal(await fixture.exists(file), false, file);
  }
  assert.equal(await fixture.exists(".cursor"), false);
});

test("the result is deterministic for the same input and clock", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });

  const first = await auditContext({ rootDir: fixture.root, mode: "check", now });
  const second = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.deepEqual(second, first);
});

/* -------------------------------------------------------------------------- */
/* Exposed API keys                                                           */
/* -------------------------------------------------------------------------- */

for (const family of Object.keys(SECRETS) as SecretFamily[]) {
  test(`exposed ${family} is critical, located and never echoed`, async (t) => {
    const fixture = await createFixture({
      ".ai/overview.md": overviewFile(`Use ${SECRETS[family]} to call the service.`),
    });
    t.after(() => fixture.cleanup());

    const result = await auditContext({ rootDir: fixture.root, now });
    assert.equal(result.severity, "critical");

    const issues = secretIssues(result);
    // Compiled copies of a secret already reported in .ai/ are not repeated.
    assert.equal(issues.length, 1);
    const [issue] = issues;
    assert.ok(issue);
    assert.equal(issue.severity, "critical");
    assert.equal(issue.ruleId, family);
    assert.equal(issue.path, ".ai/overview.md");
    // 5 frontmatter lines, a blank, the H1, a blank, then the body.
    assert.equal(issue.line, 9);
    assert.ok((issue.column ?? 0) >= 1);
    assert.match(issue.fingerprint ?? "", /^[0-9a-f]+$/);

    for (const output of [
      JSON.stringify(result),
      formatReport(result, { json: true }),
      formatReport(result, { env: {} }),
      formatReport(result, { env: { GITHUB_ACTIONS: "true" } }),
    ]) {
      assert.ok(!output.includes(sensitivePart(family)), "secret value leaked");
    }
  });
}

test("each secret in a file is reported with its own line", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(
      `First ${SECRETS["github-token"]}\n\nSecond ${SECRETS["aws-access-key"]}`,
    ),
  });
  t.after(() => fixture.cleanup());

  const issues = secretIssues(await auditContext({ rootDir: fixture.root, now }));
  assert.deepEqual(
    issues.map((issue) => [issue.ruleId, issue.line]),
    [
      ["github-token", 9],
      ["aws-access-key", 11],
    ],
  );
});

test("placeholders and inline allow markers do not trigger findings", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(
      [
        "Set ANTHROPIC_API_KEY=YOUR_API_KEY before running.",
        "Send `Authorization: Bearer <token>` with every request.",
        "Connect with postgres://user:password@localhost:5432/app.",
        `Documented fixture ${SECRETS["github-token"]} <!-- ctx-sync:allow-secret -->`,
      ].join("\n\n"),
    ),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, now });
  assert.deepEqual(secretIssues(result), []);
  assert.equal(result.severity, "ok");
});

test("secrets.disabledRules in the config turn a rule off", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(`Token ${SECRETS["github-token"]}`),
    "ctx-sync.config.json": { secrets: { disabledRules: ["github-token"] } },
  });
  t.after(() => fixture.cleanup());

  assert.equal((await auditContext({ rootDir: fixture.root, now })).severity, "ok");
});

/* -------------------------------------------------------------------------- */
/* Out-of-sync files (check mode)                                             */
/* -------------------------------------------------------------------------- */

test("check mode reports every missing generated file as critical", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(result.severity, "critical");
  const stale = result.issues.filter((issue) => issue.category === "stale-output");
  assert.deepEqual(
    stale.map((issue) => issue.path).sort(),
    [
      ".cursor/rules/project.mdc",
      ".github/copilot-instructions.md",
      ".windsurfrules",
      "CLAUDE.md",
    ],
  );
  for (const issue of stale) {
    assert.equal(issue.severity, "critical");
    assert.match(issue.message, /is missing; run "ctx-sync sync"/);
    assert.ok(issue.profile);
  }
});

test("plain audit mode does not compare files on disk", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, now });
  assert.equal(result.mode, "audit");
  assert.equal(result.severity, "ok");
  assert.deepEqual(result.issues, []);
});

test("check mode flags a generated file that no longer matches .ai/", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });

  await fixture.write(".ai/overview.md", overviewFile("Changed after the last sync."));
  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });

  assert.equal(result.severity, "critical");
  const paths = result.issues
    .filter((issue) => issue.category === "stale-output")
    .map((issue) => issue.path)
    .sort();
  assert.deepEqual(paths, [
    ".cursor/rules/project.mdc",
    ".github/copilot-instructions.md",
    ".windsurfrules",
    "CLAUDE.md",
  ]);
  assert.ok(
    result.issues.every((issue) => /is out of date with the source/.test(issue.message)),
  );

  // Re-syncing restores a clean result.
  await syncProject({ rootDir: fixture.root });
  const fixed = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(fixed.severity, "ok");
});

test("check mode flags a hand-edited generated file", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });
  await fixture.write(
    ".windsurfrules",
    `${await fixture.read(".windsurfrules")}\nHand-written line.\n`,
  );

  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(result.severity, "critical");
  assert.deepEqual(
    result.issues.map((issue) => issue.path),
    [".windsurfrules"],
  );
});

test("check mode flags a stale generated Cursor rule whose source was deleted", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(),
    ".ai/ts.md": ruleFile(
      'id: ts\ntitle: TypeScript\nglobs: ["**/*.ts"]\ntargets: cursor',
      "# TypeScript\n\n- Keep strict mode.",
    ),
  });
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });
  assert.equal(await fixture.exists(".cursor/rules/ts.mdc"), true);

  await fixture.write(
    ".ai/ts.md",
    ruleFile("id: ts\ntitle: TypeScript\nenabled: false", "# TypeScript\n\nOff."),
  );
  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });
  const issue = result.issues.find((entry) => entry.path === ".cursor/rules/ts.mdc");
  assert.ok(issue);
  assert.equal(issue.severity, "critical");
  assert.match(issue.message, /stale generated file with no matching rule/);
});

test("check mode refuses to treat an unmanaged file as synchronized", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(),
    "CLAUDE.md": "# Written by hand, not by ctx-sync\n",
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(result.severity, "critical");
  const issue = result.issues.find((entry) => entry.path === "CLAUDE.md");
  assert.ok(issue);
  assert.match(issue.message, /not managed by ctx-sync/);
});

/* -------------------------------------------------------------------------- */
/* Token budget (maxTokens)                                                   */
/* -------------------------------------------------------------------------- */

const LONG_BODY = "A sentence that costs a handful of tokens. ".repeat(80);

test("exceeding maxTokens warns for the total and for each assistant", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile(LONG_BODY) });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, maxTokens: 100, now });
  assert.equal(result.maxTokens, 100);
  assert.equal(result.severity, "warning");
  assert.ok(result.issues.every((issue) => issue.severity === "warning"));

  const budget = result.issues.filter((issue) => issue.category === "token-budget");
  assert.ok(budget.some((issue) => issue.id === "token-budget:total"));
  assert.deepEqual(
    budget
      .filter((issue) => issue.profile !== undefined)
      .map((issue) => issue.profile)
      .sort(),
    ["claude", "copilot", "cursor", "windsurf"],
  );
  const claude = budget.find((issue) => issue.profile === "claude");
  assert.match(claude?.message ?? "", /Claude Code context uses an estimated \d+ tokens, over the 100-token budget/);
  assert.equal(claude?.path, "CLAUDE.md");
  assert.match(
    budget.find((issue) => issue.id === "token-budget:total")?.message ?? "",
    /over the 100-token budget/,
  );
});

test("maxTokens is inclusive: usage equal to the budget does not warn", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile(LONG_BODY) });
  t.after(() => fixture.cleanup());

  const baseline = await auditContext({ rootDir: fixture.root, maxTokens: 0, now });
  const peak = Math.max(
    baseline.totalTokens,
    ...baseline.assistants.map((assistant) => assistant.estimatedTokens),
  );

  const atLimit = await auditContext({ rootDir: fixture.root, maxTokens: peak, now });
  assert.equal(atLimit.severity, "ok");
  assert.deepEqual(atLimit.issues, []);

  const belowLimit = await auditContext({ rootDir: fixture.root, maxTokens: peak - 1, now });
  assert.equal(belowLimit.severity, "warning");
  assert.ok(belowLimit.issues.length >= 1);
  assert.ok(belowLimit.issues.every((issue) => issue.category === "token-budget"));
});

test("maxTokens 0 disables the budget check", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile(LONG_BODY) });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, maxTokens: 0, now });
  assert.equal(result.maxTokens, 0);
  assert.equal(result.severity, "ok");
  assert.ok(!result.issues.some((issue) => issue.category === "token-budget"));
});

test("the default budget of 4000 tokens applies when none is given", async (t) => {
  const huge = "A sentence that costs a handful of tokens. ".repeat(2500);
  const fixture = await createFixture({ ".ai/overview.md": overviewFile(huge) });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, now });
  assert.equal(result.maxTokens, 4000);
  assert.ok(result.totalTokens > 4000);
  assert.equal(result.severity, "warning");
  assert.ok(result.issues.some((issue) => issue.id === "token-budget:total"));
});

test("an invalid maxTokens is rejected with a ConfigError", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      auditContext({ rootDir: fixture.root, maxTokens: value }),
      (error: unknown) =>
        error instanceof ConfigError && /maxTokens must be a non-negative integer/.test(error.message),
      String(value),
    );
  }
});

test("a token warning never hides a critical issue", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(`${LONG_BODY}\n\nKey ${SECRETS["github-token"]}`),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, maxTokens: 100, now });
  assert.equal(result.severity, "critical");
  assert.equal(result.issues[0]?.severity, "critical", "critical issues sort first");
  assert.ok(result.issues.some((issue) => issue.category === "token-budget"));
});

/* -------------------------------------------------------------------------- */
/* Wasted context: empty and duplicate rules                                  */
/* -------------------------------------------------------------------------- */

test("empty and duplicated rules are warnings, reported once", async (t) => {
  const body = "Identical guidance repeated in two files.";
  const fixture = await createFixture({
    ".ai/a.md": ruleFile("id: a\ntitle: A\ntargets: all", `# A\n\n${body}`),
    ".ai/b.md": ruleFile("id: b\ntitle: B\ntargets: all", `# B\n\n${body.toUpperCase()}`),
    ".ai/c.md": ruleFile("id: c\ntitle: C\ntargets: all", "# C\n"),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, now });
  assert.equal(result.severity, "warning");
  // Duplicates are detected case- and whitespace-insensitively; ties sort by path.
  assert.deepEqual(
    result.issues.map((issue) => [issue.category, issue.path]),
    [
      ["duplicate-block", ".ai/b.md"],
      ["empty-block", ".ai/c.md"],
    ],
  );
  assert.match(
    result.issues.find((issue) => issue.category === "duplicate-block")?.message ?? "",
    /duplicates the content of "a"/,
  );
});

test("source errors such as duplicate ids are critical", async (t) => {
  const fixture = await createFixture({
    ".ai/a.md": ruleFile("id: same", "# A\n\nFirst."),
    ".ai/b.md": ruleFile("id: same", "# B\n\nSecond."),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, now });
  assert.equal(result.severity, "critical");
  assert.ok(
    result.issues.some(
      (issue) => issue.category === "source" && /Duplicate rule id/.test(issue.message),
    ),
  );
});

/* -------------------------------------------------------------------------- */
/* ignorePatterns                                                             */
/* -------------------------------------------------------------------------- */

test("ignorePatterns exclude by value, by line and by path", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(`Fixture token ${SECRETS["github-token"]}`),
  });
  t.after(() => fixture.cleanup());

  assert.equal((await auditContext({ rootDir: fixture.root, now })).severity, "critical");

  const byValue = await auditContext({
    rootDir: fixture.root,
    now,
    ignorePatterns: ["^ghp_A1b2"],
  });
  assert.equal(byValue.severity, "ok");

  const byLine = await auditContext({
    rootDir: fixture.root,
    now,
    ignorePatterns: ["fixture token"], // case-insensitive
  });
  assert.equal(byLine.severity, "ok");

  const byPath = await auditContext({
    rootDir: fixture.root,
    now,
    ignorePatterns: ["^\\.ai/overview\\.md$"],
  });
  assert.deepEqual(secretIssues(byPath), []);
});

test("ignorePatterns that match nothing leave findings untouched", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(`Token ${SECRETS["github-token"]}`),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({
    rootDir: fixture.root,
    now,
    ignorePatterns: ["^docs/", "unrelated"],
  });
  assert.equal(result.severity, "critical");
  assert.equal(secretIssues(result).length, 1);
});

test("ignoring one file does not hide secrets in another", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(`Token ${SECRETS["github-token"]}`),
    ".ai/other.md": ruleFile(
      "id: other\ntitle: Other\ntargets: all",
      `# Other\n\nKey ${SECRETS["aws-access-key"]}`,
    ),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({
    rootDir: fixture.root,
    now,
    ignorePatterns: ["^\\.ai/overview\\.md$"],
  });
  assert.equal(result.severity, "critical");
  assert.deepEqual(
    secretIssues(result).map((issue) => issue.path),
    [".ai/other.md"],
  );
});

test("ignorePatterns also silence drift and empty rules on matching paths", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(),
    ".ai/empty.md": ruleFile("id: empty\ntitle: Empty\ntargets: all", "# Empty\n"),
  });
  t.after(() => fixture.cleanup());

  const noisy = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.ok(noisy.issues.some((issue) => issue.category === "empty-block"));
  assert.ok(noisy.issues.some((issue) => issue.category === "stale-output"));

  const quiet = await auditContext({
    rootDir: fixture.root,
    mode: "check",
    now,
    ignorePatterns: [
      "^\\.ai/empty\\.md$",
      "^CLAUDE\\.md$",
      "^\\.cursor/",
      "^\\.github/",
      "^\\.windsurfrules$",
    ],
  });
  assert.deepEqual(quiet.issues, []);
  assert.equal(quiet.severity, "ok");
});

test("an invalid ignore pattern fails fast with a ConfigError", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());

  await assert.rejects(
    auditContext({ rootDir: fixture.root, ignorePatterns: ["("] }),
    (error: unknown) =>
      error instanceof ConfigError && /invalid regular expression "\("/.test(error.message),
  );
});

/* -------------------------------------------------------------------------- */
/* Ordering and the CLI gate                                                  */
/* -------------------------------------------------------------------------- */

test("issues are sorted with critical first and then by path and line", async (t) => {
  const fixture = await createFixture({
    ".ai/z.md": ruleFile("id: z\ntitle: Z\ntargets: all", "# Z\n"),
    ".ai/overview.md": overviewFile(`Token ${SECRETS["github-token"]}`),
  });
  t.after(() => fixture.cleanup());

  const { issues } = await auditContext({ rootDir: fixture.root, now });
  const firstWarning = issues.findIndex((issue) => issue.severity === "warning");
  assert.ok(firstWarning > 0);
  assert.ok(issues.slice(0, firstWarning).every((issue) => issue.severity === "critical"));
  assert.ok(issues.slice(firstWarning).every((issue) => issue.severity === "warning"));
});

test("CLI: `check` exits 0 when clean and 1 on drift", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());

  const drift = await runCli(["check"], fixture.root);
  assert.equal(drift.code, 1);
  assert.match(drift.stdout, /CLAUDE\.md/);

  assert.equal((await runCli(["sync"], fixture.root)).code, 0);
  const clean = await runCli(["check"], fixture.root);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
});

test("CLI: `check` exits 1 on an exposed API key without printing it", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": overviewFile(`Token ${SECRETS["github-token"]}`),
  });
  t.after(() => fixture.cleanup());

  const result = await runCli(["check"], fixture.root);
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(SECRETS["github-token"]));
  assert.ok(!result.stderr.includes(SECRETS["github-token"]));
});

test("CLI: token warnings pass by default and fail with --strict", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile(LONG_BODY) });
  t.after(() => fixture.cleanup());
  assert.equal((await runCli(["sync"], fixture.root)).code, 0);

  const lenient = await runCli(["check", "--max-tokens", "100"], fixture.root);
  assert.equal(lenient.code, 0, lenient.stdout + lenient.stderr);
  assert.match(lenient.stdout, /token/i);

  const strict = await runCli(["check", "--max-tokens", "100", "--strict"], fixture.root);
  assert.equal(strict.code, 1);

  const disabled = await runCli(["check", "--max-tokens", "0", "--strict"], fixture.root);
  assert.equal(disabled.code, 0, disabled.stdout + disabled.stderr);
});

test("CLI: `check --json` emits a parseable report", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overviewFile() });
  t.after(() => fixture.cleanup());
  assert.equal((await runCli(["sync"], fixture.root)).code, 0);

  const result = await runCli(["check", "--json"], fixture.root);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as ContextAuditResult;
  assert.equal(report.mode, "check");
  assert.equal(report.severity, "ok");
  assert.deepEqual(report.issues, []);
});
