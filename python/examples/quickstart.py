"""Sample three asynchronous instruments, then find out what it cost.

Run:  python examples/quickstart.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fintech_refresh_time import (  # noqa: E402
    StreamingRefreshSampler,
    cadence_profile,
    controller_profile,
    loss_report,
    refresh_time_sample,
    subset_comparison,
)

FIXTURE = json.loads(
    (ROOT / "tests" / "fixtures" / "fixtures.json").read_text(encoding="utf-8")
)
OBSERVATIONS = FIXTURE["observations"]
INSTRUMENTS = FIXTURE["required_instruments"]
MAX_STALENESS_MS = FIXTURE["max_staleness_ms"]


def rule(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


# --- 1. the sample --------------------------------------------------------- #
rule("1. Twenty-five arrivals become four cross-sections")

result = refresh_time_sample(OBSERVATIONS, INSTRUMENTS, MAX_STALENESS_MS)
for row in result["rows"]:
    values = "  ".join(f"{k}={v}" for k, v in row["values"].items())
    print(f"  #{row['sequence']}  {row['refresh_available_at'][-13:-1]}  "
          f"{row['status']:<9} {values}")

# --- 2. the price ---------------------------------------------------------- #
rule("2. The price: over half the input never reaches the sample")

summary = result["partitions"][0]
loss = summary["loss_fraction"]
print(f"  input updates:        {summary['input_updates']}")
print(f"  refresh candidates:   {summary['refresh_candidates']}")
print(f"  discarded in-interval:{summary['discarded_updates']:>3}")
print(f"  unmatched tail:       {summary['unmatched_tail_updates']:>3}")
print(f"  information loss:     {loss['numerator']}/{loss['denominator']} "
      f"({loss['numerator'] / loss['denominator']:.0%})")

# --- 3. who is setting the clock? ------------------------------------------ #
rule("3. Who is setting your sampling clock?")

profile = controller_profile(result)["partitions"]["2026-01-05:XNYS:REG"]
for instrument, count in profile["counts"].items():
    print(f"  {instrument} controlled {count}/{profile['refreshes']} refreshes "
          f"({profile['shares'][instrument]:.0%})")
print(f"  -> {profile['dominant']} is deciding the sampling frequency single-handedly.")

# --- 4. what did each instrument give up? ---------------------------------- #
rule("4. Retention per instrument")

report = loss_report(result)["partitions"]["2026-01-05:XNYS:REG"]
for instrument in sorted(report["arrivals"]):
    print(f"  {instrument}: {report['arrivals'][instrument]:>2} arrivals -> "
          f"{report['sampled'][instrument]} sampled "
          f"({report['retention'][instrument]:.0%} retained)")

# --- 5. how regular is the series? ----------------------------------------- #
rule("5. Cadence")

cadence = cadence_profile(result)["partitions"]["2026-01-05:XNYS:REG"]
print(f"  {cadence['intervals']} intervals: min={cadence['min_ms']:.0f}ms "
      f"median={cadence['median_ms']:.0f}ms max={cadence['max_ms']:.0f}ms")
print(f"  regularity {cadence['regularity']:.2f} "
      f"(1.00 = perfectly even; a fixed-interval model assumes exactly this)")

# --- 6. should the slow name be in the basket? ----------------------------- #
rule("6. What does each instrument cost the basket?")

for index, entry in enumerate(subset_comparison(
    OBSERVATIONS,
    [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"], ["ALPHA", "GAMMA"]],
    MAX_STALENESS_MS,
)):
    # Only the FIRST subset is the baseline. A later one can coincidentally match it,
    # and calling that "baseline" too would read as though nothing had changed.
    delta = "baseline" if index == 0 else f"{entry['refreshes_vs_first']:+d} refreshes"
    print(f"  {'+'.join(entry['instruments']):<22} "
          f"{entry['refresh_candidates']:>2} refreshes  "
          f"loss {entry['loss_share']:.0%}  {delta}")
print("  -> Dropping GAMMA buys 50% more cross-sections and cuts the waste from")
print("     52% to 37%. Pairing ALPHA with GAMMA alone changes nothing, because")
print("     GAMMA was the binding constraint all along. That is the trade, priced.")

# --- 7. the same thing, live ----------------------------------------------- #
rule("7. The live sampler produces exactly the same rows")

engine = StreamingRefreshSampler(INSTRUMENTS, MAX_STALENESS_MS)
arrivals = sorted(OBSERVATIONS, key=lambda row: (row["available_at"], row["instrument"]))
emitted = engine.observe_many(arrivals)
print(f"  emitted {len(emitted)} rows live; identical to batch: "
      f"{emitted == result['rows']}")
print(f"  summary identical: {engine.summary == summary}")
print(f"  still waiting for: {engine.waiting_for or 'nothing'}")
