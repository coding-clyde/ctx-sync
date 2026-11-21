# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
- `ctx-sync build`, `--check`, `--dry-run`, `--force`, profile selection, and
  atomic writes with generated-file markers.
- Safe stale Cursor rule cleanup that never deletes handwritten `.mdc` files.
- Token estimator with per-rule and per-profile budgets.
- Secret scanner with redacted findings, fingerprints, allowlists, inline
  suppression markers, and placeholder filtering.
- `ctx-sync audit` with text, JSON, and GitHub Actions annotation output.
- GitHub Action with `build` and `audit` modes.
- Node 20/22/24 CI, 66 tests with `node --test`, and self-hosted `.ai/` rules.
