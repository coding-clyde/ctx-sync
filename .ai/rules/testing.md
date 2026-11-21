---
id: testing
title: Testing expectations
targets: all
priority: 30
globs: ["tests/**/*.ts"]
tags: [testing]
---

# Testing expectations

- Use the built-in `node:test` runner and `node:assert/strict`; do not add
  Jest, Vitest, or Mocha.
- Tests live in `tests/` and are compiled by `tsconfig.test.json` before the
  runner starts. Import production code through `../src/*.js`.
- Every filesystem test creates an isolated fixture under the operating
  system's temporary directory and removes it in `t.after`.
- Never depend on network access, the user's home directory, or the current
  wall clock. Inject `now` where time matters.
- Cover the failure path as carefully as the happy path: invalid
  frontmatter, duplicate ids, unmanaged target files, stale Cursor rules,
  budget overruns, secret placeholders, and allowlists.
- Security tests must assert that raw secrets never appear in serialized
  findings or CLI output.
- A bug fix needs a regression test that fails before the fix.
