import type { Severity, TokenMetrics } from "../types.js";

/**
 * Heuristic token estimator ("heuristic-v1").
 *
 * Approximation used for budgeting across providers:
 *  - Latin/Cyrillic/etc. text: ~4 characters per token.
 *  - CJK (Han, Hiragana, Katakana, Hangul): ~1 token per character.
 *  - Empty input: 0 tokens.
 *
 * This is deterministic and dependency-free. It intentionally does not pretend
 * to be a provider tokenizer; treat results as planning estimates (±20%).
 */
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const CJK_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

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

/** Sum metrics across files/blocks for aggregate reports. */
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
 * 0 disables the budget. Warning above 1x, critical above 2x.
 */
export function tokenStatus(tokens: number, maximum: number): Severity {
  if (maximum <= 0 || tokens <= maximum) {
    return "ok";
  }
  return tokens > maximum * 2 ? "critical" : "warning";
}
