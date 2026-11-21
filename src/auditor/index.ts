import { getAdapter, renderAllProfiles } from "../adapters/index.js";
import { loadConfig } from "../config.js";
import { readSourceTree } from "../readers/source.js";
import {
  REPORT_SCHEMA_VERSION,
  TOOL_NAME,
  VERSION,
} from "../version.js";
import type {
  AuditFinding,
  AuditOptions,
  AuditReport,
  BlockTokenReport,
  ProfileFileTokenReport,
  ProfileTokenReport,
  RuleBlock,
  SecretScanInput,
  SecretScanResult,
  Severity,
  TokenMetrics,
} from "../types.js";
import { maxSeverity } from "../types.js";
import { formatNumber } from "../utils/format.js";
import { combineMetrics, measureText, tokenStatus } from "./tokens.js";
import { scanSecrets } from "./secrets.js";

function budgetMessage(
  actual: number,
  maximum: number,
  status: Severity,
): string {
  return `Estimated ${formatNumber(actual)} tokens exceeds the ${formatNumber(
    maximum,
  )}-token budget (${status}).`;
}

function diagnosticFindings(
  report: ReportDraft,
): AuditFinding[] {
  return report.diagnostics.map((diagnostic, index) => ({
    id: `source:${diagnostic.code}:${diagnostic.path ?? "project"}:${
      diagnostic.line ?? 0
    }:${index}`,
    kind: "source",
    severity: diagnostic.severity === "error" ? "critical" : "warning",
    title:
      diagnostic.severity === "error"
        ? "Context source error"
        : "Context source warning",
    message: diagnostic.message,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    details: { code: diagnostic.code },
  }));
}

interface ReportDraft {
  diagnostics: AuditReport["source"]["diagnostics"];
}

/**
 * Audit the source and the exact content that would be written to editors.
 * No files are modified.
 */
export async function auditProject(
  options: AuditOptions,
): Promise<AuditReport> {
  const config = await loadConfig({
    rootDir: options.rootDir,
    ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    ...(options.maxPerProfile === undefined
      ? {}
      : { maxPerProfile: options.maxPerProfile }),
    ...(options.maxPerBlock === undefined
      ? {}
      : { maxPerBlock: options.maxPerBlock }),
  });

  const source = await readSourceTree({
    rootDir: config.rootDir,
    sourceDir: config.sourceDir,
  });
  const enabledProfiles = config.profiles
    .filter((entry) => entry.enabled)
    .map((entry) => entry.profile);
  const generated = renderAllProfiles(source.blocks, config);
  const enabledBlocks = source.blocks.filter((block) => block.enabled);

  let severity: Severity = "ok";
  const findings: AuditFinding[] = diagnosticFindings({
    diagnostics: source.diagnostics,
  });
  for (const finding of findings) {
    severity = maxSeverity(severity, finding.severity);
  }

  /* ---------------------------------------------------------------------- */
  /* Token audit                                                            */
  /* ---------------------------------------------------------------------- */

  const blockReports: BlockTokenReport[] = [];
  for (const block of enabledBlocks) {
    const metrics = measureText(block.body);
    const maximum = block.maxTokens ?? config.tokenBudget.maxPerBlock;
    const status = tokenStatus(metrics.estimatedTokens, maximum);
    blockReports.push({
      blockId: block.id,
      title: block.title,
      sourcePath: block.sourcePath,
      metrics,
      status,
      maxTokens: maximum,
    });

    if (status !== "ok") {
      const finding: AuditFinding = {
        id: `token-block:${block.id}`,
        kind: "token-budget",
        severity: status,
        title: "Rule exceeds token budget",
        message: budgetMessage(metrics.estimatedTokens, maximum, status),
        path: block.sourcePath,
        line: block.sourceLine,
        blockId: block.id,
        details: {
          estimatedTokens: metrics.estimatedTokens,
          maxTokens: maximum,
        },
      };
      findings.push(finding);
      severity = maxSeverity(severity, status);
    }
  }

  const profileReports: ProfileTokenReport[] = [];
  for (const profile of enabledProfiles) {
    const profileFiles = generated.filter((file) => file.profile === profile);
    const fileReports: ProfileFileTokenReport[] = profileFiles.map((file) => {
      const metrics = measureText(file.content);
      return {
        profile,
        path: file.path,
        blockCount: file.blockIds.length,
        metrics,
        status: tokenStatus(metrics.estimatedTokens, config.tokenBudget.maxPerProfile),
      };
    });

    const metrics = combineMetrics(fileReports.map((file) => file.metrics));
    const status = tokenStatus(
      metrics.estimatedTokens,
      config.tokenBudget.maxPerProfile,
    );
    const blockCount = profileFiles.reduce(
      (total, file) => total + file.blockIds.length,
      0,
    );

    profileReports.push({
      profile,
      label: getAdapter(profile).label,
      paths: profileFiles.map((file) => file.path),
      files: fileReports,
      blockCount,
      metrics,
      status,
    });

    if (status !== "ok") {
      const finding: AuditFinding = {
        id: `token-profile:${profile}`,
        kind: "token-budget",
        severity: status,
        title: `${profile} context exceeds token budget`,
        message: budgetMessage(
          metrics.estimatedTokens,
          config.tokenBudget.maxPerProfile,
          status,
        ),
        ...(profileFiles.length === 1 && profileFiles[0] !== undefined
          ? { path: profileFiles[0].path }
          : {}),
        profile,
        details: {
          estimatedTokens: metrics.estimatedTokens,
          maxTokens: config.tokenBudget.maxPerProfile,
          files: profileFiles.length,
        },
      };
      findings.push(finding);
      severity = maxSeverity(severity, status);
    }

    if (blockCount === 0) {
      const finding: AuditFinding = {
        id: `coverage:${profile}`,
        kind: "coverage",
        severity: "warning",
        title: `${profile} has no rules`,
        message: `Profile "${profile}" is enabled but none of the parsed rules target it.`,
        profile,
      };
      findings.push(finding);
      severity = maxSeverity(severity, "warning");
    }
  }

  const totalMetrics: TokenMetrics = combineMetrics(
    blockReports.map((block) => block.metrics),
  );

  /* ---------------------------------------------------------------------- */
  /* Secret audit                                                           */
  /* ---------------------------------------------------------------------- */

  const secretInputs: SecretScanInput[] = [
    ...source.files.map((file) => ({
      path: file.path,
      content: file.content,
      origin: "source" as const,
    })),
    ...generated.map((file) => ({
      path: file.path,
      content: file.content,
      origin: "generated" as const,
    })),
  ];

  const secrets: SecretScanResult = scanSecrets(secretInputs, {
    allowlist: config.secrets.allowlist,
    disabledRules: config.secrets.disabledRules,
  });
  severity = maxSeverity(severity, secrets.severity);

  findings.sort(
    (left, right) =>
      (right.severity === "critical" ? 1 : 0) -
        (left.severity === "critical" ? 1 : 0) ||
      (left.path ?? "").localeCompare(right.path ?? "", "en") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.id.localeCompare(right.id, "en"),
  );

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: VERSION },
    generatedAt: (options.now ?? new Date()).toISOString(),
    rootDir: config.rootDir,
    sourceDir: config.sourceDirRelative,
    severity,
    failOn: options.failOn ?? "warning",
    source: {
      filesRead: source.filesRead,
      blocks: source.blocks.length,
      diagnostics: source.diagnostics,
    },
    tokens: {
      method: "heuristic-v1",
      budget: config.tokenBudget,
      blocks: blockReports,
      profiles: profileReports,
      total: totalMetrics,
    },
    secrets,
    findings,
  };
}

/** Exported for callers that need the raw rule metrics without a report. */
export function measureBlocks(blocks: readonly RuleBlock[]): TokenMetrics {
  return combineMetrics(
    blocks.filter((block) => block.enabled).map((block) => measureText(block.body)),
  );
}
