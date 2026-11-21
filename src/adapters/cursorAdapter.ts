import type { Adapter, GeneratedFile, RuleBlock } from "../types.js";
import { oneLine } from "../utils/format.js";
import {
  blocksForProfile,
  buildMarkdownDocument,
  demoteHeadings,
  generatedHeader,
  joinPosix,
  profileOutput,
  yamlString,
} from "./shared.js";

const PROJECT_FILE = "project";

function frontmatter(
  description: string,
  globs: readonly string[],
  alwaysApply: boolean,
): string {
  const lines = ["---", `description: ${yamlString(description)}`];
  if (globs.length > 0) {
    lines.push("globs:");
    for (const glob of globs) {
      lines.push(`  - ${yamlString(glob)}`);
    }
  }
  lines.push(`alwaysApply: ${alwaysApply ? "true" : "false"}`, "---");
  return lines.join("\n");
}

/** Rules that apply everywhere belong in the single project.mdc. */
function isProjectWide(block: RuleBlock): boolean {
  return block.alwaysApply && block.globs.length === 0;
}

function renderScopedRule(block: RuleBlock, sourceDirRelative: string): string {
  const description = oneLine(block.description || block.title) || block.id;
  const content: string[] = [
    frontmatter(description, block.globs, block.alwaysApply),
    generatedHeader("cursor", sourceDirRelative),
    "",
    `# ${oneLine(block.title)}`,
  ];
  if (block.body.length > 0) {
    content.push("", demoteHeadings(block.body, 2));
  }
  return `${content.join("\n").replace(/\n+$/u, "")}\n`;
}

/**
 * Cursor project rules live in `.cursor/rules/*.mdc`, each with its own
 * frontmatter. Rules that always apply are merged into `project.mdc`
 * (`alwaysApply: true`); rules scoped by globs or manually attached keep a
 * file of their own so Cursor can attach them only when relevant.
 * ctx-sync metadata is never emitted into the frontmatter.
 */
export const cursorAdapter: Adapter = {
  id: "cursor",
  order: 20,
  label: "Cursor",
  kind: "rule-directory",
  defaultOutput: ".cursor/rules",
  extensions: [".mdc"],
  render(blocks, context): GeneratedFile[] {
    const selected = blocksForProfile(blocks, "cursor");
    const directory = profileOutput(context.config, cursorAdapter);
    const { sourceDirRelative } = context.config;
    const files: GeneratedFile[] = [];

    const projectWide = selected.filter(isProjectWide);
    if (projectWide.length > 0) {
      files.push({
        profile: "cursor",
        path: joinPosix(directory, `${PROJECT_FILE}.mdc`),
        content:
          `${frontmatter("Project-wide rules that always apply.", [], true)}\n` +
          buildMarkdownDocument("cursor", projectWide, context.config, {
            title: "Project rules",
          }),
        blockIds: projectWide.map((block) => block.id),
      });
    }

    const used = new Set<string>(projectWide.length > 0 ? [PROJECT_FILE] : []);
    for (const block of selected.filter((entry) => !isProjectWide(entry))) {
      let name = block.id;
      while (used.has(name)) {
        name = `${name}-rule`;
      }
      used.add(name);
      files.push({
        profile: "cursor",
        path: joinPosix(directory, `${name}.mdc`),
        content: renderScopedRule(block, sourceDirRelative),
        blockIds: [block.id],
      });
    }

    return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  },
};

export default cursorAdapter;
