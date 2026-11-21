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
  /** Internal absolute path. */
  rootDir: string;
  /** Internal absolute path of the source directory. */
  sourceDir: string;
}

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

/**
 * Read every Markdown file under the source directory and compile it into
 * rule blocks. The operation is deterministic: files are sorted by path,
 * blocks by priority (desc) and then path order.
 */
export async function readSourceTree(
  options: ReadSourceOptions,
): Promise<SourceCollection> {
  const rootDir = path.resolve(options.rootDir);
  const sourceDir = path.resolve(options.sourceDir);

  let stats;
  try {
    stats = await fs.stat(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourceError(
        `Source directory not found: ${toPosix(path.relative(rootDir, sourceDir))}. Create it or pass --source.`,
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

  let absoluteFiles;
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

    const rootRelativePath = relativePosix(rootDir, absolutePath);
    let rawContent: string;
    try {
      rawContent = await readTextFile(absolutePath);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "source.read",
        message: `Could not read rule file: ${(error as Error).message}`,
        path: rootRelativePath,
      });
      continue;
    }

    const content = normalizeLineEndings(stripBom(rawContent));
    files.push({
      path: rootRelativePath,
      relativePath,
      absolutePath,
      content,
    });
    filesRead += 1;

    const parsed = parseRuleFile({
      path: rootRelativePath,
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
      message: `No Markdown rule files found in ${toPosix(
        path.relative(rootDir, sourceDir),
      ) || "."}.`,
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
    sourceDirRelative: relativePosix(rootDir, sourceDir),
    files,
    blocks: uniqueBlocks,
    diagnostics,
    filesRead,
  };
}
