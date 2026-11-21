import type {
  Adapter,
  GeneratedFile,
  ResolvedConfig,
  RuleBlock,
  TargetProfile,
} from "../types.js";
import { TARGET_PROFILES } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { copilotAdapter } from "./copilot.js";
import { cursorAdapter } from "./cursor.js";
import { windsurfAdapter } from "./windsurf.js";

export const ADAPTERS: Record<TargetProfile, Adapter> = {
  claude: claudeAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
  windsurf: windsurfAdapter,
};

export function renderProfile(
  profile: TargetProfile,
  blocks: readonly RuleBlock[],
  config: ResolvedConfig,
): GeneratedFile[] {
  return ADAPTERS[profile].render([...blocks], { config });
}

export function renderAllProfiles(
  blocks: readonly RuleBlock[],
  config: ResolvedConfig,
): GeneratedFile[] {
  const enabled: TargetProfile[] = config.profiles
    .filter((entry) => entry.enabled)
    .map((entry) => entry.profile);
  const generated: GeneratedFile[] = [];
  for (const profile of TARGET_PROFILES) {
    if (enabled.includes(profile)) {
      generated.push(...renderProfile(profile, blocks, config));
    }
  }
  return generated;
}
