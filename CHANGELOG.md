# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

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
