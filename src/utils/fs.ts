import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readTextFile(target: string): Promise<string> {
  return fs.readFile(target, "utf8");
}

/** Write via a sibling temporary file and rename, so readers never see a partial file. */
export async function writeTextFileAtomic(
  target: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });

  const temporary = path.join(
    directory,
    `.${path.basename(target)}.ctx-syncr-${process.pid}-${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove a file, ignoring a missing file. */
export async function removeFile(target: string): Promise<void> {
  await fs.rm(target, { force: true });
}

/**
 * Recursively list regular files, sorted for deterministic output.
 * Symlinks are skipped to avoid cycles and accidental escapes.
 */
export async function listFilesRecursive(
  directory: string,
  options: { skipDirectories?: ReadonlySet<string>; extensions?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const skipDirectories = options.skipDirectories ?? new Set<string>();
  const extensions = options.extensions;
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) {
          await walk(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (extensions !== undefined && !extensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      results.push(absolute);
    }
  }

  await walk(directory);
  return results;
}
