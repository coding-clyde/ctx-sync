import type { Adapter } from "../types.js";
import { createSingleFileAdapter } from "./shared.js";

/**
 * Windsurf reads the plain-Markdown `.windsurfrules` file at the repository
 * root. Like Copilot's file it is always in context, so it stays compact.
 */
export const windsurfAdapter: Adapter = createSingleFileAdapter({
  id: "windsurf",
  order: 40,
  label: "Windsurf",
  defaultOutput: ".windsurfrules",
  title: "Windsurf rules",
});

export default windsurfAdapter;
