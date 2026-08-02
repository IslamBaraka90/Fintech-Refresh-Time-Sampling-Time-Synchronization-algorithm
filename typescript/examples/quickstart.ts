/**
 * Sample three asynchronous instruments, then find out what it cost.
 *
 * Run:  npm run example
 */

import { createRequire } from "node:module";

import {
  StreamingRefreshSampler,
  cadenceProfile,
  controllerProfile,
  lossReport,
  refreshTimeSample,
  subsetComparison,
  type Observation,
} from "../src/index.ts";

const require = createRequire(import.meta.url);
const FIXTURE = require("../test/fixtures/fixtures.json") as {
  required_instruments: string[];
  max_staleness_ms: number;
  observations: Observation[];
};

const OBSERVATIONS = FIXTURE.observations;
const INSTRUMENTS = FIXTURE.required_instruments;
const MAX_STALENESS_MS = FIXTURE.max_staleness_ms;
const PARTITION = "2026-01-05:XNYS:REG";

const rule = (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`);
const clock = (timestamp: string) => timestamp.slice(-13, -1);
const pct = (value: number) => `${Math.round(value * 100)}%`;
const pad = (value: unknown, width: number) => String(value).padStart(width);

// --- 1. the sample --------------------------------------------------------- //
rule("1. Twenty-five arrivals become four cross-sections");

const result = refreshTimeSample(OBSERVATIONS, INSTRUMENTS, MAX_STALENESS_MS);
for (const row of result.rows) {
  const values = Object.entries(row.values)
    .map(([name, value]) => `${name}=${value}`)
    .join("  ");
  console.log(
    `  #${row.sequence}  ${clock(row.refresh_available_at)}  ${row.status.padEnd(9)}${values}`,
  );
}

// --- 2. the price ---------------------------------------------------------- //
rule("2. The price: over half the input never reaches the sample");

const summary = result.partitions[0]!;
const loss = summary.loss_fraction;
console.log(`  input updates:        ${summary.input_updates}`);
console.log(`  refresh candidates:   ${summary.refresh_candidates}`);
console.log(`  discarded in-interval:${pad(summary.discarded_updates, 3)}`);
console.log(`  unmatched tail:       ${pad(summary.unmatched_tail_updates, 3)}`);
console.log(
  `  information loss:     ${loss.numerator}/${loss.denominator} ` +
    `(${pct(loss.numerator / loss.denominator)})`,
);

// --- 3. who is setting the clock? ------------------------------------------ //
rule("3. Who is setting your sampling clock?");

const profile = controllerProfile(result).partitions[PARTITION]!;
for (const [instrument, count] of Object.entries(profile.counts)) {
  console.log(
    `  ${instrument} controlled ${count}/${profile.refreshes} refreshes ` +
      `(${pct(profile.shares[instrument]!)})`,
  );
}
console.log(`  -> ${profile.dominant} is deciding the sampling frequency single-handedly.`);

// --- 4. what did each instrument give up? ---------------------------------- //
rule("4. Retention per instrument");

const report = lossReport(result).partitions[PARTITION]!;
for (const instrument of Object.keys(report.arrivals).sort()) {
  console.log(
    `  ${instrument}: ${pad(report.arrivals[instrument], 2)} arrivals -> ` +
      `${report.sampled[instrument]} sampled (${pct(report.retention[instrument]!)} retained)`,
  );
}

// --- 5. how regular is the series? ----------------------------------------- //
rule("5. Cadence");

const cadence = cadenceProfile(result).partitions[PARTITION]!;
console.log(
  `  ${cadence.intervals} intervals: min=${cadence.min_ms}ms ` +
    `median=${cadence.median_ms}ms max=${cadence.max_ms}ms`,
);
console.log(
  `  regularity ${cadence.regularity!.toFixed(2)} ` +
    "(1.00 = perfectly even; a fixed-interval model assumes exactly this)",
);

// --- 6. should the slow name be in the basket? ----------------------------- //
rule("6. What does each instrument cost the basket?");

subsetComparison(
  OBSERVATIONS,
  [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"], ["ALPHA", "GAMMA"]],
  MAX_STALENESS_MS,
).forEach((entry, index) => {
  // Only the FIRST subset is the baseline. A later one can coincidentally match it,
  // and calling that "baseline" too would read as though nothing had changed.
  const delta =
    index === 0
      ? "baseline"
      : `${entry.refreshes_vs_first > 0 ? "+" : ""}${entry.refreshes_vs_first} refreshes`;
  console.log(
    `  ${entry.instruments.join("+").padEnd(22)}${pad(entry.refresh_candidates, 2)} ` +
      `refreshes  loss ${pct(entry.loss_share)}  ${delta}`,
  );
});
console.log("  -> Dropping GAMMA buys 50% more cross-sections and cuts the waste from");
console.log("     52% to 37%. Pairing ALPHA with GAMMA alone changes nothing, because");
console.log("     GAMMA was the binding constraint all along. That is the trade, priced.");

// --- 7. the same thing, live ----------------------------------------------- //
rule("7. The live sampler produces exactly the same rows");

const engine = new StreamingRefreshSampler(INSTRUMENTS, MAX_STALENESS_MS);
const arrivals = [...OBSERVATIONS].sort((a, b) =>
  a.available_at < b.available_at
    ? -1
    : a.available_at > b.available_at
      ? 1
      : a.instrument < b.instrument
        ? -1
        : 1,
);
const emitted = engine.observeMany(arrivals);
console.log(
  `  emitted ${emitted.length} rows live; identical to batch: ` +
    `${JSON.stringify(emitted) === JSON.stringify(result.rows)}`,
);
console.log(
  `  summary identical: ${JSON.stringify(engine.summary) === JSON.stringify(summary)}`,
);
console.log(`  still waiting for: ${engine.waitingFor.join(", ") || "nothing"}`);
