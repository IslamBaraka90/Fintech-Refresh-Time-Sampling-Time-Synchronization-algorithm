/**
 * Contract tests for the sampler.
 *
 * The fixture is the cross-language acceptance anchor: 25 arrivals across three
 * instruments in one session, producing four refresh cross-sections and discarding 13
 * updates. Its complete expected output — every row, every source, every count — is
 * asserted verbatim by this suite and by the Python one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTimestampMs, refreshTimeSample } from "../src/core.ts";
import { EXPECTED, INSTRUMENTS, MAX_STALENESS_MS, observations, sample } from "./fixtures.ts";

// --- the shared fixture ------------------------------------------------------- //
test("the whole result matches the fixture", () => {
  assert.deepEqual(sample(), EXPECTED);
});

test("the fixture produces four refreshes from twenty-five arrivals", () => {
  const summary = sample().partitions[0]!;
  assert.equal(summary.input_updates, 25);
  assert.equal(summary.refresh_candidates, 4);
  assert.equal(sample().rows.length, 4);
});

test("over half the input never reaches the sample", () => {
  // The honest price of the method, asserted rather than mentioned.
  const summary = sample().partitions[0]!;
  assert.deepEqual(summary.loss_fraction, { numerator: 13, denominator: 25 });
  assert.equal(summary.discarded_updates, 10);
  assert.equal(summary.unmatched_tail_updates, 3);
});

test("sequences are contiguous from one", () => {
  assert.deepEqual(sample().rows.map((row) => row.sequence), [1, 2, 3, 4]);
});

test("every row carries every instrument", () => {
  for (const row of sample().rows) {
    assert.deepEqual(Object.keys(row.values).sort(), [...INSTRUMENTS].sort());
    assert.deepEqual(Object.keys(row.sources).sort(), [...INSTRUMENTS].sort());
  }
});

test("no observations produces nothing", () => {
  assert.deepEqual(refreshTimeSample([], INSTRUMENTS, MAX_STALENESS_MS), {
    rows: [],
    partitions: [],
  });
});

// --- the refresh rule ---------------------------------------------------------- //
test("the first refresh waits for the last instrument", () => {
  const row = sample().rows[0]!;
  assert.equal(row.refresh_available_at, "2026-01-05T14:30:00.340Z");
  assert.deepEqual(row.controller_instruments, ["GAMMA"]);
});

test("the slow instrument controls every refresh", () => {
  // One name is setting the sampling frequency for the whole basket.
  assert.deepEqual(
    sample().rows.map((row) => row.controller_instruments),
    [["GAMMA"], ["GAMMA"], ["GAMMA"], ["GAMMA"]],
  );
});

test("the first row has no previous refresh", () => {
  assert.equal(sample().rows[0]!.previous_refresh_available_at, null);
});

test("each row chains to the one before", () => {
  const rows = sample().rows;
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(
      rows[index]!.previous_refresh_available_at,
      rows[index - 1]!.refresh_available_at,
    );
  }
});

test("refresh times strictly increase", () => {
  const stamps = sample().rows.map((row) => row.refresh_available_at);
  assert.deepEqual(stamps, [...stamps].sort());
  assert.equal(new Set(stamps).size, stamps.length);
});

test("a single-instrument basket is refused", () => {
  // A "refresh" across one instrument is just that instrument's own clock.
  assert.throws(() => sample(null, ["ALPHA"]), /at least two/);
});

// --- values are observations, never carried ------------------------------------ //
test("a source never arrives after its refresh", () => {
  // The causal guarantee: nothing in the row post-dates the row.
  for (const row of sample().rows) {
    const refreshMs = parseTimestampMs(row.refresh_available_at);
    for (const source of Object.values(row.sources)) {
      assert.ok(parseTimestampMs(source.available_at) <= refreshMs);
    }
  }
});

test("every value traces to a named source", () => {
  for (const row of sample().rows) {
    for (const source of Object.values(row.sources)) {
      assert.ok(source.record_id);
      assert.ok(source.revision >= 0);
    }
  }
});

test("event age is measured from the refresh", () => {
  for (const row of sample().rows) {
    const refreshMs = parseTimestampMs(row.refresh_available_at);
    for (const [instrument, age] of Object.entries(row.event_age_ms)) {
      assert.equal(age, refreshMs - parseTimestampMs(row.sources[instrument]!.event_time));
    }
  }
});

// --- staleness ------------------------------------------------------------------ //
test("the fixture is entirely fresh at its budget", () => {
  assert.deepEqual([...new Set(sample().rows.map((row) => row.status))], ["accepted"]);
});

test("a tight budget flags rows stale without dropping them", () => {
  const result = sample(null, null, 0);
  assert.equal(result.rows.length, 4);
  assert.deepEqual([...new Set(result.rows.map((row) => row.status))], ["stale"]);
  assert.equal(result.partitions[0]!.stale_rows, 4);
  assert.equal(result.partitions[0]!.accepted_rows, 0);
});

test("a stale row still carries its values", () => {
  const row = sample(null, null, 0).rows[0]!;
  assert.equal(row.status, "stale");
  assert.ok(Object.values(row.values).every((value) => value !== null));
});

test("staleness does not change which rows exist", () => {
  assert.deepEqual(
    sample(null, null, 0).rows.map((row) => row.refresh_available_at),
    sample(null, null, 10 ** 9).rows.map((row) => row.refresh_available_at),
  );
});

for (const bad of [-1, 1.5, "5000", true, null, NaN] as unknown[]) {
  test(`an invalid budget raises (${String(bad)})`, () => {
    assert.throws(
      () => refreshTimeSample(observations(), INSTRUMENTS, bad as number),
      /max_staleness_ms/,
    );
  });
}

// --- corrections ----------------------------------------------------------------- //
test("a correction must start at revision zero", () => {
  const rows = observations(0);
  rows[0]!.revision = 1;
  assert.throws(() => sample(rows), /first revision/);
});

test("corrections must be contiguous", () => {
  const rows = observations();
  rows.push({ ...rows[0]!, revision: 2, available_at: "2026-01-05T14:30:20.000Z" });
  assert.throws(() => sample(rows), /contiguous/);
});

test("a correction must arrive later than what it corrects", () => {
  const rows = observations();
  rows.push({ ...rows[0]!, revision: 1, available_at: rows[0]!.available_at });
  assert.throws(() => sample(rows), /strictly later/);
});

test("a correction cannot change instrument", () => {
  const rows = observations();
  // A distinct event_time, so it is the instrument rule that catches this and not the
  // duplicate-event ambiguity check.
  rows.push({
    ...rows[0]!,
    revision: 1,
    instrument: "BETA",
    event_time: "2026-01-05T14:30:19.000Z",
    available_at: "2026-01-05T14:30:20.000Z",
  });
  assert.throws(() => sample(rows), /cannot change instrument/);
});

test("two records claiming one event instant are ambiguous", () => {
  const rows = observations();
  rows.push({ ...rows[0]!, record_id: "other", available_at: "2026-01-05T14:30:20.000Z" });
  assert.throws(() => sample(rows), /ambiguous duplicate event_time/);
});

// --- determinism ------------------------------------------------------------------ //
test("input order does not change the answer", () => {
  assert.deepEqual(sample([...observations()].reverse()), sample());
});

test("input rows are never mutated", () => {
  const rows = observations();
  const before = JSON.stringify(rows);
  refreshTimeSample(rows, INSTRUMENTS, MAX_STALENESS_MS);
  assert.equal(JSON.stringify(rows), before);
});

test("partitions are sampled independently", () => {
  const rows = [
    ...observations(),
    ...observations().map((row) => ({ ...row, partition: "2026-01-06:XNYS:REG" })),
  ];
  const result = refreshTimeSample(rows, INSTRUMENTS, MAX_STALENESS_MS);
  assert.equal(result.partitions.length, 2);
  assert.deepEqual(
    [...new Set(result.partitions.map((summary) => summary.refresh_candidates))],
    [4],
  );
});

// --- validation --------------------------------------------------------------------- //
for (const field of ["partition", "instrument", "record_id", "revision", "event_time",
                     "available_at", "value"]) {
  test(`a missing ${field} raises`, () => {
    const rows = observations(0) as unknown as Array<Record<string, unknown>>;
    delete rows[0]![field];
    assert.throws(() => sample(rows), /missing fields/);
  });
}

test("an unexpected instrument raises", () => {
  const rows = observations(0);
  rows[0]!.instrument = "DELTA";
  assert.throws(() => sample(rows), /unexpected instrument/);
});

for (const value of ["100", null, true, NaN, Infinity] as unknown[]) {
  test(`a non-numeric value raises (${String(value)})`, () => {
    // Number("100") would succeed; Python refuses a string outright. So do we.
    const rows = observations(0) as unknown as Array<Record<string, unknown>>;
    rows[0]!.value = value;
    assert.throws(() => sample(rows), /value must be finite/);
  });
}

for (const bad of [-1, 1.5, "0", true] as unknown[]) {
  test(`a bad revision raises (${String(bad)})`, () => {
    const rows = observations(0) as unknown as Array<Record<string, unknown>>;
    rows[0]!.revision = bad;
    assert.throws(() => sample(rows), /revision/);
  });
}

for (const field of ["partition", "record_id"]) {
  test(`an empty ${field} raises`, () => {
    const rows = observations(0) as unknown as Array<Record<string, unknown>>;
    rows[0]![field] = "";
    assert.throws(() => sample(rows), /non-empty/);
  });
}

test("an event after its arrival raises", () => {
  const rows = observations(0);
  rows[0]!.event_time = "2026-01-05T23:00:00.000Z";
  assert.throws(() => sample(rows), /cannot be after available_at/);
});

test("a non-mapping observation raises", () => {
  assert.throws(() => sample(["nope"]), /must be a mapping/);
});

// --- timestamps are strict ------------------------------------------------------------ //
test("an impossible calendar date is rejected", () => {
  assert.throws(() => parseTimestampMs("2026-02-30T00:00:00.000Z"), /not a real calendar time/);
  assert.equal(new Date("2026-02-30T00:00:00.000Z").getUTCMonth(), 2); // proof of the rollover
});

for (const timestamp of [
  "2026-01-05T14:30:00+00:00",
  "2026-01-05T14:30:00",
  "2026-01-05T14:30:00.0001Z",
  "2026-13-05T14:30:00Z",
  "",
  null,
  1767623400000,
] as unknown[]) {
  test(`a malformed timestamp is rejected (${JSON.stringify(timestamp)})`, () => {
    assert.throws(() => parseTimestampMs(timestamp));
  });
}

test("a valid timestamp parses exactly", () => {
  assert.equal(parseTimestampMs("2026-01-05T14:30:00.340Z"), 1_767_623_400_340);
});
