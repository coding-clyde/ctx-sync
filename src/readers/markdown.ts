import type {
  Diagnostic,
  RuleBlock,
  RuleFrontmatter,
  TargetProfile,
} from "../types.js";
import { isTargetProfile, listProfiles } from "../adapters/index.js";
import { normalizeLineEndings, stripBom, toPosix } from "../utils/paths.js";
import { oneLine, truncate } from "../utils/format.js";
import { parseFrontmatter } from "./frontmatter.js";

export interface ParseRuleFileOptions {
  /** Repository-relative POSIX path. */
  path: string;
  /** Source-directory-relative POSIX path. */
  relativePath: string;
  /** Internal absolute path. */
  absolutePath: string;
  content: string;
  order: number;
}

export interface ParseRuleFileResult {
  block?: RuleBlock;
  diagnostics: Diagnostic[];
}

const H1_PATTERN = /^#\s+(.+?)\s*#*\s*$/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Convert arbitrary text to a stable, path-safe, lowercase slug. */
export function slugifyId(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return normalized.length > 0 ? normalized : "rule";
}

function stripMarkdown(value: string): string {
  const codeSpans: string[] = [];
  const protectedValue = value.replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `\u0000${codeSpans.length}\u0000`;
    codeSpans.push(code);
    return token;
  });

  const stripped = protectedValue
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!])/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");

  return oneLine(stripped);
}

function truncateDescription(value: string): string {
  const clipped = truncate(value, 220);
  if (!clipped.endsWith("...") || value.length <= 220) {
    return clipped;
  }
  let withoutEllipsis = clipped.slice(0, -3);
  const lastSpace = withoutEllipsis.lastIndexOf(" ");
  if (lastSpace >= 160) {
    withoutEllipsis = withoutEllipsis.slice(0, lastSpace);
  }
  withoutEllipsis = withoutEllipsis.replace(/[\s,;:.!?-]+$/u, "");
  return `${withoutEllipsis}...`;
}

/**
 * Walk block-level Markdown and return the first meaningful paragraph or list
 * item, whichever appears first. Wrapped bullet continuations are included so
 * a description never begins mid-sentence.
 */
function firstDescriptionBlock(body: string): string {
  const lines = body.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) {
      index += 1;
      continue;
    }

    if (/^(?:```|~~~)/.test(line)) {
      const fence = line.startsWith("~~~") ? "~~~" : "```";
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith(fence)) {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (line.startsWith("<") && !line.startsWith("<!--")) {
      index += 1;
      continue;
    }

    if (line.startsWith("<!--")) {
      while (index < lines.length && !(lines[index] ?? "").includes("-->")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (LIST_ITEM_PATTERN.test(line)) {
      const itemLines: string[] = [line.replace(LIST_ITEM_PATTERN, "")];
      index += 1;
      while (index < lines.length) {
        const continuation = lines[index] ?? "";
        const trimmed = continuation.trim();
        if (trimmed.length === 0 || LIST_ITEM_PATTERN.test(trimmed) || /^\s{0,3}#{1,6}\s/.test(continuation)) {
          break;
        }
        if (!/^\s+/.test(continuation)) {
          break;
        }
        itemLines.push(trimmed);
        index += 1;
      }

      const description = truncateDescription(stripMarkdown(itemLines.join(" ")));
      if (description.length > 0) {
        return description;
      }
      continue;
    }

    if (
      line.startsWith("#") ||
      line.startsWith("|") ||
      line.startsWith(">") ||
      /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)
    ) {
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = (lines[index] ?? "").trim();
      if (candidate.length === 0) {
        break;
      }
      if (
        paragraph.length > 0 &&
        (candidate.startsWith("#") ||
          candidate.startsWith("|") ||
          candidate.startsWith(">") ||
          /^(?:```|~~~)/.test(candidate) ||
          LIST_ITEM_PATTERN.test(candidate))
      ) {
        break;
      }
      paragraph.push(candidate);
      index += 1;
    }

    const description = truncateDescription(stripMarkdown(paragraph.join(" ")));
    if (description.length > 0) {
      return description;
    }
  }

  return "";
}

/** Pull a short, single-line summary out of Markdown for Cursor metadata. */
function deriveDescription(body: string): string {
  return firstDescriptionBlock(body);
}

function parseString(
  value: unknown,
  label: string,
  diagnostics: Diagnostic[],
  path: string,
  fallback = "",
): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    diagnostics.push({
      severity: "warning",
      code: "source.invalid-field",
      message: `"${label}" should be a string; ignoring it.`,
      path,
    });
    return fallback;
  }
  return value.trim();
}

/**
 * Return the first present key. Frontmatter accepts a few human-friendly
 * aliases so authors can write "files" instead of "globs" or "assistants"
 * instead of "targets".
 */
function firstDefined(
  data: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (data[key] !== undefined) {
      return data[key];
    }
  }
  return undefined;
}

function parseTargets(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): TargetProfile[] {
  if (value === undefined) {
    return listProfiles();
  }

  const rawValues: unknown[] = Array.isArray(value) ? value : [value];
  const values: string[] = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      diagnostics.push({
        severity: "error",
        code: "source.invalid-target",
        message: "Every entry in \"targets\" must be a profile name.",
        path,
      });
      continue;
    }
    if (rawValue.trim().toLowerCase() === "all") {
      return listProfiles();
    }
    values.push(
      ...rawValue
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
  }

  const targets: TargetProfile[] = [];
  for (const valueEntry of values) {
    if (!isTargetProfile(valueEntry)) {
      diagnostics.push({
        severity: "error",
        code: "source.unknown-target",
        message: `Unknown profile "${valueEntry}" in "targets". Choose from: ${listProfiles().join(
          ", ",
        )}.`,
        path,
      });
      continue;
    }
    if (!targets.includes(valueEntry)) {
      targets.push(valueEntry);
    }
  }

  if (targets.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "source.no-targets",
      message:
        "A rule with an explicit \"targets\" field must target at least one profile.",
      path,
    });
  }

  return targets;
}

function parseGlobs(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): string[] {
  if (value === undefined) {
    return [];
  }

  let rawGlobs: string[] = [];
  if (typeof value === "string") {
    rawGlobs = splitGlobList(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        diagnostics.push({
          severity: "warning",
          code: "source.invalid-globs",
          message: "Every entry in \"globs\" must be a string; ignoring invalid entries.",
          path,
        });
        continue;
      }
      rawGlobs.push(item);
    }
  } else {
    diagnostics.push({
      severity: "warning",
      code: "source.invalid-globs",
      message: "\"globs\" must be a string or an array of strings; ignoring it.",
      path,
    });
    return [];
  }

  const globs: string[] = [];
  for (const glob of rawGlobs) {
    const normalized = toPosix(glob.trim());
    if (normalized.length > 0 && !globs.includes(normalized)) {
      globs.push(normalized);
    }
  }
  return globs;
}

/** Split comma-separated glob lists while preserving `{ts,tsx}` alternatives. */
function splitGlobList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseTags(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): string[] {  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }
  if (Array.isArray(value)) {
    const tags: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        diagnostics.push({
          severity: "warning",
          code: "source.invalid-tags",
          message: "Every entry in \"tags\" must be a string; ignoring invalid entries.",
          path,
        });
        continue;
      }
      const tag = item.trim();
      if (tag.length > 0) {
        tags.push(tag);
      }
    }
    return tags;
  }
  diagnostics.push({
    severity: "warning",
    code: "source.invalid-tags",
    message: "\"tags\" must be a string or an array of strings; ignoring it.",
    path,
  });
  return [];
}

/**
 * Parse a single Markdown rule file into a validated block.
 * Disabled blocks are returned with `enabled: false`; fatal frontmatter errors
 * return no block so raw metadata can never leak into generated files.
 */
export function parseRuleFile(
  options: ParseRuleFileOptions,
): ParseRuleFileResult {
  const diagnostics: Diagnostic[] = [];
  const normalized = normalizeLineEndings(stripBom(options.content));
  const frontmatter = parseFrontmatter(normalized);

  for (const issue of frontmatter.errors) {
    diagnostics.push({
      severity: "error",
      code: "source.frontmatter",
      message: issue.message,
      path: options.path,
      line: issue.line,
    });
  }

  if (frontmatter.fatal) {
    return { diagnostics };
  }

  const extension = /\.[^./]+$/.exec(options.relativePath)?.[0] ?? "";
  const defaultId = slugifyId(
    options.relativePath.slice(0, extension.length > 0 ? -extension.length : undefined),
  );

  const rawId = frontmatter.data["id"];
  let id = defaultId;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    id = slugifyId(rawId);
    if (id !== rawId.trim()) {
      diagnostics.push({
        severity: "warning",
        code: "source.id-normalized",
        message: `Rule id "${rawId.trim()}" was normalized to "${id}".`,
        path: options.path,
      });
    }
  } else if (rawId !== undefined) {
    diagnostics.push({
      severity: "warning",
      code: "source.invalid-id",
      message: "\"id\" must be a non-empty string; using the filename-derived id.",
      path: options.path,
    });
  }

  const bodyLines = frontmatter.body.split("\n");
  let firstContentIndex = bodyLines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex === -1) {
    firstContentIndex = 0;
  }

  let headingTitle: string | undefined;
  let sourceLine = frontmatter.bodyStartLine + firstContentIndex;
  const firstContentLine = bodyLines[firstContentIndex] ?? "";
  const headingMatch = H1_PATTERN.exec(firstContentLine.trim());
  if (headingMatch !== null && firstContentLine.trim().startsWith("# ")) {
    headingTitle = stripMarkdown(headingMatch[1] ?? "").trim();
    bodyLines.splice(firstContentIndex, 1);
  }

  let contentLines = bodyLines;
  while (contentLines.length > 0 && (contentLines[0] ?? "").trim().length === 0) {
    contentLines = contentLines.slice(1);
    sourceLine += 1;
  }
  const body = contentLines.join("\n").trimEnd();

  if (body.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "source.empty",
      message: `Rule "${id}" has a title but no content.`,
      path: options.path,
      line: sourceLine,
    });
  }

  const titleFromFrontmatter = parseString(
    frontmatter.data["title"],
    "title",
    diagnostics,
    options.path,
  );
  const title =
    titleFromFrontmatter.length > 0
      ? titleFromFrontmatter
      : headingTitle !== undefined && headingTitle.length > 0
        ? headingTitle
        : defaultId.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase());

  const rawDescription = parseString(
    frontmatter.data["description"],
    "description",
    diagnostics,
    options.path,
  );
  const description =
    oneLine(rawDescription).length > 0
      ? truncateDescription(oneLine(rawDescription))
      : deriveDescription(body);

  const targets = parseTargets(
    firstDefined(frontmatter.data, ["targets", "assistants", "profiles"]),
    options.path,
    diagnostics,
  );
  const globs = parseGlobs(
    firstDefined(frontmatter.data, ["globs", "files", "patterns", "filePatterns"]),
    options.path,
    diagnostics,
  );

  const rawPriority = frontmatter.data["priority"];
  let priority = 0;
  if (rawPriority !== undefined) {
    if (typeof rawPriority === "number" && Number.isFinite(rawPriority)) {
      priority = Math.trunc(rawPriority);
      if (priority !== rawPriority) {
        diagnostics.push({
          severity: "warning",
          code: "source.invalid-priority",
          message: "\"priority\" must be an integer; rounding it.",
          path: options.path,
        });
      }
      if (priority < -1000 || priority > 1000) {
        const clamped = Math.min(1000, Math.max(-1000, priority));
        diagnostics.push({
          severity: "warning",
          code: "source.invalid-priority",
          message: `"priority" must be between -1000 and 1000; clamped to ${clamped}.`,
          path: options.path,
        });
        priority = clamped;
      }
    } else {
      diagnostics.push({
        severity: "warning",
        code: "source.invalid-priority",
        message: "\"priority\" must be a number; using 0.",
        path: options.path,
      });
    }
  }

  const rawAlwaysApply = frontmatter.data["alwaysApply"];
  let alwaysApply = globs.length === 0;
  if (rawAlwaysApply !== undefined) {
    if (typeof rawAlwaysApply === "boolean") {
      alwaysApply = rawAlwaysApply;
    } else {
      diagnostics.push({
        severity: "warning",
        code: "source.invalid-always-apply",
        message: "\"alwaysApply\" must be a boolean; using the default.",
        path: options.path,
      });
    }
  }

  const rawEnabled = frontmatter.data["enabled"];
  let enabled = true;
  if (rawEnabled !== undefined) {
    if (typeof rawEnabled === "boolean") {
      enabled = rawEnabled;
    } else {
      diagnostics.push({
        severity: "warning",
        code: "source.invalid-enabled",
        message: "\"enabled\" must be a boolean; defaulting to true.",
        path: options.path,
      });
    }
  }

  const rawMaxTokens = frontmatter.data["maxTokens"];
  let maxTokens: number | undefined;
  if (rawMaxTokens !== undefined) {
    if (
      typeof rawMaxTokens === "number" &&
      Number.isInteger(rawMaxTokens) &&
      rawMaxTokens > 0
    ) {
      maxTokens = rawMaxTokens;
    } else {
      diagnostics.push({
        severity: "warning",
        code: "source.invalid-max-tokens",
        message: "\"maxTokens\" must be a positive integer; ignoring it.",
        path: options.path,
      });
    }
  }

  const tags = parseTags(frontmatter.data["tags"], options.path, diagnostics);

  return {
    block: {
      id,
      title,
      description,
      body,
      sourcePath: options.path,
      relativePath: options.relativePath,
      sourceAbsolutePath: options.absolutePath,
      sourceLine,
      order: options.order,
      targets,
      priority,
      globs,
      alwaysApply,
      enabled,
      tags,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      frontmatter: frontmatter.data as RuleFrontmatter,
    },
    diagnostics,
  };
}
