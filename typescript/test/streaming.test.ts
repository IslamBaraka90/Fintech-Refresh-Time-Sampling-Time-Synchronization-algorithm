/**
 * Tests for the live sampler.
 *
 * The load-bearing assertion is "streaming equals batch": feeding the fixture one
 * arrival at a time must reproduce the batch result exactly — rows, sources, counts and
 * summary. Refresh-time sampling has nothing to look ahead to, so there is no excuse for
 * the two paths to differ.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamingRefreshSampler } from "../src/streaming.ts";
import { EXPECTED, INSTRUMENTS, MAX_STALENESS_MS, arrivalOrder, sample } from "./fixtures.ts";

const live = (instruments: string[] = INSTRUMENTS, maxStalenessMs = MAX_STALENESS_MS) =>
  new StreamingRefreshSampler(instruments, maxStalenessMs);

// --- equivalence with the batch function ---------------------------------------- //
test("streaming equals batch", () => {
  assert.deepEqual(live().observeMany(arrivalOrder()), EXPECTED.rows);
});

test("the summary equals the batch summary", () => {
  const engine = live();
  engine.observeMany(arrivalOrder());
  assert.deepEqual(engine.summary, EXPECTED.partitions[0]);
});

test("the loss accounting survives the streaming path", () => {
  const engine = live();
  engine.observeMany(arrivalOrder());
  assert.deepEqual(engine.summary.loss_fraction, { numerator: 13, denominator: 25 });
});

// --- emission timing -------------------------------------------------------------- //
test("nothing is emitted until every instrument has spoken", () => {
  const engine = live();
  const rows = arrivalOrder();
  assert.equal(engine.observe(rows[0]), null);
  assert.equal(engine.observe(rows[1]), null);
  const third = engine.observe(rows[2]);
  assert.notEqual(third, null);
  assert.equal(third!.sequence, 1);
});

test("the emitting arrival is the controller", () => {
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[0]);
  engine.observe(rows[1]);
  assert.deepEqual(engine.observe(rows[2])!.controller_instruments, ["GAMMA"]);
});

test("a refresh is emitted exactly once", () => {
  const engine = live();
  const emitted = engine.observeMany(arrivalOrder());
  assert.equal(emitted.length, 4);
  assert.equal(engine.refreshCount, 4);
});

test("the engine reports what it is waiting for", () => {
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[0]);
  assert.deepEqual(engine.waitingFor, ["BETA", "GAMMA"]);
  engine.observe(rows[1]);
  assert.deepEqual(engine.waitingFor, ["GAMMA"]);
});

test("a fresh engine waits for everyone", () => {
  assert.deepEqual(live().waitingFor, [...INSTRUMENTS].sort());
});

test("the last refresh time tracks the emissions", () => {
  const engine = live();
  assert.equal(engine.lastRefreshAt, null);
  const emitted = engine.observeMany(arrivalOrder());
  assert.equal(engine.lastRefreshAt, emitted.at(-1)!.refresh_available_at);
});

// --- ordering and partitions ------------------------------------------------------- //
test("out-of-order arrival is rejected", () => {
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[5]);
  assert.throws(() => engine.observe(rows[0]), /non-decreasing available_at/);
});

test("a second partition is refused", () => {
  // Interleaving two sessions into one series would be silently wrong.
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[0]);
  assert.throws(
    () => engine.observe({ ...rows[1]!, partition: "2026-01-06:XNYS:REG" }),
    /one sampler handles one partition/,
  );
});

test("simultaneous arrivals are allowed", () => {
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[0]);
  engine.observe({ ...rows[1]!, available_at: rows[0]!.available_at });
  assert.deepEqual(engine.waitingFor, ["GAMMA"]);
});

// --- validation carries over -------------------------------------------------------- //
test("a correction out of sequence is rejected live", () => {
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[0]);
  assert.throws(
    () => engine.observe({ ...rows[0]!, revision: 2, available_at: "2026-01-05T14:30:30.000Z" }),
    /contiguous/,
  );
});

test("a duplicate event instant is rejected live", () => {
  const engine = live();
  const rows = arrivalOrder();
  engine.observe(rows[0]);
  assert.throws(
    () =>
      engine.observe({
        ...rows[0]!,
        record_id: "other",
        available_at: "2026-01-05T14:30:30.000Z",
      }),
    /ambiguous duplicate event_time/,
  );
});

test("a bad value is rejected at ingestion", () => {
  const engine = live();
  const bad = { ...arrivalOrder()[0]! } as unknown as Record<string, unknown>;
  bad.value = "100";
  assert.throws(() => engine.observe(bad), /value must be finite/);
});

test("an unexpected instrument is rejected live", () => {
  const engine = live();
  const bad = { ...arrivalOrder()[0]!, instrument: "DELTA" };
  assert.throws(() => engine.observe(bad), /unexpected instrument/);
});

for (const bad of [-1, 1.5, "5000", true, null, NaN] as unknown[]) {
  test(`a bad budget raises (${String(bad)})`, () => {
    assert.throws(
      () => new StreamingRefreshSampler(INSTRUMENTS, bad as number),
      /max_staleness_ms/,
    );
  });
}

test("a one-name basket raises", () => {
  assert.throws(() => live(["ALPHA"]), /at least two/);
});

// --- staleness ---------------------------------------------------------------------- //
test("a tight budget flags live rows stale", () => {
  const engine = live(INSTRUMENTS, 0);
  const emitted = engine.observeMany(arrivalOrder());
  assert.deepEqual([...new Set(emitted.map((row) => row.status))], ["stale"]);
  assert.equal(engine.summary.stale_rows, 4);
});

test("the tight-budget result still equals the batch one", () => {
  assert.deepEqual(
    live(INSTRUMENTS, 0).observeMany(arrivalOrder()),
    sample(null, null, 0).rows,
  );
});
