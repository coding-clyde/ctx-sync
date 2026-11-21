---
name: New adapter request
about: Ask ctx-sync to support a new AI assistant or editor (Cline, Zed, Aider, JetBrains AI, Gemini CLI, ...)
title: "adapter: <assistant name>"
labels: ["adapter", "enhancement"]
assignees: ""
---

<!--
Thanks for asking! An adapter turns your `.ai/` rules into the file an
assistant reads, and each one is a single file in `src/adapters/`.
Search the open issues first; if this assistant already has one, add your
details there instead of opening a new issue.
-->

## Assistant or editor

- **Name:**
- **Vendor / project URL:**
- **Kind:** <!-- IDE, editor extension, CLI agent, web tool... -->
- **Version you tested with:**

## Where does it read project instructions?

<!-- Link the official documentation. Requests with a docs link are the quickest to build. -->

- **Documentation link:**
- **Path(s) in the repository:** <!-- e.g. `.rules`, `.clinerules/`, `.aiassistant/rules/` -->
- **One file or a directory of files?**
- **File format:** <!-- plain Markdown, Markdown with YAML frontmatter, .mdc, JSON... -->
- **Loaded automatically?** <!-- If not, what must the user configure? e.g. a `read:` entry or a setting -->

## Features that affect the output

<!-- Tick what applies and describe it briefly. -->

- [ ] Rules can be scoped to file patterns (globs)
- [ ] Rules can be marked "always apply" or "apply manually"
- [ ] It requires its own frontmatter fields (which ones?)
- [ ] It has a documented size or token limit (how large?)
- [ ] It already reads another tool's file (for example `CLAUDE.md` or `.windsurfrules`)

Details:

## Suggested adapter

<!-- Optional. Fill in what you can; maintainers will adjust it. -->

| Field | Suggestion |
| --- | --- |
| `id` | <!-- lowercase, e.g. `zed` --> |
| `label` | <!-- e.g. `Zed` --> |
| `defaultOutput` | <!-- e.g. `.rules` --> |
| Kind | <!-- single file, or a directory of rule files --> |

## Example of a native rules file

<!-- Paste a short, real example of what this assistant expects. Use placeholders, never real credentials. -->

```text

```

## Why it matters

<!-- Who uses this assistant, and what goes wrong today when they keep its rules in sync by hand? -->

## Can you help?

- [ ] I can open a pull request. (See [CONTRIBUTING.md](https://github.com/coding-clyde/ctx-sync/blob/master/CONTRIBUTING.md#add-support-for-a-new-assistant).)
- [ ] I can test a pre-release build against a real project.
- [ ] I can only request it for now.

## Checklist

- [ ] I searched the existing issues and the roadmap in the README.
- [ ] I linked the assistant's official documentation.
- [ ] My example contains no secrets, tokens or private URLs.
