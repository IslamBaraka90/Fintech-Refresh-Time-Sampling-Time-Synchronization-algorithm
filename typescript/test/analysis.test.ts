/** Tests for the controller, loss, cadence and subset diagnostics. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cadenceProfile,
  controllerProfile,
  lossReport,
  subsetComparison,
} from "../src/analysis.ts";
import { INSTRUMENTS, MAX_STALENESS_MS, PARTITION, observations, sample } from "./fixtures.ts";

// --- controllerProfile --------------------------------------------------------- //
test("the profile names the bottleneck", () => {
  // GAMMA controls all four refreshes — it alone sets the sampling frequency.
  const entry = controllerProfile(sample()).partitions[PARTITION]!;
  assert.equal(entry.dominant, "GAMMA");
  assert.deepEqual(entry.counts, { GAMMA: 4 });
  assert.equal(entry.shares.GAMMA, 1);
});

test("the refresh count matches the sample", () => {
  assert.equal(
    controllerProfile(sample()).partitions[PARTITION]!.refreshes,
    sample().rows.length,
  );
});

test("a fast instrument never controls", () => {
  assert.ok(!("ALPHA" in controllerProfile(sample()).partitions[PARTITION]!.counts));
});

test("co-controlled refreshes are counted", () => {
  // Two instruments landing in the same millisecond genuinely share the blame.
  const rows = observations();
  for (const row of rows) {
    if (row.instrument === "GAMMA" && row.available_at.endsWith("00.340Z")) {
      row.available_at = "2026-01-05T14:30:00.220Z";
    }
  }
  const entry = controllerProfile(sample(rows)).partitions[PARTITION]!;
  assert.ok(entry.co_controlled >= 1);
  assert.ok(Object.values(entry.shares).reduce((a, b) => a + b, 0) > 1);
});

test("an empty sample profiles to nothing", () => {
  assert.deepEqual(controllerProfile({ rows: [], partitions: [] }).partitions, {});
});

test("the profile rejects foreign input", () => {
  assert.throws(() => controllerProfile({ nope: 1 }), /refreshTimeSample/);
});

// --- lossReport ------------------------------------------------------------------ //
test("the report counts arrivals per instrument", () => {
  const entry = lossReport(sample()).partitions[PARTITION]!;
  // 25 arrivals minus the 3 that fall after the final refresh.
  assert.equal(Object.values(entry.arrivals).reduce((a, b) => a + b, 0), 22);
});

test("every instrument contributes one value per refresh", () => {
  const entry = lossReport(sample()).partitions[PARTITION]!;
  assert.deepEqual(
    entry.sampled,
    Object.fromEntries(INSTRUMENTS.map((name) => [name, 4])),
  );
});

test("retention shows the fast instrument being decimated", () => {
  // ALPHA prints far more than it contributes; that ratio is the cost.
  const entry = lossReport(sample()).partitions[PARTITION]!;
  assert.ok(entry.retention.ALPHA! < entry.retention.GAMMA!);
});

test("the report carries the partition summary", () => {
  assert.deepEqual(lossReport(sample()).summaries[PARTITION]!.loss_fraction, {
    numerator: 13,
    denominator: 25,
  });
});

// --- cadenceProfile --------------------------------------------------------------- //
test("the cadence counts intervals between refreshes", () => {
  const entry = cadenceProfile(sample()).partitions[PARTITION]!;
  assert.equal(entry.refreshes, 4);
  assert.equal(entry.intervals, 3);
});

test("the fixture cadence is four seconds", () => {
  const entry = cadenceProfile(sample()).partitions[PARTITION]!;
  assert.equal(entry.median_ms, 4040);
  assert.equal(entry.min_ms, 4040);
  assert.equal(entry.max_ms, 4040);
});

test("a perfectly regular series scores one", () => {
  assert.equal(cadenceProfile(sample()).partitions[PARTITION]!.regularity, 1);
});

test("a single refresh has no interval", () => {
  const rows = observations().filter(
    (row) => row.available_at < "2026-01-05T14:30:01Z",
  );
  const entry = cadenceProfile(sample(rows)).partitions[PARTITION]!;
  assert.equal(entry.intervals, 0);
  assert.equal(entry.median_ms, null);
});

// --- subsetComparison -------------------------------------------------------------- //
test("dropping the slow instrument buys more refreshes", () => {
  // The decision this whole surface exists to inform.
  const [full, withoutGamma] = subsetComparison(
    observations(),
    [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"]],
    MAX_STALENESS_MS,
  );
  assert.ok(withoutGamma!.refresh_candidates > full!.refresh_candidates);
  assert.ok(withoutGamma!.refreshes_vs_first > 0);
});

test("the smaller basket wastes less", () => {
  const comparison = subsetComparison(
    observations(),
    [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"]],
    MAX_STALENESS_MS,
  );
  assert.ok(comparison[1]!.loss_share < comparison[0]!.loss_share);
});

test("each subset reports its own controller", () => {
  const comparison = subsetComparison(
    observations(),
    [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"]],
    MAX_STALENESS_MS,
  );
  assert.deepEqual(comparison[0]!.dominant_controllers, ["GAMMA"]);
  assert.ok(!comparison[1]!.dominant_controllers.includes("GAMMA"));
});

test("the first subset is the baseline", () => {
  const comparison = subsetComparison(
    observations(),
    [["ALPHA", "BETA"], ["ALPHA", "BETA", "GAMMA"]],
    MAX_STALENESS_MS,
  );
  assert.equal(comparison[0]!.refreshes_vs_first, 0);
  assert.ok(comparison[1]!.refreshes_vs_first < 0);
});

test("the full basket agrees with a direct sample", () => {
  const entry = subsetComparison(observations(), [INSTRUMENTS], MAX_STALENESS_MS)[0]!;
  assert.equal(entry.refresh_candidates, sample().rows.length);
  assert.equal(entry.input_updates, 25);
  assert.equal(entry.discarded, 13);
});

test("subset instruments come back sorted", () => {
  const entry = subsetComparison(
    observations(),
    [["GAMMA", "ALPHA", "BETA"]],
    MAX_STALENESS_MS,
  )[0]!;
  assert.deepEqual(entry.instruments, ["ALPHA", "BETA", "GAMMA"]);
});

test("a one-name subset raises", () => {
  assert.throws(
    () => subsetComparison(observations(), [["ALPHA"]], MAX_STALENESS_MS),
    /at least two/,
  );
});

test("an empty subset list returns nothing", () => {
  assert.deepEqual(subsetComparison(observations(), [], MAX_STALENESS_MS), []);
});

test("the comparison does not mutate the observations", () => {
  const rows = observations();
  const before = JSON.stringify(rows);
  subsetComparison(rows, [["ALPHA", "BETA"]], MAX_STALENESS_MS);
  assert.equal(JSON.stringify(rows), before);
});
