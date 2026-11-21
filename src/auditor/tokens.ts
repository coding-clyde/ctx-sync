/**
 * Compatibility entry point for token estimation.
 *
 * The dependency-free estimator and its per-file/per-block aggregators live in
 * ../readers/tokenEstimator.ts. Audit code keeps importing this module so the
 * public API and existing call sites remain stable.
 */
export {
  TOKEN_ESTIMATOR_METHOD,
  combineMetrics,
  countCharacters,
  countLines,
  estimateBlockTokens,
  estimateFileTokens,
  estimateSourceTokens,
  estimateTokens,
  measureText,
  tokenStatus,
} from "../readers/tokenEstimator.js";
export type {
  BlockTokenEstimate,
  FileTokenEstimate,
  SourceTokenEstimate,
  TokenEstimatorMethod,
} from "../readers/tokenEstimator.js";
