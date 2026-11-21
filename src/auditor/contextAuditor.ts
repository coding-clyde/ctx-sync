import { createHash } from "node:crypto";

import { getAdapter } from "../adapters/index.js";
import { ConfigError } from "../errors.js";
import { planBuild } from "../sync.js";
import type {
  AssistantTokenUsage,
  ContextAuditOptions,
  ContextAuditResult,
  ContextIssue,
  FileChange,
  RuleBlock,
  SecretScanInput,
  Severity,
} from "../types.js";
import { maxSeverity } from "../types.js";
import { REPORT_SCHEMA_VERSION, TOOL_NAME, VERSION } from "../version.js";
import { scanSecrets } from "./secrets.js";
import { combineMetrics, measureText } from "./tokens.js";

export const DEFAULT_CONTEXT_MAX_TOKENS = 4000;

function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((expression) => {
    try {
      return new RegExp(expression, "i");
    } catch (error) {
      throw new ConfigError(
        `ignorePatterns contains an invalid regular expression "${expression}": ${
          (error as Error).message
        }`,
        "audit.ignore-pattern",
        error,
      );
    }
  });
}

function staleMessage(change: FileChange): string {
  switch (change.status) {
    case "created":
      return `${change.path} is missing; run "ctx-sync build" to generate it from the source.`;
    case "updated":
      return `${change.path} is out of date with the source; run "ctx-sync build".`;
    case "removed":
      return `${change.path} is a stale generated file with no matching rule; run "ctx-sync build" to remove it.`;
    default:
      return `${change.path} cannot be synchronized (it exists but is not managed by ctx-sync); move it aside or run "ctx-sync build --force".`;
  }
}

function bodyKey(block: RuleBlock): string {
  const normalized = block.body.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Evaluate the compiled context and (in "check" mode) its on-disk sync state.
 * Never writes files and never includes secret values in its result.
 *
 * Severity:
 *  - critical: a possible secret/API key is exposed, or (check mode) a
 *    generated file differs from what `.ai/` would produce.
 *  - warning: the token budget is exceeded, or a rule is empty/duplicated.
 *  - ok: none of the above.
 */
export async function auditContext(
  options: ContextAuditOptions,
): Promise<ContextAuditResult> {
  const mode = options.mode ?? "audit";
  const maxTokens = options.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new ConfigError(
      `maxTokens must be a non-negative integer (received ${String(maxTokens)}).`,
      "audit.max-tokens",
    );
  }
  const ignore = compilePatterns(options.ignorePatterns ?? []);
  const isIgnoredPath = (filePath: string): boolean =>
    ignore.some((expression) => expression.test(filePath));

  const plan = await planBuild({
    rootDir: options.rootDir,
    ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    check: mode === "check",
  });

  const issues: ContextIssue[] = [];

  /* Source diagnostics (parse errors, duplicate ids, ...). Build-time
   * diagnostics are covered by the stale-output check below. */
  for (const diagnostic of plan.source.diagnostics) {
    // Empty rules are reported once, by the empty-block check below.
    if (diagnostic.code === "source.empty") {
      continue;
    }
    issues.push({
      id: `source:${diagnostic.code}:${diagnostic.path ?? "project"}:${diagnostic.line ?? 0}`,
      category: "source",
      severity: diagnostic.severity === "error" ? "critical" : "warning",
      message: diagnostic.message,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    });
  }

  /* Secrets: any hit in source or compiled output is critical. */
  const inputs: SecretScanInput[] = [
    ...plan.source.files.map((file) => ({
      path: file.path,
      content: file.content,
      origin: "source" as const,
    })),
    ...plan.generated.map((file) => ({
      path: file.path,
      content: file.content,
      origin: "generated" as const,
    })),
  ];

  const scan = scanSecrets(inputs, {
    allowlist: [...plan.config.secrets.allowlist, ...(options.ignorePatterns ?? [])],
    disabledRules: plan.config.secrets.disabledRules,
  });
  // Secrets inside an ignored path are dropped, along with the compiled copies
  // derived from them. Compiled copies of a secret already reported in `.ai/`
  // add only noise.
  const sourcePaths = new Set(plan.source.files.map((file) => file.path));
  const ignoredFingerprints = new Set(
    scan.findings
      .filter((finding) => isIgnoredPath(finding.path))
      .map((finding) => finding.fingerprint),
  );
  const reportedInSource = new Set(
    scan.findings
      .filter((finding) => sourcePaths.has(finding.path) && !isIgnoredPath(finding.path))
      .map((finding) => finding.fingerprint),
  );
  for (const finding of scan.findings) {
    if (isIgnoredPath(finding.path) || ignoredFingerprints.has(finding.fingerprint)) {
      continue;
    }
    if (!sourcePaths.has(finding.path) && reportedInSource.has(finding.fingerprint)) {
      continue;
    }
    issues.push({
      id: `secret:${finding.ruleId}:${finding.path}:${finding.line}:${finding.column}`,
      category: "secret",
      severity: "critical",
      message: `${finding.name} detected (${finding.matchLength} chars, fingerprint ${finding.fingerprint}). Remove it and rotate the credential if it is real.`,
      path: finding.path,
      line: finding.line,
      column: finding.column,
      ruleId: finding.ruleId,
      fingerprint: finding.fingerprint,
    });
  }

  /* Sync check. */
  if (mode === "check") {
    for (const change of plan.changes) {
      if (change.status === "unchanged" || isIgnoredPath(change.path)) {
        continue;
      }
      issues.push({
        id: `stale-output:${change.status}:${change.path}`,
        category: "stale-output",
        severity: "critical",
        message: staleMessage(change),
        path: change.path,
        profile: change.profile,
      });
    }
  }

  /* Wasted context: empty and duplicated rules. */
  const enabled = plan.source.blocks.filter(
    (block) => block.enabled && !isIgnoredPath(block.sourcePath),
  );
  const firstByBody = new Map<string, RuleBlock>();
  for (const block of enabled) {
    if (block.body.trim().length === 0) {
      issues.push({
        id: `empty-block:${block.id}`,
        category: "empty-block",
        severity: "warning",
        message: `Rule "${block.id}" has no content and only wastes context.`,
        path: block.sourcePath,
        line: block.sourceLine,
      });
      continue;
    }
    const key = bodyKey(block);
    const first = firstByBody.get(key);
    if (first === undefined) {
      firstByBody.set(key, block);
    } else {
      issues.push({
        id: `duplicate-block:${block.id}`,
        category: "duplicate-block",
        severity: "warning",
        message: `Rule "${block.id}" duplicates the content of "${first.id}" (${first.sourcePath}); remove one of them.`,
        path: block.sourcePath,
        line: block.sourceLine,
      });
    }
  }

  /* Tokens. */
  const totalTokens = combineMetrics(
    plan.source.blocks
      .filter((block) => block.enabled)
      .map((block) => measureText(block.body)),
  ).estimatedTokens;

  const assistants: AssistantTokenUsage[] = plan.profiles.map((profile) => {
    const files = plan.generated.filter((file) => file.profile === profile);
    const metrics = combineMetrics(files.map((file) => measureText(file.content)));
    return {
      profile,
      label: getAdapter(profile).label,
      paths: files.map((file) => file.path),
      blocks: files.reduce((sum, file) => sum + file.blockIds.length, 0),
      characters: metrics.characters,
      estimatedTokens: metrics.estimatedTokens,
    };
  });

  if (maxTokens > 0) {
    if (totalTokens > maxTokens) {
      issues.push({
        id: "token-budget:total",
        category: "token-budget",
        severity: "warning",
        message: `Context uses an estimated ${totalTokens} tokens, over the ${maxTokens}-token budget.`,
      });
    }
    for (const assistant of assistants) {
      if (assistant.estimatedTokens > maxTokens) {
        issues.push({
          id: `token-budget:${assistant.profile}`,
          category: "token-budget",
          severity: "warning",
          message: `${assistant.label} context uses an estimated ${assistant.estimatedTokens} tokens, over the ${maxTokens}-token budget.`,
          profile: assistant.profile,
          ...(assistant.paths.length === 1 && assistant.paths[0] !== undefined
            ? { path: assistant.paths[0] }
            : {}),
        });
      }
    }
  }

  issues.sort(
    (left, right) =>
      (right.severity === "critical" ? 1 : 0) -
        (left.severity === "critical" ? 1 : 0) ||
      (left.path ?? "").localeCompare(right.path ?? "", "en") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.id.localeCompare(right.id, "en"),
  );

  let severity: Severity = "ok";
  for (const issue of issues) {
    severity = maxSeverity(severity, issue.severity);
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: VERSION },
    generatedAt: (options.now ?? new Date()).toISOString(),
    mode,
    severity,
    maxTokens,
    totalTokens,
    assistants,
    filesScanned: scan.scannedFiles,
    issues,
  };
}
