import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/**
 * GitHub Copilot loads `.github/copilot-instructions.md` into every chat and
 * review request, so the file stays compact: no index, no per-section
 * metadata, just the rules.
 */
export const copilotAdapter: Adapter = createSingleFileAdapter({
  id: "copilot",
  order: 30,
  label: "GitHub Copilot",
  defaultOutput: ".github/copilot-instructions.md",
  title: "Copilot instructions",
});

export default copilotAdapter;
