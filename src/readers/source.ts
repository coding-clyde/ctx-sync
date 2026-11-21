/**
 * Compatibility entry point for the source reader.
 *
 * The implementation lives in ./sourceReader.ts so the reader can be used
 * without importing the higher-level project context module.
 */
export {
  readSourceDirectory,
  readSourceDirectory as readSourceTree,
} from "./sourceReader.js";
export type { ReadSourceOptions } from "./sourceReader.js";
