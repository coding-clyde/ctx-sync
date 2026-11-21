/**
 * Source directory reader.
 *
 * Validates that `.ai/` (or a custom source directory) exists, discovers every
 * Markdown file under it, parses frontmatter and rule bodies using the minimal
 * YAML and Markdown parsers, and returns a deterministic, sorted collection of
 * validated rule blocks.
 *
 * Files are discovered recursively, filtered by extension (`.md`, `.markdown`),
 * and sorted lexicographically by their source-relative POSIX paths so order
 * never depends on the filesystem or the platform.
 *
 * Hidden files, hidden directories, and `node_modules` are always ignored.
 *
 * Duplicate rule ids are detected and reported as diagnostics. Only the first
 * block with a given id is kept; later occurrences are dropped.
 *
 * @module readers/sourceReader
 */
import fs from "node:fs/promises";
import path from "node:path";

import { SourceError } from "../errors.js";
import type {
  Diagnostic,
  RuleBlock,
  SourceCollection,
  SourceFile,
} from "../types.js";
import { listFilesRecursive, readTextFile } from "../utils/fs.js";
import {
  normalizeLineEndings,
  relativePosix,
  stripBom,
  toPosix,
} from "../utils/paths.js";
import { parseRuleFile } from "./markdown.js";

export interface ReadSourceOptions {
  /** Internal absolute path of the repository root. */
  rootDir: string;
  /**
   * Source directory, absolute or relative to `rootDir`.
   * Defaults to ".ai".
   */
  sourceDir?: string;
}

const DEFAULT_SOURCE_DIRECTORY = ".ai";
const SOURCE_EXTENSIONS = new Set([".md", ".markdown"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function shouldSkip(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const fileName = segments.at(-1) ?? "";
  if (fileName.startsWith(".")) {
    return true;
  }

  return segments
    .slice(0, -1)
    .some(
      (segment) =>
        segment.startsWith(".") || SKIPPED_DIRECTORIES.has(segment),
    );
}

async function assertSourceDirectory(
  sourceDir: string,
  displayPath: string,
): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourceError(
        `Source directory not found: ${displayPath}. Run "ctx-sync init" to create it.`,
        "source.missing",
        error,
      );
    }
    throw new SourceError(
      `Could not read source directory ${sourceDir}: ${(error as Error).message}`,
      "source.unreadable",
      error,
    );
  }

  if (!stats.isDirectory()) {
    throw new SourceError(
      `Source path is not a directory: ${sourceDir}`,
      "source.not-directory",
    );
  }
}

/**
 * Read every Markdown file under the source directory and compile it into
 * validated rule blocks.
 *
 * Metadata lives in standard YAML frontmatter:
 *
 *   priority: 20              render order (higher first)
 *   globs: ["src/**"]         file patterns for Cursor auto-attachment
 *   targets: [claude, cursor] destination assistants
 *
 * `files`, `patterns` and `filePatterns` are accepted as aliases for `globs`;
 * `assistants` and `profiles` are accepted as aliases for `targets`. The
 * Markdown parser also supports the remaining frontmatter keys documented in
 * README.md.
 * Ordering is deterministic: files are visited in lexicographic order, blocks
 * are sorted by priority descending, then source order, then id. Hidden files,
 * hidden directories and node_modules are ignored.
 */
export async function readSourceDirectory(
  options: ReadSourceOptions,
): Promise<SourceCollection> {
  const rootDir = path.resolve(options.rootDir);
  const sourceDir = path.resolve(
    rootDir,
    options.sourceDir ?? DEFAULT_SOURCE_DIRECTORY,
  );
  const sourceDirRelative =
    toPosix(path.relative(rootDir, sourceDir)) || ".";

  await assertSourceDirectory(sourceDir, sourceDirRelative);

  let absoluteFiles: string[];
  try {
    absoluteFiles = await listFilesRecursive(sourceDir, {
      skipDirectories: SKIPPED_DIRECTORIES,
      extensions: SOURCE_EXTENSIONS,
    });
  } catch (error) {
    throw new SourceError(
      `Could not scan source directory ${sourceDir}: ${(error as Error).message}`,
      "source.unreadable",
      error,
    );
  }

  // `listFilesRecursive` sorts entries per directory. Sort globally by the
  // source-relative POSIX path so traversal order never depends on the
  // filesystem or on a directory/file name collision (e.g. "a" vs "a.md").
  absoluteFiles.sort((left, right) => {
    const leftPath = relativePosix(sourceDir, left);
    const rightPath = relativePosix(sourceDir, right);
    return leftPath.localeCompare(rightPath, "en");
  });

  const files: SourceFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const blocks: RuleBlock[] = [];
  let filesRead = 0;
  let fileOrder = 0;

  for (const absolutePath of absoluteFiles) {
    const relativePath = relativePosix(sourceDir, absolutePath);
    if (shouldSkip(relativePath)) {
      continue;
    }

    const sourcePath = relativePosix(rootDir, absolutePath);
    let rawContent: string;
    try {
      rawContent = await readTextFile(absolutePath);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "source.read",
        message: `Could not read rule file: ${(error as Error).message}`,
        path: sourcePath,
      });
      continue;
    }

    const content = normalizeLineEndings(stripBom(rawContent));
    files.push({
      path: sourcePath,
      relativePath,
      absolutePath,
      content,
    });
    filesRead += 1;

    const parsed = parseRuleFile({
      path: sourcePath,
      relativePath,
      absolutePath,
      content,
      order: fileOrder,
    });
    fileOrder += 1;
    diagnostics.push(...parsed.diagnostics);
    if (parsed.block !== undefined) {
      blocks.push(parsed.block);
    }
  }

  // Drop duplicate ids instead of silently overwriting one of their outputs.
  const seenIds = new Map<string, RuleBlock>();
  const uniqueBlocks: RuleBlock[] = [];
  for (const block of blocks) {
    const existing = seenIds.get(block.id);
    if (existing !== undefined) {
      diagnostics.push({
        severity: "error",
        code: "source.duplicate-id",
        message: `Duplicate rule id "${block.id}" (already defined in ${existing.sourcePath}).`,
        path: block.sourcePath,
        line: block.sourceLine,
      });
      continue;
    }

    seenIds.set(block.id, block);
    uniqueBlocks.push(block);
  }

  uniqueBlocks.sort(
    (left, right) =>
      right.priority - left.priority ||
      left.order - right.order ||
      left.id.localeCompare(right.id, "en"),
  );

  if (files.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "source.empty",
      message: `No Markdown rule files found in ${sourceDirRelative}.`,
    });
  } else if (uniqueBlocks.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "source.no-blocks",
      message: "No valid rule blocks could be parsed from the source directory.",
    });
  }

  return {
    rootDir,
    sourceDir,
    sourceDirRelative,
    files,
    blocks: uniqueBlocks,
    diagnostics,
    filesRead,
  };
}
