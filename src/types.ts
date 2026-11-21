/**
 * Public type surface for ctx-sync.
 *
 * The data model is deliberately small:
 *
 *   Markdown source -> RuleBlock[] -> GeneratedFile[] (one per target profile)
 *                                         |
 *   every file/block -> TokenMetrics     +--> AuditReport
 *   every source/generated file --------> SecretFinding[]
 *
 * All paths exposed by the library and JSON output are repository-relative
 * POSIX paths ("."-separated, forward slashes). Absolute paths stay internal
 * to readers and writers so reports are portable across operating systems.
 */

/* -------------------------------------------------------------------------- */
/* Target profiles                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Identifier of a native context consumer (an "assistant").
 *
 * The set of valid profiles is not hard-coded: it is whatever the adapter
 * registry in `src/adapters/index.ts` discovers. Adding an assistant means
 * adding one `src/adapters/<name>Adapter.ts` file; nothing else changes.
 * Built-in ids: "claude", "cursor", "copilot", "windsurf".
 */
export type TargetProfile = string;

/** Shape every profile id must follow (also used as a file/CLI token). */
export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * - single-file    -> the adapter emits exactly one file at `output`
 * - rule-directory -> `output` is a directory ctx-sync owns the generated
 *                     files of (stale generated files in it are removed)
 */
export type AdapterKind = "single-file" | "rule-directory";

/* -------------------------------------------------------------------------- */
/* Severity and diagnostics                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Normalized severity used by findings and reports.
 *
 * "ok" is a valid report-level result, never a finding-level one.
 */
export type Severity = "ok" | "warning" | "critical";

/** Severity used for configuration/source diagnostics. */
export type DiagnosticSeverity = "warning" | "error";

export const SEVERITY_RANK: Record<Severity, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
};

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * A non-fatal problem discovered while reading source rules or planning a
 * build. "error" diagnostics prevent writes; "warning" diagnostics do not.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine-readable code, e.g. "source.duplicate-id". */
  code: string;
  message: string;
  /** Repository-relative path, when applicable. */
  path?: string;
  /** 1-based line number, when applicable. */
  line?: number;
}

/** Alias kept for call sites that specifically deal with source parsing. */
export type SourceDiagnostic = Diagnostic;

/* -------------------------------------------------------------------------- */
/* Markdown rule sources                                                      */
/* -------------------------------------------------------------------------- */

/**
 * YAML frontmatter accepted on a rule file. ctx-sync implements a deliberately
 * small, dependency-free YAML subset: scalars, quoted strings, inline arrays,
 * dash arrays and literal/folded block strings. Unknown keys are preserved in
 * `RuleBlock.frontmatter` for forward compatibility.
 */
export interface RuleFrontmatter {
  id?: string;
  title?: string;
  description?: string;
  targets?: TargetProfile[];
  /** Higher priority rules are rendered first. Defaults to 0. */
  priority?: number;
  /** Glob patterns used by Cursor auto-attachment. */
  globs?: string[];
  /** Cursor always-apply flag. Defaults to true when no globs are present. */
  alwaysApply?: boolean;
  /** Set to false to keep a rule in the source tree but out of outputs. */
  enabled?: boolean;
  tags?: string[];
  /** Per-block token budget override used by the auditor. */
  maxTokens?: number;
  [key: string]: unknown;
}

/** A Markdown file discovered under the source directory. */
export interface SourceFile {
  /** Repository-relative POSIX path. */
  path: string;
  /** Source-directory-relative POSIX path. */
  relativePath: string;
  /** Internal absolute path. */
  absolutePath: string;
  /** UTF-8 contents with line endings normalized to LF. */
  content: string;
}

/**
 * A single, fully validated rule ready to be rendered.
 *
 * A source file maps to exactly one block. The leading H1 is promoted to
 * `title` and removed from `body`; all remaining Markdown is preserved.
 */
export interface RuleBlock {
  /** Stable slug, safe to use as a Cursor .mdc filename. */
  id: string;
  title: string;
  /** Short, single-line summary used for Cursor metadata. */
  description: string;
  /** Markdown content without frontmatter or the promoted H1. */
  body: string;
  /** Repository-relative POSIX path of the source file. */
  sourcePath: string;
  /** Source-directory-relative POSIX path. */
  relativePath: string;
  /** Internal absolute path. */
  sourceAbsolutePath: string;
  /** 1-based line where the rule content/title starts. */
  sourceLine: number;
  /** Stable position based on sorted source paths. */
  order: number;
  targets: TargetProfile[];
  priority: number;
  globs: string[];
  alwaysApply: boolean;
  enabled: boolean;
  tags: string[];
  /** Per-block budget override, when present. */
  maxTokens?: number;
  frontmatter: RuleFrontmatter;
}

/** Result of scanning the complete source directory. */
export interface SourceCollection {
  /** Internal absolute path of the repository root. */
  rootDir: string;
  /** Internal absolute path of the source directory. */
  sourceDir: string;
  /** Repository-relative POSIX source directory, e.g. ".ai". */
  sourceDirRelative: string;
  /** All discovered files, including ones that failed to parse. */
  files: SourceFile[];
  /** Valid, enabled-or-disabled blocks sorted by priority then path. */
  blocks: RuleBlock[];
  diagnostics: Diagnostic[];
  /** Number of Markdown files read successfully. */
  filesRead: number;
}

/* -------------------------------------------------------------------------- */
/* Token metrics                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Dependency-free, deterministic estimate. It is a planning signal, not a
 * byte-exact tokenizer: provider tokenizers change frequently and are not
 * exposed as stable offline APIs.
 */
export interface TokenMetrics {
  characters: number;
  words: number;
  /** Content lines; a trailing newline does not create an extra line. */
  lines: number;
  estimatedTokens: number;
}

/** 0 disables a limit. */
export interface TokenBudget {
  maxPerProfile: number;
  maxPerBlock: number;
}

export interface BlockTokenReport {
  blockId: string;
  title: string;
  sourcePath: string;
  metrics: TokenMetrics;
  status: Severity;
  maxTokens: number;
}

export interface ProfileFileTokenReport {
  profile: TargetProfile;
  path: string;
  blockCount: number;
  metrics: TokenMetrics;
  status: Severity;
}

export interface ProfileTokenReport {
  profile: TargetProfile;
  label: string;
  paths: string[];
  files: ProfileFileTokenReport[];
  blockCount: number;
  metrics: TokenMetrics;
  status: Severity;
}

/* -------------------------------------------------------------------------- */
/* Build / sync                                                               */
/* -------------------------------------------------------------------------- */

/** One native output produced by an adapter. */
export interface GeneratedFile {
  profile: TargetProfile;
  /** Repository-relative POSIX output path. */
  path: string;
  /** Complete file content, always LF-normalized and newline-terminated. */
  content: string;
  /** Source block ids that contributed to this file. */
  blockIds: string[];
}

export interface AdapterRenderContext {
  config: ResolvedConfig;
}

/**
 * Contract implemented by every target adapter. A module named
 * `src/adapters/<name>Adapter.ts` must default-export one of these to be
 * picked up by the registry.
 */
export interface Adapter {
  /** Lowercase token used in config, `--profile` and rule `targets`. */
  id: TargetProfile;
  /** Human-readable name used in reports. */
  label: string;
  kind: AdapterKind;
  /**
   * Position in reports and generated output (ascending). Optional: adapters
   * without one come after those with one, ordered by id.
   */
  order?: number;
  /** Repository-relative POSIX file (single-file) or directory. */
  defaultOutput: string;
  /**
   * File extensions (with dot) of the files a "rule-directory" adapter
   * generates. Used to find stale generated files. Ignored for single-file.
   */
  extensions?: readonly string[];
  render(blocks: RuleBlock[], context: AdapterRenderContext): GeneratedFile[];
}

export type FileChangeStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "removed"
  | "blocked";

export interface FileChange {
  path: string;
  profile: TargetProfile;
  status: FileChangeStatus;
  bytes: number;
  estimatedTokens: number;
}

export interface BuildOptions {
  /** Repository root. Defaults to `process.cwd()` in the CLI. */
  rootDir: string;
  /** Source directory, relative to the root. Defaults to config or ".ai". */
  sourceDir?: string;
  /** Restrict/enable only these profiles. Defaults to config. */
  profiles?: TargetProfile[];
  /** Do not write; fail if outputs are stale. */
  check?: boolean;
  /** Do not write; report what would change. */
  dryRun?: boolean;
  /** Overwrite target files that were not generated by ctx-sync. */
  force?: boolean;
}

export interface BuildSummary {
  /** True when source is valid and the requested mode succeeded. */
  ok: boolean;
  /** False when configuration or source parsing produced errors. */
  valid: boolean;
  check: boolean;
  dryRun: boolean;
  /** True when files would be created, updated, removed, or blocked. */
  drift: boolean;
  /** Repository-relative POSIX source directory. */
  sourceDir: string;
  /** Number of parsed blocks, including disabled ones. */
  blocks: number;
  profiles: TargetProfile[];
  changes: FileChange[];
  diagnostics: Diagnostic[];
}

/** Internal-build plan, exposed for advanced API consumers and tests. */
export interface BuildPlan {
  config: ResolvedConfig;
  source: SourceCollection;
  generated: GeneratedFile[];
  changes: FileChange[];
  diagnostics: Diagnostic[];
  profiles: TargetProfile[];
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

export type SecretFindingSeverity = Exclude<Severity, "ok">;

export interface SecretPattern {
  id: string;
  name: string;
  description: string;
  severity: SecretFindingSeverity;
  pattern: RegExp;
  /** Capture group holding the secret value when it differs from the full match. */
  valueGroup?: number;
  /** Skip obvious documentation values ("example", "xxxx", placeholders...). */
  suppressPlaceholders: boolean;
}

export interface SecretScanInput {
  /** Repository-relative POSIX path. */
  path: string;
  content: string;
  /** Where the content came from. */
  origin: "source" | "generated";
}

export interface SecretScanOptions {
  /**
   * Case-insensitive JavaScript regular expressions. A match against the
   * finding's raw value or its full source line suppresses the finding.
   */
  allowlist?: string[];
  /** Pattern ids to disable, e.g. "generic-password". */
  disabledRules?: string[];
}

export interface SecretFinding {
  ruleId: string;
  name: string;
  description: string;
  severity: SecretFindingSeverity;
  path: string;
  /** 1-based line and column. */
  line: number;
  column: number;
  /** Redacted preview. Never contains the complete secret. */
  preview: string;
  /** Stable, non-reversible hash for deduplication and suppression. */
  fingerprint: string;
  /** Length of the matched value, useful for triage without disclosure. */
  matchLength: number;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  scannedFiles: number;
  severity: Severity;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export type AuditFindingKind =
  | "token-budget"
  | "source"
  | "coverage"
  | "secret-exposure";

export type FailOn = "warning" | "critical" | "never";

export interface AuditFinding {
  id: string;
  kind: AuditFindingKind;
  severity: Exclude<Severity, "ok">;
  title: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
  profile?: TargetProfile;
  blockId?: string;
  /** Safe, non-sensitive context for machine consumers. */
  details?: Record<string, string | number | boolean>;
}

export interface AuditOptions {
  rootDir: string;
  sourceDir?: string;
  profiles?: TargetProfile[];
  /** Override configured budgets. 0 disables the check. */
  maxPerProfile?: number;
  maxPerBlock?: number;
  failOn?: FailOn;
  /** Injectable clock for deterministic reports/tests. */
  now?: Date;
}

export interface AuditReport {
  schemaVersion: 1;
  tool: {
    name: string;
    version: string;
  };
  /** ISO-8601 timestamp. */
  generatedAt: string;
  /** Internal absolute path; useful locally, never contains file contents. */
  rootDir: string;
  sourceDir: string;
  severity: Severity;
  failOn: FailOn;
  source: {
    filesRead: number;
    blocks: number;
    diagnostics: Diagnostic[];
  };
  tokens: {
    method: "heuristic-v1";
    budget: TokenBudget;
    blocks: BlockTokenReport[];
    profiles: ProfileTokenReport[];
    /** Source-only total; profile files may repeat blocks. */
    total: TokenMetrics;
  };
  secrets: SecretScanResult;
  findings: AuditFinding[];
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface ProfileConfig {
  enabled?: boolean;
  /**
   * Relative to the repository root. A file for single-file adapters or a
   * directory for Cursor. Defaults to the adapter's native location.
   */
  output?: string;
}

export interface CtxSyncConfigFile {
  $schema?: string;
  sourceDir?: string;
  profiles?: Partial<Record<TargetProfile, ProfileConfig>>;
  tokenBudget?: Partial<TokenBudget>;
  secrets?: SecretScanOptions;
}

export interface ResolvedProfileConfig {
  profile: TargetProfile;
  enabled: boolean;
  output: string;
}

export interface ResolvedConfig {
  /** Internal absolute path. */
  rootDir: string;
  /** Internal absolute path. */
  sourceDir: string;
  /** Repository-relative POSIX source directory. */
  sourceDirRelative: string;
  /** Absolute config path, or null when defaults are used. */
  configPath: string | null;
  profiles: ResolvedProfileConfig[];
  tokenBudget: TokenBudget;
  secrets: {
    allowlist: string[];
    disabledRules: string[];
  };
}

export interface LoadConfigOptions {
  rootDir: string;
  sourceDir?: string;
  profiles?: TargetProfile[];
  maxPerProfile?: number;
  maxPerBlock?: number;
}

/* -------------------------------------------------------------------------- */
/* Context audit (contextAuditor / reporter)                                  */
/* -------------------------------------------------------------------------- */

/** "check" additionally verifies generated files on disk against `.ai/`. */
export type ContextAuditMode = "audit" | "check";

export type ContextIssueCategory =
  | "secret"
  | "stale-output"
  | "token-budget"
  | "empty-block"
  | "duplicate-block"
  | "source";

export interface ContextIssue {
  id: string;
  category: ContextIssueCategory;
  severity: Exclude<Severity, "ok">;
  message: string;
  /** Repository-relative POSIX path. */
  path?: string;
  line?: number;
  column?: number;
  profile?: TargetProfile;
  /** Secret detector id; never the secret itself. */
  ruleId?: string;
  fingerprint?: string;
}

export interface ContextAuditOptions {
  rootDir: string;
  sourceDir?: string;
  profiles?: TargetProfile[];
  /** Defaults to "audit". */
  mode?: ContextAuditMode;
  /** Token budget; defaults to 4000. 0 disables the check. */
  maxTokens?: number;
  /**
   * Case-insensitive regular expressions. A match against a repository-relative
   * path skips that file; a match against a detected value or its line
   * suppresses that secret finding.
   */
  ignorePatterns?: string[];
  /** Injectable clock for deterministic output. */
  now?: Date;
}

/** Compiled-context cost of one assistant. */
export interface AssistantTokenUsage {
  profile: TargetProfile;
  label: string;
  paths: string[];
  blocks: number;
  characters: number;
  estimatedTokens: number;
}

export interface ContextAuditResult {
  schemaVersion: 1;
  tool: { name: string; version: string };
  generatedAt: string;
  mode: ContextAuditMode;
  severity: Severity;
  maxTokens: number;
  /** Tokens of the enabled rules, counted once (source of truth). */
  totalTokens: number;
  assistants: AssistantTokenUsage[];
  filesScanned: number;
  issues: ContextIssue[];
}
