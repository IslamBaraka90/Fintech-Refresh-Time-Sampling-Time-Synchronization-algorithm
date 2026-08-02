/**
 * Causal all-refresh sampling: sample when everybody has spoken.
 *
 * ## The problem this solves
 *
 * Two instruments do not trade on the same clock. One prints ten times a second, the
 * other twice a minute. Any attempt to put them on a shared grid has to decide what to
 * do about the silent one, and the usual answers — carry the last value forward, or
 * interpolate — both introduce a bias that shows up as spurious correlation. Sampling
 * frequently makes it worse, not better: the more often you sample, the more of your
 * series is stale carry-forward rather than observation.
 *
 * Refresh-time sampling takes the other route. **It lets the data choose the sampling
 * times.** A refresh occurs at the first moment every required instrument has posted at
 * least one new observation since the last refresh. At that instant, and only then,
 * every instrument has something fresh to say, and the cross-section is a set of real
 * observations rather than a mixture of observations and assumptions.
 *
 * ## What it costs, stated plainly
 *
 * It throws data away, and often most of it. A fast instrument may print twenty times
 * while the slow one prints once; nineteen of those updates never appear in the output.
 * This module does not hide that — every refresh row reports `discarded_updates`, and
 * every partition reports a `loss_fraction`. On the reference fixture that fraction is
 * **13/25**: over half the input never reaches the sample.
 *
 * ## The operational clock is `available_at`
 *
 * Not `event_time`. A refresh happens when your system *learns* things, not when the
 * market did them, because a sampler cannot act on an observation it has not received.
 * `event_time` is kept as lineage and drives the staleness diagnostic: if the freshest
 * available value is nonetheless very old, the row comes back with `status: "stale"`
 * rather than being silently repaired or dropped.
 */

export const REQUIRED_FIELDS = [
  "partition",
  "instrument",
  "record_id",
  "revision",
  "event_time",
  "available_at",
  "value",
] as const;

export interface Observation {
  partition: string;
  instrument: string;
  record_id: string;
  revision: number;
  event_time: string;
  available_at: string;
  value: number;
}

export interface SourceRef {
  record_id: string;
  revision: number;
  event_time: string;
  available_at: string;
}

export interface RefreshRow {
  partition: string;
  sequence: number;
  previous_refresh_available_at: string | null;
  refresh_available_at: string;
  controller_instruments: string[];
  status: "accepted" | "stale";
  values: Record<string, number>;
  sources: Record<string, SourceRef>;
  event_age_ms: Record<string, number>;
  arrivals_by_instrument: Record<string, number>;
  discarded_updates: number;
}

export interface PartitionSummary {
  partition: string;
  input_updates: number;
  refresh_candidates: number;
  accepted_rows: number;
  stale_rows: number;
  discarded_updates: number;
  unmatched_tail_updates: number;
  loss_fraction: { numerator: number; denominator: number };
}

export interface RefreshResult {
  rows: RefreshRow[];
  partitions: PartitionSummary[];
}

export interface NormalisedRow extends Observation {
  eventMs: number;
  availableMs: number;
}

/** RFC 3339 UTC, `Z` only, millisecond precision at most. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Sentinel for "before any arrival". Finite, so it survives a JSON round-trip. */
export const BEFORE_TIME = -(2 ** 53);

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1]!;

/**
 * Days since 1970-01-01 for a proleptic-Gregorian date, by integer arithmetic.
 *
 * Deliberately not `Date.UTC`: that helper maps two-digit years into the 1900s and
 * accepts out-of-range days by rolling them over, both of which would let this port
 * disagree with the Python one.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Parse an RFC 3339 UTC timestamp to integer milliseconds since the epoch.
 *
 * Strict by design: `2026-02-30` is rejected rather than rolled over.
 */
export function parseTimestampMs(value: unknown, field = "timestamp"): number {
  if (typeof value !== "string") {
    throw new Error(`${field} must be an RFC 3339 UTC string ending in Z`);
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    throw new Error(
      `${field} must be an RFC 3339 UTC string ending in Z ` +
        `(millisecond precision at most), got: ${JSON.stringify(value)}`,
    );
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const fraction = match[7] ?? "";
  const millisecond = fraction === "" ? 0 : Number(fraction.padEnd(3, "0"));

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw new Error(`${field} is not a real calendar time: ${JSON.stringify(value)}`);
  }

  return (
    daysFromCivil(year, month, day) * 86_400_000 +
    (hour * 3600 + minute * 60 + second) * 1000 +
    millisecond
  );
}

/** Render integer milliseconds back to the RFC 3339 form this package accepts. */
export function formatTimestampMs(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function requireInstruments(required: Iterable<unknown>): string[] {
  const instruments = [...new Set(required)].sort() as string[];
  if (instruments.length < 2) {
    throw new Error("required_instruments must contain at least two names");
  }
  if (instruments.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new Error("required_instruments must contain at least two names");
  }
  return instruments;
}

/**
 * Validate ONE observation's shape and values, in isolation.
 *
 * Deliberately free of any cross-row check. The streaming sampler validates arrivals
 * one at a time and carries its own revision history, so folding the history rules in
 * here would make a lone revision-1 arrival look like a record starting at revision 1.
 */
export function normaliseRow(raw: unknown, allowed: Set<string>): NormalisedRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("each observation must be a mapping");
  }
  const source = raw as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((field) => !(field in source));
  if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
  if (!allowed.has(source.instrument as string)) {
    throw new Error(`unexpected instrument: ${source.instrument}`);
  }
  if (typeof source.partition !== "string" || source.partition.trim() === "") {
    throw new Error("partition and record_id must be non-empty");
  }
  if (typeof source.record_id !== "string" || source.record_id.trim() === "") {
    throw new Error("partition and record_id must be non-empty");
  }
  if (typeof source.revision !== "number" || !Number.isInteger(source.revision)) {
    throw new Error("revision must be a non-negative integer");
  }
  if (source.revision < 0) throw new Error("revision must be a non-negative integer");

  // Strictly a number, never a coerced string.
  if (typeof source.value !== "number" || !Number.isFinite(source.value)) {
    throw new Error("value must be finite");
  }

  const eventMs = parseTimestampMs(source.event_time, "event_time");
  const availableMs = parseTimestampMs(source.available_at, "available_at");
  if (eventMs > availableMs) throw new Error("event_time cannot be after available_at");

  return {
    partition: source.partition,
    instrument: source.instrument as string,
    record_id: source.record_id,
    revision: source.revision,
    event_time: source.event_time as string,
    available_at: source.available_at as string,
    value: source.value,
    eventMs,
    availableMs,
  };
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Corrections must be contiguous, later, and about the same instrument. */
function checkRevisionHistories(rows: NormalisedRow[]): void {
  const histories = new Map<string, NormalisedRow>();
  const eventOwners = new Map<string, string>();

  for (const row of rows) {
    const eventKey = `${row.partition}|${row.instrument}|${row.eventMs}`;
    const owner = eventOwners.get(eventKey);
    if (owner === undefined) eventOwners.set(eventKey, row.record_id);
    else if (owner !== row.record_id) {
      // Two different records claiming the same event instant makes "the value at that
      // instant" undefined, and the answer would depend on input order.
      throw new Error("ambiguous duplicate event_time across distinct record_id values");
    }

    const key = `${row.partition}|${row.record_id}`;
    const previous = histories.get(key);
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
    histories.set(key, row);
  }
}

/**
 * Validate every observation and return it sorted into arrival order.
 *
 * Sorting is by `(partition, available_at, instrument, record_id, revision)` — the
 * order a consumer would have seen, with deterministic tie-breaking so two runs over
 * the same data can never disagree.
 */
export function normalise(
  observations: Iterable<unknown>,
  requiredInstruments: Iterable<unknown>,
): { rows: NormalisedRow[]; instruments: string[] } {
  const instruments = requireInstruments(requiredInstruments);
  const allowed = new Set(instruments);
  const rows = [...observations].map((raw) => normaliseRow(raw, allowed));

  rows.sort(
    (a, b) =>
      compareStrings(a.partition, b.partition) ||
      a.availableMs - b.availableMs ||
      compareStrings(a.instrument, b.instrument) ||
      compareStrings(a.record_id, b.record_id) ||
      a.revision - b.revision,
  );
  checkRevisionHistories(rows);
  return { rows, instruments };
}

/**
 * Pick the value in force for each instrument from the known records.
 *
 * `latestByRecord` already holds only the newest revision of each record, so this picks
 * the newest *event* per instrument, breaking ties by arrival and then by `record_id`
 * so the result never depends on iteration order.
 */
export function select(
  latestByRecord: Map<string, NormalisedRow>,
  instruments: string[],
): Record<string, NormalisedRow> {
  const selected: Record<string, NormalisedRow> = {};
  const all = [...latestByRecord.values()];

  for (const instrument of instruments) {
    const candidates = all.filter((row) => row.instrument === instrument);
    if (candidates.length === 0) throw new Error(`no known observation for ${instrument}`);

    const eventOwners = new Map<number, string>();
    for (const row of candidates) {
      const owner = eventOwners.get(row.eventMs);
      if (owner === undefined) eventOwners.set(row.eventMs, row.record_id);
      else if (owner !== row.record_id) {
        throw new Error("ambiguous duplicate event_time across distinct record_id values");
      }
    }

    selected[instrument] = candidates.reduce((best, row) =>
      row.eventMs > best.eventMs ||
      (row.eventMs === best.eventMs &&
        (row.availableMs > best.availableMs ||
          (row.availableMs === best.availableMs && row.record_id > best.record_id)))
        ? row
        : best,
    );
  }
  return selected;
}

export function buildRow(
  partition: string,
  sequence: number,
  cursor: number,
  refreshMs: number,
  controllers: string[],
  selected: Record<string, NormalisedRow>,
  instruments: string[],
  arrivalsByInstrument: Record<string, number>,
  discarded: number,
  maxStalenessMs: number,
): RefreshRow {
  const ages: Record<string, number> = {};
  for (const instrument of instruments) {
    ages[instrument] = refreshMs - selected[instrument]!.eventMs;
  }
  const values: Record<string, number> = {};
  const sources: Record<string, SourceRef> = {};
  for (const instrument of instruments) {
    const row = selected[instrument]!;
    values[instrument] = row.value;
    sources[instrument] = {
      record_id: row.record_id,
      revision: row.revision,
      event_time: row.event_time,
      available_at: row.available_at,
    };
  }

  return {
    partition,
    sequence,
    previous_refresh_available_at:
      cursor === BEFORE_TIME ? null : formatTimestampMs(cursor),
    refresh_available_at: formatTimestampMs(refreshMs),
    controller_instruments: controllers,
    status: Math.max(...Object.values(ages)) > maxStalenessMs ? "stale" : "accepted",
    values,
    sources,
    event_age_ms: ages,
    arrivals_by_instrument: arrivalsByInstrument,
    discarded_updates: discarded,
  };
}

/**
 * Return complete refresh candidates and per-partition information loss.
 *
 * @param observations Rows carrying every field in {@link REQUIRED_FIELDS}.
 * @param requiredInstruments The names that must all refresh. At least two — a
 *   "refresh" across one instrument is just that instrument's own clock.
 * @param maxStalenessMs Age past which a complete row is flagged `stale`. The row is
 *   still returned; it is a diagnostic, not a filter.
 */
export function refreshTimeSample(
  observations: Iterable<unknown>,
  requiredInstruments: Iterable<unknown>,
  maxStalenessMs: number,
): RefreshResult {
  if (
    typeof maxStalenessMs !== "number" ||
    !Number.isInteger(maxStalenessMs) ||
    maxStalenessMs < 0
  ) {
    throw new Error("max_staleness_ms must be a non-negative integer");
  }

  const { rows, instruments } = normalise(observations, requiredInstruments);
  const partitions = [...new Set(rows.map((row) => row.partition))].sort(compareStrings);

  const outputRows: RefreshRow[] = [];
  const summaries: PartitionSummary[] = [];

  for (const partition of partitions) {
    const arrivals = rows.filter((row) => row.partition === partition);
    const byInstrument = new Map<string, NormalisedRow[]>();
    for (const instrument of instruments) {
      byInstrument.set(
        instrument,
        arrivals.filter((row) => row.instrument === instrument),
      );
    }
    // One cursor per instrument, advanced in step with the refresh cursor, so the scan
    // for "first arrival after the cursor" never restarts from the beginning.
    const pointers = new Map(instruments.map((instrument) => [instrument, 0]));
    const latestByRecord = new Map<string, NormalisedRow>();
    let knownIndex = 0;

    let cursor = BEFORE_TIME;
    let sequence = 0;
    let discardedTotal = 0;
    let staleCount = 0;
    let acceptedCount = 0;

    for (;;) {
      const firstNew = new Map<string, NormalisedRow>();
      let complete = true;
      for (const instrument of instruments) {
        const queue = byInstrument.get(instrument)!;
        let index = pointers.get(instrument)!;
        while (index < queue.length && queue[index]!.availableMs <= cursor) index += 1;
        pointers.set(instrument, index);
        if (index >= queue.length) {
          complete = false;
          break;
        }
        firstNew.set(instrument, queue[index]!);
      }
      if (!complete) break;

      // The refresh happens when the LAST of them lands — that instrument is the
      // controller, and it is the one deciding your sampling frequency.
      const refreshMs = Math.max(...[...firstNew.values()].map((row) => row.availableMs));

      let intervalCount = 0;
      while (knownIndex < arrivals.length && arrivals[knownIndex]!.availableMs <= refreshMs) {
        const row = arrivals[knownIndex]!;
        if (row.availableMs > cursor) intervalCount += 1;
        latestByRecord.set(row.record_id, row);
        knownIndex += 1;
      }

      const selected = select(latestByRecord, instruments);
      const kept = new Set(
        Object.values(selected)
          .filter((row) => row.availableMs > cursor && row.availableMs <= refreshMs)
          .map((row) => `${row.record_id}|${row.revision}`),
      );
      const discarded = intervalCount - kept.size;
      discardedTotal += discarded;

      const arrivalsByInstrument: Record<string, number> = {};
      for (const instrument of instruments) {
        arrivalsByInstrument[instrument] = arrivals.filter(
          (row) =>
            row.instrument === instrument &&
            row.availableMs > cursor &&
            row.availableMs <= refreshMs,
        ).length;
      }

      sequence += 1;
      const built = buildRow(
        partition,
        sequence,
        cursor,
        refreshMs,
        [...firstNew.entries()]
          .filter(([, row]) => row.availableMs === refreshMs)
          .map(([instrument]) => instrument)
          .sort(compareStrings),
        selected,
        instruments,
        arrivalsByInstrument,
        discarded,
        maxStalenessMs,
      );
      if (built.status === "stale") staleCount += 1;
      else acceptedCount += 1;
      outputRows.push(built);
      cursor = refreshMs;
    }

    const tail = arrivals.filter((row) => row.availableMs > cursor).length;
    summaries.push({
      partition,
      input_updates: arrivals.length,
      refresh_candidates: sequence,
      accepted_rows: acceptedCount,
      stale_rows: staleCount,
      discarded_updates: discardedTotal,
      // Arrivals after the final refresh: real data that never made it into a complete
      // cross-section because the session ended first.
      unmatched_tail_updates: tail,
      loss_fraction: { numerator: discardedTotal + tail, denominator: arrivals.length },
    });
  }

  return { rows: outputRows, partitions: summaries };
}
