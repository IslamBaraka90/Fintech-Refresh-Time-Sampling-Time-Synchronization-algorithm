"""Tests for the controller, loss, cadence and subset diagnostics."""

from __future__ import annotations

import pytest
from conftest import INSTRUMENTS, MAX_STALENESS_MS, observations, sample

from fintech_refresh_time import (
    cadence_profile,
    controller_profile,
    loss_report,
    subset_comparison,
)

PARTITION = "2026-01-05:XNYS:REG"


# --- controller_profile --------------------------------------------------------- #
def test_the_profile_names_the_bottleneck():
    """GAMMA controls all four refreshes — it alone sets the sampling frequency."""

    entry = controller_profile(sample())["partitions"][PARTITION]
    assert entry["dominant"] == "GAMMA"
    assert entry["counts"] == {"GAMMA": 4}
    assert entry["shares"]["GAMMA"] == 1.0


def test_the_refresh_count_matches_the_sample():
    entry = controller_profile(sample())["partitions"][PARTITION]
    assert entry["refreshes"] == len(sample()["rows"])


def test_a_fast_instrument_never_controls():
    entry = controller_profile(sample())["partitions"][PARTITION]
    assert "ALPHA" not in entry["counts"]


def test_co_controlled_refreshes_are_counted():
    """Two instruments landing in the same millisecond genuinely share the blame."""

    rows = observations()
    for row in rows:
        if row["instrument"] == "GAMMA" and row["available_at"].endswith("00.340Z"):
            row["available_at"] = "2026-01-05T14:30:00.220Z"
    entry = controller_profile(sample(rows=rows))["partitions"][PARTITION]
    assert entry["co_controlled"] >= 1
    assert sum(entry["shares"].values()) > 1.0


def test_an_empty_sample_profiles_to_nothing():
    assert controller_profile({"rows": [], "partitions": []})["partitions"] == {}


def test_the_profile_rejects_foreign_input():
    with pytest.raises(ValueError, match="refresh_time_sample"):
        controller_profile({"nope": 1})


# --- loss_report ------------------------------------------------------------------ #
def test_the_report_counts_arrivals_per_instrument():
    entry = loss_report(sample())["partitions"][PARTITION]
    assert sum(entry["arrivals"].values()) == 22  # 25 minus the 3 tail arrivals


def test_every_instrument_contributes_one_value_per_refresh():
    entry = loss_report(sample())["partitions"][PARTITION]
    assert entry["sampled"] == {name: 4 for name in INSTRUMENTS}


def test_retention_shows_the_fast_instrument_being_decimated():
    """ALPHA prints far more than it contributes; that ratio is the cost."""

    entry = loss_report(sample())["partitions"][PARTITION]
    assert entry["retention"]["ALPHA"] < entry["retention"]["GAMMA"]


def test_the_report_carries_the_partition_summary():
    report = loss_report(sample())
    assert report["summaries"][PARTITION]["loss_fraction"] == {
        "numerator": 13,
        "denominator": 25,
    }


# --- cadence_profile --------------------------------------------------------------- #
def test_the_cadence_counts_intervals_between_refreshes():
    entry = cadence_profile(sample())["partitions"][PARTITION]
    assert entry["refreshes"] == 4
    assert entry["intervals"] == 3


def test_the_fixture_cadence_is_four_seconds():
    entry = cadence_profile(sample())["partitions"][PARTITION]
    assert entry["median_ms"] == 4040
    assert entry["min_ms"] == 4040
    assert entry["max_ms"] == 4040


def test_a_perfectly_regular_series_scores_one():
    assert cadence_profile(sample())["partitions"][PARTITION]["regularity"] == 1.0


def test_an_irregular_series_scores_below_one():
    rows = [row for row in observations() if row["available_at"] < "2026-01-05T14:30:09Z"]
    entry = cadence_profile(sample(rows=rows))["partitions"][PARTITION]
    if entry["intervals"] > 1:
        assert entry["regularity"] <= 1.0


def test_a_single_refresh_has_no_interval():
    rows = [row for row in observations() if row["available_at"] < "2026-01-05T14:30:01Z"]
    entry = cadence_profile(sample(rows=rows))["partitions"][PARTITION]
    assert entry["intervals"] == 0
    assert entry["median_ms"] is None


# --- subset_comparison -------------------------------------------------------------- #
def test_dropping_the_slow_instrument_buys_more_refreshes():
    """The decision this whole surface exists to inform."""

    comparison = subset_comparison(
        observations(),
        [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"]],
        MAX_STALENESS_MS,
    )
    full, without_gamma = comparison
    assert without_gamma["refresh_candidates"] > full["refresh_candidates"]
    assert without_gamma["refreshes_vs_first"] > 0


def test_the_smaller_basket_wastes_less():
    comparison = subset_comparison(
        observations(),
        [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"]],
        MAX_STALENESS_MS,
    )
    assert comparison[1]["loss_share"] < comparison[0]["loss_share"]


def test_each_subset_reports_its_own_controller():
    comparison = subset_comparison(
        observations(), [["ALPHA", "BETA", "GAMMA"], ["ALPHA", "BETA"]], MAX_STALENESS_MS
    )
    assert comparison[0]["dominant_controllers"] == ["GAMMA"]
    assert "GAMMA" not in comparison[1]["dominant_controllers"]


def test_the_first_subset_is_the_baseline():
    comparison = subset_comparison(
        observations(), [["ALPHA", "BETA"], ["ALPHA", "BETA", "GAMMA"]], MAX_STALENESS_MS
    )
    assert comparison[0]["refreshes_vs_first"] == 0
    assert comparison[1]["refreshes_vs_first"] < 0


def test_the_full_basket_agrees_with_a_direct_sample():
    comparison = subset_comparison(observations(), [INSTRUMENTS], MAX_STALENESS_MS)
    assert comparison[0]["refresh_candidates"] == len(sample()["rows"])
    assert comparison[0]["input_updates"] == 25
    assert comparison[0]["discarded"] == 13


def test_subset_instruments_come_back_sorted():
    comparison = subset_comparison(
        observations(), [["GAMMA", "ALPHA", "BETA"]], MAX_STALENESS_MS
    )
    assert comparison[0]["instruments"] == ["ALPHA", "BETA", "GAMMA"]


def test_a_one_name_subset_raises():
    with pytest.raises(ValueError, match="at least two"):
        subset_comparison(observations(), [["ALPHA"]], MAX_STALENESS_MS)


def test_an_empty_subset_list_returns_nothing():
    assert subset_comparison(observations(), [], MAX_STALENESS_MS) == []


def test_the_comparison_does_not_mutate_the_observations():
    rows = observations()
    before = [dict(row) for row in rows]
    subset_comparison(rows, [["ALPHA", "BETA"]], MAX_STALENESS_MS)
    assert rows == before
