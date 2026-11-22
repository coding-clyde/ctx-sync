# ctx-syncr

**One `.ai/` folder to keep `CLAUDE.md`, `.cursor/rules`, GitHub Copilot and Windsurf in sync — without wasting tokens.**

[![npm version](https://img.shields.io/npm/v/ctx-syncr.svg)](https://www.npmjs.com/package/ctx-syncr)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![CI](https://github.com/coding-clyde/ctx-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/coding-clyde/ctx-sync/actions/workflows/ci.yml)
[![node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)

Write your AI rules once in `.ai/`. ctx-syncr compiles them into the native file
each assistant reads, shows what every assistant costs you in tokens, and
blocks leaked secrets before they reach a commit, a pull request or a prompt.

```bash
npx ctx-syncr init     # scaffold .ai/ with ready-to-edit rules
npx ctx-syncr sync     # audit, then write CLAUDE.md, .cursor/rules, Copilot and Windsurf files
npx ctx-syncr check    # CI gate: fail on drift or leaked secrets
```

## Why ctx-syncr

Every AI editor invented its own context file. Teams copy the same rules into
four places, the copies drift, nobody knows which one is current, every
always-on line is paid for in tokens on every request, and sooner or later an
API key ends up in one of them. ctx-syncr treats editor context like code.

- **One source of truth.** Rules live in `.ai/**/*.md`. Output is
  deterministic: same source, same bytes.
- **Token-aware.** Every run prints the estimated tokens each assistant loads,
  against a budget (default 4,000). Scope a rule to specific assistants with
  `targets`, or to file patterns with `globs`, so each tool loads only what it
  needs.
- **Secret-proof.** `sync` audits before it writes. If it finds a credential it
  writes nothing, so a leaked key is never copied into four files. Findings are
  redacted: the raw secret is never printed.
- **CI-native.** `ctx-syncr check` fails the build when a generated file drifts
  from `.ai/` or a secret is exposed, with annotations on the pull request.
- **Safe by default.** Files ctx-syncr did not generate are never overwritten
  without `--force`. Writes are atomic.
- **Zero runtime dependencies.** Node.js 20+ built-ins only.

## Quick start

```bash
npx ctx-syncr init
```

This creates `.ai/` with four starter rules (`00-overview.md`,
`coding-style.md`, `testing.md`, `security.md`) that already pass
`check --strict`. Edit them, then compile and commit the result:

```bash
npx ctx-syncr sync
git add .ai CLAUDE.md .cursor .github/copilot-instructions.md .windsurfrules
```

Commit the generated files so each editor gets its context without running a
build first. To use the command without `npx`, install it:
`npm install --save-dev ctx-syncr`.

### What it prints

Real output (ctx-syncr v0.1.0) from `sync` on a fresh `init`:

```text
$ npx ctx-syncr sync
ctx-syncr sync v0.1.0

  created   .cursor/rules/project.mdc (435 est. tokens)
  created   .github/copilot-instructions.md (417 est. tokens)
  created   .windsurfrules (416 est. tokens)
  created   CLAUDE.md (488 est. tokens)

Wrote 4 files, removed 0; 0 unchanged.

ctx-syncr audit v0.1.0 (audit mode)
350 estimated tokens in total | budget 4,000 | 8 files scanned

Tokens by assistant
  Claude Code            488   12%  CLAUDE.md (4 rules)
  Cursor                 435   11%  .cursor/rules/project.mdc (4 rules)
  GitHub Copilot         417   10%  .github/copilot-instructions.md (4 rules)
  Windsurf               416   10%  .windsurfrules (4 rules)

Result OK - 0 critical, 0 warnings
```

The total counts your rules once; each assistant line is the full generated
file, headers included, and the percentage is its share of the token budget.

This repository uses ctx-syncr on itself. Its `check` output shows the effect of
scoping: the release checklist targets only `claude` and `copilot`, so Cursor
and Windsurf load 4 rules instead of 5 and never pay for it.

```text
$ npx ctx-syncr check
ctx-syncr audit v0.1.0 (check mode)
1,246 estimated tokens in total | budget 4,000 | 11 files scanned

Tokens by assistant
  Claude Code          1,436   36%  CLAUDE.md (5 rules)
  Cursor               1,396   35%  .cursor/rules/project.mdc +2 (4 rules)
  GitHub Copilot       1,328   33%  .github/copilot-instructions.md (5 rules)
  Windsurf             1,205   30%  .windsurfrules (4 rules)

Result OK - 0 critical, 0 warnings
```

And when someone pastes a credential into a rule, `sync` refuses to write
anything (the token table is omitted here for brevity):

```text
$ npx ctx-syncr sync
ctx-syncr audit v0.1.0 (audit mode)
373 estimated tokens in total | budget 4,000 | 8 files scanned

[...]

Issues
  CRITICAL GitHub token detected (40 chars, fingerprint 2846512a47d819ca). Remove it and rotate the credential if it is real. .ai/00-overview.md:26

Result CRITICAL - 1 critical, 0 warnings

No files were written: fix the critical issues above and run `ctx-syncr sync` again.
```

The command exits with code `1`, and the token itself appears nowhere in the
output.

## Write a rule

Every `.md` file under `.ai/` is one rule. Frontmatter is optional:

```markdown
---
id: typescript
title: TypeScript conventions
targets: [claude, cursor, copilot, windsurf]
priority: 40
globs:
  - "**/*.ts"
  - "**/*.tsx"
tags: [typescript]
---

# TypeScript conventions

- Keep `strict: true`.
- Never add a runtime dependency.
- Use `import type` for type-only imports.
```

| Source | Compiled output | Consumer |
| --- | --- | --- |
| `.ai/**/*.md` | `CLAUDE.md` | Claude Code |
| `.ai/**/*.md` | `.cursor/rules/<id>.mdc` | Cursor |
| `.ai/**/*.md` | `.github/copilot-instructions.md` | GitHub Copilot |
| `.ai/**/*.md` | `.windsurfrules` | Windsurf |

Cursor gets one `project.mdc` for rules that always apply, plus one `.mdc` per
rule scoped by `globs`, so Cursor attaches those only when they are relevant.
See [Source format](#source-format) for every frontmatter key.

### Example Output

```text
$ ctx-syncr sync
ctx-syncr sync v0.1.0

  created   .cursor/rules/project.mdc (435 est. tokens)
  created   .github/copilot-instructions.md (417 est. tokens)
  created   .windsurfrules (416 est. tokens)
  created   CLAUDE.md (488 est. tokens)

Wrote 4 files, removed 0; 0 unchanged.

ctx-syncr audit v0.1.0 (audit mode)
350 estimated tokens in total | budget 4,000 | 8 files scanned

Tokens by assistant
  Claude Code            488   12%  CLAUDE.md (4 rules)
  Cursor                 435   11%  .cursor/rules/project.mdc (4 rules)
  GitHub Copilot         417   10%  .github/copilot-instructions.md (4 rules)
  Windsurf               416   10%  .windsurfrules (4 rules)

Result OK - 0 critical, 0 warnings
```

## GitHub Actions

Copy this into `.github/workflows/ai-context.yml`. It fails the pull request
when a generated file is missing or out of date with `.ai/`, or when a secret
is exposed:

```yaml
name: AI context

on:
  pull_request:

permissions:
  contents: read

jobs:
  ctx-syncr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: coding-clyde/ctx-sync@v1   # pin a release tag or a commit SHA
        with:
          strict: "true"        # also fail on warnings, e.g. an exceeded token budget
          max-tokens: "4000"    # optional; 0 disables the budget
          # targets: claude,cursor   # optional; default: every enabled assistant
```

Each finding is also emitted as an `::error` / `::warning` annotation with its
file and line.

| Input | Default | Meaning |
| --- | --- | --- |
| `targets` | all enabled | Comma-separated assistants to check. |
| `max-tokens` | `4000` | Token budget per assistant and in total; `0` disables it. |
| `strict` | `false` | Fail on warnings too. |

The action sets up Node 20 and builds ctx-syncr on first use (`npm ci` installs
only TypeScript dev dependencies; the runtime has none). Prefer no action? The
same gate is one step:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx --yes ctx-syncr check --strict
```

## CLI reference

Run commands from the repository root. Color is used only on a terminal and is
disabled by `NO_COLOR`.

| Command | What it does |
| --- | --- |
| `ctx-syncr init` | Create a starter `.ai/` folder. Refuses to touch an `.ai/` that already has content. |
| `ctx-syncr sync` | Audit, then write `CLAUDE.md` and the other target files. Writes nothing if the audit finds a critical issue. |
| `ctx-syncr check` | Read-only CI gate: generated files are in sync and the context is safe. |
| `ctx-syncr help [command]` | Show help. Same as `--help`. |

| Flag | Commands | Default | Meaning |
| --- | --- | --- | --- |
| `--targets <list>` | `sync`, `check` | every enabled assistant | Comma-separated assistants (`claude`, `cursor`, `copilot`, `windsurf`). May be repeated. |
| `--max-tokens <n>` | `sync`, `check` | `4000` | Token budget, per assistant and for the whole source. `0` disables it. |
| `--strict` | `sync`, `check` | off | Exit `1` on warnings too, not only on critical findings. |
| `--force` | `sync` | off | Overwrite target files that ctx-syncr did not generate. |
| `--json` | `init`, `sync`, `check` | off | One JSON document on stdout, no ANSI colors. |
| `-h`, `--help` | all | | Show help (`ctx-syncr <command> --help` for one command). |
| `-v`, `--version` | | | Show the version. |

| Exit code | Meaning |
| --- | --- |
| `0` | Everything is correct (warnings are tolerated unless `--strict`). |
| `1` | Critical findings, or warnings with `--strict`. |
| `2` | Usage, configuration or file error (missing `.ai/`, unreadable file, unmanaged target, bad flag). Printed as one `error:` line, never a stack trace. |
| `3` | Unexpected internal error. Set `CTX_SYNCR_DEBUG=1` for a stack trace. |

| Severity | Examples |
| --- | --- |
| `critical` | An exposed secret or API key; a generated file out of sync (`check`); an invalid rule in `.ai/`. |
| `warning` | Token budget exceeded; an empty or duplicated rule. |

With `--json`, stdout is a single document (schema v1: `severity`, `issues`,
`assistants`, `totalTokens`, ...). `sync --json` adds a `sync` field with the
files it wrote. Exit code `2` errors go to stderr and leave stdout empty.

### How `sync` stays safe

1. It reads `.ai/` and **audits first**: secrets, token budget, empty and
   duplicate rules.
2. On a **critical** finding it writes **nothing**.
3. Otherwise it writes the target files atomically (temp file + rename),
   rewriting only those whose content changed.

Generated files carry a stable marker:

```html
<!-- ctx-syncr:generated profile="claude" version="0.1.0" -->
```

An existing file without that marker is yours: `sync` stops with exit code `2`
and leaves it untouched unless you pass `--force`. Cursor cleanup only deletes
`.mdc` files that carry the marker; handwritten rules in `.cursor/rules/` are
always preserved.

## Supported assistants and roadmap

| Assistant | Output | Status |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` | ✅ Supported |
| Cursor | `.cursor/rules/*.mdc` | ✅ Supported |
| GitHub Copilot | `.github/copilot-instructions.md` | ✅ Supported |
| Windsurf | `.windsurfrules` | ✅ Supported |
| Cline | `.clinerules/` | 🛠 Planned |
| Zed | `.rules` | 🛠 Planned |
| Aider | `CONVENTIONS.md` (loaded through `read:` in `.aider.conf.yml`) | 🛠 Planned |
| JetBrains AI Assistant | `.aiassistant/rules/*.md` | 🛠 Planned |
| Gemini CLI | `GEMINI.md` | 🙋 Help wanted |
| Codex and other `AGENTS.md` readers | `AGENTS.md` | 🙋 Help wanted |

Missing your assistant? Each one is a single file in `src/adapters/`, usually
under 20 lines. [Request an adapter](https://github.com/coding-clyde/ctx-sync/issues/new?template=new-adapter.md)
or send a pull request: the steps are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Reference

### Source format

Every `.md` or `.markdown` file under `.ai/` is one rule. Hidden files, hidden
directories and `node_modules` are ignored. A leading H1 becomes the rule title
and is removed from the body; all remaining Markdown is preserved.

Frontmatter is optional and uses a dependency-free YAML subset: scalars, quoted
strings, booleans, numbers, inline arrays, dash arrays and `|`/`>` block
strings. Unknown keys are preserved but not emitted.

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `id` | string | filename slug | Stable id and Cursor filename. Normalized to lowercase kebab case. |
| `title` | string | H1 or id | Heading used in compiled output. |
| `description` | string | first paragraph or list item | Cursor rule description. Single line, max 220 chars. |
| `targets` | profile list or `all` | all | Which assistants receive the rule. |
| `priority` | number | `0` | Higher priority renders first. Clamped to -1000..1000. |
| `globs` | string or string[] | `[]` | Cursor auto-attach globs. |
| `alwaysApply` | boolean | `true` when no globs | Cursor always-apply flag. |
| `enabled` | boolean | `true` | Keep the source but omit the rule when false. |
| `tags` | string or string[] | `[]` | Metadata for humans and future tooling. |
| `maxTokens` | positive integer | config default | Per-rule audit budget. |

`files`, `patterns` and `filePatterns` are accepted as aliases for `globs`;
`assistants` and `profiles` are accepted as aliases for `targets`. A typo in
`targets` is a build error, never a silent fallback to every assistant.
Duplicate ids are also build errors.

### Token budgets

The estimator is deterministic and dependency-free (`heuristic-v1`): roughly
four Latin characters per token, one token per CJK character, with whitespace
and punctuation included. Treat results as a planning estimate (±20%), not a
provider-exact tokenizer. Provider tokenizers change frequently; guessing a
specific BPE table would be worse.

The CLI budget is `--max-tokens` (default 4,000, `0` disables it). Exceeding it
for the whole source or for any single assistant is a `warning`, which only
fails the run with `--strict`. Per-assistant totals measure complete generated
files, including headers; Cursor sums all its generated `.mdc` files.

The finer-grained budgets below (`tokenBudget` in `ctx-syncr.config.json`,
per-rule `maxTokens`) are used by the programmatic `auditProject()` API and are
not consulted by `ctx-syncr sync`/`check`:

- `maxPerProfile`: 12,000 tokens per compiled target.
- `maxPerBlock`: 2,500 tokens per rule.
- Above 1x the budget: `warning`. Above 2x: `critical`. `0` disables it.

### Secret detection

The auditor scans every source file under `.ai/` plus every rendered output.
Findings contain a rule id, path, line, column, matched length, a redacted
preview (`[redacted N chars]`) and a non-reversible fingerprint. **The raw
secret is never stored in the report or printed by the CLI.**

Detectors include:

- PEM/OpenSSH/PGP private key headers
- AWS access key IDs
- GitHub, npm, Hugging Face, Slack, OpenAI, Anthropic, Google and Stripe keys
- Slack and Discord webhook URLs
- Database/broker connection strings with inline credentials
- Bearer tokens, JWTs and generic credential assignments

Obvious placeholders (`YOUR_API_KEY`, `${DB_PASSWORD}`, `example`, `xxxx`) are
ignored. Stripe test keys produce warnings; other credentials produce critical
findings.

Suppression options, in order of preference:

```markdown
<!-- ctx-syncr:allow-secret -->
The fixture below is fake and covered by the explicit marker.
```

Or in `ctx-syncr.config.json`:

```json
{
  "secrets": {
    "allowlist": ["^example-fixture-[0-9]+$"],
    "disabledRules": ["jwt"]
  }
}
```

Allowlist entries are case-insensitive JavaScript regular expressions tested
against the matched value and its full source line. Keep them narrow and
document why a fixture is safe. A detected credential may already have leaked;
rotate it even after removing it.

This scanner is a focused context-file guard, not a replacement for
repository-wide secret scanning or provider-side key revocation.

### Configuration

`ctx-syncr.config.json` is optional. Defaults:

```json
{
  "sourceDir": ".ai",
  "profiles": {
    "claude": { "enabled": true, "output": "CLAUDE.md" },
    "cursor": { "enabled": true, "output": ".cursor/rules" },
    "copilot": { "enabled": true, "output": ".github/copilot-instructions.md" },
    "windsurf": { "enabled": true, "output": ".windsurfrules" }
  },
  "tokenBudget": {
    "maxPerProfile": 12000,
    "maxPerBlock": 2500
  },
  "secrets": {
    "allowlist": [],
    "disabledRules": []
  }
}
```

Output paths must stay inside the repository. Cursor output is a directory
(`project.mdc` for rules that always apply, plus one `.mdc` per rule scoped by
`globs`); the other outputs are files. Two profiles cannot write to the same
path. Unknown config keys are rejected so typos cannot silently disable
protection.

### Use as a library

The CLI is built on small, read-only modules that you can import:

```ts
import { readProjectContext } from "ctx-syncr";

const context = await readProjectContext({ rootDir: process.cwd() });
console.log(context.source.blocks, context.tokens.total, context.existingOutputs);
```

`readProjectContext()` bundles the parsed `.ai/` source, token estimates and the
native context files that already exist. `auditContext()`, `syncProject()` and
the adapter registry are exported from the same entry point.

## Contributing

Bug reports, adapters and docs fixes are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); to ask for a new assistant, open an
[adapter request](https://github.com/coding-clyde/ctx-sync/issues/new?template=new-adapter.md).

If ctx-syncr saves you from drifting rule files, a star on GitHub helps other
teams find it.

## License

MIT. See [LICENSE](LICENSE).
