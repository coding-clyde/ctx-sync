import assert from "node:assert/strict";
import test from "node:test";

import { parseFrontmatter } from "../src/readers/frontmatter.js";

test("parses scalars, inline arrays, block lists, and block strings", () => {
  const source = [
    "---",
    'title: "Hello: world"',
    "targets: [claude, \"cursor\", copilot]",
    "priority: 10",
    "enabled: true",
    "description: |",
    "  Line one.",
    "  Line two.",
    "globs:",
    '  - "**/*.ts"',
    "  - 'tests/**/*.ts'",
    "tags:",
    "  - one",
    "  - two",
    "---",
    "",
    "# Body",
    "",
    "Text.",
  ].join("\n");

  const result = parseFrontmatter(source);
  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.fatal, false);
  assert.equal(result.errors.length, 0);
  assert.equal(result.data["title"], "Hello: world");
  assert.deepEqual(result.data["targets"], ["claude", "cursor", "copilot"]);
  assert.equal(result.data["priority"], 10);
  assert.equal(result.data["enabled"], true);
  assert.equal(result.data["description"], "Line one.\nLine two.\n");
  assert.deepEqual(result.data["globs"], ["**/*.ts", "tests/**/*.ts"]);
  assert.deepEqual(result.data["tags"], ["one", "two"]);
  assert.match(result.body, /# Body/);
  assert.equal(result.bodyStartLine, 16);
});

test("keeps comments, URLs, and quoted commas intact", () => {
  const result = parseFrontmatter(
    [
      "---",
      "url: https://example.test/path#fragment",
      "note: something # real comment",
      'list: ["a, b", c]',
      "---",
      "body",
    ].join("\n"),
  );

  assert.equal(result.data["url"], "https://example.test/path#fragment");
  assert.equal(result.data["note"], "something");
  assert.deepEqual(result.data["list"], ["a, b", "c"]);
});

test("returns a fatal result for unterminated frontmatter", () => {
  const result = parseFrontmatter("---\nid: broken\n\nNo closing marker.");
  assert.equal(result.fatal, true);
  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.body, "");
  assert.equal(result.errors[0]?.line, 1);
  assert.match(result.errors[0]?.message ?? "", /Unterminated/);
});

test("reports the exact line for unsupported YAML syntax", () => {
  const result = parseFrontmatter(
    ["---", "id: valid", "this is not yaml", "---", "Body"].join("\n"),
  );
  assert.equal(result.fatal, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.line, 3);
  assert.equal(result.data["id"], "valid");
});

test("passes through files without frontmatter", () => {
  const source = "# Just Markdown\n\nHello.";
  const result = parseFrontmatter(source);
  assert.equal(result.hasFrontmatter, false);
  assert.equal(result.body, source);
  assert.equal(result.bodyStartLine, 1);
  assert.deepEqual(result.data, {});
});
