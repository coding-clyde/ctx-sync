/**
 * Kept in sync with package.json by tests/version.test.ts.
 * Importing package.json from ESM at runtime is fragile across Node versions,
 * so the version is a compile-time constant instead.
 */
export const TOOL_NAME = "ctx-sync";
export const VERSION = "0.1.0";
export const REPORT_SCHEMA_VERSION = 1 as const;
