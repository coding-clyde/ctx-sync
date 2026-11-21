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
export type { ReadSourceOptions } from "./readers/source.js";
export { ADAPTERS, renderAllProfiles, renderProfile } from "./adapters/index.js";
export { claudeAdapter } from "./adapters/claude.js";
export { copilotAdapter } from "./adapters/copilot.js";
export { cursorAdapter } from "./adapters/cursor.js";
export { windsurfAdapter } from "./adapters/windsurf.js";
export { planBuild, syncProject } from "./sync.js";
export { auditProject, measureBlocks } from "./auditor/index.js";
export {
  combineMetrics,
  countCharacters,
  countLines,
  estimateTokens,
  measureText,
  tokenStatus,
} from "./auditor/tokens.js";
export { SECRET_PATTERNS, scanSecrets } from "./auditor/secrets.js";
