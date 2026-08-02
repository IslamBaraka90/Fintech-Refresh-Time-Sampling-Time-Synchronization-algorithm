/**
 * Who is setting your sampling clock, and what is each instrument costing you?
 *
 * The core module produces the sample. This module answers the questions that decide
 * whether the basket was a good idea.
 *
 * **Which instrument is the bottleneck?** — {@link controllerProfile}
 * A refresh happens when the *last* required instrument finally posts. That instrument
 * is the controller, and on a typical basket one name controls almost every refresh. It
 * is setting your sampling frequency single-handedly, and until you look, you do not
 * know which one it is. On the reference fixture GAMMA controls **4 of 4** refreshes.
 *
 * **What did each instrument cost?** — {@link lossReport}
 * Per-instrument arrivals against updates that actually reached the sample. A fast
 * instrument contributing forty updates and six sampled values is not being sampled; it
 * is being decimated by somebody else's cadence.
 *
 * **Should this name be in the basket at all?** — {@link subsetComparison}
 * The one that changes decisions. It re-runs the sampler over candidate subsets and
 * reports what each costs in refresh count and information loss.
 *
 * **How regular is the resulting series?** — {@link cadenceProfile}
 * Refresh intervals are *not* evenly spaced — that is the whole point of the method —
 * so any downstream estimator assuming a fixed interval is misspecified.
 */

import {
  type Observation,
  type RefreshResult,
  parseTimestampMs,
  refreshTimeSample,
} from "./core.ts";

export interface ControllerEntry {
  refreshes: number;
  counts: Record<string, number>;
  shares: Record<string, number>;
  co_controlled: number;
  dominant: string | null;
}

export interface LossEntry {
  refreshes: number;
  arrivals: Record<string, number>;
  sampled: Record<string, number>;
  retention: Record<string, number | null>;
}

export interface CadenceEntry {
  refreshes: number;
  intervals: number;
  min_ms: number | null;
  median_ms: number | null;
  max_ms: number | null;
  regularity: number | null;
}

export interface SubsetEntry {
  instruments: string[];
  refresh_candidates: number;
  input_updates: number;
  discarded: number;
  loss_share: number;
  median_cadence_ms: number | null;
  dominant_controllers: string[];
  refreshes_vs_first: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

function rowsOf(result: unknown): RefreshResult["rows"] {
  if (
    result === null ||
    typeof result !== "object" ||
    !("rows" in result) ||
    !("partitions" in result)
  ) {
    throw new Error("result must come from refreshTimeSample()");
  }
  return [...(result as RefreshResult).rows];
}

/**
 * Count how often each instrument was the last to arrive.
 *
 * When two instruments land in the same millisecond both are credited, which is why the
 * shares can sum to more than one — a co-controlled refresh is genuinely both their
 * doing.
 */
export function controllerProfile(result: unknown): {
  partitions: Record<string, ControllerEntry>;
} {
  const rows = rowsOf(result);
  const working = new Map<
    string,
    { refreshes: number; counts: Record<string, number>; co_controlled: number }
  >();

  for (const row of rows) {
    const partition = String(row.partition);
    const entry =
      working.get(partition) ?? { refreshes: 0, counts: {}, co_controlled: 0 };
    entry.refreshes += 1;
    if (row.controller_instruments.length > 1) entry.co_controlled += 1;
    for (const instrument of row.controller_instruments) {
      entry.counts[instrument] = (entry.counts[instrument] ?? 0) + 1;
    }
    working.set(partition, entry);
  }

  const partitions: Record<string, ControllerEntry> = {};
  for (const partition of [...working.keys()].sort()) {
    const entry = working.get(partition)!;
    const counts = sortedRecord(entry.counts);
    const shares: Record<string, number> = {};
    for (const [instrument, count] of Object.entries(counts)) {
      shares[instrument] = count / entry.refreshes;
    }
    const ranked = Object.entries(counts).sort(
      ([nameA, a], [nameB, b]) => b - a || (nameA < nameB ? 1 : -1),
    );
    partitions[partition] = {
      refreshes: entry.refreshes,
      counts,
      shares,
      co_controlled: entry.co_controlled,
      // The single name most responsible for the sampling frequency.
      dominant: ranked.length ? ranked[0]![0] : null,
    };
  }
  return { partitions };
}

/** Per-instrument arrivals against updates that survived into the sample. */
export function lossReport(result: unknown): {
  partitions: Record<string, LossEntry>;
  summaries: Record<string, RefreshResult["partitions"][number]>;
} {
  const rows = rowsOf(result);
  const working = new Map<
    string,
    { refreshes: number; arrivals: Record<string, number>; sampled: Record<string, number> }
  >();

  for (const row of rows) {
    const partition = String(row.partition);
    const entry = working.get(partition) ?? { refreshes: 0, arrivals: {}, sampled: {} };
    entry.refreshes += 1;
    for (const [instrument, count] of Object.entries(row.arrivals_by_instrument)) {
      entry.arrivals[instrument] = (entry.arrivals[instrument] ?? 0) + count;
    }
    for (const instrument of Object.keys(row.values)) {
      entry.sampled[instrument] = (entry.sampled[instrument] ?? 0) + 1;
    }
    working.set(partition, entry);
  }

  const partitions: Record<string, LossEntry> = {};
  for (const partition of [...working.keys()].sort()) {
    const entry = working.get(partition)!;
    const arrivals = sortedRecord(entry.arrivals);
    const sampled = sortedRecord(entry.sampled);
    const retention: Record<string, number | null> = {};
    for (const [instrument, count] of Object.entries(arrivals)) {
      retention[instrument] = count ? (sampled[instrument] ?? 0) / count : null;
    }
    partitions[partition] = { refreshes: entry.refreshes, arrivals, sampled, retention };
  }

  const summaries: Record<string, RefreshResult["partitions"][number]> = {};
  for (const summary of (result as RefreshResult).partitions) {
    summaries[String(summary.partition)] = { ...summary };
  }
  return { partitions, summaries };
}

/**
 * Distribution of gaps between consecutive refreshes, per partition.
 *
 * Refresh intervals are **not** evenly spaced. Any downstream estimator that assumes a
 * fixed sampling interval is misspecified on this series, and the spread between
 * `min_ms` and `max_ms` is how badly.
 */
export function cadenceProfile(result: unknown): {
  partitions: Record<string, CadenceEntry>;
} {
  const rows = rowsOf(result);
  const byPartition = new Map<string, number[]>();
  for (const row of rows) {
    const partition = String(row.partition);
    const stamps = byPartition.get(partition) ?? [];
    stamps.push(parseTimestampMs(row.refresh_available_at, "refresh_available_at"));
    byPartition.set(partition, stamps);
  }

  const partitions: Record<string, CadenceEntry> = {};
  for (const partition of [...byPartition.keys()].sort()) {
    const stamps = byPartition.get(partition)!;
    const gaps: number[] = [];
    for (let index = 1; index < stamps.length; index += 1) {
      gaps.push(stamps[index]! - stamps[index - 1]!);
    }
    const max = gaps.length ? Math.max(...gaps) : 0;
    partitions[partition] = {
      refreshes: stamps.length,
      intervals: gaps.length,
      min_ms: gaps.length ? Math.min(...gaps) : null,
      median_ms: gaps.length ? median(gaps) : null,
      max_ms: gaps.length ? max : null,
      // 1.0 would be perfectly regular. Anything else is the irregularity a
      // fixed-interval model would be pretending away.
      regularity: gaps.length && max ? Math.min(...gaps) / max : null,
    };
  }
  return { partitions };
}

/**
 * Re-run the sampler over candidate instrument subsets and compare the cost.
 *
 * This is the decision tool. Adding one slow name to a basket can halve the number of
 * refreshes — every other instrument then waits for it — and that shows up here as a
 * smaller `refresh_candidates` and a larger `loss_share`.
 */
export function subsetComparison(
  observations: Iterable<Observation>,
  subsets: Iterable<Iterable<string>>,
  maxStalenessMs: number,
): SubsetEntry[] {
  const observationList = [...observations].map((row) => ({ ...row }));
  const results: SubsetEntry[] = [];
  let baseline: number | null = null;

  for (const subset of subsets) {
    const instruments = [...new Set(subset)].sort();
    if (instruments.length < 2) {
      throw new Error("each subset must contain at least two instruments");
    }
    const allowed = new Set(instruments);
    const filtered = observationList.filter((row) => allowed.has(row.instrument));
    const result = refreshTimeSample(filtered, instruments, maxStalenessMs);

    const refreshes = result.partitions.reduce(
      (sum, summary) => sum + summary.refresh_candidates,
      0,
    );
    const numerator = result.partitions.reduce(
      (sum, summary) => sum + summary.loss_fraction.numerator,
      0,
    );
    const denominator = result.partitions.reduce(
      (sum, summary) => sum + summary.loss_fraction.denominator,
      0,
    );
    const medians = Object.values(cadenceProfile(result).partitions)
      .map((entry) => entry.median_ms)
      .filter((value): value is number => value !== null);
    const controllers = Object.values(controllerProfile(result).partitions)
      .map((entry) => entry.dominant)
      .filter((value): value is string => value !== null);

    if (baseline === null) baseline = refreshes;

    results.push({
      instruments,
      refresh_candidates: refreshes,
      input_updates: denominator,
      discarded: numerator,
      loss_share: denominator ? numerator / denominator : 0,
      median_cadence_ms: medians.length ? median(medians) : null,
      dominant_controllers: [...new Set(controllers)].sort(),
      refreshes_vs_first: refreshes - baseline,
    });
  }

  return results;
}
