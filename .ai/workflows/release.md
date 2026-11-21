---
id: release
title: Release checklist
targets: [claude, copilot]
priority: 20
globs: []
tags: [release]
---

# Release checklist

1. Run `npm test` and `npm run check` on a clean checkout.
2. Run `node dist/index.js check --strict`.
3. Update `CHANGELOG.md` and bump the version in both `package.json` and
   `src/version.ts`. `tests/version.test.ts` enforces that they match.
4. Verify `npm pack --dry-run` contains `dist/`, `action.yml`, `README.md`,
   and `LICENSE`, and no test artifacts.
5. Tag the release. The GitHub Action references the compiled `dist/index.js`
   at the tagged ref.
