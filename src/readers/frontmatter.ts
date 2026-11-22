import { normalizeLineEndings, stripBom } from "../utils/paths.js";

/**
 * Minimal YAML frontmatter parser.
 *
 * Supported: top-level `key: value` mappings, quoted and plain scalars,
 * booleans/null/numbers, inline arrays, dash arrays and literal/folded block
 * strings. Nested mappings are preserved as strings under unknown keys. This
 * is everything ctx-syncr needs and keeps runtime dependencies at zero.
 */

export interface FrontmatterIssue {
  message: string;
  /** 1-based line in the original file. */
  line: number;
}

export interface FrontmatterParseResult {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line number where the body starts. */
  bodyStartLine: number;
  hasFrontmatter: boolean;
  /** True for an opening `---` with no closing delimiter. */
  fatal: boolean;
  errors: FrontmatterIssue[];
}

class ScalarError extends Error {}

function stripInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trimEnd();
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") {
      depth += 1;
      continue;
    }
    if (character === "]" || character === "}" || character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts.map((part) => part.trim());
}

function parseScalar(rawValue: string): unknown {
  const value = stripInlineComment(rawValue).trim();
  if (value.length === 0) {
    return null;
  }

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new ScalarError(`Unterminated double-quoted scalar: ${value}`);
    }
    const inner = value.slice(1, -1);
    try {
      return JSON.parse(`"${inner}"`) as unknown;
    } catch {
      return inner
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\")
        .replaceAll("\\n", "\n")
        .replaceAll("\\t", "\t");
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new ScalarError(`Unterminated single-quoted scalar: ${value}`);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }

  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new ScalarError(`Unterminated inline array: ${value}`);
    }
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }
    return splitTopLevel(inner, ",").map((item) => parseScalar(item));
  }

  if (value.startsWith("{")) {
    if (!value.endsWith("}")) {
      throw new ScalarError(`Unterminated inline object: ${value}`);
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  if (/^(?:true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  if (/^(?:null|~)$/i.test(value)) {
    return null;
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function dedent(lines: string[]): string[] {
  let minimumIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const indentation = line.length - line.trimStart().length;
    minimumIndent = Math.min(minimumIndent, indentation);
  }
  if (!Number.isFinite(minimumIndent)) {
    return lines.map(() => "");
  }
  return lines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(minimumIndent),
  );
}

function parseFrontmatterData(
  lines: string[],
  startLine: number,
): { data: Record<string, unknown>; errors: FrontmatterIssue[] } {
  const data: Record<string, unknown> = {};
  const errors: FrontmatterIssue[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const lineNumber = startLine + index;
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(rawLine);
    if (match === null) {
      errors.push({
        message: `Unsupported frontmatter syntax: ${rawLine.trim()}`,
        line: lineNumber,
      });
      index += 1;
      continue;
    }

    const key = match[1];
    if (key === undefined) {
      index += 1;
      continue;
    }
    const rawRest = match[2] ?? "";
    const rest = stripInlineComment(rawRest);
    const blockIndicator = /^([|>])([+-]?)$/.exec(rest);

    if (blockIndicator !== null) {
      const style = blockIndicator[1];
      const chomping = blockIndicator[2] ?? "";
      index += 1;
      const collected: string[] = [];
      while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line.trim().length === 0) {
          collected.push("");
          index += 1;
          continue;
        }
        if (!/^[ \t]/.test(line)) {
          break;
        }
        collected.push(line);
        index += 1;
      }

      let text = dedent(collected).join("\n");
      if (style === ">") {
        text = text
          .split(/\n{2,}/)
          .map((paragraph) =>
            paragraph
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join(" "),
          )
          .join("\n\n");
      }

      if (chomping === "-") {
        text = text.replace(/\n+$/u, "");
      } else if (chomping !== "+") {
        text = `${text.replace(/\n+$/u, "")}\n`;
      }
      data[key] = text;
      continue;
    }

    if (rest.length === 0) {
      index += 1;
      const gathered: string[] = [];
      const gatheredStart = index;
      while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line.trim().length === 0 || /^[ \t]/.test(line)) {
          gathered.push(line);
          index += 1;
          continue;
        }
        break;
      }

      const meaningful = gathered.filter((line) => line.trim().length > 0);
      if (meaningful.length === 0) {
        data[key] = null;
      } else if ((meaningful[0] ?? "").trimStart().startsWith("-")) {
        const values: unknown[] = [];
        for (let offset = 0; offset < gathered.length; offset += 1) {
          const itemLine = gathered[offset] ?? "";
          if (itemLine.trim().length === 0) {
            continue;
          }
          const trimmed = itemLine.trimStart();
          if (!trimmed.startsWith("-")) {
            errors.push({
              message: `Expected a list item under "${key}", got: ${trimmed}`,
              line: startLine + gatheredStart + offset,
            });
            continue;
          }
          const itemValue = trimmed.slice(1).trim();
          try {
            values.push(parseScalar(itemValue));
          } catch (error) {
            errors.push({
              message: `Invalid value for "${key}": ${(error as Error).message}`,
              line: startLine + gatheredStart + offset,
            });
          }
        }
        data[key] = values;
      } else {
        data[key] = dedent(gathered).join("\n").trim();
      }
      continue;
    }

    try {
      data[key] = parseScalar(rawRest);
    } catch (error) {
      errors.push({
        message: `Invalid value for "${key}": ${(error as Error).message}`,
        line: lineNumber,
      });
    }
    index += 1;
  }

  return { data, errors };
}

export function parseFrontmatter(source: string): FrontmatterParseResult {
  const text = normalizeLineEndings(stripBom(source));
  const lines = text.split("\n");
  const firstLine = lines[0] ?? "";

  if (firstLine.trim() !== "---") {
    return {
      data: {},
      body: text,
      bodyStartLine: 1,
      hasFrontmatter: false,
      fatal: false,
      errors: [],
    };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^(?:---|\.\.\.)\s*$/.test(line)) {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex === -1) {
    return {
      data: {},
      body: "",
      bodyStartLine: 1,
      hasFrontmatter: true,
      fatal: true,
      errors: [
        {
          message:
            "Unterminated frontmatter: expected a closing --- or ... delimiter.",
          line: 1,
        },
      ],
    };
  }

  const { data, errors } = parseFrontmatterData(
    lines.slice(1, closingIndex),
    2,
  );
  const body = lines.slice(closingIndex + 1).join("\n");

  return {
    data,
    body,
    bodyStartLine: closingIndex + 2,
    hasFrontmatter: true,
    fatal: false,
    errors,
  };
}
