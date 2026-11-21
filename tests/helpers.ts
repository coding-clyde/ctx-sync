import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RuleBlock } from "../src/types.js";
import { listProfiles } from "../src/adapters/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Works from both tests/ (tsc input) and .test-build/tests/ (test output). */
export const PROJECT_ROOT = path.resolve(here, "../..");

export interface Fixture {
  root: string;
  cleanup(): Promise<void>;
  write(relativePath: string, content: string | object): Promise<void>;
  read(relativePath: string): Promise<string>;
  exists(relativePath: string): Promise<boolean>;
  absolute(relativePath: string): string;
}

export async function createFixture(
  files: Record<string, string | object> = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ctx-sync-test-"));

  const fixture: Fixture = {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
    async write(relativePath, content) {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const serialized =
        typeof content === "string"
          ? content
          : `${JSON.stringify(content, null, 2)}\n`;
      await writeFile(target, serialized, "utf8");
    },
    async read(relativePath) {
      return readFile(path.join(root, relativePath), "utf8");
    },
    async exists(relativePath) {
      try {
        await stat(path.join(root, relativePath));
        return true;
      } catch {
        return false;
      }
    },
    absolute(relativePath) {
      return path.join(root, relativePath);
    },
  };

  for (const [relativePath, content] of Object.entries(files)) {
    await fixture.write(relativePath, content);
  }

  return fixture;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the compiled CLI in a fixture directory. */
export function runCli(
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  const cli = path.join(PROJECT_ROOT, "dist", "cli.js");
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment["CTX_SYNC_DEBUG"];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** A fully valid block with overridable fields. */
export function ruleBlock(overrides: Partial<RuleBlock> = {}): RuleBlock {
  const id = overrides.id ?? "typescript";
  return {
    id,
    title: "TypeScript conventions",
    description: "Conventions for TypeScript files.",
    body: "- Keep strict mode enabled.\n- Never add a runtime dependency.",
    sourcePath: `.ai/rules/${id}.md`,
    relativePath: `rules/${id}.md`,
    sourceAbsolutePath: `/repo/.ai/rules/${id}.md`,
    sourceLine: 8,
    order: 0,
    targets: listProfiles(),
    priority: 0,
    globs: [],
    alwaysApply: true,
    enabled: true,
    tags: [],
    frontmatter: {},
    ...overrides,
  };
}

/** A rule file with frontmatter, useful for end-to-end fixtures. */
export function ruleFile(
  frontmatter: string,
  body: string,
): string {
  return `---\n${frontmatter.trim()}\n---\n\n${body.trim()}\n`;
}
