import { createHash } from "node:crypto";

import type {
  SecretFinding,
  SecretFindingSeverity,
  SecretPattern,
  SecretScanInput,
  SecretScanOptions,
  SecretScanResult,
  Severity,
} from "../types.js";
import { normalizeLineEndings } from "../utils/paths.js";

/**
 * High-signal secret patterns. Ordered from specific to generic so a broad
 * match does not usually hide a more useful one.
 *
 * Every pattern avoids catastrophic backtracking and is safe to run over
 * untrusted Markdown in CI.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "private-key",
    name: "Private key block",
    description:
      "A PEM/OpenSSH/PGP private key header was committed in context files.",
    severity: "critical",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
    suppressPlaceholders: false,
  },
  {
    id: "aws-access-key",
    name: "AWS access key ID",
    description: "An AWS access key ID is exposed to AI assistants.",
    severity: "critical",
    pattern:
      /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
    suppressPlaceholders: true,
  },
  {
    id: "github-token",
    name: "GitHub token",
    description: "A GitHub personal access or fine-grained token is exposed.",
    severity: "critical",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    suppressPlaceholders: true,
  },
  {
    id: "openai-key",
    name: "OpenAI API key",
    description: "An OpenAI API key is exposed.",
    severity: "critical",
    pattern:
      /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "anthropic-key",
    name: "Anthropic API key",
    description: "An Anthropic API key is exposed.",
    severity: "critical",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "google-api-key",
    name: "Google API key",
    description: "A Google API key is exposed.",
    severity: "critical",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "npm-token",
    name: "npm token",
    description: "An npm automation or publish token is exposed.",
    severity: "critical",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "huggingface-token",
    name: "Hugging Face token",
    description: "A Hugging Face access token is exposed.",
    severity: "critical",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "slack-token",
    name: "Slack token",
    description: "A Slack bot/user token is exposed.",
    severity: "critical",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "slack-webhook",
    name: "Slack webhook URL",
    description: "A Slack incoming webhook URL can be used to post to a workspace.",
    severity: "critical",
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/,
    suppressPlaceholders: true,
  },
  {
    id: "discord-webhook",
    name: "Discord webhook URL",
    description: "A Discord webhook URL can be used to post to a channel.",
    severity: "critical",
    pattern:
      /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/,
    suppressPlaceholders: true,
  },
  {
    id: "stripe-live-key",
    name: "Stripe live key",
    description: "A Stripe live secret/restricted key is exposed.",
    severity: "critical",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "stripe-test-key",
    name: "Stripe test key",
    description: "A Stripe test secret/restricted key is exposed.",
    severity: "warning",
    pattern: /\b(?:sk|rk)_test_[A-Za-z0-9]{16,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "connection-string",
    name: "Database URL with credentials",
    description:
      "A database or broker URL contains an inline username and password.",
    severity: "critical",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:([^\s@/]+)@[^\s/]+/,
    valueGroup: 1,
    suppressPlaceholders: true,
  },
  {
    id: "bearer-token",
    name: "Bearer token",
    description: "An Authorization: Bearer header contains a long-lived token.",
    severity: "warning",
    pattern: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{20,})/i,
    valueGroup: 1,
    suppressPlaceholders: true,
  },
  {
    id: "jwt",
    name: "JSON Web Token",
    description: "A JWT-like token is exposed; it may grant API access.",
    severity: "warning",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    suppressPlaceholders: true,
  },
  {
    id: "generic-secret-assignment",
    name: "Hardcoded credential assignment",
    description:
      "A password, API key, or token appears to be assigned a literal value.",
    severity: "warning",
    pattern:
      /(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/i,
    valueGroup: 1,
    suppressPlaceholders: true,
  },
];

const INLINE_IGNORE_MARKERS = [
  "ctx-sync:allow-secret",
  "ctx-sync:ignore-secret",
];

const PLACEHOLDER_PATTERN =
  /(?:example|sample|placeholder|changeme|change-me|dummy|redacted|your[_-]?(?:[a-z0-9]+[_-])?(?:key|token|secret|password)|<[^>]+>|\$\{|\{\{|process\.env|env\(|:password@|\.\.\.|x{8,}|\*{4,})/i;

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/^(?:password|passwd|pwd|secret|token|api[_-]?key)$/i.test(trimmed)) {
    return true;
  }
  if (PLACEHOLDER_PATTERN.test(trimmed)) {
    return true;
  }
  if (/^(.)\1{7,}$/s.test(trimmed)) {
    return true;
  }
  if (/^x{8,}$/i.test(trimmed) || /^\*{4,}$/.test(trimmed)) {
    return true;
  }
  return false;
}

function fingerprint(ruleId: string, value: string): string {
  return createHash("sha256")
    .update(ruleId)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function lineStartsFor(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function locate(
  starts: readonly number[],
  index: number,
): { line: number; column: number; lineIndex: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (index < start) {
      high = middle - 1;
    } else if (index >= next) {
      low = middle + 1;
    } else {
      return { line: middle + 1, column: index - start + 1, lineIndex: middle };
    }
  }
  return { line: 1, column: 1, lineIndex: 0 };
}

function combineSeverity(
  current: Severity,
  next: SecretFindingSeverity,
): Severity {
  if (current === "critical" || next === "critical") {
    return "critical";
  }
  return "warning";
}

/**
 * Scan in-memory source/generated files for secrets. Findings never contain
 * the secret itself: only a redacted preview and a stable fingerprint.
 */
export function scanSecrets(
  inputs: readonly SecretScanInput[],
  options: SecretScanOptions = {},
): SecretScanResult {
  const disabled = new Set(options.disabledRules ?? []);
  const allowlist: RegExp[] = [];
  for (const expression of options.allowlist ?? []) {
    try {
      allowlist.push(new RegExp(expression, "i"));
    } catch {
      // Configuration validation rejects invalid expressions. If the library is
      // used directly, fail closed rather than silently ignoring the allowlist.
      continue;
    }
  }

  const findings: SecretFinding[] = [];
  let severity: Severity = "ok";

  for (const input of inputs) {
    const text = normalizeLineEndings(input.content);
    const starts = lineStartsFor(text);
    const lines = text.split("\n");
    const coveredOnLine = new Set<string>();

    for (const pattern of SECRET_PATTERNS) {
      if (disabled.has(pattern.id)) {
        continue;
      }
      const flags = pattern.pattern.flags.includes("g")
        ? pattern.pattern.flags
        : `${pattern.pattern.flags}g`;
      const expression = new RegExp(pattern.pattern.source, flags);

      for (const match of text.matchAll(expression)) {
        const fullMatch = match[0];
        if (fullMatch === undefined || fullMatch.length === 0) {
          continue;
        }
        const value = match[pattern.valueGroup ?? 0] ?? fullMatch;
        if (pattern.suppressPlaceholders && isPlaceholder(value)) {
          continue;
        }

        const index = match.index ?? 0;
        const location = locate(starts, index);
        const lineText = lines[location.lineIndex] ?? "";
        const previousLine = lines[location.lineIndex - 1] ?? "";
        if (
          INLINE_IGNORE_MARKERS.some(
            (marker) =>
              lineText.includes(marker) || previousLine.includes(marker),
          )
        ) {
          continue;
        }
        if (
          allowlist.some(
            (expression) =>
              expression.test(value) || expression.test(lineText),
          )
        ) {
          continue;
        }

        // A specific detector (e.g. GitHub token) wins over a broad one
        // (e.g. token assignment) for the same value on the same line.
        const coverageKey = `${location.line}\0${value}`;
        if (coveredOnLine.has(coverageKey)) {
          continue;
        }
        coveredOnLine.add(coverageKey);

        const finding: SecretFinding = {
          ruleId: pattern.id,
          name: pattern.name,
          description: pattern.description,
          severity: pattern.severity,
          path: input.path,
          line: location.line,
          column: location.column,
          preview: `[redacted ${value.length} chars]`,
          fingerprint: fingerprint(pattern.id, value),
          matchLength: value.length,
        };
        findings.push(finding);
        severity = combineSeverity(severity, finding.severity);
      }
    }
  }

  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en") ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId, "en"),
  );

  return {
    findings,
    scannedFiles: inputs.length,
    severity,
  };
}
