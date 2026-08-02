"""Tests for the live sampler.

The load-bearing assertion is :func:`test_streaming_equals_batch`: feeding the fixture
one arrival at a time must reproduce the batch result exactly — rows, sources, counts
and summary. Refresh-time sampling has nothing to look ahead to, so there is no excuse
for the two paths to differ, and the day they do is the day research and production
stop describing the same series.
"""

from __future__ import annotations

import pytest
from conftest import EXPECTED, INSTRUMENTS, MAX_STALENESS_MS, arrival_order, sample

from fintech_refresh_time import StreamingRefreshSampler


def live(instruments=None, max_staleness_ms=None) -> StreamingRefreshSampler:
    return StreamingRefreshSampler(
        INSTRUMENTS if instruments is None else instruments,
        MAX_STALENESS_MS if max_staleness_ms is None else max_staleness_ms,
    )


# --- equivalence with the batch function ---------------------------------------- #
def test_streaming_equals_batch():
    engine = live()
    emitted = engine.observe_many(arrival_order())
    assert emitted == EXPECTED["rows"]


def test_the_summary_equals_the_batch_summary():
    engine = live()
    engine.observe_many(arrival_order())
    assert engine.summary == EXPECTED["partitions"][0]


def test_the_loss_accounting_survives_the_streaming_path():
    engine = live()
    engine.observe_many(arrival_order())
    assert engine.summary["loss_fraction"] == {"numerator": 13, "denominator": 25}


# --- emission timing -------------------------------------------------------------- #
def test_nothing_is_emitted_until_every_instrument_has_spoken():
    engine = live()
    rows = arrival_order()
    assert engine.observe(rows[0]) is None
    assert engine.observe(rows[1]) is None
    third = engine.observe(rows[2])
    assert third is not None
    assert third["sequence"] == 1


def test_the_emitting_arrival_is_the_controller():
    engine = live()
    rows = arrival_order()
    emitted = [engine.observe(row) for row in rows[:3]][-1]
    assert emitted["controller_instruments"] == ["GAMMA"]


def test_a_refresh_is_emitted_exactly_once():
    engine = live()
    emitted = engine.observe_many(arrival_order())
    assert len(emitted) == engine.refresh_count == 4


def test_the_engine_reports_what_it_is_waiting_for():
    engine = live()
    rows = arrival_order()
    engine.observe(rows[0])
    assert engine.waiting_for == ["BETA", "GAMMA"]
    engine.observe(rows[1])
    assert engine.waiting_for == ["GAMMA"]


def test_a_fresh_engine_waits_for_everyone():
    assert live().waiting_for == sorted(INSTRUMENTS)


def test_the_last_refresh_time_tracks_the_emissions():
    engine = live()
    assert engine.last_refresh_at is None
    emitted = engine.observe_many(arrival_order())
    assert engine.last_refresh_at == emitted[-1]["refresh_available_at"]


# --- ordering and partitions ------------------------------------------------------- #
def test_out_of_order_arrival_is_rejected():
    engine = live()
    rows = arrival_order()
    engine.observe(rows[5])
    with pytest.raises(ValueError, match="non-decreasing available_at"):
        engine.observe(rows[0])


def test_a_second_partition_is_refused():
    """Interleaving two sessions into one series would be silently wrong."""

    engine = live()
    rows = arrival_order()
    engine.observe(rows[0])
    with pytest.raises(ValueError, match="one sampler handles one partition"):
        engine.observe({**rows[1], "partition": "2026-01-06:XNYS:REG"})


def test_simultaneous_arrivals_are_allowed():
    engine = live()
    rows = arrival_order()
    engine.observe(rows[0])
    engine.observe({**rows[1], "available_at": rows[0]["available_at"]})
    assert engine.waiting_for == ["GAMMA"]


# --- validation carries over -------------------------------------------------------- #
def test_a_correction_out_of_sequence_is_rejected_live():
    engine = live()
    rows = arrival_order()
    engine.observe(rows[0])
    with pytest.raises(ValueError, match="contiguous"):
        engine.observe({**rows[0], "revision": 2, "available_at": "2026-01-05T14:30:30.000Z"})


def test_a_duplicate_event_instant_is_rejected_live():
    engine = live()
    rows = arrival_order()
    engine.observe(rows[0])
    with pytest.raises(ValueError, match="ambiguous duplicate event_time"):
        engine.observe(
            {**rows[0], "record_id": "other", "available_at": "2026-01-05T14:30:30.000Z"}
        )


def test_a_bad_value_is_rejected_at_ingestion():
    engine = live()
    bad = dict(arrival_order()[0])
    bad["value"] = "100"
    with pytest.raises(ValueError, match="value must be finite"):
        engine.observe(bad)


def test_an_unexpected_instrument_is_rejected_live():
    engine = live()
    bad = dict(arrival_order()[0])
    bad["instrument"] = "DELTA"
    with pytest.raises(ValueError, match="unexpected instrument"):
        engine.observe(bad)


@pytest.mark.parametrize("bad", [-1, 1.5, "5000", True, None])
def test_a_bad_budget_raises(bad):
    # Constructed directly rather than through the helper, whose `None` means "use the
    # fixture default" and would swallow the case under test.
    with pytest.raises(ValueError, match="max_staleness_ms"):
        StreamingRefreshSampler(INSTRUMENTS, bad)


def test_a_one_name_basket_raises():
    with pytest.raises(ValueError, match="at least two"):
        live(instruments=["ALPHA"])


# --- staleness ---------------------------------------------------------------------- #
def test_a_tight_budget_flags_live_rows_stale():
    engine = live(max_staleness_ms=0)
    emitted = engine.observe_many(arrival_order())
    assert {row["status"] for row in emitted} == {"stale"}
    assert engine.summary["stale_rows"] == 4


def test_the_tight_budget_result_still_equals_the_batch_one():
    engine = live(max_staleness_ms=0)
    assert engine.observe_many(arrival_order()) == sample(max_staleness_ms=0)["rows"]
