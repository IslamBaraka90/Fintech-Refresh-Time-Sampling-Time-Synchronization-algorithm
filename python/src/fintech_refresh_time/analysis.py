"""Who is setting your sampling clock, and what is each instrument costing you?

The core module produces the sample. This module answers the questions that decide
whether the basket was a good idea.

**Which instrument is the bottleneck?** — :func:`controller_profile`
A refresh happens when the *last* required instrument finally posts. That instrument is
the controller, and on a typical basket one name controls almost every refresh. It is
setting your sampling frequency single-handedly, and until you look, you do not know
which one it is. On the reference fixture GAMMA controls **4 of 4** refreshes.

**What did each instrument cost?** — :func:`loss_report`
Per-instrument arrivals against updates that actually reached the sample. A fast
instrument contributing forty updates and six sampled values is not being sampled; it
is being decimated by somebody else's cadence.

**Should this name be in the basket at all?** — :func:`subset_comparison`
The one that changes decisions. It re-runs the sampler over candidate subsets and
reports what each costs in refresh count and information loss. Dropping a single
illiquid name routinely doubles the sample size, and this puts a number on the trade
instead of leaving it to intuition.

**How regular is the resulting series?** — :func:`cadence_profile`
Refresh intervals are *not* evenly spaced — that is the whole point of the method — so
any downstream estimator assuming a fixed interval is misspecified. This reports the
spread so you can see how far from regular you actually are.
"""

from __future__ import annotations

from statistics import median
from typing import Any, Iterable, Mapping

from .core import parse_timestamp_ms, refresh_time_sample

__all__ = [
    "controller_profile",
    "loss_report",
    "subset_comparison",
    "cadence_profile",
]


def _rows_of(result: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    if not isinstance(result, Mapping) or "rows" not in result or "partitions" not in result:
        raise ValueError("result must come from refresh_time_sample()")
    return list(result["rows"])


def controller_profile(result: Mapping[str, Any]) -> dict[str, Any]:
    """Count how often each instrument was the last to arrive.

    The controller decides when a refresh can happen, so a name controlling most
    refreshes is setting the sampling frequency for the whole basket. When two
    instruments land in the same millisecond both are credited, which is why the shares
    can sum to more than one — a co-controlled refresh is genuinely both their doing.
    """

    rows = _rows_of(result)
    partitions: dict[str, dict[str, Any]] = {}

    for row in rows:
        partition = str(row["partition"])
        entry = partitions.setdefault(
            partition, {"refreshes": 0, "counts": {}, "co_controlled": 0}
        )
        entry["refreshes"] += 1
        controllers = list(row["controller_instruments"])
        if len(controllers) > 1:
            entry["co_controlled"] += 1
        for instrument in controllers:
            entry["counts"][instrument] = entry["counts"].get(instrument, 0) + 1

    for entry in partitions.values():
        refreshes = entry["refreshes"]
        entry["counts"] = dict(sorted(entry["counts"].items()))
        entry["shares"] = {
            instrument: count / refreshes for instrument, count in entry["counts"].items()
        }
        # The single name most responsible for the sampling frequency.
        entry["dominant"] = (
            max(entry["counts"].items(), key=lambda item: (item[1], item[0]))[0]
            if entry["counts"]
            else None
        )

    return {"partitions": dict(sorted(partitions.items()))}


def loss_report(result: Mapping[str, Any]) -> dict[str, Any]:
    """Per-instrument arrivals against updates that survived into the sample."""

    rows = _rows_of(result)
    partitions: dict[str, dict[str, Any]] = {}

    for row in rows:
        partition = str(row["partition"])
        entry = partitions.setdefault(
            partition, {"arrivals": {}, "sampled": {}, "refreshes": 0}
        )
        entry["refreshes"] += 1
        for instrument, count in row["arrivals_by_instrument"].items():
            entry["arrivals"][instrument] = entry["arrivals"].get(instrument, 0) + count
        for instrument in row["values"]:
            entry["sampled"][instrument] = entry["sampled"].get(instrument, 0) + 1

    for entry in partitions.values():
        entry["arrivals"] = dict(sorted(entry["arrivals"].items()))
        entry["sampled"] = dict(sorted(entry["sampled"].items()))
        entry["retention"] = {
            instrument: (entry["sampled"].get(instrument, 0) / arrivals)
            if arrivals
            else None
            for instrument, arrivals in entry["arrivals"].items()
        }

    summaries = {
        str(summary["partition"]): dict(summary) for summary in result["partitions"]
    }
    return {"partitions": dict(sorted(partitions.items())), "summaries": summaries}


def cadence_profile(result: Mapping[str, Any]) -> dict[str, Any]:
    """Distribution of gaps between consecutive refreshes, per partition.

    Refresh intervals are **not** evenly spaced. Any downstream estimator that assumes a
    fixed sampling interval is misspecified on this series, and the spread between
    ``min_ms`` and ``max_ms`` is how badly.
    """

    rows = _rows_of(result)
    by_partition: dict[str, list[int]] = {}
    for row in rows:
        by_partition.setdefault(str(row["partition"]), []).append(
            parse_timestamp_ms(row["refresh_available_at"], "refresh_available_at")
        )

    partitions: dict[str, Any] = {}
    for partition, stamps in sorted(by_partition.items()):
        gaps = [
            float(stamps[index] - stamps[index - 1]) for index in range(1, len(stamps))
        ]
        partitions[partition] = {
            "refreshes": len(stamps),
            "intervals": len(gaps),
            "min_ms": min(gaps) if gaps else None,
            "median_ms": median(gaps) if gaps else None,
            "max_ms": max(gaps) if gaps else None,
            # 1.0 would be perfectly regular. Anything else is the irregularity a
            # fixed-interval model would be pretending away.
            "regularity": (min(gaps) / max(gaps)) if gaps and max(gaps) else None,
        }
    return {"partitions": partitions}


def subset_comparison(
    observations: Iterable[Mapping[str, Any]],
    subsets: Iterable[Iterable[str]],
    max_staleness_ms: int,
) -> list[dict[str, Any]]:
    """Re-run the sampler over candidate instrument subsets and compare the cost.

    This is the decision tool. Adding one slow name to a basket can halve the number of
    refreshes — every other instrument then waits for it — and that shows up here as a
    smaller ``refresh_candidates`` and a larger ``loss_share``.

    Args:
        observations: The full observation set. Rows for instruments outside a subset
            are excluded from that subset's run, since they are not required to refresh.
        subsets: Candidate instrument groups, each with at least two names.
        max_staleness_ms: Passed through to each run.

    Returns:
        One entry per subset, in the order given, carrying the refresh count, the loss
        share, and the median cadence — plus ``refreshes_vs_first`` so the cost of the
        larger basket is a number rather than a comparison you have to do by eye.
    """

    observation_list = [dict(row) for row in observations]
    results: list[dict[str, Any]] = []
    baseline: int | None = None

    for subset in subsets:
        instruments = sorted(set(subset))
        if len(instruments) < 2:
            raise ValueError("each subset must contain at least two instruments")
        filtered = [
            row for row in observation_list if row.get("instrument") in set(instruments)
        ]
        sample = refresh_time_sample(filtered, instruments, max_staleness_ms)

        refreshes = sum(
            int(summary["refresh_candidates"]) for summary in sample["partitions"]
        )
        numerator = sum(
            int(summary["loss_fraction"]["numerator"]) for summary in sample["partitions"]
        )
        denominator = sum(
            int(summary["loss_fraction"]["denominator"])
            for summary in sample["partitions"]
        )
        cadence = cadence_profile(sample)["partitions"]
        medians = [
            entry["median_ms"]
            for entry in cadence.values()
            if entry["median_ms"] is not None
        ]
        controllers = controller_profile(sample)["partitions"]

        if baseline is None:
            baseline = refreshes

        results.append(
            {
                "instruments": instruments,
                "refresh_candidates": refreshes,
                "input_updates": denominator,
                "discarded": numerator,
                "loss_share": (numerator / denominator) if denominator else 0.0,
                "median_cadence_ms": median(medians) if medians else None,
                "dominant_controllers": sorted(
                    {
                        entry["dominant"]
                        for entry in controllers.values()
                        if entry["dominant"] is not None
                    }
                ),
                "refreshes_vs_first": refreshes - baseline,
            }
        )

    return results
