# Contributing to ctx-syncr

Thanks for helping. The fastest contribution is a new assistant adapter: one
small file in `src/adapters/`. This guide covers the local setup, the
conventions the codebase enforces, and exactly how to add an adapter.

## Set up

You need Node.js 20 or newer and npm. CI runs Node 20, 22 and 24.

```bash
git clone https://github.com/coding-clyde/ctx-sync.git
cd ctx-sync
npm ci            # installs dev tooling only: TypeScript and Node types
npm run build     # tsc -> dist/
npm test          # builds, compiles the tests, runs node --test
```

Run your build against this repository, or against any other one:

```bash
node dist/index.js check                   # from this repository
cd ../some-project && node ../ctx-syncr/dist/index.js sync --targets claude
```

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` to `dist/`. |
| `npm test` | Build, compile `tests/` to `.test-build/`, run every test. |
| `npm run sync` | Build, then regenerate this repository's own context files. |
| `npm run check` | Build, then verify them. This is what CI runs (with `--strict`). |
| `npm run clean` | Delete `dist/` and `.test-build/`. |

`dist/` and `.test-build/` are generated and ignored by Git.

### This repository eats its own cooking

`CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md` and
`.windsurfrules` are generated from `.ai/`. Never edit them by hand. Change a
rule under `.ai/`, run `npm run sync` and commit both the source and the
generated files, or CI will fail on drift.

## Conventions

These are enforced by review and by CI. The full text lives in `.ai/rules/`.

- TypeScript with `strict` on. No `any`: use `unknown` and narrow it.
- ESM with `NodeNext`: relative imports include the `.js` extension, even from
  `.ts` files. Use `import type` for type-only imports.
- **Zero runtime dependencies.** `dependencies` stays empty and the CLI uses
  Node built-ins only. Dev tooling is limited to TypeScript and Node types.
- Tests use `node:test` and `node:assert/strict`. No Jest, Vitest or Mocha.
- Tests create isolated fixtures in the OS temp directory, never touch the
  network, and inject `now` instead of reading the clock.
- Test the failure path as carefully as the happy path. A bug fix comes with a
  regression test that fails without the fix.
- Output is deterministic: no timestamps, no absolute paths, stable ordering.
- Security tests assert that a raw secret never appears in findings or CLI
  output.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat(adapters): ...`, `fix(auditor): ...`, `docs: ...`, `test: ...`).

## Project layout

```text
src/
├── adapters/          one <name>Adapter.ts per assistant, auto-registered
│   ├── index.ts       registry: scans this directory at startup
│   └── shared.ts      createSingleFileAdapter() and rendering helpers
├── auditor/           secret detection, token budgets, terminal/JSON/CI reports
├── readers/           .ai/ discovery, frontmatter parser, token estimator
├── utils/             filesystem, formatting, path and GitHub helpers
├── cli.ts             argument parsing (util.parseArgs) and help text
├── index.ts           executable entry point and public API
├── init.ts            `ctx-syncr init` templates
├── sync.ts            plans diffs and writes files atomically
└── types.ts           shared types, including the Adapter contract
tests/                 *.test.ts, compiled to .test-build/ before running
```

## Add support for a new assistant

An adapter turns your parsed `.ai/` rules into the file an assistant reads. You
add one, and only one, source file. You do **not** register it anywhere: the
registry in `src/adapters/index.ts` scans the directory at startup, and
`--targets`, rule `targets`, config validation, `sync`, `check` and the CLI
help pick the new assistant up automatically.

### 1. Create `src/adapters/<name>Adapter.ts`

The file name must match `<name>Adapter.ts` using letters and digits only
(`zedAdapter.ts`, `clineAdapter.ts`, `jetbrainsAdapter.ts`) and it must
`export default` an `Adapter`. For an assistant that reads a single Markdown
file, use the factory:

```ts
// src/adapters/zedAdapter.ts
import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/** Zed reads `.rules` at the repository root. */
export const zedAdapter: Adapter = createSingleFileAdapter({
  id: "zed",
  order: 50,
  label: "Zed",
  defaultOutput: ".rules",
  title: "Zed rules",
});

export default zedAdapter;
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase token used in `--targets`, rule `targets` and the config. Must match `^[a-z][a-z0-9-]*$` and be unique. |
| `label` | yes | Human-readable name shown in reports. |
| `defaultOutput` | yes | Repository-relative POSIX path of the generated file. Users can override it in `ctx-syncr.config.json`. |
| `title` | yes | The single H1 of the generated file. |
| `order` | no | Position in reports (ascending). The built-ins use 10 to 40; adapters without one come last, sorted by `id`. |
| `index` | no | Emit a linked table of contents. Off by default. Keep it off for files that are always in context, like Copilot's. |
| `sourceComments` | no | Emit `<!-- source: ... -->` under each section. Off by default. |

### 2. Multi-file or custom formats

If the assistant needs several files, or its own frontmatter, implement
`Adapter` directly instead of using the factory. Set `kind: "rule-directory"`,
list the generated `extensions`, and return one `GeneratedFile` per output from
`render()`. `src/adapters/cursorAdapter.ts` is the reference. Two rules apply to
every adapter:

- Every generated file must carry the `ctx-syncr:generated` marker (use
  `generatedHeader()` from `shared.ts`). The marker is how ctx-syncr knows which
  files it may overwrite or delete; files without it are treated as yours.
- Rendering must be deterministic and must use `blocksForProfile()` so
  `targets`, `enabled` and `priority` behave the same for every assistant.

### 3. Build and try it

```bash
npm run build
cd /path/to/a/scratch/repo
node /path/to/ctx-syncr/dist/index.js init
node /path/to/ctx-syncr/dist/index.js sync --targets zed
```

```text
  created   .rules (413 est. tokens)
```

A broken adapter (no default export, an invalid or duplicate `id`) stops the
CLI at startup with an `adapter.invalid` error, so you find out immediately.

### 4. Tests

Add `tests/<name>Adapter.test.ts` that renders a few rules through your adapter
and asserts the output path, the generated marker and the content. Reuse
`createFixture`, `ruleBlock` and `ruleFile` from `tests/helpers.ts`. The test
`a new assistant is added by creating a single adapter file` in
`tests/adapters.test.ts` shows how to load an adapter in isolation.

Heads-up: several existing tests assert the exact list and number of built-in
assistants (profile lists, generated file counts, one row per assistant). When
your adapter becomes a built-in, `npm test` will fail in `adapters.test.ts`,
`audit.test.ts`, `auditor.test.ts`, `contextAuditor.test.ts` and `sync.test.ts`.
Update those expectations in the same pull request; each failure prints the
expected and actual lists.

### 5. Docs

- Move the assistant to **Supported** in the roadmap table in `README.md`.
- Add a line under `## [Unreleased]` → `### Added` in `CHANGELOG.md`.

Do not bump the version; maintainers do that at release time.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run check` passes (run `npm run sync` first if you touched `.ai/`).
- [ ] New behavior has tests, including the failure path.
- [ ] No new runtime dependency.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]`.
- [ ] No real credentials in code, tests, fixtures or examples. Use obvious
      placeholders such as `YOUR_API_KEY`.

## Ask for an adapter instead

Not ready to write one? Open an
[adapter request](https://github.com/coding-clyde/ctx-sync/issues/new?template=new-adapter.md)
with the assistant's rules file location and format. Requests that link to the
official documentation are the quickest to build.
