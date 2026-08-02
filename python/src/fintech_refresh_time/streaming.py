"""Refresh sampling as it actually happens: one arrival at a time.

Refresh-time sampling is a streaming algorithm wearing a batch costume. A refresh is
detected the instant the last required instrument posts — there is nothing to look
ahead to, and nothing to wait for beyond the arrival itself. So the live engine is not
an approximation of the batch function here; it is the same computation, driven by the
feed instead of by a loop.

:meth:`StreamingRefreshSampler.observe` returns the refresh row if that arrival
completed one, and ``None`` otherwise. That single return value is the whole API: the
moment a refresh is emitted is the moment it became true.

The batch function and this engine are asserted to produce identical rows for identical
input, because the day they diverge is the day your research and your production
sampler stop describing the same series.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .core import (
    _BEFORE_TIME,
    _require_instruments,
    _select,
    format_timestamp_ms,
    normalise_row,
)

__all__ = ["StreamingRefreshSampler"]


class StreamingRefreshSampler:
    """Emit refresh cross-sections as arrivals complete them.

    Args:
        required_instruments: The names that must all refresh. At least two.
        max_staleness_ms: Age past which a complete row is flagged ``stale``.

    Notes:
        One sampler handles one partition at a time. Feeding it two partitions raises,
        rather than silently interleaving two unrelated sessions into one series.
    """

    def __init__(
        self, required_instruments: Iterable[Any], max_staleness_ms: int
    ) -> None:
        if isinstance(max_staleness_ms, bool) or not isinstance(max_staleness_ms, int):
            raise ValueError("max_staleness_ms must be a non-negative integer")
        if max_staleness_ms < 0:
            raise ValueError("max_staleness_ms must be a non-negative integer")

        instruments = _require_instruments(required_instruments)
        self._instruments = instruments
        self._allowed = set(instruments)
        self._max_staleness_ms = max_staleness_ms

        self._partition: str | None = None
        self._cursor = _BEFORE_TIME
        self._sequence = 0
        self._last_available_ms: int | None = None
        self._latest_by_record: dict[str, dict[str, Any]] = {}
        self._histories: dict[str, dict[str, Any]] = {}
        self._event_owners: dict[tuple[str, int], str] = {}
        self._pending: dict[str, list[dict[str, Any]]] = {
            instrument: [] for instrument in instruments
        }
        self._interval_arrivals: dict[str, int] = {
            instrument: 0 for instrument in instruments
        }
        self._interval_count = 0
        self._discarded_total = 0
        self._accepted = 0
        self._stale = 0
        self._input_updates = 0

    # --- ingestion ---------------------------------------------------------- #
    def observe(self, observation: Mapping[str, Any]) -> dict[str, Any] | None:
        """Ingest one arrival. Returns a refresh row if this arrival completed one."""

        # Per-row validation only. The cross-row revision rules are enforced by
        # _check_history below, which carries state the batch validator cannot see.
        row = normalise_row(observation, self._allowed)

        if self._partition is None:
            self._partition = row["partition"]
        elif row["partition"] != self._partition:
            raise ValueError(
                "one sampler handles one partition; "
                f"got {row['partition']!r} after {self._partition!r}"
            )

        if (
            self._last_available_ms is not None
            and row["available_ms"] < self._last_available_ms
        ):
            raise ValueError(
                "observations must arrive in non-decreasing available_at order"
            )
        self._check_history(row)

        self._last_available_ms = row["available_ms"]
        self._input_updates += 1
        self._interval_count += 1
        self._interval_arrivals[row["instrument"]] += 1
        self._latest_by_record[row["record_id"]] = row
        self._pending[row["instrument"]].append(row)

        if any(not queue for queue in self._pending.values()):
            return None
        return self._emit(row["available_ms"])

    def observe_many(
        self, observations: Iterable[Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        """Ingest many arrivals, returning every refresh row they completed."""

        emitted: list[dict[str, Any]] = []
        for observation in observations:
            row = self.observe(observation)
            if row is not None:
                emitted.append(row)
        return emitted

    def _check_history(self, row: dict[str, Any]) -> None:
        event_key = (row["instrument"], row["event_ms"])
        owner = self._event_owners.setdefault(event_key, row["record_id"])
        if owner != row["record_id"]:
            raise ValueError(
                "ambiguous duplicate event_time across distinct record_id values"
            )

        previous = self._histories.get(row["record_id"])
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
        self._histories[row["record_id"]] = row

    def _emit(self, refresh_ms: int) -> dict[str, Any]:
        selected = _select(self._latest_by_record, self._instruments)
        controllers = sorted(
            instrument
            for instrument, queue in self._pending.items()
            if queue[0]["available_ms"] == refresh_ms
        )
        kept = {
            (row["record_id"], row["revision"])
            for row in selected.values()
            if self._cursor < row["available_ms"] <= refresh_ms
        }
        discarded = self._interval_count - len(kept)
        self._discarded_total += discarded

        ages = {
            instrument: refresh_ms - row["event_ms"]
            for instrument, row in selected.items()
        }
        status = "stale" if max(ages.values()) > self._max_staleness_ms else "accepted"
        if status == "stale":
            self._stale += 1
        else:
            self._accepted += 1
        self._sequence += 1

        emitted = {
            "partition": self._partition,
            "sequence": self._sequence,
            "previous_refresh_available_at": (
                None if self._cursor == _BEFORE_TIME else format_timestamp_ms(self._cursor)
            ),
            "refresh_available_at": format_timestamp_ms(refresh_ms),
            "controller_instruments": controllers,
            "status": status,
            "values": {
                instrument: selected[instrument]["value"]
                for instrument in self._instruments
            },
            "sources": {
                instrument: {
                    "record_id": selected[instrument]["record_id"],
                    "revision": selected[instrument]["revision"],
                    "event_time": selected[instrument]["event_time"],
                    "available_at": selected[instrument]["available_at"],
                }
                for instrument in self._instruments
            },
            "event_age_ms": ages,
            "arrivals_by_instrument": dict(sorted(self._interval_arrivals.items())),
            "discarded_updates": discarded,
        }

        self._cursor = refresh_ms
        # Every queue is non-empty here, so dropping one entry each keeps exactly the
        # arrivals that have not yet been consumed by a refresh.
        for instrument in self._instruments:
            self._pending[instrument] = [
                row
                for row in self._pending[instrument]
                if row["available_ms"] > refresh_ms
            ]
        self._interval_count = sum(len(queue) for queue in self._pending.values())
        self._interval_arrivals = {
            instrument: len(self._pending[instrument])
            for instrument in self._instruments
        }
        return emitted

    # --- introspection ------------------------------------------------------ #
    @property
    def summary(self) -> dict[str, Any]:
        """The same partition summary the batch function reports."""

        tail = sum(len(queue) for queue in self._pending.values())
        return {
            "partition": self._partition,
            "input_updates": self._input_updates,
            "refresh_candidates": self._sequence,
            "accepted_rows": self._accepted,
            "stale_rows": self._stale,
            "discarded_updates": self._discarded_total,
            "unmatched_tail_updates": tail,
            "loss_fraction": {
                "numerator": self._discarded_total + tail,
                "denominator": self._input_updates,
            },
        }

    @property
    def waiting_for(self) -> list[str]:
        """Instruments that have not posted since the last refresh.

        This is the live version of the controller question: whatever is in this list
        is what the whole basket is currently waiting on.
        """

        return sorted(
            instrument for instrument, queue in self._pending.items() if not queue
        )

    @property
    def refresh_count(self) -> int:
        return self._sequence

    @property
    def last_refresh_at(self) -> str | None:
        return None if self._cursor == _BEFORE_TIME else format_timestamp_ms(self._cursor)
