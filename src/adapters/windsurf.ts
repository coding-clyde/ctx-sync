import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/** Compiles rules into .windsurfrules. */
export const windsurfAdapter: Adapter = createSingleFileAdapter("windsurf");
