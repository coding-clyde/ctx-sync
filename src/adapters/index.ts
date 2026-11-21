/**
 * Adapter registry.
 *
 * Every file in this directory named `<name>Adapter.(js|ts)` is loaded at
 * startup and must default-export an `Adapter` (see `src/types.ts`). To add
 * support for a new assistant, create one such file, for example
 * `src/adapters/zedAdapter.ts`:
 *
 *   import { createSingleFileAdapter } from "./shared.js";
 *   export default createSingleFileAdapter({
 *     id: "zed", label: "Zed", defaultOutput: ".rules", title: "Zed rules",
 *   });
 *
 * No other file needs to change: config validation, `--profile`, rule
 * `targets`, the build, the audit and the CLI help all read this registry.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CtxSyncError } from "../errors.js";
import type {
  Adapter,
  GeneratedFile,
  ResolvedConfig,
  RuleBlock,
  TargetProfile,
} from "../types.js";
import { PROFILE_ID_PATTERN } from "../types.js";

/** `claudeAdapter.js`, `zedAdapter.ts`... but never `.d.ts` or source maps. */
const ADAPTER_FILE = /^[A-Za-z0-9]+Adapter\.(?:js|ts)$/;

function fail(file: string, problem: string): never {
  throw new CtxSyncError(`Invalid adapter module "${file}": ${problem}`, {
    code: "adapter.invalid",
    exitCode: 70,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow an unknown module export to the `Adapter` contract. */
function isAdapter(value: unknown): value is Adapter {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.kind === "single-file" || value.kind === "rule-directory") &&
    typeof value.defaultOutput === "string" &&
    (value.order === undefined || typeof value.order === "number") &&
    typeof value.render === "function"
  );
}

async function discoverAdapters(): Promise<Adapter[]> {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(directory))
    .filter((name) => !name.endsWith(".d.ts") && ADAPTER_FILE.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));

  const found: Array<{ adapter: Adapter; file: string }> = [];
  for (const file of files) {
    const loaded: unknown = await import(
      pathToFileURL(path.join(directory, file)).href
    );
    const candidate = isRecord(loaded) ? loaded.default : undefined;
    if (!isAdapter(candidate)) {
      fail(file, "it must `export default` an Adapter.");
    }
    if (!PROFILE_ID_PATTERN.test(candidate.id)) {
      fail(file, `id "${candidate.id}" must match ${PROFILE_ID_PATTERN}.`);
    }
    if (candidate.defaultOutput.trim().length === 0) {
      fail(file, "defaultOutput must not be empty.");
    }
    const duplicate = found.find((entry) => entry.adapter.id === candidate.id);
    if (duplicate !== undefined) {
      fail(file, `id "${candidate.id}" is already used by "${duplicate.file}".`);
    }
    found.push({ adapter: candidate, file });
  }

  return found
    .map((entry) => entry.adapter)
    .sort(
      (left, right) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) -
          (right.order ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id, "en"),
    );
}

const discovered = await discoverAdapters();

/** All registered adapters keyed by profile id. */
export const ADAPTERS: Readonly<Record<TargetProfile, Adapter>> =
  Object.freeze(
    Object.fromEntries(discovered.map((adapter) => [adapter.id, adapter])),
  );

const PROFILE_IDS: readonly TargetProfile[] = Object.freeze(
  discovered.map((adapter) => adapter.id),
);

/** Registered profile ids in stable (alphabetical) order. */
export function listProfiles(): TargetProfile[] {
  return [...PROFILE_IDS];
}

export function isTargetProfile(value: unknown): value is TargetProfile {
  return typeof value === "string" && Object.hasOwn(ADAPTERS, value);
}

/** Adapter for a registered profile; throws for an unknown id. */
export function getAdapter(profile: TargetProfile): Adapter {
  const adapter = Object.hasOwn(ADAPTERS, profile) ? ADAPTERS[profile] : undefined;
  if (adapter === undefined) {
    throw new CtxSyncError(
      `Unknown profile "${profile}". Choose from: ${PROFILE_IDS.join(", ")}.`,
      { code: "adapter.unknown", exitCode: 2 },
    );
  }
  return adapter;
}

export function renderProfile(
  profile: TargetProfile,
  blocks: readonly RuleBlock[],
  config: ResolvedConfig,
): GeneratedFile[] {
  return getAdapter(profile).render([...blocks], { config });
}

export function renderAllProfiles(
  blocks: readonly RuleBlock[],
  config: ResolvedConfig,
): GeneratedFile[] {
  const enabled = new Set(
    config.profiles
      .filter((entry) => entry.enabled)
      .map((entry) => entry.profile),
  );
  const generated: GeneratedFile[] = [];
  for (const profile of PROFILE_IDS) {
    if (enabled.has(profile)) {
      generated.push(...renderProfile(profile, blocks, config));
    }
  }
  return generated;
}
