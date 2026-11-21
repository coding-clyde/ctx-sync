---
id: security
title: Security and secrets
targets: all
priority: 90
alwaysApply: true
tags: [security]
---

# Security and secrets

- Context files are committed and loaded by assistants. Treat every line in
  `.ai/` as public. Never place credentials, customer data, internal URLs, or
  private keys in a rule.
- Read configuration values from the environment at runtime. Do not paste
  real values into examples; use obvious placeholders such as
  `YOUR_API_KEY`.
- The auditor scans both source rules and rendered outputs. Findings are
  redacted: they carry a rule id, path, line, matched length, and a
  non-reversible fingerprint, never the secret itself.
- Suppress a known-safe fixture with a `ctx-sync:allow-secret` comment on the
  same or previous line, or add a narrowly scoped regular expression to
  `secrets.allowlist` in `ctx-sync.config.json`.
- Never weaken a high-signal pattern to silence a false positive. Prefer an
  allowlist entry with a comment explaining why the value is safe.
- CI must run `ctx-sync audit --fail-on warning`. A redacted finding requires
  rotating the credential if it was ever real.
