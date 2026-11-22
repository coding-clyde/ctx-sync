import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";

import { listProfiles } from "../src/adapters/index.js";
import { helpText, parseCli } from "../src/cli.js";
import { exitCodeFor, run, type RunEnvironment } from "../src/index.js";
import { INIT_TEMPLATES } from "../src/init.js";
import { VERSION } from "../src/version.js";
import { createFixture, ruleFile, runCli } from "./helpers.js";

const GITHUB_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const NATIVE_FILES = [
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".windsurfrules",
  ".cursor/rules/project.mdc",
];

function basicFixture(extra: Record<string, string | object> = {}) {
  return createFixture({
    ".ai/rule.md": ruleFile(
      "id: rule\ntitle: Rule",
      "# Rule\n\nKeep it short and deterministic.",
    ),
    ...extra,
  });
}

function leakFixture() {
  return createFixture({
    ".ai/leak.md": ruleFile(
      "id: leak\ntitle: Leak",
      `# Leak\n\nUse this token: ${GITHUB_TOKEN}`,
    ),
  });
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

test("parseCli: subcommands and flags", () => {
  assert.deepEqual(parseCli(["--version"]), { kind: "version" });
  assert.deepEqual(parseCli(["-v"]), { kind: "version" });
  assert.deepEqual(parseCli([]), { kind: "help" });
  assert.deepEqual(parseCli(["--help"]), { kind: "help" });
  assert.deepEqual(parseCli(["-h"]), { kind: "help" });
  assert.deepEqual(parseCli(["sync", "--help"]), { kind: "help", command: "sync" });
  assert.deepEqual(parseCli(["help", "check"]), { kind: "help", command: "check" });

  assert.deepEqual(parseCli(["check"]), {
    kind: "run",
    command: "check",
    strict: false,
    json: false,
    force: false,
  });

  assert.deepEqual(
    parseCli(["sync", "--targets", "claude, cursor", "--targets", "claude,copilot",
      "--max-tokens", "1500", "--strict", "--json", "--force"]),
    {
      kind: "run",
      command: "sync",
      targets: ["claude", "cursor", "copilot"],
      maxTokens: 1500,
      strict: true,
      json: true,
      force: true,
    },
  );
  assert.equal(
    (parseCli(["check", "--max-tokens=0"]) as { maxTokens?: number }).maxTokens,
    0,
  );
  assert.deepEqual(parseCli(["init"]), {
    kind: "run",
    command: "init",
    strict: false,
    json: false,
    force: false,
  });
});

test("parseCli: --version wins over a command", () => {
  assert.deepEqual(parseCli(["sync", "--version"]), { kind: "version" });
});

test("parseCli: rejects invalid input with exit code 2", () => {
  const cases: Array<[string[], RegExp]> = [
    [["deploy"], /Unknown command "deploy"/],
    [["sync", "--nope"], /nope/],
    [["sync", "--targets", "vscode"], /Unknown target "vscode"/],
    [["sync", "--targets", ","], /at least one target/],
    [["sync", "--max-tokens", "lots"], /--max-tokens must be a non-negative integer/],
    [["sync", "--max-tokens", "1.5"], /--max-tokens must be a non-negative integer/],
    [["sync", "--max-tokens"], /max-tokens/],
    [["check", "--force"], /--force is not valid for `ctx-syncr check`/],
    [["init", "--strict"], /--strict is not valid for `ctx-syncr init`/],
    [["init", "--targets", "claude"], /--targets is not valid/],
    [["sync", "extra"], /Unexpected argument "extra"/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(
      () => parseCli(argv),
      (error: unknown) =>
        error instanceof Error &&
        (error as { exitCode?: number }).exitCode === 2 &&
        pattern.test(error.message),
      `argv: ${argv.join(" ")}`,
    );
  }
});

test("exitCodeFor: critical always fails, warning only with --strict", () => {
  assert.equal(exitCodeFor("ok", true), 0);
  assert.equal(exitCodeFor("warning", false), 0);
  assert.equal(exitCodeFor("warning", true), 1);
  assert.equal(exitCodeFor("critical", false), 1);
  assert.equal(exitCodeFor("critical", true), 1);
});

/* -------------------------------------------------------------------------- */
/* Help and version                                                           */
/* -------------------------------------------------------------------------- */

test("prints help and version", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  const help = await runCli(["--help"], fixture.root);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /ctx-syncr init/);
  assert.match(help.stdout, /ctx-syncr sync/);
  assert.match(help.stdout, /ctx-syncr check/);
  for (const profile of listProfiles()) {
    assert.ok(help.stdout.includes(profile), `help lists ${profile}`);
  }

  const none = await runCli([], fixture.root);
  assert.equal(none.code, 0);
  assert.equal(none.stdout, help.stdout);

  const sync = await runCli(["sync", "--help"], fixture.root);
  assert.equal(sync.code, 0);
  for (const flag of ["--targets", "--max-tokens", "--strict", "--json", "--force"]) {
    assert.ok(sync.stdout.includes(flag), `sync help lists ${flag}`);
  }
  assert.equal(sync.stdout.trimEnd(), helpText("sync"));

  const version = await runCli(["--version"], fixture.root);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), `ctx-syncr ${VERSION}`);
});

/* -------------------------------------------------------------------------- */
/* init                                                                       */
/* -------------------------------------------------------------------------- */

test("init creates a ready-to-use .ai/ that syncs and checks cleanly", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  const init = await runCli(["init"], fixture.root);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /Created \.ai\/ with 4 starter files/);
  for (const template of INIT_TEMPLATES) {
    assert.equal(await fixture.exists(`.ai/${template.path}`), true, template.path);
  }

  // Strict: the templates must not even produce warnings.
  const sync = await runCli(["sync", "--strict"], fixture.root);
  assert.equal(sync.code, 0, sync.stdout + sync.stderr);
  for (const file of NATIVE_FILES) {
    assert.equal(await fixture.exists(file), true, file);
  }
  const claude = await fixture.read("CLAUDE.md");
  assert.match(claude, /Project overview/);

  const check = await runCli(["check", "--strict"], fixture.root);
  assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("init refuses to overwrite an existing .ai/ and never touches it", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());
  const before = await fixture.read(".ai/rule.md");

  const result = await runCli(["init"], fixture.root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(result.stdout, "");
  assert.equal(await fixture.read(".ai/rule.md"), before);
  assert.equal(await fixture.exists(".ai/00-overview.md"), false);
});

test("init accepts an empty .ai/ directory and supports --json", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  await mkdir(fixture.absolute(".ai"));

  const result = await runCli(["init", "--json"], fixture.root);
  assert.equal(result.code, 0, result.stderr);
  const document = JSON.parse(result.stdout) as { command: string; created: string[] };
  assert.equal(document.command, "init");
  assert.equal(document.created.length, INIT_TEMPLATES.length);
  assert.ok(document.created.includes(".ai/00-overview.md"));
});

test("init fails clearly when .ai is a file", async (t) => {
  const fixture = await createFixture({ ".ai": "not a directory" });
  t.after(() => fixture.cleanup());

  const result = await runCli(["init"], fixture.root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /exists but is not a directory/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

/* -------------------------------------------------------------------------- */
/* sync                                                                       */
/* -------------------------------------------------------------------------- */

test("sync writes every target and is idempotent", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const first = await runCli(["sync"], fixture.root);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /created\s+CLAUDE\.md/);
  assert.match(first.stdout, /Result OK/);
  for (const file of NATIVE_FILES) {
    assert.equal(await fixture.exists(file), true, file);
  }

  const second = await runCli(["sync"], fixture.root);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already up to date/);
  assert.doesNotMatch(second.stdout, /created|updated/);
});

test("sync --targets limits what is written", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["sync", "--targets", "claude"], fixture.root);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fixture.exists("CLAUDE.md"), true);
  assert.equal(await fixture.exists(".windsurfrules"), false);
  assert.equal(await fixture.exists(".github/copilot-instructions.md"), false);
});

test("sync --json emits one parseable document without ANSI", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["sync", "--json"], fixture.root, {
    FORCE_COLOR: "1",
    NO_COLOR: "",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\u001B\[/);
  const document = JSON.parse(result.stdout) as {
    mode: string;
    severity: string;
    sync: { wrote: boolean; changes: Array<{ path: string; status: string }> };
    assistants: Array<{ profile: string }>;
  };
  assert.equal(document.mode, "audit");
  assert.equal(document.severity, "ok");
  assert.equal(document.sync.wrote, true);
  assert.ok(
    document.sync.changes.some(
      (change) => change.path === "CLAUDE.md" && change.status === "created",
    ),
  );
  assert.deepEqual(
    document.assistants.map((assistant) => assistant.profile),
    listProfiles(),
  );
});

test("sync refuses to write when a secret is found, and never prints it", async (t) => {
  const fixture = await leakFixture();
  t.after(() => fixture.cleanup());

  for (const args of [["sync"], ["sync", "--json"]]) {
    const result = await runCli(args, fixture.root);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal((result.stdout + result.stderr).includes(GITHUB_TOKEN), false);
    for (const file of NATIVE_FILES) {
      assert.equal(await fixture.exists(file), false, `${file} must not exist`);
    }
  }

  const human = await runCli(["sync"], fixture.root);
  assert.match(human.stdout, /CRITICAL/);
  assert.match(human.stdout, /No files were written/);

  const json = JSON.parse((await runCli(["sync", "--json"], fixture.root)).stdout) as {
    severity: string;
    sync: { wrote: boolean };
  };
  assert.equal(json.severity, "critical");
  assert.equal(json.sync.wrote, false);
});

test("sync does not overwrite an unmanaged target unless --force", async (t) => {
  const fixture = await basicFixture({ "CLAUDE.md": "# Mine\n" });
  t.after(() => fixture.cleanup());

  const refused = await runCli(["sync"], fixture.root);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Refusing to overwrite unmanaged file "CLAUDE\.md"/);
  assert.equal(await fixture.read("CLAUDE.md"), "# Mine\n");
  assert.equal(await fixture.exists(".windsurfrules"), false);

  const forced = await runCli(["sync", "--force"], fixture.root);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(await fixture.read("CLAUDE.md"), /ctx-syncr:generated/);
});

/* -------------------------------------------------------------------------- */
/* check                                                                      */
/* -------------------------------------------------------------------------- */

test("check passes when in sync and fails (exit 1) on drift", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const missing = await runCli(["check"], fixture.root);
  assert.equal(missing.code, 1, missing.stdout);
  assert.match(missing.stdout, /CLAUDE\.md is missing/);
  assert.equal(await fixture.exists("CLAUDE.md"), false, "check never writes");

  await runCli(["sync"], fixture.root);
  const clean = await runCli(["check"], fixture.root);
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /Result OK/);

  await fixture.write("CLAUDE.md", `${await fixture.read("CLAUDE.md")}\nedited\n`);
  const stale = await runCli(["check"], fixture.root);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /CLAUDE\.md is out of date/);
  assert.match(stale.stdout, /ctx-syncr sync/);

  const afterCheck = await fixture.read("CLAUDE.md");
  assert.match(afterCheck, /edited/, "check must not repair the file");
});

test("check fails on exposed secrets without printing them", async (t) => {
  const fixture = await leakFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["check"], fixture.root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CRITICAL/);
  assert.equal(result.stdout.includes(GITHUB_TOKEN), false);
});

test("check --json is clean JSON", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());
  await runCli(["sync"], fixture.root);

  const result = await runCli(["check", "--json"], fixture.root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { mode: string; severity: string; issues: unknown[] };
  assert.equal(report.mode, "check");
  assert.equal(report.severity, "ok");
  assert.deepEqual(report.issues, []);
});

test("check emits GitHub annotations inside GitHub Actions", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const result = await runCli(["check"], fixture.root, { GITHUB_ACTIONS: "true" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^::error .*file=CLAUDE\.md/m);
});

test("--strict turns warnings into failures; --max-tokens sets the budget", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());
  await runCli(["sync"], fixture.root);

  const lenient = await runCli(["check", "--max-tokens", "5"], fixture.root);
  assert.equal(lenient.code, 0, lenient.stdout);
  assert.match(lenient.stdout, /WARNING/);
  assert.match(lenient.stdout, /over the 5-token budget/);

  const strict = await runCli(["check", "--max-tokens", "5", "--strict"], fixture.root);
  assert.equal(strict.code, 1);

  const off = await runCli(["check", "--max-tokens", "0", "--strict"], fixture.root);
  assert.equal(off.code, 0, off.stdout);

  const syncStrict = await runCli(["sync", "--max-tokens", "5", "--strict"], fixture.root);
  assert.equal(syncStrict.code, 1);
});

/* -------------------------------------------------------------------------- */
/* Errors: clear messages, no stack traces                                    */
/* -------------------------------------------------------------------------- */

test("a missing .ai/ is a clear exit-2 error without a stack trace", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());

  for (const command of ["sync", "check"]) {
    const result = await runCli([command], fixture.root);
    assert.equal(result.code, 2, command);
    assert.match(result.stderr, /^error: Source directory not found: \.ai/);
    assert.match(result.stderr, /ctx-syncr init/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(result.stdout, "");
  }
});

test("usage errors exit 2 with a one-line message", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  const unknown = await runCli(["deploy"], fixture.root);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^error: Unknown command "deploy"/);

  const target = await runCli(["sync", "--targets", "vscode"], fixture.root);
  assert.equal(target.code, 2);
  assert.match(target.stderr, /Unknown target "vscode"/);
  assert.equal(await fixture.exists("CLAUDE.md"), false);

  const flag = await runCli(["check", "--nope"], fixture.root);
  assert.equal(flag.code, 2);
  assert.doesNotMatch(flag.stderr, /\n\s+at /);
});

test("an invalid config file is reported without a stack trace", async (t) => {
  const fixture = await basicFixture({ "ctx-syncr.config.json": "{ not json" });
  t.after(() => fixture.cleanup());

  const result = await runCli(["check"], fixture.root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ctx-syncr\.config\.json is not valid JSON/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

/* -------------------------------------------------------------------------- */
/* In-process API                                                             */
/* -------------------------------------------------------------------------- */

test("run() works in-process with an injected environment", async (t) => {
  const fixture = await basicFixture();
  t.after(() => fixture.cleanup());

  let stdout = "";
  const io: RunEnvironment = {
    cwd: fixture.root,
    env: {},
    isTTY: false,
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  };
  assert.equal(await run(["sync", "--targets", "claude"], io), 0);
  assert.equal(await run(["check", "--targets", "claude"], io), 0);
  assert.match(stdout, /Result OK/);
  assert.equal(await run(["--version"], io), 0);
});
