/** Error types with stable exit codes for the CLI. */

/**
 * Base error for expected, user-facing failures. Anything that is not a
 * CtxSyncError is treated as an internal error by the CLI.
 */
export class CtxSyncError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(
    message: string,
    options: { code: string; exitCode?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.exitCode = options.exitCode ?? 2;
  }
}

/** Invalid configuration, CLI usage, or an unsafe output path. */
export class ConfigError extends CtxSyncError {
  constructor(message: string, code = "config.invalid", cause?: unknown) {
    super(message, { code, exitCode: 2, cause });
  }
}

/** The source directory could not be read. */
export class SourceError extends CtxSyncError {
  constructor(message: string, code = "source.unreadable", cause?: unknown) {
    super(message, { code, exitCode: 2, cause });
  }
}
