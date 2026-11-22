# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- New command line: `ctx-syncr init`, `ctx-syncr sync` and `ctx-syncr check`,
  parsed with `util.parseArgs` in `src/cli.ts`, with `--targets`,
  `--max-tokens`, `--strict`, `--json`, `--help`/`-h` and `--version`/`-v`
  (plus `--force` for `sync`). Exit code 1 on critical findings (also on
  warnings with `--strict`), 2 on usage/file errors, with one-line messages
  and no stack traces.
- `init` scaffolds `.ai/` with four starter rules and never overwrites an
  existing `.ai/`.
- `sync` audits before writing and writes nothing when a critical finding
  (such as an exposed secret) exists.
- `src/index.ts` is now the executable (`#!/usr/bin/env node`) and the public
  API; the `bin` entry points to `dist/index.js`.

- `src/auditor/contextAuditor.ts`: `auditContext()` grades the compiled context
  `ok`/`warning`/`critical`. Critical: exposed secrets (Anthropic, OpenAI,
  GitHub, AWS, Bearer, ...) or, in `check` mode, generated files out of sync
  with `.ai/`. Warning: over `maxTokens` (default 4000), or empty/duplicate
  rules. `ignorePatterns` skips known false positives.
- `src/auditor/reporter.ts`: ANSI terminal report with a per-assistant token
  breakdown, clean `--json` output, and `::error::`/`::warning::` annotations
  when `GITHUB_ACTIONS=true`.
- Bearer detection no longer requires an `Authorization:` prefix.
- Adapter registry in `src/adapters/index.ts` that auto-discovers
  `src/adapters/*Adapter.ts` modules, so a new assistant is a single new file.
  Exposes `listProfiles()`, `getAdapter()` and `isTargetProfile()`.
- `CLAUDE.md` now has an auto-generated header, a linked index and
  source comments; rule headings are nested under each section.

### Changed

- **Breaking:** `ctx-syncr build` and `ctx-syncr audit` are replaced by `sync`
  and `check`; `--profile` is now `--targets`. The GitHub Action now runs
  `ctx-syncr check` and accepts only `targets`, `max-tokens` and `strict`
  (it also sets up Node 20).
- `npm test` passes explicit test files to `node --test`; passing a directory
  no longer works on Node 22+.

- Adapters renamed to `claudeAdapter.ts`, `cursorAdapter.ts`,
  `copilotAdapter.ts` and `windsurfAdapter.ts`. `TargetProfile` is now a
  string validated against the registry; `TARGET_PROFILES`,
  `TARGET_PROFILE_LABELS`, `TARGET_PROFILE_DEFAULT_OUTPUTS`,
  `TARGET_PROFILE_KINDS` and `isTargetProfile` moved from `types.ts` to the
  adapters (`isTargetProfile` is now exported from `adapters/index.ts`).
- Cursor: rules that always apply are merged into `.cursor/rules/project.mdc`;
  rules with `globs` keep their own `.mdc` file.
- Stale generated file cleanup now applies to any `rule-directory` adapter.

- Split source discovery/parsing into `src/readers/sourceReader.ts`, token
  measurement into `src/readers/tokenEstimator.ts`, and added
  `readProjectContext()` in `src/readers/index.ts` to validate `.ai`, estimate
  tokens per file and block, and detect existing native context files.
- Existing `readSourceTree` and `auditor/tokens.ts` imports remain supported as
  compatibility re-exports.

## [0.1.0] - 2026-11-21

### Added

- Deterministic compiler from `.ai/` Markdown rules to `CLAUDE.md`,
  `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, and
  `.windsurfrules`.
- Dependency-free YAML frontmatter parser and rule validation.
- `ctx-syncr build`, `--check`, `--dry-run`, `--force`, profile selection, and
  atomic writes with generated-file markers.
- Safe stale Cursor rule cleanup that never deletes handwritten `.mdc` files.
- Token estimator with per-rule and per-profile budgets.
- Secret scanner with redacted findings, fingerprints, allowlists, inline
  suppression markers, and placeholder filtering.
- `ctx-syncr audit` with text, JSON, and GitHub Actions annotation output.
- GitHub Action with `build` and `audit` modes.
- Node 20/22/24 CI, 66 tests with `node --test`, and self-hosted `.ai/` rules.
