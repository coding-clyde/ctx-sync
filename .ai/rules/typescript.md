---
id: typescript
title: TypeScript conventions
targets: all
priority: 40
globs:
  - "**/*.ts"
  - "**/*.tsx"
tags: [typescript]
---

# TypeScript conventions

- Keep `strict: true`. Do not add `any`; prefer `unknown` plus a narrowing
  function at trust boundaries.
- The package is ESM (`"type": "module"`) with `module` and
  `moduleResolution` set to `NodeNext`. Relative imports must include the
  `.js` extension, even from `.ts` files.
- Use `import type` for type-only imports. `verbatimModuleSyntax` is enabled.
- Prefer narrow interfaces in `src/types.ts` over ad-hoc object shapes.
- Never introduce a runtime dependency. Small, well-tested utilities are
  better than a package. Dev-only tooling is limited to TypeScript and Node
  type definitions.
- Paths in public output are repository-relative POSIX paths. Use the helpers
  in `src/utils/paths.ts`; never print absolute paths in generated files.
- Keep user-facing errors actionable: say what failed, where, and how to fix
  it. Include a stable error code for automation.
- Write asynchronous filesystem code with `node:fs/promises`. Generated
  files are written atomically through `writeTextFileAtomic`.
