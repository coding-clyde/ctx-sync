import type {
  ContextAuditResult,
  ContextIssue,
  FileChange,
  Severity,
} from "../types.js";
import { formatNumber, padEnd, padStart, plural } from "../utils/format.js";
import { formatGithubAnnotation } from "../utils/github.js";
import { TOOL_NAME, VERSION } from "../version.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface ReportOptions {
  /** Emit only the JSON document (no ANSI, no annotations). */
  json?: boolean;
  /** Use ANSI colors. Defaults to false; see {@link shouldUseColor}. */
  color?: boolean;
  /** Environment used to detect GitHub Actions. Defaults to `process.env`. */
  env?: Env;
}

/** True when `--json` is present in the argument list. */
export function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

/** True when running inside GitHub Actions (`GITHUB_ACTIONS=true`). */
export function isGithubActions(env: Env = process.env): boolean {
  return env["GITHUB_ACTIONS"] === "true";
}

/** Honors NO_COLOR and FORCE_COLOR, otherwise requires a TTY. */
export function shouldUseColor(
  env: Env = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") {
    return false;
  }
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") {
    return true;
  }
  return isTTY;
}

function ansi(enabled: boolean, code: string) {
  return (value: string): string =>
    enabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}

function paintFor(
  severity: Severity,
  c: { red(v: string): string; yellow(v: string): string; green(v: string): string },
): (value: string) => string {
  return severity === "critical" ? c.red : severity === "warning" ? c.yellow : c.green;
}

/** Clean, machine-readable JSON. Contains no secret values. */
export function formatJson(result: ContextAuditResult): string {
  return JSON.stringify(result, null, 2);
}

/** One `::error::`/`::warning::` workflow command per issue. */
export function formatAnnotations(result: ContextAuditResult): string[] {
  return result.issues.map((issue: ContextIssue) =>
    formatGithubAnnotation({
      kind: issue.severity === "critical" ? "error" : "warning",
      title: `${TOOL_NAME} ${issue.category}`,
      message: issue.message,
      ...(issue.path === undefined ? {} : { file: issue.path }),
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.column === undefined ? {} : { column: issue.column }),
    }),
  );
}

/** Human-readable terminal report using native ANSI escape codes. */
export function formatTerminal(
  result: ContextAuditResult,
  color = false,
): string {
  const c = {
    bold: ansi(color, "1"),
    dim: ansi(color, "2"),
    red: ansi(color, "31"),
    yellow: ansi(color, "33"),
    green: ansi(color, "32"),
  };
  const lines: string[] = [];

  lines.push(c.bold(`${TOOL_NAME} audit v${VERSION}`) + c.dim(` (${result.mode} mode)`));
  lines.push(
    c.dim(
      `${formatNumber(result.totalTokens)} estimated tokens in total | budget ${
        result.maxTokens === 0 ? "off" : formatNumber(result.maxTokens)
      } | ${result.filesScanned} ${plural(result.filesScanned, "file")} scanned`,
    ),
  );

  lines.push("", c.bold("Tokens by assistant"));
  if (result.assistants.length === 0) {
    lines.push("  No assistants enabled.");
  }
  for (const assistant of result.assistants) {
    const over = result.maxTokens > 0 && assistant.estimatedTokens > result.maxTokens;
    const tokens = padStart(formatNumber(assistant.estimatedTokens), 7);
    const share =
      result.maxTokens > 0
        ? `${padStart(String(Math.round((assistant.estimatedTokens / result.maxTokens) * 100)), 4)}%`
        : "";
    const location =
      assistant.paths.length <= 1
        ? (assistant.paths[0] ?? "(no files)")
        : `${assistant.paths[0]} +${assistant.paths.length - 1}`;
    lines.push(
      `  ${padEnd(assistant.label, 18)} ${(over ? c.yellow : c.green)(tokens)} ${c.dim(share)}  ${c.dim(
        `${location} (${assistant.blocks} ${plural(assistant.blocks, "rule")})`,
      )}`,
    );
  }

  if (result.issues.length > 0) {
    lines.push("", c.bold("Issues"));
    for (const issue of result.issues) {
      const where =
        issue.path === undefined
          ? ""
          : ` ${c.dim(`${issue.path}${issue.line === undefined ? "" : `:${issue.line}`}`)}`;
      lines.push(
        `  ${paintFor(issue.severity, c)(padEnd(issue.severity.toUpperCase(), 8))} ${issue.message}${where}`,
      );
    }
  }

  const critical = result.issues.filter((issue) => issue.severity === "critical").length;
  const warnings = result.issues.length - critical;
  lines.push(
    "",
    `${c.bold("Result")} ${paintFor(result.severity, c)(result.severity.toUpperCase())} ${c.dim(
      `- ${critical} critical, ${warnings} ${plural(warnings, "warning")}`,
    )}`,
  );
  return lines.join("\n");
}

/**
 * Format an audit for the current environment.
 *  - `json: true` -> only valid JSON.
 *  - otherwise the terminal report, preceded by GitHub Actions annotations when
 *    `GITHUB_ACTIONS=true`.
 */
export function formatReport(
  result: ContextAuditResult,
  options: ReportOptions = {},
): string {
  if (options.json === true) {
    return formatJson(result);
  }
  const env = options.env ?? process.env;
  const parts: string[] = [];
  if (isGithubActions(env)) {
    parts.push(...formatAnnotations(result));
  }
  parts.push(formatTerminal(result, options.color ?? false));
  return parts.join("\n");
}

/** Human-readable list of what `sync` wrote, one line per file. */
export function formatSyncChanges(
  changes: readonly FileChange[],
  color = false,
): string {
  const c = {
    bold: ansi(color, "1"),
    dim: ansi(color, "2"),
    red: ansi(color, "31"),
    yellow: ansi(color, "33"),
    green: ansi(color, "32"),
  };
  const lines: string[] = [c.bold(`${TOOL_NAME} sync v${VERSION}`), ""];

  const paint: Record<FileChange["status"], (value: string) => string> = {
    created: c.green,
    updated: c.yellow,
    removed: c.red,
    blocked: c.red,
    unchanged: c.dim,
  };
  for (const change of changes) {
    lines.push(
      `  ${paint[change.status](padEnd(change.status, 9))} ${change.path} ${c.dim(
        `(${formatNumber(change.estimatedTokens)} est. tokens)`,
      )}`,
    );
  }

  const count = (status: FileChange["status"]): number =>
    changes.filter((change) => change.status === status).length;
  const wrote = count("created") + count("updated");
  const removed = count("removed");
  lines.push("");
  lines.push(
    wrote + removed === 0
      ? c.green("All generated files were already up to date.")
      : c.green(
          `Wrote ${wrote} ${plural(wrote, "file")}, removed ${removed}; ${count(
            "unchanged",
          )} unchanged.`,
        ),
  );
  return lines.join("\n");
}
