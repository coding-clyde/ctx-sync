import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { VERSION } from "../src/version.js";
import { PROJECT_ROOT } from "./helpers.js";

test("package metadata stays in sync with the CLI version", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as {
    version: string;
    bin: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    type: string;
    engines: { node: string };
  };

  assert.equal(packageJson.version, VERSION);
  assert.equal(packageJson.bin["ctx-sync"], "./dist/cli.js");
  assert.deepEqual(packageJson.dependencies, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies).sort(), [
    "@types/node",
    "typescript",
  ]);
  assert.equal(packageJson.type, "module");
  assert.match(packageJson.engines.node, />=20/);
});
