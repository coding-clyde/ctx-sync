# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Node 20/22/24 CI, 58 tests with `node --test`, and self-hosted `.ai/` rules.
