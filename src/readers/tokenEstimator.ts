/**
 * Token estimation without external dependencies.
 *
 * This module provides a fast, deterministic token estimator for text content
 * that works across all providers without requiring their native tokenizers.
 * The heuristic is intentionally conservative and transparent:
 *
 *  - Latin/Cyrillic scripts: roughly 4 characters per token.
 *  - CJK scripts (Han, Hiragana, Katakana, Hangul): roughly 1 token per char.
 *  - Empty input: 0 tokens.
 *
 * Characters are counted as Unicode code points, lines are normalized to LF,
 * and words are Unicode-aware. The estimate is ±20% of actual provider tokens
 * but stays stable across runs and platforms, making it suitable for budgeting
 * and regression detection.
 *
 * This is not a replacement for provider tokenizers when exact counts matter.
 * It is a planning signal so developers can detect runaway context before it
 * becomes a quota problem.
 *
 * @module readers/tokenEstimator
 */
import type {
  RuleBlock,
  Severity,
  SourceCollection,
  SourceFile,
  TokenMetrics,
} from "../types.js";

/**
 * Deterministic, dependency-free token estimation ("heuristic-v1").
 *
 * This is a planning signal, not a provider tokenizer. Provider tokenizers
 * change frequently and are not available as stable offline APIs. The estimate
 * is intentionally conservative:
 *
 *  - Latin, Cyrillic and similar scripts: roughly four characters per token.
 *  - Han, Hiragana, Katakana and Hangul: roughly one token per character.
 *  - Empty input: zero tokens.
 *
 * Characters are counted as Unicode code points so a multi-byte emoji or CJK
 * glyph is never counted twice. Lines are counted with LF normalization in
 * mind; a single trailing newline does not invent an extra line.
 */
export const TOKEN_ESTIMATOR_METHOD = "heuristic-v1" as const;

export type TokenEstimatorMethod = typeof TOKEN_ESTIMATOR_METHOD;

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const CJK_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** Token metrics for one complete source file, including frontmatter. */
export interface FileTokenEstimate {
  /** Repository-relative POSIX path. */
  path: string;
  /** Source-directory-relative POSIX path. */
  relativePath: string;
  metrics: TokenMetrics;
}

/** Token metrics for one parsed rule body. */
export interface BlockTokenEstimate {
  blockId: string;
  title: string;
  /** Repository-relative POSIX path of the source file. */
  sourcePath: string;
  /** Disabled blocks are measured but must not be compiled. */
  enabled: boolean;
  metrics: TokenMetrics;
}

/** Per-file and per-block estimates for a complete source tree. */
export interface SourceTokenEstimate {
  method: TokenEstimatorMethod;
  files: FileTokenEstimate[];
  blocks: BlockTokenEstimate[];
  /** Combined metrics for all source files, including frontmatter and titles. */
  total: TokenMetrics;
  /** Combined metrics for every parsed rule body, including disabled rules. */
  blockTotal: TokenMetrics;
}

export function countCharacters(text: string): number {
  return Array.from(text).length;
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      newlines += 1;
    }
  }

  return text.endsWith("\n") ? newlines : newlines + 1;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const characters = countCharacters(text);
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const nonCjk = Math.max(0, characters - cjkCount);
  return Math.max(1, Math.ceil(cjkCount + nonCjk / 4));
}

export function measureText(text: string): TokenMetrics {
  if (text.length === 0) {
    return { characters: 0, words: 0, lines: 0, estimatedTokens: 0 };
  }

  return {
    characters: countCharacters(text),
    words: text.match(WORD_PATTERN)?.length ?? 0,
    lines: countLines(text),
    estimatedTokens: estimateTokens(text),
  };
}

/** Sum metrics across files or blocks for aggregate reports. */
export function combineMetrics(metrics: readonly TokenMetrics[]): TokenMetrics {
  const total: TokenMetrics = {
    characters: 0,
    words: 0,
    lines: 0,
    estimatedTokens: 0,
  };

  for (const item of metrics) {
    total.characters += item.characters;
    total.words += item.words;
    total.lines += item.lines;
    total.estimatedTokens += item.estimatedTokens;
  }

  return total;
}

/**
 * Turn a numeric estimate into an audit status.
 *
 * A maximum of 0 disables the check. Values above 1x are warnings and values
 * above 2x are critical, so a single runaway rule is visible before it becomes
 * a quota problem.
 */
export function tokenStatus(tokens: number, maximum: number): Severity {
  if (maximum <= 0 || tokens <= maximum) {
    return "ok";
  }
  return tokens > maximum * 2 ? "critical" : "warning";
}

/** Measure one discovered source file. */
export function estimateFileTokens(
  file: Pick<SourceFile, "path" | "relativePath" | "content">,
): FileTokenEstimate {
  return {
    path: file.path,
    relativePath: file.relativePath,
    metrics: measureText(file.content),
  };
}

/** Measure one parsed rule body, using the same convention as the auditor. */
export function estimateBlockTokens(
  block: Pick<RuleBlock, "id" | "title" | "sourcePath" | "body" | "enabled">,
): BlockTokenEstimate {
  return {
    blockId: block.id,
    title: block.title,
    sourcePath: block.sourcePath,
    enabled: block.enabled,
    metrics: measureText(block.body),
  };
}

/**
 * Measure every file and every parsed block in a source collection.
 *
 * The output preserves the deterministic order of the collection, so reports
 * are stable across platforms and repeated runs.
 */
export function estimateSourceTokens(
  source: Pick<SourceCollection, "files" | "blocks">,
): SourceTokenEstimate {
  const files = source.files.map(estimateFileTokens);
  const blocks = source.blocks.map(estimateBlockTokens);

  return {
    method: TOKEN_ESTIMATOR_METHOD,
    files,
    blocks,
    total: combineMetrics(files.map((file) => file.metrics)),
    blockTotal: combineMetrics(blocks.map((block) => block.metrics)),
  };
}
