import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/** Compiles rules into .github/copilot-instructions.md. */
export const copilotAdapter: Adapter = createSingleFileAdapter("copilot");
