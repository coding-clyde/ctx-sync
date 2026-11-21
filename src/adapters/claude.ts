import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/** Compiles rules into CLAUDE.md. */
export const claudeAdapter: Adapter = createSingleFileAdapter("claude");
