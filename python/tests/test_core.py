"""Contract tests for the sampler.

The fixture is the cross-language acceptance anchor: 25 arrivals across three
instruments in one session, producing four refresh cross-sections and discarding 13
updates. Its complete expected output — every row, every source, every count — is
asserted verbatim by this suite and by the TypeScript one.
"""

from __future__ import annotations

import pytest
from conftest import EXPECTED, INSTRUMENTS, MAX_STALENESS_MS, observations, sample

from fintech_refresh_time import parse_timestamp_ms, refresh_time_sample

# --- the shared fixture ------------------------------------------------------- #
def test_the_whole_result_matches_the_fixture():
    assert sample() == EXPECTED


def test_the_fixture_produces_four_refreshes_from_twenty_five_arrivals():
    summary = sample()["partitions"][0]
    assert summary["input_updates"] == 25
    assert summary["refresh_candidates"] == 4
    assert len(sample()["rows"]) == 4


def test_over_half_the_input_never_reaches_the_sample():
    """The honest price of the method, asserted rather than mentioned."""

    summary = sample()["partitions"][0]
    assert summary["loss_fraction"] == {"numerator": 13, "denominator": 25}
    assert summary["discarded_updates"] == 10
    assert summary["unmatched_tail_updates"] == 3


def test_sequences_are_contiguous_from_one():
    assert [row["sequence"] for row in sample()["rows"]] == [1, 2, 3, 4]


def test_every_row_carries_every_instrument():
    for row in sample()["rows"]:
        assert sorted(row["values"]) == sorted(INSTRUMENTS)
        assert sorted(row["sources"]) == sorted(INSTRUMENTS)


def test_no_observations_produces_nothing():
    assert refresh_time_sample([], INSTRUMENTS, MAX_STALENESS_MS) == {
        "rows": [],
        "partitions": [],
    }


# --- the refresh rule ---------------------------------------------------------- #
def test_the_first_refresh_waits_for_the_last_instrument():
    row = sample()["rows"][0]
    assert row["refresh_available_at"] == "2026-01-05T14:30:00.340Z"
    assert row["controller_instruments"] == ["GAMMA"]


def test_the_slow_instrument_controls_every_refresh():
    """One name is setting the sampling frequency for the whole basket."""

    controllers = [row["controller_instruments"] for row in sample()["rows"]]
    assert controllers == [["GAMMA"]] * 4


def test_the_first_row_has_no_previous_refresh():
    assert sample()["rows"][0]["previous_refresh_available_at"] is None


def test_each_row_chains_to_the_one_before():
    rows = sample()["rows"]
    for earlier, later in zip(rows, rows[1:]):
        assert later["previous_refresh_available_at"] == earlier["refresh_available_at"]


def test_refresh_times_strictly_increase():
    stamps = [row["refresh_available_at"] for row in sample()["rows"]]
    assert stamps == sorted(stamps)
    assert len(set(stamps)) == len(stamps)


def test_a_single_instrument_basket_is_refused():
    """A 'refresh' across one instrument is just that instrument's own clock."""

    with pytest.raises(ValueError, match="at least two"):
        sample(instruments=["ALPHA"])


def test_two_instruments_that_never_both_refresh_produce_no_rows():
    rows = [row for row in observations() if row["instrument"] == "ALPHA"]
    rows.append(
        {
            "partition": "2026-01-05:XNYS:REG", "instrument": "BETA", "record_id": "zz",
            "revision": 0, "event_time": "2026-01-05T14:30:00.000Z",
            "available_at": "2026-01-05T14:30:00.220Z", "value": 1.0,
        }
    )
    result = refresh_time_sample(rows, ["ALPHA", "BETA"], MAX_STALENESS_MS)
    assert len(result["rows"]) == 1  # BETA never posts again
    assert result["partitions"][0]["unmatched_tail_updates"] > 0


# --- values are observations, never carried ------------------------------------ #
def test_every_value_traces_to_a_named_source():
    for row in sample()["rows"]:
        for instrument, source in row["sources"].items():
            assert source["record_id"]
            assert source["revision"] >= 0
            assert source["available_at"] <= row["refresh_available_at"]


def test_a_source_never_arrives_after_its_refresh():
    """The causal guarantee: nothing in the row post-dates the row."""

    for row in sample()["rows"]:
        refresh_ms = parse_timestamp_ms(row["refresh_available_at"])
        for source in row["sources"].values():
            assert parse_timestamp_ms(source["available_at"]) <= refresh_ms


def test_event_age_is_measured_from_the_refresh():
    for row in sample()["rows"]:
        refresh_ms = parse_timestamp_ms(row["refresh_available_at"])
        for instrument, age in row["event_age_ms"].items():
            event_ms = parse_timestamp_ms(row["sources"][instrument]["event_time"])
            assert age == refresh_ms - event_ms


# --- staleness ------------------------------------------------------------------ #
def test_the_fixture_is_entirely_fresh_at_its_budget():
    assert {row["status"] for row in sample()["rows"]} == {"accepted"}


def test_a_tight_budget_flags_rows_stale_without_dropping_them():
    """A stale row is returned with a warning, not silently repaired or removed."""

    result = sample(max_staleness_ms=0)
    assert len(result["rows"]) == 4
    assert {row["status"] for row in result["rows"]} == {"stale"}
    assert result["partitions"][0]["stale_rows"] == 4
    assert result["partitions"][0]["accepted_rows"] == 0


def test_a_stale_row_still_carries_its_values():
    row = sample(max_staleness_ms=0)["rows"][0]
    assert row["status"] == "stale"
    assert all(value is not None for value in row["values"].values())


def test_staleness_does_not_change_which_rows_exist():
    tight = sample(max_staleness_ms=0)["rows"]
    loose = sample(max_staleness_ms=10**9)["rows"]
    assert [row["refresh_available_at"] for row in tight] == [
        row["refresh_available_at"] for row in loose
    ]


@pytest.mark.parametrize("bad", [-1, 1.5, "5000", True, None])
def test_an_invalid_budget_raises(bad):
    with pytest.raises(ValueError, match="max_staleness_ms"):
        refresh_time_sample(observations(), INSTRUMENTS, bad)


# --- corrections ----------------------------------------------------------------- #
def test_a_correction_must_start_at_revision_zero():
    rows = observations(0)
    rows[0]["revision"] = 1
    with pytest.raises(ValueError, match="first revision"):
        sample(rows=rows)


def test_corrections_must_be_contiguous():
    rows = observations()
    rows.append({**rows[0], "revision": 2, "available_at": "2026-01-05T14:30:20.000Z"})
    with pytest.raises(ValueError, match="contiguous"):
        sample(rows=rows)


def test_a_correction_must_arrive_later_than_what_it_corrects():
    rows = observations()
    rows.append({**rows[0], "revision": 1, "available_at": rows[0]["available_at"]})
    with pytest.raises(ValueError, match="strictly later"):
        sample(rows=rows)


def test_a_correction_cannot_change_instrument():
    rows = observations()
    # A distinct event_time, so it is the instrument rule that catches this and not
    # the duplicate-event ambiguity check.
    rows.append(
        {**rows[0], "revision": 1, "instrument": "BETA",
         "event_time": "2026-01-05T14:30:19.000Z",
         "available_at": "2026-01-05T14:30:20.000Z"}
    )
    with pytest.raises(ValueError, match="cannot change instrument"):
        sample(rows=rows)


def test_two_records_claiming_one_event_instant_are_ambiguous():
    rows = observations()
    rows.append({**rows[0], "record_id": "other", "available_at": "2026-01-05T14:30:20.000Z"})
    with pytest.raises(ValueError, match="ambiguous duplicate event_time"):
        sample(rows=rows)


# --- determinism ------------------------------------------------------------------ #
def test_input_order_does_not_change_the_answer():
    assert sample(rows=list(reversed(observations()))) == sample()


def test_input_rows_are_never_mutated():
    rows = observations()
    before = [dict(row) for row in rows]
    refresh_time_sample(rows, INSTRUMENTS, MAX_STALENESS_MS)
    assert rows == before


def test_partitions_are_sampled_independently():
    rows = observations() + [
        {**row, "partition": "2026-01-06:XNYS:REG"} for row in observations()
    ]
    result = refresh_time_sample(rows, INSTRUMENTS, MAX_STALENESS_MS)
    assert len(result["partitions"]) == 2
    assert {summary["refresh_candidates"] for summary in result["partitions"]} == {4}


# --- validation --------------------------------------------------------------------- #
@pytest.mark.parametrize("field", ["partition", "instrument", "record_id", "revision",
                                   "event_time", "available_at", "value"])
def test_a_missing_field_raises(field):
    rows = observations(0)
    del rows[0][field]
    with pytest.raises(ValueError, match="missing fields"):
        sample(rows=rows)


def test_an_unexpected_instrument_raises():
    rows = observations(0)
    rows[0]["instrument"] = "DELTA"
    with pytest.raises(ValueError, match="unexpected instrument"):
        sample(rows=rows)


@pytest.mark.parametrize("value", ["100", None, True, float("nan"), float("inf")])
def test_a_non_numeric_value_raises(value):
    """`float('100')` would succeed in Python; TypeScript refuses it. So do we."""

    rows = observations(0)
    rows[0]["value"] = value
    with pytest.raises(ValueError, match="value must be finite"):
        sample(rows=rows)


@pytest.mark.parametrize("bad", [-1, 1.5, "0", True])
def test_a_bad_revision_raises(bad):
    rows = observations(0)
    rows[0]["revision"] = bad
    with pytest.raises(ValueError, match="revision"):
        sample(rows=rows)


@pytest.mark.parametrize("field", ["partition", "record_id"])
def test_an_empty_key_raises(field):
    rows = observations(0)
    rows[0][field] = ""
    with pytest.raises(ValueError, match="non-empty"):
        sample(rows=rows)


def test_an_event_after_its_arrival_raises():
    rows = observations(0)
    rows[0]["event_time"] = "2026-01-05T23:00:00.000Z"
    with pytest.raises(ValueError, match="cannot be after available_at"):
        sample(rows=rows)


def test_a_non_mapping_observation_raises():
    with pytest.raises(ValueError, match="mapping"):
        sample(rows=["nope"])


# --- timestamps are strict ------------------------------------------------------------ #
def test_an_impossible_calendar_date_is_rejected():
    with pytest.raises(ValueError, match="not a real calendar time"):
        parse_timestamp_ms("2026-02-30T00:00:00.000Z")


@pytest.mark.parametrize(
    "timestamp",
    ["2026-01-05T14:30:00+00:00", "2026-01-05T14:30:00", "2026-01-05T14:30:00.0001Z",
     "2026-13-05T14:30:00Z", "", None, 1767623400000],
)
def test_a_malformed_timestamp_is_rejected(timestamp):
    with pytest.raises(ValueError):
        parse_timestamp_ms(timestamp)


def test_a_valid_timestamp_parses_exactly():
    assert parse_timestamp_ms("2026-01-05T14:30:00.340Z") == 1_767_623_400_340
