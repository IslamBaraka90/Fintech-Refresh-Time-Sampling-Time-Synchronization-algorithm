# Fintech Refresh-Time Sampling — Time Synchronization Algorithm

> A canonical, well-specified, **cross-language (Python + TypeScript)** reference
> implementation of causal all-refresh sampling. Instead of forcing asynchronous
> instruments onto a clock grid — and filling the silence with carry-forward or
> interpolation — it lets **the data choose the sampling times**: a refresh happens the
> moment every required instrument has posted something new. Every value in the output
> is a real observation. The method's real cost, the data it discards, is measured and
> reported rather than glossed over, and an `analysis` surface names **which instrument
> is setting your sampling frequency** and what each one costs the basket.

<p>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.7%2B-3178c6">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Tests" src="https://img.shields.io/badge/tests-111%20py%20%2F%20111%20ts-brightgreen">
</p>

**📖 Full article (canonical):** **[Refresh-Time Sampling — The Fintech Builder](https://thefintechbuilder.com/market-data-engineering/time-synchronization/refresh-time-sampling/)**

This repository is the runnable, production-oriented companion to that article.
The article teaches the concept; this repo is the code you install and build on.

🧭 **Browse all algorithms:** [Awesome FinTech Algorithms](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome) — the full index of the library.
🗂️ **This algorithm's domain:** [Market Data Engineering](https://thefintechbuilder.com/domains/market-data-engineering/) › **Time Synchronization**
📥 **Just want to call it?** It also ships in the [`fintech-algorithms`](https://www.npmjs.com/package/fintech-algorithms) npm package — see [Two ways to use this](#two-ways-to-use-this).

| | |
|---|---|
| **Catalog topic** | `D01-F03-A03` |
| **Domain** | D01 — Market Data Engineering |
| **Family** | D01-F03 — Time Synchronization |
| **Difficulty** | 4 / 5 |
| **Languages** | Python, TypeScript |

---

## Table of contents

- [The problem: two instruments, two clocks](#the-problem-two-instruments-two-clocks)
- [The rule](#the-rule)
- [What it costs, stated plainly](#what-it-costs-stated-plainly)
- [The operational clock is `available_at`](#the-operational-clock-is-available_at)
- [Two ways to use this](#two-ways-to-use-this)
- [Install](#install)
- [Quickstart](#quickstart)
- [Worked example (exact)](#worked-example-exact)
- [Analysis: who is setting your clock?](#analysis-who-is-setting-your-clock)
- [Streaming](#streaming)
- [Row shapes](#row-shapes)
- [API reference](#api-reference)
- [Edge cases & limitations](#edge-cases--limitations)
- [Testing](#testing)
- [Related algorithms](#related-algorithms)
- [License](#license)

---

## The problem: two instruments, two clocks

One instrument prints ten times a second. The other prints twice a minute. You want a
covariance between them.

Put them on a one-second grid and most of the slow instrument's series is the same
number repeated — carried forward from a print that happened long ago. That stale
repetition drags the measured correlation toward zero, and it gets **worse** the more
finely you sample. Sampling more often feels like gathering more information and is in
fact gathering more assumption.

Interpolating instead of carrying forward does not rescue it; it swaps one bias for
another and adds lookahead on top, since interpolation needs the future point.

Refresh-time sampling refuses the grid entirely.

---

## The rule

> A refresh occurs at the first moment every required instrument has posted at least one
> **new** observation since the last refresh.

At that instant — and only then — every instrument has something fresh to say, so the
cross-section is a set of real observations rather than a mixture of observations and
assumptions. No carry-forward. No interpolation. No grid.

The instrument that arrives **last** is the **controller**: it is the one that decides
when the refresh can happen, and therefore how often you get to sample at all.

---

## What it costs, stated plainly

It throws data away, and usually most of it.

While the slow instrument prints once, the fast one may print twenty times. Nineteen of
those updates never reach the output. This implementation does not hide that:

| Reported | Where |
|---|---|
| `discarded_updates` | per refresh row — updates in that interval that did not survive |
| `unmatched_tail_updates` | per partition — arrivals after the final refresh |
| `loss_fraction` | per partition — the whole story as a fraction |

On the reference fixture that fraction is **13/25 — 52% of the input never reaches the
sample.**

That is the honest price of not inventing data. Look at it before deciding this is the
right method; on a wide basket with one illiquid name it can reach 90%.

---

## The operational clock is `available_at`

Not `event_time`.

A refresh happens when your system *learns* things, not when the market did them,
because a sampler cannot act on an observation it has not received. `event_time` is kept
as lineage and drives the staleness diagnostic: if the freshest available value is
nonetheless very old, the row comes back with `status: "stale"`.

**A stale row is still returned.** It is a warning, not a filter — silently dropping it
would leave a hole you could not explain, and silently repairing it would be exactly the
carry-forward this method exists to avoid.

---

## Two ways to use this

**📥 The fast path — one call, TypeScript only:**

```bash
npm install fintech-algorithms
```

```ts
import { refreshTimeSample } from "fintech-algorithms/market-data-engineering/time-synchronization/refresh-time-sampling";
```

That package is the breadth option: 271 algorithms, one install, the tutorial-level
kernel for each.

**🔬 This repo — the depth option.** Python *and* TypeScript, the `analysis` surface
(controller profiling, per-instrument retention, cadence, subset comparison), the live
sampler, strict calendar validation, and 222 tests pinning both languages to one shared
fixture — including its complete expected output, row for row.

---

## Install

**Python** (3.10+, no dependencies):

```bash
git clone https://github.com/IslamBaraka90/Fintech-Refresh-Time-Sampling-Time-Synchronization-algorithm.git
cd Fintech-Refresh-Time-Sampling-Time-Synchronization-algorithm/python
pip install -e ".[dev]"
```

**TypeScript** (Node 20+, no runtime dependencies):

```bash
cd Fintech-Refresh-Time-Sampling-Time-Synchronization-algorithm/typescript
npm install
npm run build
```

---

## Quickstart

**Python**

```python
from fintech_refresh_time import controller_profile, refresh_time_sample

result = refresh_time_sample(observations, ["ALPHA", "BETA", "GAMMA"],
                             max_staleness_ms=5000)

for row in result["rows"]:
    print(row["refresh_available_at"], row["values"], row["status"])

# Which name is deciding your sampling frequency?
print(controller_profile(result)["partitions"]["2026-01-05:XNYS:REG"]["dominant"])
```

**TypeScript**

```ts
import { controllerProfile, refreshTimeSample } from "fintech-refresh-time";

const result = refreshTimeSample(observations, ["ALPHA", "BETA", "GAMMA"], 5000);
```

---

## Worked example (exact)

25 arrivals across three instruments in one session. These values are asserted verbatim
by both test suites from one shared JSON fixture — the *complete* expected output, every
row and every source.

```
#1  14:30:00.340  accepted  ALPHA=100.0  BETA=50.0  GAMMA=25.0
#2  14:30:04.380  accepted  ALPHA=100.4  BETA=50.3  GAMMA=25.2
#3  14:30:08.420  accepted  ALPHA=100.8  BETA=50.6  GAMMA=25.4
#4  14:30:12.460  accepted  ALPHA=100.9  BETA=50.9  GAMMA=25.6
```

| | |
|---|---|
| input updates | 25 |
| refresh candidates | **4** |
| discarded in-interval | 10 |
| unmatched tail | 3 |
| **information loss** | **13/25 (52%)** |

**GAMMA controlled 4 of 4 refreshes.** One instrument set the sampling frequency for the
entire basket, and nothing in the sampled series itself would have told you.

---

## Analysis: who is setting your clock?

This is the surface that does not fit in a tutorial, and the reason to install the repo
rather than copy the snippet.

### `controller_profile` — name the bottleneck

```
GAMMA controlled 4/4 refreshes (100%)
-> GAMMA is deciding the sampling frequency single-handedly.
```

When two instruments land in the same millisecond both are credited, so shares can sum
to more than one — a co-controlled refresh is genuinely both their doing.

### `loss_report` — what each instrument gave up

```
ALPHA: 10 arrivals ->  4 sampled ( 40% retained)
BETA:   8 arrivals ->  4 sampled ( 50% retained)
GAMMA:  4 arrivals ->  4 sampled (100% retained)
```

The controller keeps everything; everyone else is decimated by its cadence. An
instrument at 40% retention is not being sampled so much as summarised.

### `subset_comparison` — should this name be in the basket?

The one that changes decisions.

```
ALPHA+BETA+GAMMA   4 refreshes  loss 52%  baseline
ALPHA+BETA         6 refreshes  loss 37%  +2 refreshes
ALPHA+GAMMA        4 refreshes  loss 50%  +0 refreshes
```

Dropping GAMMA buys 50% more cross-sections and cuts the waste from 52% to 37%. Pairing
ALPHA with GAMMA alone changes nothing — because GAMMA was the binding constraint all
along. **That is the trade, priced.** Adding one illiquid name to a basket is never free,
and this is how much it costs.

### `cadence_profile` — how irregular is the result?

```
3 intervals: min=4040ms median=4040ms max=4040ms
regularity 1.00
```

`regularity` is `min/max`. **1.00 is perfectly even, which is what a fixed-interval
estimator assumes.** Real data scores well below that, and the gap is how misspecified
the downstream model is.

---

## Streaming

Refresh-time sampling is a streaming algorithm wearing a batch costume. A refresh is
detected the instant the last required instrument posts — there is nothing to look ahead
to. So `StreamingRefreshSampler` is not an approximation of the batch function; it is the
same computation driven by the feed.

```python
engine = StreamingRefreshSampler(["ALPHA", "BETA", "GAMMA"], max_staleness_ms=5000)

for arrival in feed:                  # in available_at order
    row = engine.observe(arrival)     # a RefreshRow, or None
    if row:
        publish(row)

engine.waiting_for   # ['ALPHA'] — what the whole basket is currently blocked on
engine.summary       # the same partition summary the batch function reports
```

`observe()` returns the refresh row if that arrival completed one, and `None` otherwise.
The moment a row is emitted is the moment it became true.

Both suites assert that streaming and batch produce **identical** rows and an identical
summary, because the day they diverge is the day research and production stop describing
the same series.

One sampler handles one partition; feeding it a second raises rather than silently
interleaving two unrelated sessions.

---

## Row shapes

**Observation** — `partition`, `instrument`, `record_id` (non-empty strings),
`revision` (integer ≥ 0), `event_time`, `available_at` (RFC 3339 UTC, `Z` only,
millisecond precision at most, `event_time <= available_at`), `value` (finite number).

**RefreshRow** — `partition`, `sequence`, `previous_refresh_available_at`,
`refresh_available_at`, `controller_instruments`, `status`, `values`, `sources`,
`event_age_ms`, `arrivals_by_instrument`, `discarded_updates`.

**PartitionSummary** — `input_updates`, `refresh_candidates`, `accepted_rows`,
`stale_rows`, `discarded_updates`, `unmatched_tail_updates`, `loss_fraction`.

**Corrections.** Records get revised. Revisions must start at zero, be contiguous, arrive
strictly later than what they supersede, and never change instrument. Two records
claiming the same event instant is rejected as ambiguous — "the value at that instant"
would otherwise depend on input order.

Timestamps are validated by explicit civil arithmetic rather than `Date.parse`, which
silently rolls `2026-02-30` over to March 2. Values must be numbers, not numeric strings:
`float("100.5")` would succeed in Python where TypeScript refuses it, so both ports here
reject it.

---

## API reference

| Python | TypeScript | Purpose |
|---|---|---|
| `refresh_time_sample(observations, required_instruments, max_staleness_ms)` | `refreshTimeSample(...)` | Batch sampling |
| `controller_profile(result)` | `controllerProfile(...)` | Which instrument sets the clock |
| `loss_report(result)` | `lossReport(...)` | Per-instrument arrivals vs retention |
| `cadence_profile(result)` | `cadenceProfile(...)` | Refresh interval distribution |
| `subset_comparison(observations, subsets, max_staleness_ms)` | `subsetComparison(...)` | What each basket costs |
| `StreamingRefreshSampler(required_instruments, max_staleness_ms)` | `new StreamingRefreshSampler(...)` | Live sampler |
| `.observe(row)` / `.observe_many(rows)` | `.observe(...)` / `.observeMany(...)` | Ingest; returns a row or `None` |
| `.waiting_for` / `.summary` | `.waitingFor` / `.summary` | What is blocking; the running totals |
| `parse_timestamp_ms(value)` | `parseTimestampMs(...)` | Strict RFC 3339 → milliseconds |

---

## Edge cases & limitations

- **At least two instruments.** A "refresh" across one instrument is just that
  instrument's own clock, so a one-name basket is refused.
- **The loss is the headline, not a footnote.** Check `loss_fraction` before trusting the
  output. A basket that discards 90% of its input is not sampling; it is subsetting.
- **Refresh intervals are not evenly spaced.** Anything downstream that assumes a fixed
  interval — a naive realized-variance estimator, a fixed-lag model — is misspecified on
  this series. `cadence_profile` measures by how much.
- **One slow instrument dominates everything.** Adding an illiquid name to a basket
  reduces the sample for every other name in it. Run `subset_comparison` first.
- **Stale rows are returned, not dropped.** `max_staleness_ms` is a diagnostic threshold.
  Filtering on it is your decision, taken with the row in hand.
- **Arrivals must be in `available_at` order for the streaming sampler.** The batch
  function sorts for you; a live feed that reorders is a genuine fault.
- **Millisecond precision.** Timestamps with more than three fractional digits are
  rejected rather than silently truncated.

---

## Testing

```bash
cd python && pytest -q          # 111 tests
cd typescript && npm test       # 111 tests
```

Both suites read the **same** `fixtures.json` and assert its complete expected output —
all four rows, every source reference, every count — verbatim in each language.

The suites also pin: streaming equalling batch row-for-row (including under a zero
staleness budget), the causal guarantee that no source in a row post-dates the row,
`2026-02-30` being rejected in both languages, correction ordering rules, and input order
never changing the answer.

---

## Related algorithms

**Same family — D01-F03 Time Synchronization**

- **[Previous-Tick Interpolation](https://github.com/IslamBaraka90/Fintech-Previous-Tick-Interpolation-Time-Synchronization-algorithm)** — the carry-forward this method exists to avoid, done safely when you do need it.
- **[Linear Quote Interpolation](https://github.com/IslamBaraka90/Fintech-Linear-Quote-Interpolation-Time-Synchronization-algorithm)** — the other way to fill silence, and why it is research-only.
- Exchange Calendar Alignment · Asynchronous Return Alignment *(articles live; repos pending)*

**Upstream — D01-F02 Cleaning and Validation**

- **[Stale Quote Detector](https://github.com/IslamBaraka90/Fintech-Stale-Quote-Detector-Data-Quality-algorithm)** · **[Duplicate Trade Resolver](https://github.com/IslamBaraka90/Fintech-Duplicate-Trade-Resolver-Data-Quality-algorithm)** — the validation this algorithm assumes has already happened.

🧭 **[Browse all algorithms →](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome)**

---

## License

MIT — see [LICENSE](LICENSE).

The synthetic fixture data is CC0-1.0. No market data is redistributed.
