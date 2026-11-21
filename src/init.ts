/**
 * `ctx-sync init`: scaffold a starter `.ai/` folder.
 *
 * The templates are deliberately generic and pass `ctx-sync check` as-is, so a
 * fresh `init` followed by `sync` works with zero edits. They contain no
 * secrets and no language-specific advice: replace them with your own rules.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { CtxSyncError } from "./errors.js";
import { removeFile, writeTextFileAtomic } from "./utils/fs.js";

export const INIT_SOURCE_DIR = ".ai";

export interface InitTemplate {
  /** Path relative to the source directory, POSIX separators. */
  path: string;
  content: string;
}

export const INIT_TEMPLATES: readonly InitTemplate[] = [
  {
    path: "00-overview.md",
    content: `---
id: overview
title: Project overview
targets: all
priority: 100
alwaysApply: true
tags: [overview]
---

# Project overview

<!-- Replace this section with a short description of your project. -->

- What the project does and who uses it.
- The main languages, frameworks and tools.
- Where the important code lives (for example \`src/\`, \`tests/\`).

## Working agreements

- Prefer small, focused changes and explain the reason in the commit message.
- Ask before adding a new dependency.
- Keep this file short: every line here is sent to the assistant on each request.
`,
  },
  {
    path: "rules/coding-style.md",
    content: `---
id: coding-style
title: Coding style
targets: all
priority: 50
alwaysApply: true
tags: [style]
---

# Coding style

- Follow the formatter and linter already configured in the repository; do not
  reformat unrelated code.
- Name things for what they mean, not how they are implemented.
- Keep functions small and single-purpose; extract helpers instead of nesting.
- Handle errors explicitly and report them with an actionable message.
- Comment the *why*, not the *what*.
`,
  },
  {
    path: "rules/testing.md",
    content: `---
id: testing
title: Testing
targets: all
priority: 30
alwaysApply: true
tags: [testing]
---

# Testing

- Every bug fix comes with a test that fails without the fix.
- Test behaviour through public interfaces, not private implementation details.
- Tests must be deterministic: no network, no wall-clock time, no shared state.
- Run the full test suite before proposing a change.
`,
  },
  {
    path: "rules/security.md",
    content: `---
id: security
title: Security
targets: all
priority: 90
alwaysApply: true
tags: [security]
---

# Security

- Never put credentials, tokens or private keys in this folder or in code;
  read them from the environment. Everything under \`.ai/\` is committed and
  sent to AI assistants.
- Use obvious placeholders in examples, such as \`YOUR_API_KEY\`.
- Validate and sanitize all external input.
- Do not log personal data or secrets.
`,
  },
];

export interface InitResult {
  /** Repository-relative source directory that was created. */
  sourceDir: string;
  /** Repository-relative POSIX paths of the files that were written. */
  created: string[];
}

/**
 * Create `.ai/` with the starter templates.
 *
 * Never overwrites anything: if `.ai/` already exists and has content (or is
 * not a directory) it fails with a clear message and writes nothing.
 */
export async function initProject(options: {
  rootDir: string;
}): Promise<InitResult> {
  const rootDir = path.resolve(options.rootDir);

  try {
    const stats = await fs.stat(rootDir);
    if (!stats.isDirectory()) {
      throw new CtxSyncError(`Not a directory: ${rootDir}`, {
        code: "init.root",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CtxSyncError(`Directory not found: ${rootDir}`, {
        code: "init.root",
        cause: error,
      });
    }
    throw error;
  }

  const sourceDir = path.join(rootDir, INIT_SOURCE_DIR);
  try {
    const stats = await fs.stat(sourceDir);
    if (!stats.isDirectory()) {
      throw new CtxSyncError(
        `${INIT_SOURCE_DIR} exists but is not a directory. Rename or remove it, then run \`ctx-sync init\` again.`,
        { code: "init.exists" },
      );
    }
    const entries = await fs.readdir(sourceDir);
    if (entries.length > 0) {
      throw new CtxSyncError(
        `${INIT_SOURCE_DIR}/ already exists and is not empty; refusing to overwrite it. ` +
          "Edit the files there, or move the folder aside and run `ctx-sync init` again.",
        { code: "init.exists" },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const written: string[] = [];
  try {
    for (const template of INIT_TEMPLATES) {
      await writeTextFileAtomic(
        path.join(sourceDir, ...template.path.split("/")),
        template.content,
      );
      written.push(`${INIT_SOURCE_DIR}/${template.path}`);
    }
  } catch (error) {
    // Do not leave a half-initialized folder behind.
    for (const file of written) {
      await removeFile(path.join(rootDir, file)).catch(() => undefined);
    }
    throw new CtxSyncError(
      `Could not create ${INIT_SOURCE_DIR}/: ${(error as Error).message}`,
      { code: "init.write", cause: error },
    );
  }

  return { sourceDir: INIT_SOURCE_DIR, created: written };
}
