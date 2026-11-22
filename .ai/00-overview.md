---
id: overview
title: Project overview
targets: all
priority: 100
alwaysApply: true
tags: [architecture, context]
---

# Project overview

ctx-syncr is a zero-runtime-dependency CLI and GitHub Action that turns one
source of truth, `.ai/`, into the native context files used by AI assistants:
`CLAUDE.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, and
`.windsurfrules`.

## Design constraints

- Node.js 20+ and TypeScript with `strict` enabled.
- No packages in `dependencies`. The CLI uses only Node built-ins.
- Every generated file carries a `ctx-syncr:generated` marker. Never hand-edit
  a generated file; edit the rule under `.ai/` and run `ctx-syncr sync`.
- Builds are deterministic. Output order is priority (descending), then source
  path. No timestamps or machine-specific paths are written.
- Existing files without the generated marker are considered user-owned and
  must not be overwritten unless the operator passes `--force`.
- `ctx-syncr check` is the CI gate: it fails on drift between `.ai/` and the
  generated files and on leaked secrets (`--strict` also fails on token
  budget warnings). `ctx-syncr sync` audits first and writes nothing when a
  secret is found.

## Repository map

- `src/readers/` parses frontmatter and Markdown into rule blocks.
- `src/adapters/` renders each target profile. Each assistant is one
  `<name>Adapter.ts` file auto-registered by `src/adapters/index.ts`.
- `src/auditor/` estimates tokens and scans for secrets.
- `src/sync.ts` plans diffs and performs atomic writes.
- `src/cli.ts` parses `sync`, `check` and `init` with `util.parseArgs`;
  `src/index.ts` is the executable entry point and the public API.
- `src/init.ts` scaffolds a starter `.ai/` folder.
- `tests/` runs with `node --test` against compiled JavaScript.
