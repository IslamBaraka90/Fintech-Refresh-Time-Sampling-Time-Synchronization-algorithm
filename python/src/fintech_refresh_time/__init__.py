"""Causal all-refresh sampling for asynchronous instruments.

Sample when *everybody* has spoken — no carry-forward, no interpolation, and an honest
accounting of the data it costs you.

Quickstart::

    from fintech_refresh_time import refresh_time_sample

    result = refresh_time_sample(observations, ["ALPHA", "BETA"], max_staleness_ms=5000)

See :mod:`fintech_refresh_time.core` for the sampling rule,
:mod:`fintech_refresh_time.streaming` for the live sampler, and
:mod:`fintech_refresh_time.analysis` for the controller, loss and subset diagnostics.

Article: https://thefintechbuilder.com/market-data-engineering/time-synchronization/refresh-time-sampling/
"""

from .analysis import (
    cadence_profile,
    controller_profile,
    loss_report,
    subset_comparison,
)
from .core import (
    REQUIRED_FIELDS,
    format_timestamp_ms,
    parse_timestamp_ms,
    refresh_time_sample,
)
from .streaming import StreamingRefreshSampler

__version__ = "0.1.0"

__all__ = [
    "REQUIRED_FIELDS",
    "StreamingRefreshSampler",
    "__version__",
    "cadence_profile",
    "controller_profile",
    "format_timestamp_ms",
    "loss_report",
    "parse_timestamp_ms",
    "refresh_time_sample",
    "subset_comparison",
]
