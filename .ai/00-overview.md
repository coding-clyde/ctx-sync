---
id: overview
title: Project overview
targets: all
priority: 100
alwaysApply: true
tags: [architecture, context]
---

# Project overview

ctx-sync is a zero-runtime-dependency CLI and GitHub Action that turns one
source of truth, `.ai/`, into the native context files used by AI assistants:
`CLAUDE.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, and
`.windsurfrules`.

## Design constraints

- Node.js 20+ and TypeScript with `strict` enabled.
- No packages in `dependencies`. The CLI uses only Node built-ins.
- Every generated file carries a `ctx-sync:generated` marker. Never hand-edit
  a generated file; edit the rule under `.ai/` and run `ctx-sync build`.
- Builds are deterministic. Output order is priority (descending), then source
  path. No timestamps or machine-specific paths are written.
- Existing files without the generated marker are considered user-owned and
  must not be overwritten unless the operator passes `--force`.
- `ctx-sync build --check` is the CI gate for drift. `ctx-sync audit` is the
  CI gate for token budgets and leaked secrets.

## Repository map

- `src/readers/` parses frontmatter and Markdown into rule blocks.
- `src/adapters/` renders each target profile.
- `src/auditor/` estimates tokens and scans for secrets.
- `src/sync.ts` plans diffs and performs atomic writes.
- `src/cli.ts` exposes `build` and `audit`.
- `tests/` runs with `node --test` against compiled JavaScript.
