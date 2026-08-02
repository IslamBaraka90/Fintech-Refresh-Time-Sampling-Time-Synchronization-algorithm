/** Shared fixture access. The same JSON backs the Python suite. */

import { createRequire } from "node:module";

import { refreshTimeSample, type Observation, type RefreshResult } from "../src/core.ts";

const require = createRequire(import.meta.url);
const FIXTURE = require("./fixtures/fixtures.json") as {
  required_instruments: string[];
  max_staleness_ms: number;
  observations: Observation[];
  expected: RefreshResult;
};

export const INSTRUMENTS = FIXTURE.required_instruments;
export const MAX_STALENESS_MS = FIXTURE.max_staleness_ms;
export const OBSERVATIONS = FIXTURE.observations;
export const EXPECTED = FIXTURE.expected;
export const PARTITION = "2026-01-05:XNYS:REG";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Deep-copied fixture observations — all, or the given 0-based positions. */
export const observations = (...indexes: number[]): Observation[] =>
  indexes.length === 0
    ? clone(OBSERVATIONS)
    : indexes.map((index) => clone(OBSERVATIONS[index]!));

/** The fixture in the order a consumer would have received it. */
export const arrivalOrder = (): Observation[] =>
  [...observations()].sort((a, b) =>
    a.available_at < b.available_at
      ? -1
      : a.available_at > b.available_at
        ? 1
        : a.instrument < b.instrument
          ? -1
          : a.instrument > b.instrument
            ? 1
            : 0,
  );

export const sample = (
  rows?: unknown[] | null,
  instruments?: string[] | null,
  maxStalenessMs?: number,
): RefreshResult =>
  refreshTimeSample(
    rows ?? observations(),
    instruments ?? INSTRUMENTS,
    maxStalenessMs ?? MAX_STALENESS_MS,
  );
