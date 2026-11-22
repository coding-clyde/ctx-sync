/**
 * Command-line parsing for ctx-syncr.
 *
 * This module is pure: it turns `argv` into a typed {@link CliInvocation} (or
 * throws a {@link CtxSyncError} with exit code 2) and renders help text. It
 * does no I/O. Running the command is `src/index.ts`'s job.
 */
import { parseArgs } from "node:util";

import { isTargetProfile, listProfiles } from "./adapters/index.js";
import { CtxSyncError } from "./errors.js";
import type { TargetProfile } from "./types.js";
import { TOOL_NAME, VERSION } from "./version.js";

export const COMMANDS = ["sync", "check", "init"] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CommandOptions {
  /** Restrict to these assistants. `undefined` means "whatever the config enables". */
  targets?: TargetProfile[];
  /** Token budget. `undefined` means the auditor default; 0 disables it. */
  maxTokens?: number;
  /** Treat warnings as failures. */
  strict: boolean;
  /** Print one machine-readable JSON document on stdout. */
  json: boolean;
  /** `sync` only: overwrite target files that ctx-syncr did not generate. */
  force: boolean;
}

export type CliInvocation =
  | { kind: "help"; command?: CommandName }
  | { kind: "version" }
  | ({ kind: "run"; command: CommandName } & CommandOptions);

/** Options each subcommand accepts. `--help` and `--version` are always allowed. */
const ALLOWED_OPTIONS: Record<CommandName, readonly string[]> = {
  sync: ["targets", "max-tokens", "strict", "json", "force"],
  check: ["targets", "max-tokens", "strict", "json"],
  init: ["json"],
};

function usageError(message: string): CtxSyncError {
  return new CtxSyncError(message, { code: "cli.usage", exitCode: 2 });
}

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

function parseTargets(raw: readonly string[]): TargetProfile[] {
  const profiles: TargetProfile[] = [];
  for (const entry of raw.flatMap((value) => value.split(","))) {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) {
      continue;
    }
    if (!isTargetProfile(candidate)) {
      throw usageError(
        `Unknown target "${entry.trim()}". Choose from: ${listProfiles().join(", ")}.`,
      );
    }
    if (!profiles.includes(candidate)) {
      profiles.push(candidate);
    }
  }
  if (profiles.length === 0) {
    throw usageError(
      `--targets needs at least one target. Choose from: ${listProfiles().join(", ")}.`,
    );
  }
  return profiles;
}

function parseMaxTokens(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw usageError(
      `--max-tokens must be a non-negative integer (0 disables the limit), got "${raw}".`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw usageError("--max-tokens is too large.");
  }
  return value;
}

/** Parse `process.argv.slice(2)`. Throws a usage error (exit code 2) on bad input. */
export function parseCli(argv: readonly string[]): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        targets: { type: "string", multiple: true },
        "max-tokens": { type: "string" },
        strict: { type: "boolean" },
        json: { type: "boolean" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw usageError(
      `${(error as Error).message.split("\n")[0] ?? "Invalid arguments."} ` +
        `Run \`${TOOL_NAME} --help\` for usage.`,
    );
  }

  const { values, positionals } = parsed;
  const [first, ...extra] = positionals;

  let command: CommandName | undefined;
  if (first !== undefined && first !== "help") {
    if (!isCommand(first)) {
      throw usageError(
        `Unknown command "${first}". Expected one of: ${COMMANDS.join(", ")}. ` +
          `Run \`${TOOL_NAME} --help\` for usage.`,
      );
    }
    command = first;
  }

  if (values.version === true) {
    return { kind: "version" };
  }
  if (values.help === true || first === "help") {
    // `ctx-syncr help sync` is the same as `ctx-syncr sync --help`.
    const topic = first === "help" ? extra[0] : command;
    return topic !== undefined && isCommand(topic)
      ? { kind: "help", command: topic }
      : { kind: "help" };
  }
  if (command === undefined) {
    // No subcommand at all: show help rather than guessing.
    return { kind: "help" };
  }
  if (extra.length > 0) {
    throw usageError(
      `Unexpected argument "${extra[0]}". \`${TOOL_NAME} ${command}\` takes only options.`,
    );
  }

  const allowed = ALLOWED_OPTIONS[command];
  for (const name of ["targets", "max-tokens", "strict", "json", "force"] as const) {
    if (values[name] !== undefined && !allowed.includes(name)) {
      throw usageError(
        `--${name} is not valid for \`${TOOL_NAME} ${command}\`. ` +
          `Run \`${TOOL_NAME} ${command} --help\` for its options.`,
      );
    }
  }

  const options: CommandOptions = {
    strict: values.strict === true,
    json: values.json === true,
    force: values.force === true,
  };
  if (values.targets !== undefined) {
    options.targets = parseTargets(values.targets);
  }
  if (values["max-tokens"] !== undefined) {
    options.maxTokens = parseMaxTokens(values["max-tokens"]);
  }
  return { kind: "run", command, ...options };
}

/* -------------------------------------------------------------------------- */
/* Help                                                                       */
/* -------------------------------------------------------------------------- */

const EXIT_CODES = [
  "Exit codes:",
  "  0  everything is correct",
  "  1  critical findings (or warnings too, with --strict)",
  "  2  usage, configuration or file error (nothing was written)",
  "  3  unexpected internal error",
];

export function versionText(): string {
  return `${TOOL_NAME} ${VERSION}`;
}

export function helpText(command?: CommandName): string {
  const targets = listProfiles().join(", ");

  switch (command) {
    case "sync":
      return [
        `${TOOL_NAME} sync - compile .ai/ into the native files of each assistant`,
        "",
        "Usage: ctx-syncr sync [options]",
        "",
        "Audits first, then writes. Nothing is written when the audit finds",
        "critical issues (for example an exposed secret).",
        "",
        "Options:",
        `  --targets <list>     Comma-separated assistants: ${targets}`,
        "  --max-tokens <n>     Token budget per assistant and in total (default 4000, 0 = off)",
        "  --strict             Also exit 1 on warnings",
        "  --force              Overwrite target files not generated by ctx-syncr",
        "  --json               Print one JSON document on stdout",
        "  -h, --help           Show this help",
        "",
        ...EXIT_CODES,
      ].join("\n");
    case "check":
      return [
        `${TOOL_NAME} check - verify generated files are in sync and the context is safe`,
        "",
        "Usage: ctx-syncr check [options]",
        "",
        "Writes nothing. Fails when a generated file is missing or out of date,",
        "or when a secret is exposed. Meant for CI.",
        "",
        "Options:",
        `  --targets <list>     Comma-separated assistants: ${targets}`,
        "  --max-tokens <n>     Token budget per assistant and in total (default 4000, 0 = off)",
        "  --strict             Also exit 1 on warnings",
        "  --json               Print one JSON document on stdout",
        "  -h, --help           Show this help",
        "",
        ...EXIT_CODES,
      ].join("\n");
    case "init":
      return [
        `${TOOL_NAME} init - create a starter .ai/ folder`,
        "",
        "Usage: ctx-syncr init [options]",
        "",
        "Creates .ai/ with ready-to-edit rule templates. Refuses to touch an",
        ".ai/ folder that already has content.",
        "",
        "Options:",
        "  --json               Print the created files as JSON",
        "  -h, --help           Show this help",
        "",
        ...EXIT_CODES,
      ].join("\n");
    default:
      return [
        `${TOOL_NAME} v${VERSION} - one source of truth for AI assistant context`,
        "",
        "Usage:",
        "  ctx-syncr init [options]      Create a starter .ai/ folder",
        "  ctx-syncr sync [options]      Generate CLAUDE.md and the other target files",
        "  ctx-syncr check [options]     Verify files are in sync and context is safe (CI)",
        "",
        "Global options:",
        "  -h, --help                   Show help (also: ctx-syncr <command> --help)",
        "  -v, --version                Show the version",
        "",
        `Assistants: ${targets}`,
        "",
        ...EXIT_CODES,
      ].join("\n");
  }
}
