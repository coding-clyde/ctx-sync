/**
 * ctx-sync public API.
 *
 * The CLI is a thin wrapper over these exports; everything is side-effect free
 * except syncProject(), which writes generated files.
 */

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
  formatTerminal,
  isGithubActions,
  shouldUseColor,
  wantsJson,
} from "./auditor/reporter.js";
export type { ReportOptions } from "./auditor/reporter.js";
export { SECRET_PATTERNS, scanSecrets } from "./auditor/secrets.js";
