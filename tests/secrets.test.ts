import assert from "node:assert/strict";
import test from "node:test";

import { scanSecrets } from "../src/auditor/secrets.js";

const AWS_KEY = "AKIAQ7RT5N2K9L4M8P3W";
const GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const OPENAI_KEY = "sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12";

function input(content: string, path = ".ai/rules/security.md") {
  return [{ path, content, origin: "source" as const }];
}

test("detects high-signal secrets across source content", () => {
  const content = [
    "# Deploy notes",
    "",
    `const key = "${AWS_KEY}";`,
    `token: ${GITHUB_TOKEN}`,
    "DATABASE_URL=postgres://admin:s3cr3tPassw0rd@db.internal:5432/prod",
    'password = "hunter2hunter2"',
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEow...",
  ].join("\n");

  const result = scanSecrets(input(content));
  const rules = new Set(result.findings.map((finding) => finding.ruleId));

  assert.equal(result.severity, "critical");
  assert.equal(result.scannedFiles, 1);
  assert.ok(rules.has("aws-access-key"));
  assert.ok(rules.has("github-token"));
  assert.ok(rules.has("connection-string"));
  assert.ok(rules.has("generic-secret-assignment"));
  assert.ok(rules.has("private-key"));

  const aws = result.findings.find((finding) => finding.ruleId === "aws-access-key");
  assert.equal(aws?.line, 3);
  assert.equal(aws?.path, ".ai/rules/security.md");
  assert.equal(aws?.severity, "critical");
});

test("deduplicates a broad detector when a specific one matched the same line", () => {
  const result = scanSecrets(input(`token: ${GITHUB_TOKEN}`));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.ruleId, "github-token");
});

test("never serializes the raw secret or an identifiable preview", () => {
  const result = scanSecrets(
    input([`${GITHUB_TOKEN}`, `password = "hunter2hunter2"`].join("\n")),
  );
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes(GITHUB_TOKEN), false);
  assert.equal(serialized.includes("hunter2hunter2"), false);
  for (const finding of result.findings) {
    assert.match(finding.preview, /^\[redacted \d+ chars\]$/);
    assert.equal(finding.fingerprint.length, 16);
    assert.doesNotMatch(finding.preview, /ghp_|hunter/);
  }
});

test("ignores documentation placeholders", () => {
  const content = [
    "AKIAIOSFODNN7EXAMPLE",
    "github: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "token: YOUR_API_KEY",
    'api_key: "${DB_PASSWORD}"',
    "password: process.env.DB_PASSWORD",
    "postgres://user:password@localhost/app",
    "private_key: <your-private-key>",
    "api_key: abc...",
    "openai: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ].join("\n");

  const result = scanSecrets(input(content));
  assert.deepEqual(result.findings, []);
  assert.equal(result.severity, "ok");
});

test("supports inline ignore markers on the same or previous line", () => {
  const sameLine = scanSecrets(
    input(`${GITHUB_TOKEN} # ctx-sync:allow-secret`),
  );
  assert.equal(sameLine.findings.length, 0);

  const previousLine = scanSecrets(
    input(`<!-- ctx-sync:ignore-secret -->\n${GITHUB_TOKEN}`),
  );
  assert.equal(previousLine.findings.length, 0);
});

test("supports regex allowlists and disabled rules", () => {
  const allowed = scanSecrets(input(`${AWS_KEY}\n${GITHUB_TOKEN}`), {
    allowlist: ["AKIA"],
  });
  assert.deepEqual(
    allowed.findings.map((finding) => finding.ruleId),
    ["github-token"],
  );

  const disabled = scanSecrets(input(`token: ${GITHUB_TOKEN}`), {
    disabledRules: ["github-token"],
  });
  assert.equal(
    disabled.findings.some((finding) => finding.ruleId === "github-token"),
    false,
  );
});

test("computes line and column for findings", () => {
  const content = ["First line", "x = 1", `prefix ${OPENAI_KEY}`].join("\n");
  const findings = scanSecrets(input(content)).findings;
  const openai = findings.find((finding) => finding.ruleId === "openai-key");
  assert.ok(openai);
  assert.equal(openai.line, 3);
  assert.equal(openai.column, 8);
  assert.equal(openai.matchLength, OPENAI_KEY.length);
});

test("scans multiple files and aggregates severity", () => {
  const result = scanSecrets([
    { path: ".ai/a.md", content: "nothing here", origin: "source" },
    {
      path: "CLAUDE.md",
      content: `password: "s3cr3tPassw0rd"`,
      origin: "generated",
    },
  ]);
  assert.equal(result.scannedFiles, 2);
  assert.equal(result.severity, "warning");
  assert.equal(result.findings[0]?.path, "CLAUDE.md");
});
