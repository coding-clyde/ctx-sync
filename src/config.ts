import fs from "node:fs/promises";
import path from "node:path";

import { getAdapter, isTargetProfile, listProfiles } from "./adapters/index.js";
import { ConfigError } from "./errors.js";
import {
  type CtxSyncConfigFile,
  type LoadConfigOptions,
  type ResolvedConfig,
  type ResolvedProfileConfig,
  type TokenBudget,
} from "./types.js";
import { pathExists, readTextFile } from "./utils/fs.js";
import { resolveOutputPath, resolveSourceDir, toPosix } from "./utils/paths.js";

export const CONFIG_FILENAME = "ctx-sync.config.json";

/**
 * Defaults are intentionally conservative: 12k tokens is already a large
 * always-loaded instruction file, and 2.5k is a large single rule.
 * Set a value to 0 to disable that budget.
 */
export const DEFAULT_MAX_TOKENS_PER_PROFILE = 12_000;
export const DEFAULT_MAX_TOKENS_PER_BLOCK = 2_500;
export const DEFAULT_SOURCE_DIR = ".ai";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  object: JsonObject,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${label} has unknown key "${key}". Allowed keys: ${allowed.join(", ")}.`,
        "config.unknown-key",
      );
    }
  }
}

function parseBudgetNumber(
  value: unknown,
  label: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    !Number.isFinite(value)
  ) {
    throw new ConfigError(
      `${label} must be a non-negative integer (0 disables the limit).`,
      "config.token-budget",
    );
  }
  return value;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${label} must be an array of strings.`, "config.invalid");
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

async function readConfigFile(
  rootDir: string,
): Promise<{ raw: CtxSyncConfigFile; configPath: string | null }> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  if (!(await pathExists(configPath))) {
    return { raw: {}, configPath: null };
  }

  let text: string;
  try {
    text = await readTextFile(configPath);
  } catch (error) {
    throw new ConfigError(
      `Could not read ${CONFIG_FILENAME}: ${(error as Error).message}`,
      "config.unreadable",
      error,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${CONFIG_FILENAME} is not valid JSON: ${(error as Error).message}`,
      "config.json",
      error,
    );
  }

  if (!isObject(parsed)) {
    throw new ConfigError(
      `${CONFIG_FILENAME} must contain a JSON object.`,
      "config.invalid",
    );
  }

  assertKnownKeys(
    parsed,
    ["$schema", "sourceDir", "profiles", "tokenBudget", "secrets"],
    CONFIG_FILENAME,
  );

  return { raw: parsed as CtxSyncConfigFile, configPath };
}

function parseProfiles(
  raw: CtxSyncConfigFile["profiles"],
  requested: readonly string[] | undefined,
): ResolvedProfileConfig[] {
  if (raw !== undefined && !isObject(raw)) {
    throw new ConfigError(
      '"profiles" must be an object keyed by profile name.',
      "config.profiles",
    );
  }

  if (requested !== undefined) {
    if (requested.length === 0) {
      throw new ConfigError(
        "At least one --profile must be provided.",
        "config.profiles",
      );
    }
    for (const profile of requested) {
      if (!isTargetProfile(profile)) {
        throw new ConfigError(
          `Unknown profile "${profile}". Choose from: ${listProfiles().join(", ")}.`,
          "config.profiles",
        );
      }
    }
  }

  const requestedSet = requested === undefined ? null : new Set(requested);
  const resolved: ResolvedProfileConfig[] = [];
  const outputOwners = new Map<string, string>();

  for (const profile of listProfiles()) {
    const profileRaw = raw?.[profile];
    if (profileRaw !== undefined && !isObject(profileRaw)) {
      throw new ConfigError(
        `profiles.${profile} must be an object.`,
        "config.profiles",
      );
    }
    if (profileRaw !== undefined) {
      assertKnownKeys(
        profileRaw,
        ["enabled", "output"],
        `profiles.${profile}`,
      );
    }

    if (profileRaw?.enabled !== undefined && typeof profileRaw.enabled !== "boolean") {
      throw new ConfigError(
        `profiles.${profile}.enabled must be a boolean.`,
        "config.profiles",
      );
    }
    if (profileRaw?.output !== undefined && typeof profileRaw.output !== "string") {
      throw new ConfigError(
        `profiles.${profile}.output must be a string.`,
        "config.profiles",
      );
    }

    // An explicit --profile is a command-line override: it selects and enables
    // that profile even if the config file disabled it.
    const enabled =
      requestedSet === null
        ? (profileRaw?.enabled ?? true)
        : requestedSet.has(profile);
    const configuredOutput =
      profileRaw?.output ?? getAdapter(profile).defaultOutput;

    resolved.push({
      profile,
      enabled,
      output: toPosix(configuredOutput),
    });

    const normalizedOutput = configuredOutput
      .replaceAll("\\", "/")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
    const previousOwner = outputOwners.get(normalizedOutput);
    if (previousOwner !== undefined) {
      throw new ConfigError(
        `profiles.${previousOwner} and profiles.${profile} both write to "${normalizedOutput}".`,
        "config.output-conflict",
      );
    }
    outputOwners.set(normalizedOutput, profile);
  }

  if (!resolved.some((profile) => profile.enabled)) {
    throw new ConfigError(
      "No profiles are enabled. Enable at least one in ctx-sync.config.json or pass --profile.",
      "config.no-profiles",
    );
  }

  return resolved;
}

/**
 * Load and validate ctx-sync.config.json (if present), then apply CLI
 * overrides and safe defaults.
 */
export async function loadConfig(
  options: LoadConfigOptions,
): Promise<ResolvedConfig> {
  const rootDir = path.resolve(options.rootDir);
  let stats;
  try {
    stats = await fs.stat(rootDir);
  } catch (error) {
    throw new ConfigError(
      `Repository root does not exist: ${rootDir}`,
      "config.root",
      error,
    );
  }
  if (!stats.isDirectory()) {
    throw new ConfigError(
      `Repository root is not a directory: ${rootDir}`,
      "config.root",
    );
  }

  const { raw, configPath } = await readConfigFile(rootDir);

  if (raw.sourceDir !== undefined && typeof raw.sourceDir !== "string") {
    throw new ConfigError('"sourceDir" must be a string.', "config.source-dir");
  }
  if (raw.tokenBudget !== undefined) {
    if (!isObject(raw.tokenBudget)) {
      throw new ConfigError('"tokenBudget" must be an object.', "config.token-budget");
    }
    assertKnownKeys(
      raw.tokenBudget,
      ["maxPerProfile", "maxPerBlock"],
      "tokenBudget",
    );
  }
  if (raw.secrets !== undefined) {
    if (!isObject(raw.secrets)) {
      throw new ConfigError('"secrets" must be an object.', "config.secrets");
    }
    assertKnownKeys(raw.secrets, ["allowlist", "disabledRules"], "secrets");
  }

  const sourceDirInput =
    options.sourceDir ?? raw.sourceDir ?? DEFAULT_SOURCE_DIR;
  if (typeof sourceDirInput !== "string" || sourceDirInput.trim().length === 0) {
    throw new ConfigError('"sourceDir" cannot be empty.', "config.source-dir");
  }

  let sourceDirectory;
  try {
    sourceDirectory = resolveSourceDir(rootDir, sourceDirInput.trim());
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(
        `Invalid sourceDir "${sourceDirInput}": ${error.message}`,
        "config.source-dir",
        error,
      );
    }
    throw error;
  }

  const profiles = parseProfiles(raw.profiles, options.profiles);

  for (const profile of profiles) {
    resolveOutputPath(
      rootDir,
      profile.output,
      `profiles.${profile.profile}.output`,
    );
  }

  const tokenBudget: TokenBudget = {
    maxPerProfile: parseBudgetNumber(
      options.maxPerProfile ?? raw.tokenBudget?.maxPerProfile,
      "maxPerProfile",
      DEFAULT_MAX_TOKENS_PER_PROFILE,
    ),
    maxPerBlock: parseBudgetNumber(
      options.maxPerBlock ?? raw.tokenBudget?.maxPerBlock,
      "maxPerBlock",
      DEFAULT_MAX_TOKENS_PER_BLOCK,
    ),
  };

  const allowlist = parseStringArray(
    raw.secrets?.allowlist,
    "secrets.allowlist",
  );
  for (const expression of allowlist) {
    try {
      new RegExp(expression, "i");
    } catch (error) {
      throw new ConfigError(
        `secrets.allowlist contains an invalid regular expression "${expression}": ${
          (error as Error).message
        }`,
        "config.secrets",
        error,
      );
    }
  }

  const disabledRules = parseStringArray(
    raw.secrets?.disabledRules,
    "secrets.disabledRules",
  );

  return {
    rootDir,
    sourceDir: sourceDirectory.absolutePath,
    sourceDirRelative: sourceDirectory.relativePath,
    configPath,
    profiles,
    tokenBudget,
    secrets: { allowlist, disabledRules },
  };
}
