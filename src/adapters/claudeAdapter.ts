import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/**
 * Claude Code reads `CLAUDE.md` at the repository root at the start of every
 * session. The file gets an auto-generated header (HTML comments, which cost
 * no context), a linked index so the outline is scannable, and one `##`
 * section per rule with its headings nested underneath.
 */
export const claudeAdapter: Adapter = createSingleFileAdapter({
  id: "claude",
  order: 10,
  label: "Claude Code",
  defaultOutput: "CLAUDE.md",
  title: "Repository context",
  index: true,
  sourceComments: true,
});

export default claudeAdapter;
