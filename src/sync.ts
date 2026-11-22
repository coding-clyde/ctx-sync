import path from "node:path";

import { getAdapter, renderAllProfiles } from "./adapters/index.js";
import { hasGeneratedMarker } from "./adapters/shared.js";
import { loadConfig } from "./config.js";
import { CtxSyncError } from "./errors.js";
import { readSourceTree } from "./readers/source.js";
import { measureText } from "./auditor/tokens.js";
import type {
  BuildOptions,
  BuildPlan,
  BuildSummary,
  Diagnostic,
  FileChange,
  GeneratedFile,
  ResolvedConfig,
} from "./types.js";
import {
  listFilesRecursive,
  pathExists,
  readTextFile,
  removeFile,
  writeTextFileAtomic,
} from "./utils/fs.js";
import { relativePosix } from "./utils/paths.js";

function changeFor(
  file: GeneratedFile,
  status: FileChange["status"],
): FileChange {
  return {
    path: file.path,
    profile: file.profile,
    status,
    bytes: Buffer.byteLength(file.content, "utf8"),
    estimatedTokens: measureText(file.content).estimatedTokens,
  };
}

async function collectChanges(
  rootDir: string,
  config: ResolvedConfig,
  generated: GeneratedFile[],
  force: boolean,
  diagnostics: Diagnostic[],
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const expectedDirectoryPaths = new Set<string>();

  for (const file of generated) {
    if (getAdapter(file.profile).kind === "rule-directory") {
      expectedDirectoryPaths.add(path.resolve(rootDir, file.path));
    }

    const absolutePath = path.resolve(rootDir, file.path);
    const exists = await pathExists(absolutePath);
    if (!exists) {
      changes.push(changeFor(file, "created"));
      continue;
    }

    let existing: string;
    try {
      existing = await readTextFile(absolutePath);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "build.read",
        message: `Could not read existing target: ${(error as Error).message}`,
        path: file.path,
      });
      changes.push(changeFor(file, "blocked"));
      continue;
    }

    if (!hasGeneratedMarker(existing) && !force) {
      diagnostics.push({
        severity: "error",
        code: "build.unmanaged-file",
        message:
          `Refusing to overwrite unmanaged file "${file.path}". ` +
          "Move it aside or rerun with --force.",
        path: file.path,
      });
      changes.push(changeFor(file, "blocked"));
      continue;
    }

    changes.push(
      changeFor(file, existing === file.content ? "unchanged" : "updated"),
    );
  }

  // Rule-directory adapters own the generated files in their directory, so
  // generated files that no longer correspond to a rule are removed.
  for (const entry of config.profiles) {
    const adapter = getAdapter(entry.profile);
    if (!entry.enabled || adapter.kind !== "rule-directory") {
      continue;
    }
    const directory = path.resolve(rootDir, entry.output);
    let existingFiles: string[] = [];
    try {
      existingFiles = await listFilesRecursive(
        directory,
        adapter.extensions === undefined
          ? {}
          : { extensions: new Set(adapter.extensions) },
      );
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "build.output-directory",
        message: `${adapter.label} output "${entry.output}" is not a readable directory: ${
          (error as Error).message
        }`,
        path: entry.output,
      });
    }

    for (const absolutePath of existingFiles) {
      if (expectedDirectoryPaths.has(absolutePath)) {
        continue;
      }
      const relativePath = relativePosix(rootDir, absolutePath);
      let content: string;
      try {
        content = await readTextFile(absolutePath);
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "build.read",
          message: `Could not inspect stale rule file: ${(error as Error).message}`,
          path: relativePath,
        });
        continue;
      }
      if (!hasGeneratedMarker(content)) {
        // User-authored rules are never touched.
        continue;
      }
      changes.push({
        path: relativePath,
        profile: entry.profile,
        status: "removed",
        bytes: Buffer.byteLength(content, "utf8"),
        estimatedTokens: measureText(content).estimatedTokens,
      });
    }
  }

  changes.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return changes;
}

/** Read, validate, render, and diff without touching the filesystem. */
export async function planBuild(options: BuildOptions): Promise<BuildPlan> {
  const config = await loadConfig({
    rootDir: options.rootDir,
    ...(options.sourceDir === undefined ? {} : { sourceDir: options.sourceDir }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
  });

  const source = await readSourceTree({
    rootDir: config.rootDir,
    sourceDir: config.sourceDir,
  });

  const diagnostics = [...source.diagnostics];
  const generated = renderAllProfiles(source.blocks, config);
  const changes = await collectChanges(
    config.rootDir,
    config,
    generated,
    options.force ?? false,
    diagnostics,
  );

  return {
    config,
    source,
    generated,
    changes,
    diagnostics,
    profiles: config.profiles
      .filter((entry) => entry.enabled)
      .map((entry) => entry.profile),
  };
}

function summarize(
  plan: BuildPlan,
  check: boolean,
  dryRun: boolean,
): BuildSummary {
  const valid = !plan.diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const drift = plan.changes.some((change) => change.status !== "unchanged");
  return {
    ok: valid && (check ? !drift : true),
    valid,
    check,
    dryRun,
    drift,
    sourceDir: plan.config.sourceDirRelative,
    blocks: plan.source.blocks.length,
    profiles: plan.profiles,
    changes: plan.changes,
    diagnostics: plan.diagnostics,
  };
}

/**
 * Compile and, unless --check/--dry-run is used, write all native files.
 *
 * Safety contract:
 *  - Nothing is written when the source has errors.
 *  - Existing files without the ctx-syncr marker are never overwritten unless
 *    `force` is true.
 *  - Rule-directory files (e.g. Cursor .mdc) without the marker are never
 *    deleted.
 */
export async function syncProject(options: BuildOptions): Promise<BuildSummary> {
  const plan = await planBuild(options);
  const check = options.check ?? false;
  const dryRun = options.dryRun ?? false;
  const summary = summarize(plan, check, dryRun);

  if (!summary.valid || check || dryRun) {
    return summary;
  }

  const generatedByPath = new Map(
    plan.generated.map((file) => [file.path, file]),
  );

  try {
    for (const change of plan.changes) {
      if (change.status === "created" || change.status === "updated") {
        const file = generatedByPath.get(change.path);
        if (file === undefined) {
          throw new CtxSyncError(
            `Internal error: no generated content for ${change.path}.`,
            { code: "build.internal" },
          );
        }
        await writeTextFileAtomic(
          path.resolve(plan.config.rootDir, change.path),
          file.content,
        );
      } else if (change.status === "removed") {
        await removeFile(path.resolve(plan.config.rootDir, change.path));
      }
    }
  } catch (error) {
    if (error instanceof CtxSyncError) {
      throw error;
    }
    throw new CtxSyncError(
      `Could not write generated files: ${(error as Error).message}`,
      { code: "build.write", cause: error },
    );
  }

  return summary;
}
