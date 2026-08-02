"""Shared fixture access. The same JSON backs the TypeScript suite."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "fixtures.json").read_text(encoding="utf-8")
)
INSTRUMENTS = FIXTURE["required_instruments"]
MAX_STALENESS_MS = FIXTURE["max_staleness_ms"]
OBSERVATIONS = FIXTURE["observations"]
EXPECTED = FIXTURE["expected"]


def observations(*indexes: int) -> list[dict]:
    """Deep-copied fixture observations — all, or the given 0-based positions."""

    if not indexes:
        return copy.deepcopy(OBSERVATIONS)
    return [copy.deepcopy(OBSERVATIONS[i]) for i in indexes]


def arrival_order() -> list[dict]:
    """The fixture in the order a consumer would have received it."""

    return sorted(observations(), key=lambda row: (row["available_at"], row["instrument"]))


def sample(rows=None, instruments=None, max_staleness_ms=None):
    from fintech_refresh_time import refresh_time_sample

    return refresh_time_sample(
        observations() if rows is None else rows,
        INSTRUMENTS if instruments is None else instruments,
        MAX_STALENESS_MS if max_staleness_ms is None else max_staleness_ms,
    )
