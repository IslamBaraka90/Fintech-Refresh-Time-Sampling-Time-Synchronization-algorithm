"""Causal all-refresh sampling: sample when everybody has spoken.

The problem this solves
-----------------------
Two instruments do not trade on the same clock. One prints ten times a second, the
other twice a minute. Any attempt to put them on a shared grid has to decide what to do
about the silent one, and the usual answers — carry the last value forward, or
interpolate — both introduce a bias that shows up as spurious correlation. Sampling
frequently makes it worse, not better: the more often you sample, the more of your
series is stale carry-forward rather than observation.

Refresh-time sampling takes the other route. **It lets the data choose the sampling
times.** A refresh occurs at the first moment every required instrument has posted at
least one new observation since the last refresh. At that instant, and only then, every
instrument has something fresh to say, and the cross-section is a set of real
observations rather than a mixture of observations and assumptions.

What it costs, stated plainly
-----------------------------
It throws data away, and often most of it. A fast instrument may print twenty times
while the slow one prints once; nineteen of those updates never appear in the output.
This module does not hide that — every refresh row reports ``discarded_updates``, and
every partition reports a ``loss_fraction``. On the reference fixture that fraction is
**13/25**: over half the input never reaches the sample.

That is the honest price of not inventing data, and it is a number you should look at
before deciding this is the right method.

The operational clock is ``available_at``
-----------------------------------------
Not ``event_time``. A refresh happens when your system *learns* things, not when the
market did them, because a sampler cannot act on an observation it has not received.
``event_time`` is kept as lineage and drives the staleness diagnostic: if the freshest
available value is nonetheless very old, the row is returned with ``status='stale'``
rather than silently repaired or dropped. You get the row and the warning, and you
decide.

Corrections
-----------
Records are revised. A revision supersedes its predecessor only from its own
``available_at``, revisions must be contiguous from zero, and they may not change
instrument. A correction that arrived before the thing it corrects would make "the
latest revision known at time T" ambiguous, so it is rejected outright.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any, Iterable, Mapping

__all__ = [
    "refresh_time_sample",
    "parse_timestamp_ms",
    "format_timestamp_ms",
    "REQUIRED_FIELDS",
]

REQUIRED_FIELDS = (
    "partition",
    "instrument",
    "record_id",
    "revision",
    "event_time",
    "available_at",
    "value",
)

#: RFC 3339 UTC, ``Z`` only, millisecond precision at most.
_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$"
)

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

#: Sentinel for "before any arrival". Finite, so it survives a JSON round-trip.
_BEFORE_TIME = -(2**53)


def parse_timestamp_ms(value: Any, field: str = "timestamp") -> int:
    """Parse an RFC 3339 UTC timestamp to integer milliseconds since the epoch.

    Strict by design: ``2026-02-30`` is rejected rather than rolled over, which is what
    keeps this port and the TypeScript one agreeing on the same input.
    """

    if not isinstance(value, str):
        raise ValueError(f"{field} must be an RFC 3339 UTC string ending in Z")
    match = _TIMESTAMP.match(value)
    if match is None:
        raise ValueError(
            f"{field} must be an RFC 3339 UTC string ending in Z "
            f"(millisecond precision at most), got: {value!r}"
        )

    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    fraction = match.group(7) or ""
    millisecond = int(fraction.ljust(3, "0")) if fraction else 0

    try:
        moment = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(f"{field} is not a real calendar time: {value!r}") from exc

    delta: timedelta = moment - _EPOCH
    return delta.days * 86_400_000 + delta.seconds * 1000 + millisecond


def format_timestamp_ms(milliseconds: int) -> str:
    """Render integer milliseconds back to the RFC 3339 form this package accepts."""

    moment = _EPOCH + timedelta(milliseconds=milliseconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _require_instruments(required_instruments: Iterable[Any]) -> list[str]:
    instruments = sorted(set(required_instruments))
    if len(instruments) < 2:
        raise ValueError("required_instruments must contain at least two names")
    if any(not isinstance(name, str) or not name.strip() for name in instruments):
        raise ValueError("required_instruments must contain at least two names")
    return instruments


def normalise_row(raw: Mapping[str, Any], allowed: set[str]) -> dict[str, Any]:
    """Validate ONE observation's shape and values, in isolation.

    Deliberately free of any cross-row check. The streaming sampler validates arrivals
    one at a time and carries its own revision history, so folding the history rules in
    here would make a lone revision-1 arrival look like a record starting at revision 1.
    """

    if not isinstance(raw, Mapping):
        raise ValueError("each observation must be a mapping")
    missing = [field for field in REQUIRED_FIELDS if field not in raw]
    if missing:
        raise ValueError(f"missing fields: {', '.join(missing)}")
    if raw["instrument"] not in allowed:
        raise ValueError(f"unexpected instrument: {raw['instrument']}")
    if not isinstance(raw["partition"], str) or not raw["partition"].strip():
        raise ValueError("partition and record_id must be non-empty")
    if not isinstance(raw["record_id"], str) or not raw["record_id"].strip():
        raise ValueError("partition and record_id must be non-empty")
    if isinstance(raw["revision"], bool) or not isinstance(raw["revision"], int):
        raise ValueError("revision must be a non-negative integer")
    if raw["revision"] < 0:
        raise ValueError("revision must be a non-negative integer")

    # Strictly a number, never a coerced string: float("100.5") would succeed here
    # while the TypeScript port rejects anything that is not a number.
    value = raw["value"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise ValueError("value must be finite")

    event_ms = parse_timestamp_ms(raw["event_time"], "event_time")
    available_ms = parse_timestamp_ms(raw["available_at"], "available_at")
    if event_ms > available_ms:
        raise ValueError("event_time cannot be after available_at")

    return {
        "partition": raw["partition"],
        "instrument": raw["instrument"],
        "record_id": raw["record_id"],
        "revision": raw["revision"],
        "event_time": raw["event_time"],
        "available_at": raw["available_at"],
        "value": float(value),
        "event_ms": event_ms,
        "available_ms": available_ms,
    }


def normalise(
    observations: Iterable[Mapping[str, Any]], required_instruments: Iterable[Any]
) -> tuple[list[dict[str, Any]], list[str]]:
    """Validate every observation and return it sorted into arrival order.

    Sorting is by ``(partition, available_at, instrument, record_id, revision)`` — the
    order a consumer would have seen, with deterministic tie-breaking so two runs over
    the same data can never disagree.
    """

    instruments = _require_instruments(required_instruments)
    allowed = set(instruments)
    rows = [normalise_row(raw, allowed) for raw in observations]

    rows.sort(
        key=lambda row: (
            row["partition"],
            row["available_ms"],
            row["instrument"],
            row["record_id"],
            row["revision"],
        )
    )
    _check_revision_histories(rows)
    return rows, instruments


def _check_revision_histories(rows: list[dict[str, Any]]) -> None:
    """Corrections must be contiguous, later, and about the same instrument."""

    histories: dict[tuple[str, str], dict[str, Any]] = {}
    event_owners: dict[tuple[str, str, int], str] = {}

    for row in rows:
        event_key = (row["partition"], row["instrument"], row["event_ms"])
        owner = event_owners.setdefault(event_key, row["record_id"])
        if owner != row["record_id"]:
            # Two different records claiming the same event instant makes "the value
            # at that instant" undefined, and the answer would depend on input order.
            raise ValueError(
                "ambiguous duplicate event_time across distinct record_id values"
            )

        key = (row["partition"], row["record_id"])
        previous = histories.get(key)
        if previous is None:
            if row["revision"] != 0:
                raise ValueError("the first revision of a record must be zero")
        else:
            if row["instrument"] != previous["instrument"]:
                raise ValueError("a correction cannot change instrument")
            if row["revision"] != previous["revision"] + 1:
                raise ValueError("record revisions must be contiguous")
            if row["available_ms"] <= previous["available_ms"]:
                raise ValueError("corrections must become available strictly later")
        histories[key] = row


def _select(
    latest_by_record: dict[str, dict[str, Any]], instruments: list[str]
) -> dict[str, dict[str, Any]]:
    """Pick the value in force for each instrument from the known records.

    ``latest_by_record`` already holds only the newest revision of each record, so this
    picks the newest *event* per instrument, breaking ties by arrival and then by
    ``record_id`` so the result never depends on iteration order.
    """

    selected: dict[str, dict[str, Any]] = {}
    for instrument in instruments:
        candidates = [
            row for row in latest_by_record.values() if row["instrument"] == instrument
        ]
        if not candidates:
            raise ValueError(f"no known observation for {instrument}")
        event_owners: dict[int, str] = {}
        for row in candidates:
            owner = event_owners.setdefault(row["event_ms"], row["record_id"])
            if owner != row["record_id"]:
                raise ValueError(
                    "ambiguous duplicate event_time across distinct record_id values"
                )
        selected[instrument] = max(
            candidates,
            key=lambda row: (row["event_ms"], row["available_ms"], row["record_id"]),
        )
    return selected


def refresh_time_sample(
    observations: Iterable[Mapping[str, Any]],
    required_instruments: Iterable[Any],
    max_staleness_ms: int,
) -> dict[str, Any]:
    """Return complete refresh candidates and per-partition information loss.

    Args:
        observations: Rows carrying every field in :data:`REQUIRED_FIELDS`.
        required_instruments: The names that must all refresh. At least two — a
            "refresh" across one instrument is just that instrument's own clock.
        max_staleness_ms: Age past which a complete row is flagged ``stale``. The row
            is still returned; it is a diagnostic, not a filter.

    Returns:
        ``{"rows": [...], "partitions": [...]}`` — the refresh cross-sections in
        sequence, and a loss summary per partition.
    """

    if isinstance(max_staleness_ms, bool) or not isinstance(max_staleness_ms, int):
        raise ValueError("max_staleness_ms must be a non-negative integer")
    if max_staleness_ms < 0:
        raise ValueError("max_staleness_ms must be a non-negative integer")

    rows, instruments = normalise(observations, required_instruments)
    partitions = sorted({row["partition"] for row in rows})

    output_rows: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []

    for partition in partitions:
        arrivals = [row for row in rows if row["partition"] == partition]
        by_instrument = {
            instrument: [row for row in arrivals if row["instrument"] == instrument]
            for instrument in instruments
        }
        # One cursor per instrument, advanced in step with the refresh cursor, so the
        # scan for "first arrival after the cursor" never restarts from the beginning.
        pointers = {instrument: 0 for instrument in instruments}
        known_index = 0
        latest_by_record: dict[str, dict[str, Any]] = {}

        cursor = _BEFORE_TIME
        sequence = 0
        discarded_total = 0
        stale_count = 0
        accepted_count = 0

        while True:
            first_new: dict[str, dict[str, Any]] = {}
            complete = True
            for instrument in instruments:
                queue = by_instrument[instrument]
                index = pointers[instrument]
                while index < len(queue) and queue[index]["available_ms"] <= cursor:
                    index += 1
                pointers[instrument] = index
                if index >= len(queue):
                    complete = False
                    break
                first_new[instrument] = queue[index]
            if not complete:
                break

            # The refresh happens when the LAST of them lands — that instrument is the
            # controller, and it is the one deciding your sampling frequency.
            refresh_ms = max(row["available_ms"] for row in first_new.values())

            interval_count = 0
            while (
                known_index < len(arrivals)
                and arrivals[known_index]["available_ms"] <= refresh_ms
            ):
                row = arrivals[known_index]
                if row["available_ms"] > cursor:
                    interval_count += 1
                latest_by_record[row["record_id"]] = row
                known_index += 1

            selected = _select(latest_by_record, instruments)
            kept = {
                (row["record_id"], row["revision"])
                for row in selected.values()
                if cursor < row["available_ms"] <= refresh_ms
            }
            discarded = interval_count - len(kept)
            discarded_total += discarded

            ages = {
                instrument: refresh_ms - row["event_ms"]
                for instrument, row in selected.items()
            }
            status = "stale" if max(ages.values()) > max_staleness_ms else "accepted"
            stale_count += status == "stale"
            accepted_count += status == "accepted"
            sequence += 1

            output_rows.append(
                {
                    "partition": partition,
                    "sequence": sequence,
                    "previous_refresh_available_at": (
                        None if cursor == _BEFORE_TIME else format_timestamp_ms(cursor)
                    ),
                    "refresh_available_at": format_timestamp_ms(refresh_ms),
                    "controller_instruments": sorted(
                        instrument
                        for instrument, row in first_new.items()
                        if row["available_ms"] == refresh_ms
                    ),
                    "status": status,
                    "values": {
                        instrument: selected[instrument]["value"]
                        for instrument in instruments
                    },
                    "sources": {
                        instrument: {
                            "record_id": selected[instrument]["record_id"],
                            "revision": selected[instrument]["revision"],
                            "event_time": selected[instrument]["event_time"],
                            "available_at": selected[instrument]["available_at"],
                        }
                        for instrument in instruments
                    },
                    "event_age_ms": ages,
                    "arrivals_by_instrument": {
                        instrument: sum(
                            1
                            for row in arrivals
                            if row["instrument"] == instrument
                            and cursor < row["available_ms"] <= refresh_ms
                        )
                        for instrument in instruments
                    },
                    "discarded_updates": discarded,
                }
            )
            cursor = refresh_ms

        tail = sum(1 for row in arrivals if row["available_ms"] > cursor)
        summaries.append(
            {
                "partition": partition,
                "input_updates": len(arrivals),
                "refresh_candidates": sequence,
                "accepted_rows": accepted_count,
                "stale_rows": stale_count,
                "discarded_updates": discarded_total,
                # Arrivals after the final refresh: real data that never made it into
                # a complete cross-section because the session ended first.
                "unmatched_tail_updates": tail,
                "loss_fraction": {
                    "numerator": discarded_total + tail,
                    "denominator": len(arrivals),
                },
            }
        )

    return {"rows": output_rows, "partitions": summaries}
