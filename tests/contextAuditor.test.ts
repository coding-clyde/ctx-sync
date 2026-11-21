import assert from "node:assert/strict";
import test from "node:test";

import { auditContext } from "../src/auditor/contextAuditor.js";
import {
  formatReport,
  isGithubActions,
  wantsJson,
} from "../src/auditor/reporter.js";
import { syncProject } from "../src/sync.js";
import { createFixture, ruleFile } from "./helpers.js";

const now = new Date("2026-01-02T03:04:05.000Z");
const GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const ANTHROPIC_KEY = "sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm";
const OPENAI_KEY = "sk-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8";
const AWS_KEY = "AKIAQ7WXYZ2ABCD3EFGH";
const BEARER = "Bearer Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8";

const overview = ruleFile(
  "id: overview\ntitle: Overview\ntargets: all",
  "# Overview\n\nGeneral rules for the repository.",
);

test("clean, synchronized context is ok", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overview });
  t.after(() => fixture.cleanup());
  await syncProject({ rootDir: fixture.root });

  const result = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(result.severity, "ok");
  assert.deepEqual(result.issues, []);
  assert.equal(result.maxTokens, 4000);
  assert.equal(result.assistants.length, 4);
  assert.ok(result.totalTokens > 0);
});

test("each secret family is critical and never serialized", async (t) => {
  for (const secret of [GITHUB_TOKEN, ANTHROPIC_KEY, OPENAI_KEY, AWS_KEY, BEARER]) {
    const fixture = await createFixture({
      ".ai/overview.md": ruleFile(
        "id: overview\ntitle: Overview\ntargets: all",
        `# Overview\n\nUse ${secret} to call the API.`,
      ),
    });
    t.after(() => fixture.cleanup());

    const result = await auditContext({ rootDir: fixture.root, now });
    assert.equal(result.severity, "critical", secret.slice(0, 6));
    const issue = result.issues.find((entry) => entry.category === "secret");
    assert.ok(issue);
    assert.equal(issue.path, ".ai/overview.md");
    // Compiled copies of the same secret are not reported again.
    assert.equal(result.issues.filter((entry) => entry.category === "secret").length, 1);

    const secretValue = secret.replace(/^Bearer /, "");
    for (const output of [
      JSON.stringify(result),
      formatReport(result, { json: true }),
      formatReport(result, { env: { GITHUB_ACTIONS: "true" } }),
    ]) {
      assert.ok(!output.includes(secretValue));
    }
  }
});

test("placeholders do not trigger secret findings", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": ruleFile(
      "id: overview\ntitle: Overview\ntargets: all",
      "# Overview\n\nSet ANTHROPIC_API_KEY=YOUR_API_KEY and use Bearer <token>.",
    ),
  });
  t.after(() => fixture.cleanup());
  const result = await auditContext({ rootDir: fixture.root, now });
  assert.equal(result.severity, "ok");
});

test("ignorePatterns suppress values, lines and whole paths", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": ruleFile(
      "id: overview\ntitle: Overview\ntargets: all",
      `# Overview\n\nFixture token ${GITHUB_TOKEN}`,
    ),
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
    ignorePatterns: ["Fixture token"],
  });
  assert.equal(byLine.severity, "ok");
  const byPath = await auditContext({
    rootDir: fixture.root,
    now,
    ignorePatterns: ["^\\.ai/overview\\.md$"],
  });
  assert.equal(byPath.issues.filter((entry) => entry.category === "secret").length, 0);

  await assert.rejects(
    auditContext({ rootDir: fixture.root, ignorePatterns: ["("] }),
    /invalid regular expression/,
  );
});

test("check mode flags missing and outdated generated files as critical", async (t) => {
  const fixture = await createFixture({ ".ai/overview.md": overview });
  t.after(() => fixture.cleanup());

  const missing = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(missing.severity, "critical");
  assert.ok(missing.issues.some((issue) => issue.category === "stale-output"));
  // Plain audit mode does not verify files on disk.
  assert.equal((await auditContext({ rootDir: fixture.root, now })).severity, "ok");

  await syncProject({ rootDir: fixture.root });
  await fixture.write(
    ".ai/overview.md",
    ruleFile(
      "id: overview\ntitle: Overview\ntargets: all",
      "# Overview\n\nChanged after the last build.",
    ),
  );
  const stale = await auditContext({ rootDir: fixture.root, mode: "check", now });
  assert.equal(stale.severity, "critical");
  assert.ok(stale.issues.some((issue) => issue.path === "CLAUDE.md"));
});

test("token budget, empty and duplicate rules are warnings", async (t) => {
  const body = "# A\n\n" + "A sentence that costs tokens. ".repeat(60);
  const fixture = await createFixture({
    ".ai/a.md": ruleFile("id: a\ntitle: A\ntargets: all", body),
    ".ai/b.md": ruleFile("id: b\ntitle: B\ntargets: all", body.replace("# A", "# B")),
    ".ai/c.md": ruleFile("id: c\ntitle: C\ntargets: all", "# C\n"),
  });
  t.after(() => fixture.cleanup());

  const result = await auditContext({ rootDir: fixture.root, maxTokens: 100, now });
  assert.equal(result.severity, "warning");
  const categories = new Set(result.issues.map((issue) => issue.category));
  assert.ok(categories.has("token-budget"));
  assert.ok(categories.has("duplicate-block"));
  assert.ok(categories.has("empty-block"));
  assert.ok(result.issues.every((issue) => issue.severity === "warning"));

  const unlimited = await auditContext({ rootDir: fixture.root, maxTokens: 0, now });
  assert.ok(!unlimited.issues.some((issue) => issue.category === "token-budget"));
});

test("reporter: --json is clean, GitHub annotations, ANSI toggle", async (t) => {
  const fixture = await createFixture({
    ".ai/overview.md": ruleFile(
      "id: overview\ntitle: Overview\ntargets: all",
      `# Overview\n\nKey ${GITHUB_TOKEN}`,
    ),
    ".ai/empty.md": ruleFile("id: empty\ntitle: Empty\ntargets: all", "# Empty\n"),
  });
  t.after(() => fixture.cleanup());
  const result = await auditContext({ rootDir: fixture.root, now });

  const json = formatReport(result, { json: true, color: true, env: { GITHUB_ACTIONS: "true" } });
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(result)));
  assert.ok(!json.includes("\u001B"));
  assert.ok(!json.includes("::error"));

  const github = formatReport(result, { env: { GITHUB_ACTIONS: "true" } });
  assert.match(github, /^::error title=ctx-sync secret,file=\.ai\/overview\.md,line=\d+,col=\d+::/m);
  assert.match(github, /^::warning title=ctx-sync empty-block,file=\.ai\/empty\.md/m);
  assert.ok(!github.includes("\u001B"));

  const local = formatReport(result, { env: {} });
  assert.ok(!local.includes("::error"));
  assert.match(local, /Tokens by assistant/);
  for (const label of result.assistants.map((assistant) => assistant.label)) {
    assert.ok(local.includes(label));
  }
  assert.match(formatReport(result, { color: true, env: {} }), /\u001B\[31m/);

  assert.equal(wantsJson(["--json"]), true);
  assert.equal(wantsJson(["--quiet"]), false);
  assert.equal(isGithubActions({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(isGithubActions({ GITHUB_ACTIONS: "false" }), false);
});
