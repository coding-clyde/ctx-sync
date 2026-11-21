#!/usr/bin/env node
/**
 * ctx-sync entry point and public API.
 *
 * Run as a program (`ctx-sync sync|check|init`) this file orchestrates the
 * whole pipeline:
 *
 *   init   create a starter `.ai/`
 *   sync   audit `.ai/` (secrets, tokens), then write CLAUDE.md and the other
 *          target files; nothing is written if the audit finds critical issues
 *   check  read-only: fail if a generated file is out of sync or a secret is
 *          exposed
 *
 * Imported as a library it only exposes the API re-exported at the bottom;
 * nothing runs on import.
 *
 * Exit codes: 0 correct | 1 critical findings (or warnings with --strict) |
 * 2 usage, configuration or file error | 3 unexpected internal error.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatReport,
  formatSyncChanges,
  shouldUseColor,
} from "./auditor/reporter.js";
import { auditContext } from "./auditor/contextAuditor.js";
import {
  type CommandOptions,
  helpText,
  parseCli,
  versionText,
} from "./cli.js";
import { CtxSyncError } from "./errors.js";
import { initProject } from "./init.js";
import { syncProject } from "./sync.js";
import type { ContextAuditResult, Severity } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/** Everything the CLI touches outside the repository, injectable for tests. */
export interface RunEnvironment {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
}

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function processEnvironment(): RunEnvironment {
  return {
    cwd: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    stdout: (text) => void process.stdout.write(line(text)),
    stderr: (text) => void process.stderr.write(line(text)),
  };
}

/* -------------------------------------------------------------------------- */
/* Exit codes                                                                 */
/* -------------------------------------------------------------------------- */

/** 1 on critical findings, or on warnings too when `strict`; otherwise 0. */
export function exitCodeFor(severity: Severity, strict: boolean): number {
  if (severity === "critical") {
    return 1;
  }
  return severity === "warning" && strict ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

async function runInit(
  options: CommandOptions,
  io: RunEnvironment,
): Promise<number> {
  const result = await initProject({ rootDir: io.cwd });
  if (options.json) {
    io.stdout(JSON.stringify({ command: "init", ...result }, null, 2));
    return 0;
  }
  io.stdout(
    [
      `Created ${result.sourceDir}/ with ${result.created.length} starter files:`,
      ...result.created.map((file) => `  ${file}`),
      "",
      "Edit them to describe your project, then run `ctx-sync sync`.",
    ].join("\n"),
  );
  return 0;
}

async function runSync(
  options: CommandOptions,
  io: RunEnvironment,
): Promise<number> {
  const color = shouldUseColor(io.env, io.isTTY);
  const shared = {
    rootDir: io.cwd,
    profiles: options.targets,
    maxTokens: options.maxTokens,
  };

  // Audit first so that a leaked secret is never copied into every target file.
  const audit = await auditContext({ ...shared, mode: "audit" });
  const blocked = audit.severity === "critical";

  let changes: Awaited<ReturnType<typeof syncProject>>["changes"] = [];
  if (!blocked) {
    const summary = await syncProject({ ...shared, force: options.force });
    for (const diagnostic of summary.diagnostics) {
      if (!diagnostic.code.startsWith("build.")) {
        continue; // Source diagnostics are already part of the audit.
      }
      const where = diagnostic.path === undefined ? "" : ` ${diagnostic.path}:`;
      io.stderr(`${diagnostic.severity}:${where} ${diagnostic.message}`);
    }
    if (!summary.valid) {
      return 2; // e.g. an existing CLAUDE.md that ctx-sync did not generate.
    }
    changes = summary.changes;
  }

  if (options.json) {
    const document: ContextAuditResult & {
      sync: { wrote: boolean; changes: typeof changes };
    } = { ...audit, sync: { wrote: !blocked, changes } };
    io.stdout(JSON.stringify(document, null, 2));
  } else {
    const parts = blocked ? [] : [formatSyncChanges(changes, color), ""];
    parts.push(formatReport(audit, { color, env: io.env }));
    if (blocked) {
      parts.push(
        "",
        "No files were written: fix the critical issues above and run `ctx-sync sync` again.",
      );
    }
    io.stdout(parts.join("\n"));
  }

  return exitCodeFor(audit.severity, options.strict);
}

async function runCheck(
  options: CommandOptions,
  io: RunEnvironment,
): Promise<number> {
  const result = await auditContext({
    rootDir: io.cwd,
    profiles: options.targets,
    maxTokens: options.maxTokens,
    mode: "check",
  });
  io.stdout(
    formatReport(result, {
      json: options.json,
      color: shouldUseColor(io.env, io.isTTY),
      env: io.env,
    }),
  );
  return exitCodeFor(result.severity, options.strict);
}

/**
 * Run the CLI for `argv` (without the node and script entries) and return the
 * exit code. Expected failures throw {@link CtxSyncError}; see {@link main}
 * for how they are reported.
 */
export async function run(
  argv: readonly string[],
  io: RunEnvironment = processEnvironment(),
): Promise<number> {
  const invocation = parseCli(argv);
  switch (invocation.kind) {
    case "version":
      io.stdout(versionText());
      return 0;
    case "help":
      io.stdout(
        invocation.command === undefined
          ? helpText()
          : helpText(invocation.command),
      );
      return 0;
    case "run":
      switch (invocation.command) {
        case "init":
          return runInit(invocation, io);
        case "sync":
          return runSync(invocation, io);
        case "check":
          return runCheck(invocation, io);
      }
  }
}

/* -------------------------------------------------------------------------- */
/* Error reporting                                                            */
/* -------------------------------------------------------------------------- */

function describePath(error: NodeJS.ErrnoException): string {
  if (typeof error.path !== "string") {
    return "";
  }
  const relative = path.relative(process.cwd(), error.path);
  const shown =
    relative.length > 0 && !relative.startsWith("..") ? relative : error.path;
  return `: ${shown}`;
}

/** A readable one-line message for common filesystem errors, else undefined. */
function fileSystemMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const errno = error as NodeJS.ErrnoException;
  switch (errno.code) {
    case "ENOENT":
      return `File or directory not found${describePath(errno)}`;
    case "EACCES":
    case "EPERM":
      return `Permission denied${describePath(errno)}`;
    case "EISDIR":
      return `Expected a file but found a directory${describePath(errno)}`;
    case "ENOTDIR":
      return `Expected a directory but found a file${describePath(errno)}`;
    case "ENOSPC":
      return "No space left on the device";
    case "EROFS":
      return `The file system is read-only${describePath(errno)}`;
    default:
      return undefined;
  }
}

/**
 * Entry point used by the executable. Never throws and never prints a stack
 * trace unless `CTX_SYNC_DEBUG` is set.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: RunEnvironment = processEnvironment(),
): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof CtxSyncError) {
      io.stderr(`error: ${error.message}`);
      return error.exitCode;
    }
    const friendly = fileSystemMessage(error);
    if (friendly !== undefined) {
      io.stderr(`error: ${friendly}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: unexpected failure: ${message}`);
    io.stderr("Set CTX_SYNC_DEBUG=1 for a stack trace.");
    if (io.env["CTX_SYNC_DEBUG"] !== undefined && error instanceof Error) {
      io.stderr(error.stack ?? message);
    }
    return 3;
  }
}

function executedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(new URL(import.meta.url));
  } catch {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  }
}

if (executedDirectly()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export { parseCli, helpText, versionText } from "./cli.js";
export type { CliInvocation, CommandName, CommandOptions } from "./cli.js";
export { initProject, INIT_TEMPLATES } from "./init.js";
export type { InitResult } from "./init.js";
export * from "./types.js";
export { VERSION, TOOL_NAME, REPORT_SCHEMA_VERSION } from "./version.js";
export { CtxSyncError, ConfigError, SourceError } from "./errors.js";
export {
  CONFIG_FILENAME,
  DEFAULT_MAX_TOKENS_PER_BLOCK,
  DEFAULT_MAX_TOKENS_PER_PROFILE,
  DEFAULT_SOURCE_DIR,
  loadConfig,
} from "./config.js";
export { parseFrontmatter } from "./readers/frontmatter.js";
export type {
  FrontmatterIssue,
  FrontmatterParseResult,
} from "./readers/frontmatter.js";
export { parseRuleFile, slugifyId } from "./readers/markdown.js";
export type {
  ParseRuleFileOptions,
  ParseRuleFileResult,
} from "./readers/markdown.js";
export { readSourceTree } from "./readers/source.js";
export { readSourceDirectory } from "./readers/sourceReader.js";
export type { ReadSourceOptions } from "./readers/sourceReader.js";
export { readProjectContext } from "./readers/index.js";
export type {
  DetectedContextFile,
  ExistingContextKind,
  ProjectReaderContext,
  ProjectReaderOptions,
} from "./readers/index.js";
export {
  ADAPTERS,
  getAdapter,
  isTargetProfile,
  listProfiles,
  renderAllProfiles,
  renderProfile,
} from "./adapters/index.js";
export { createSingleFileAdapter } from "./adapters/shared.js";
export { claudeAdapter } from "./adapters/claudeAdapter.js";
export { copilotAdapter } from "./adapters/copilotAdapter.js";
export { cursorAdapter } from "./adapters/cursorAdapter.js";
export { windsurfAdapter } from "./adapters/windsurfAdapter.js";
export { planBuild, syncProject } from "./sync.js";
export { auditProject, measureBlocks } from "./auditor/index.js";
export {
  TOKEN_ESTIMATOR_METHOD,
  combineMetrics,
  countCharacters,
  countLines,
  estimateBlockTokens,
  estimateFileTokens,
  estimateSourceTokens,
  estimateTokens,
  measureText,
  tokenStatus,
} from "./readers/tokenEstimator.js";
export type {
  BlockTokenEstimate,
  FileTokenEstimate,
  SourceTokenEstimate,
  TokenEstimatorMethod,
} from "./readers/tokenEstimator.js";
export {
  DEFAULT_CONTEXT_MAX_TOKENS,
  auditContext,
} from "./auditor/contextAuditor.js";
export {
  formatAnnotations,
  formatJson,
  formatReport,
  formatSyncChanges,
  formatTerminal,
  isGithubActions,
  shouldUseColor,
  wantsJson,
} from "./auditor/reporter.js";
export type { ReportOptions } from "./auditor/reporter.js";
export { SECRET_PATTERNS, scanSecrets } from "./auditor/secrets.js";
