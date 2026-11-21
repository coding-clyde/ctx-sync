import path from "node:path";

import { ConfigError } from "../errors.js";

/** Convert OS-specific separators to the POSIX paths used in all reports. */
export function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** POSIX path of `target` relative to `root`. */
export function relativePosix(root: string, target: string): string {
  return toPosix(path.relative(root, target));
}

/** True when `child` is strictly inside `parent`. */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

/** Reject paths that could escape the repository root. */
export function assertInside(
  parent: string,
  child: string,
  label: string,
): void {
  if (!isPathInside(parent, child)) {
    throw new ConfigError(
      `${label} must resolve inside the repository root (${toPosix(parent)}).`,
      "path.outside-root",
    );
  }
}

/**
 * Validate a configured output path. Outputs must stay relative so generated
 * files cannot escape the repository when ctx-sync is run in CI.
 */
export function resolveOutputPath(
  rootDir: string,
  configuredPath: string,
  label: string,
): { absolutePath: string; relativePath: string } {
  const trimmed = configuredPath.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${label} cannot be empty.`, "config.output-empty");
  }
  if (trimmed.includes("\0")) {
    throw new ConfigError(`${label} contains a NUL byte.`, "config.output-invalid");
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new ConfigError(
      `${label} must be relative to the repository root, got "${configuredPath}".`,
      "config.output-absolute",
    );
  }

  const normalized = toPosix(trimmed).replace(/\/+/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    throw new ConfigError(
      `${label} must be a safe relative path, got "${configuredPath}".`,
      "config.output-traversal",
    );
  }

  const absolutePath = path.resolve(rootDir, ...segments);
  assertInside(rootDir, absolutePath, label);
  return { absolutePath, relativePath: segments.join("/") };
}

/** Validate a source directory relative to the root. */
export function resolveSourceDir(
  rootDir: string,
  configuredPath: string,
): { absolutePath: string; relativePath: string } {
  const resolved = path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(rootDir, configuredPath);
  assertInside(rootDir, resolved, "sourceDir");
  return { absolutePath: resolved, relativePath: relativePosix(rootDir, resolved) };
}

/** Normalize CRLF/CR to LF. All generated content and token counts use LF. */
export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Strip a UTF-8 BOM if present. */
export function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
