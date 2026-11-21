import assert from "node:assert/strict";
import test from "node:test";

import {
  combineMetrics,
  countLines,
  estimateTokens,
  measureText,
  tokenStatus,
} from "../src/auditor/tokens.js";

test("empty content has zero metrics", () => {
  assert.deepEqual(measureText(""), {
    characters: 0,
    words: 0,
    lines: 0,
    estimatedTokens: 0,
  });
});

test("counts lines without inventing a line for a trailing newline", () => {
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\n"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("one\n\ntwo"), 3);
  assert.equal(countLines(""), 0);
});

test("token estimates grow with content and are deterministic", () => {
  const short = estimateTokens("Use strict TypeScript.");
  const long = estimateTokens(
    "Use strict TypeScript. ".repeat(25) + "```ts\nconst x: number = 1;\n```",
  );
  assert.equal(short, estimateTokens("Use strict TypeScript."));
  assert.ok(short > 0);
  assert.ok(long > short);
});

test("CJK text costs more per character than Latin text", () => {
  const latin = "abcdefghij"; // 10 code units
  const han = "你好世界你好世界你好世界"; // 12 code points
  assert.ok(estimateTokens(han) / 12 > estimateTokens(latin) / 10);
});

test("combineMetrics sums every field", () => {
  const combined = combineMetrics([
    measureText("one two"),
    measureText("three\nfour"),
    measureText(""),
  ]);
  assert.ok(combined.characters > 0);
  assert.equal(combined.words, 4);
  assert.equal(combined.lines, 3);
  assert.equal(
    combined.estimatedTokens,
    measureText("one two").estimatedTokens + measureText("three\nfour").estimatedTokens,
  );
});

test("tokenStatus honors 0 as disabled and the 2x critical threshold", () => {
  assert.equal(tokenStatus(999_999, 0), "ok");
  assert.equal(tokenStatus(100, 100), "ok");
  assert.equal(tokenStatus(101, 100), "warning");
  assert.equal(tokenStatus(200, 100), "warning");
  assert.equal(tokenStatus(201, 100), "critical");
});
