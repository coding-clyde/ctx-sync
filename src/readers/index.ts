/**
 * Unified project context reader.
 *
 * This module combines source validation, token estimation, and native context
 * file detection into one read-only entry point. It validates the repository
 * root, reads and parses every Markdown rule under `.ai/`, measures per-file
 * and per-block token usage, and detects which native assistant files already
 * exist (CLAUDE.md, .cursor/rules, .github/copilot-instructions.md, and
 * .windsurfrules).
 *
 * The result is a complete, immutable snapshot of the project's context state:
 * parsed rules, token metrics, existing outputs, and any diagnostics. The CLI,
 * auditor, and sync logic build on top of this unified context.
 *
 * Example:
 *
 *   import { readProjectContext } from "ctx-sync";
 *
 *   const context = await readProjectContext({ rootDir: process.cwd() });
 *   console.log(context.source.blocks);
 *   console.log(context.tokens.total);
 *   console.log(context.existingOutputs);
 *
 * @module readers/index
 */
import fs from "node:fs/promises";
import path from "node:path";

import { SourceError } from "../errors.js";
import type {
  Diagnostic,
  SourceCollection,
  TargetProfile,
} from "../types.js";
import { getAdapter, listProfiles } from "../adapters/index.js";
import { listFilesRecursive } from "../utils/fs.js";
import { relativePosix } from "../utils/paths.js";
import {
  readSourceDirectory,
  type ReadSourceOptions,
} from "./sourceReader.js";
import {
  estimateSourceTokens,
  type SourceTokenEstimate,
} from "./tokenEstimator.js";

export interface ProjectReaderOptions {
  /** Repository root. Resolved internally. */
  rootDir: string;
  /**
   * Source directory, absolute or relative to `rootDir`.
   * Defaults to ".ai".
   */
  sourceDir?: string;
  /**
   * Override the output path used to detect already-existing context files.
   * Defaults to each adapter's native location.
   */
  outputs?: Partial<Record<TargetProfile, string>>;
  /** Set to false to skip filesystem detection of existing outputs. */
  detectExistingOutputs?: boolean;
}

export type ExistingContextKind = "file" | "directory";

/** A native context path that already exists in the repository. */
export interface DetectedContextFile {
  profile: TargetProfile;
  /** Repository-relative POSIX path. */
  path: string;
  /** Internal absolute path. */
  absolutePath: string;
  kind: ExistingContextKind;
  /**
   * Number of regular files found: 1 for a single-file output, or the number
   * of `.mdc` files for a Cursor rule directory.
   */
  entries: number;
}

/**
 * Everything a compiler needs from the source tree, plus a snapshot of the
 * native context files that already exist.
 */
export interface ProjectReaderContext {
  /** Internal absolute path. */
  rootDir: string;
  /** Internal absolute path. */
  sourceDir: string;
  /** Repository-relative POSIX source directory. */
  sourceDirRelative: string;
  source: SourceCollection;
  tokens: SourceTokenEstimate;
  existingOutputs: DetectedContextFile[];
  diagnostics: Diagnostic[];
  /** True when no source or reader diagnostic has "error" severity. */
  valid: boolean;
}

interface DetectionResult {
  detected?: DetectedContextFile;
  diagnostic?: Diagnostic;
}

async function assertRootDirectory(rootDir: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourceError(
        `Repository root not found: ${rootDir}.`,
        "source.root-missing",
        error,
      );
    }
    throw new SourceError(
      `Could not read repository root ${rootDir}: ${(error as Error).message}`,
      "source.root-unreadable",
      error,
    );
  }

  if (!stats.isDirectory()) {
    throw new SourceError(
      `Repository root is not a directory: ${rootDir}`,
      "source.root-not-directory",
    );
  }
}

async function detectOutput(
  rootDir: string,
  profile: TargetProfile,
  configuredPath: string,
): Promise<DetectionResult> {
  const trimmedPath = configuredPath.trim();
  if (trimmedPath.length === 0) {
    return {
      diagnostic: {
        severity: "warning",
        code: "reader.invalid-output",
        message: `Ignoring an empty ${profile} output path.`,
      },
    };
  }

  const absolutePath = path.resolve(rootDir, trimmedPath);
  const relativePath = relativePosix(rootDir, absolutePath) || ".";

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return {
      diagnostic: {
        severity: "warning",
        code: "reader.output-check",
        message: `Could not inspect existing output "${relativePath}": ${
          (error as Error).message
        }`,
        path: relativePath,
      },
    };
  }

  if (stats.isFile()) {
    return {
      detected: {
        profile,
        path: relativePath,
        absolutePath,
        kind: "file",
        entries: 1,
      },
    };
  }

  if (!stats.isDirectory()) {
    return {
      diagnostic: {
        severity: "warning",
        code: "reader.output-type",
        message: `Existing output "${relativePath}" is neither a regular file nor a directory; ignoring it.`,
        path: relativePath,
      },
    };
  }

  try {
    const files = await listFilesRecursive(
      absolutePath,
      getAdapter(profile).extensions === undefined
        ? {}
        : { extensions: new Set(getAdapter(profile).extensions) },
    );
    return {
      detected: {
        profile,
        path: relativePath,
        absolutePath,
        kind: "directory",
        entries: files.length,
      },
    };
  } catch (error) {
    return {
      diagnostic: {
        severity: "warning",
        code: "reader.output-check",
        message: `Could not list existing output directory "${relativePath}": ${
          (error as Error).message
        }`,
        path: relativePath,
      },
    };
  }
}

/**
 * Validate the source tree and return a unified, read-only compilation context.
 *
 * The function verifies the repository root and the source directory (".ai" by
 * default), parses every Markdown rule, estimates per-file and per-block token
 * usage, and detects which native assistant files already exist. It never
 * writes to disk.
 */
export async function readProjectContext(
  options: ProjectReaderOptions,
): Promise<ProjectReaderContext> {
  const rootDir = path.resolve(options.rootDir);
  await assertRootDirectory(rootDir);

  const sourceOptions: ReadSourceOptions = {
    rootDir,
    ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
  };
  const source = await readSourceDirectory(sourceOptions);

  const diagnostics: Diagnostic[] = [...source.diagnostics];
  const existingOutputs: DetectedContextFile[] = [];

  if (options.detectExistingOutputs !== false) {
    for (const profile of listProfiles()) {
      const configuredPath =
        options.outputs?.[profile] ??
        getAdapter(profile).defaultOutput;
      const result = await detectOutput(rootDir, profile, configuredPath);
      if (result.detected !== undefined) {
        existingOutputs.push(result.detected);
      }
      if (result.diagnostic !== undefined) {
        diagnostics.push(result.diagnostic);
      }
    }
  }

  return {
    rootDir,
    sourceDir: source.sourceDir,
    sourceDirRelative: source.sourceDirRelative,
    source,
    tokens: estimateSourceTokens(source),
    existingOutputs,
    diagnostics,
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  };
}
