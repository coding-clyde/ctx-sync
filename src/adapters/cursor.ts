import type { Adapter, GeneratedFile, RuleBlock } from "../types.js";
import { TARGET_PROFILE_DEFAULT_OUTPUTS, TARGET_PROFILE_LABELS } from "../types.js";
import { oneLine } from "../utils/format.js";
import {
  blocksForProfile,
  generatedHeader,
  joinPosix,
  profileOutput,
  yamlString,
} from "./shared.js";

function renderRule(block: RuleBlock, sourceDirRelative: string): string {
  const description = oneLine(block.description || block.title) || block.id;
  const frontmatter: string[] = [
    "---",
    `description: ${yamlString(description)}`,
  ];
  if (block.globs.length > 0) {
    frontmatter.push("globs:");
    for (const glob of block.globs) {
      frontmatter.push(`  - ${yamlString(glob)}`);
    }
  }
  frontmatter.push(`alwaysApply: ${block.alwaysApply ? "true" : "false"}`);
  frontmatter.push("---");

  const content: string[] = [
    ...frontmatter,
    generatedHeader("cursor", sourceDirRelative),
    "",
    `# ${oneLine(block.title)}`,
  ];
  if (block.body.length > 0) {
    content.push("", block.body);
  }

  return `${content.join("\n").replace(/\n+$/u, "")}\n`;
}

/**
 * Cursor uses one .mdc file per rule. The native frontmatter carries the
 * description/globs/alwaysApply fields Cursor understands; ctx-sync metadata
 * is never emitted.
 */
export const cursorAdapter: Adapter = {
  id: "cursor",
  label: TARGET_PROFILE_LABELS.cursor,
  kind: "rule-directory",
  defaultOutput: TARGET_PROFILE_DEFAULT_OUTPUTS.cursor,
  render(blocks, context): GeneratedFile[] {
    const selected = blocksForProfile(blocks, "cursor");
    const directory = profileOutput(context.config, "cursor");
    return selected.map((block) => ({
      profile: "cursor",
      path: joinPosix(directory, `${block.id}.mdc`),
      content: renderRule(block, context.config.sourceDirRelative),
      blockIds: [block.id],
    }));
  },
};
