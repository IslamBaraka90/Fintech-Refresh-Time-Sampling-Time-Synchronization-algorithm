/**
 * Causal all-refresh sampling for asynchronous instruments.
 *
 * Sample when *everybody* has spoken — no carry-forward, no interpolation, and an
 * honest accounting of the data it costs you.
 *
 * ```ts
 * import { refreshTimeSample } from "fintech-refresh-time";
 *
 * const result = refreshTimeSample(observations, ["ALPHA", "BETA"], 5000);
 * ```
 *
 * Article: https://thefintechbuilder.com/market-data-engineering/time-synchronization/refresh-time-sampling/
 */

export {
  type NormalisedRow,
  type Observation,
  type PartitionSummary,
  type RefreshResult,
  type RefreshRow,
  type SourceRef,
  REQUIRED_FIELDS,
  formatTimestampMs,
  parseTimestampMs,
  refreshTimeSample,
} from "./core.ts";

export {
  type CadenceEntry,
  type ControllerEntry,
  type LossEntry,
  type SubsetEntry,
  cadenceProfile,
  controllerProfile,
  lossReport,
  subsetComparison,
} from "./analysis.ts";

export { StreamingRefreshSampler } from "./streaming.ts";
