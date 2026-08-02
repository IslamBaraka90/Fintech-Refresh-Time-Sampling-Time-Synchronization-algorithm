/**
 * Refresh sampling as it actually happens: one arrival at a time.
 *
 * Refresh-time sampling is a streaming algorithm wearing a batch costume. A refresh is
 * detected the instant the last required instrument posts — there is nothing to look
 * ahead to, and nothing to wait for beyond the arrival itself. So the live engine is not
 * an approximation of the batch function here; it is the same computation, driven by the
 * feed instead of by a loop.
 *
 * {@link StreamingRefreshSampler.observe} returns the refresh row if that arrival
 * completed one, and `null` otherwise. That single return value is the whole API: the
 * moment a refresh is emitted is the moment it became true.
 *
 * The batch function and this engine are asserted to produce identical rows for
 * identical input, because the day they diverge is the day your research and your
 * production sampler stop describing the same series.
 */

import {
  BEFORE_TIME,
  type NormalisedRow,
  type PartitionSummary,
  type RefreshRow,
  buildRow,
  formatTimestampMs,
  normaliseRow,
  requireInstruments,
  select,
} from "./core.ts";

/** Emit refresh cross-sections as arrivals complete them. */
export class StreamingRefreshSampler {
  readonly #instruments: string[];
  readonly #allowed: Set<string>;
  readonly #maxStalenessMs: number;

  #partition: string | null = null;
  #cursor = BEFORE_TIME;
  #sequence = 0;
  #lastAvailableMs: number | null = null;
  #latestByRecord = new Map<string, NormalisedRow>();
  #histories = new Map<string, NormalisedRow>();
  #eventOwners = new Map<string, string>();
  #pending = new Map<string, NormalisedRow[]>();
  #discardedTotal = 0;
  #accepted = 0;
  #stale = 0;
  #inputUpdates = 0;

  /**
   * @param requiredInstruments The names that must all refresh. At least two.
   * @param maxStalenessMs Age past which a complete row is flagged `stale`.
   *
   * One sampler handles one partition at a time. Feeding it two partitions throws,
   * rather than silently interleaving two unrelated sessions into one series.
   */
  constructor(requiredInstruments: Iterable<unknown>, maxStalenessMs: number) {
    if (
      typeof maxStalenessMs !== "number" ||
      !Number.isInteger(maxStalenessMs) ||
      maxStalenessMs < 0
    ) {
      throw new Error("max_staleness_ms must be a non-negative integer");
    }
    this.#instruments = requireInstruments(requiredInstruments);
    this.#allowed = new Set(this.#instruments);
    this.#maxStalenessMs = maxStalenessMs;
    for (const instrument of this.#instruments) this.#pending.set(instrument, []);
  }

  // --- ingestion ---------------------------------------------------------- //
  /** Ingest one arrival. Returns a refresh row if this arrival completed one. */
  observe(observation: unknown): RefreshRow | null {
    // Per-row validation only. The cross-row revision rules are enforced by
    // #checkHistory below, which carries state the batch validator cannot see.
    const row = normaliseRow(observation, this.#allowed);

    if (this.#partition === null) this.#partition = row.partition;
    else if (row.partition !== this.#partition) {
      throw new Error(
        `one sampler handles one partition; got ${JSON.stringify(row.partition)} ` +
          `after ${JSON.stringify(this.#partition)}`,
      );
    }

    if (this.#lastAvailableMs !== null && row.availableMs < this.#lastAvailableMs) {
      throw new Error("observations must arrive in non-decreasing available_at order");
    }
    this.#checkHistory(row);

    this.#lastAvailableMs = row.availableMs;
    this.#inputUpdates += 1;
    this.#latestByRecord.set(row.record_id, row);
    this.#pending.get(row.instrument)!.push(row);

    for (const queue of this.#pending.values()) {
      if (queue.length === 0) return null;
    }
    return this.#emit(row.availableMs);
  }

  /** Ingest many arrivals, returning every refresh row they completed. */
  observeMany(observations: Iterable<unknown>): RefreshRow[] {
    const emitted: RefreshRow[] = [];
    for (const observation of observations) {
      const row = this.observe(observation);
      if (row !== null) emitted.push(row);
    }
    return emitted;
  }

  #checkHistory(row: NormalisedRow): void {
    const eventKey = `${row.instrument}|${row.eventMs}`;
    const owner = this.#eventOwners.get(eventKey);
    if (owner === undefined) this.#eventOwners.set(eventKey, row.record_id);
    else if (owner !== row.record_id) {
      throw new Error("ambiguous duplicate event_time across distinct record_id values");
    }

    const previous = this.#histories.get(row.record_id);
    if (previous === undefined) {
      if (row.revision !== 0) throw new Error("the first revision of a record must be zero");
    } else {
      if (row.instrument !== previous.instrument) {
        throw new Error("a correction cannot change instrument");
      }
      if (row.revision !== previous.revision + 1) {
        throw new Error("record revisions must be contiguous");
      }
      if (row.availableMs <= previous.availableMs) {
        throw new Error("corrections must become available strictly later");
      }
    }
    this.#histories.set(row.record_id, row);
  }

  #emit(refreshMs: number): RefreshRow {
    const selected = select(this.#latestByRecord, this.#instruments);
    const controllers = [...this.#pending.entries()]
      .filter(([, queue]) => queue[0]!.availableMs === refreshMs)
      .map(([instrument]) => instrument)
      .sort();

    const kept = new Set(
      Object.values(selected)
        .filter((row) => row.availableMs > this.#cursor && row.availableMs <= refreshMs)
        .map((row) => `${row.record_id}|${row.revision}`),
    );
    let intervalCount = 0;
    const arrivalsByInstrument: Record<string, number> = {};
    for (const instrument of this.#instruments) {
      const count = this.#pending.get(instrument)!.length;
      arrivalsByInstrument[instrument] = count;
      intervalCount += count;
    }

    const discarded = intervalCount - kept.size;
    this.#discardedTotal += discarded;
    this.#sequence += 1;

    const emitted = buildRow(
      this.#partition!,
      this.#sequence,
      this.#cursor,
      refreshMs,
      controllers,
      selected,
      this.#instruments,
      arrivalsByInstrument,
      discarded,
      this.#maxStalenessMs,
    );
    if (emitted.status === "stale") this.#stale += 1;
    else this.#accepted += 1;

    this.#cursor = refreshMs;
    // Every queue is non-empty here, so keeping only arrivals after the refresh leaves
    // exactly what has not yet been consumed.
    for (const instrument of this.#instruments) {
      this.#pending.set(
        instrument,
        this.#pending.get(instrument)!.filter((row) => row.availableMs > refreshMs),
      );
    }
    return emitted;
  }

  // --- introspection ------------------------------------------------------ //
  /** The same partition summary the batch function reports. */
  get summary(): PartitionSummary {
    let tail = 0;
    for (const queue of this.#pending.values()) tail += queue.length;
    return {
      partition: this.#partition as string,
      input_updates: this.#inputUpdates,
      refresh_candidates: this.#sequence,
      accepted_rows: this.#accepted,
      stale_rows: this.#stale,
      discarded_updates: this.#discardedTotal,
      unmatched_tail_updates: tail,
      loss_fraction: {
        numerator: this.#discardedTotal + tail,
        denominator: this.#inputUpdates,
      },
    };
  }

  /**
   * Instruments that have not posted since the last refresh.
   *
   * The live version of the controller question: whatever is in this list is what the
   * whole basket is currently waiting on.
   */
  get waitingFor(): string[] {
    return [...this.#pending.entries()]
      .filter(([, queue]) => queue.length === 0)
      .map(([instrument]) => instrument)
      .sort();
  }

  get refreshCount(): number {
    return this.#sequence;
  }

  get lastRefreshAt(): string | null {
    return this.#cursor === BEFORE_TIME ? null : formatTimestampMs(this.#cursor);
  }
}
