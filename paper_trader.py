#!/usr/bin/env python3
# =============================================================================
#  PAPER TRADING ONLY — REAL DATA, FAKE MONEY.
#
#  This file never connects to a brokerage, never authenticates, never places
#  an order, and holds no credentials. There is no code path anywhere in this
#  program that can transmit an order to any venue. Price data is real (pulled
#  from Yahoo Finance via `yfinance`); every dollar simulated here is invented.
#
#  Nothing in this file is investment advice, and nothing here should be read
#  as a claim that this strategy has positive expected value in live markets.
#  Aggressive breakout systems like this one routinely lose money after costs.
#  MAX-RISK mode in particular exists to make ruin risk *visible*, not to
#  avoid it — it will blow up simulated accounts, and that is the point.
# =============================================================================
"""
paper_trader.py — high-risk / high-reward paper-trading simulator.

Single file, on purpose: the tunables live at the top, the logic lives below,
and you can copy one file around without an import path to fight. See the
CONFIG block immediately below — you should never need to edit anything past
the `END OF CONFIG` banner to change the risk profile.

Quick start:
    pip install yfinance pandas numpy
    python paper_trader.py --once            # one evaluation cycle, then exit
    python paper_trader.py --replay          # backtest over the fetched history
    python paper_trader.py                   # live paper loop (Ctrl+C to stop)
    python paper_trader.py --max-risk        # leverage, shorts, pyramiding
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import os
import random
import signal
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone, date, time as dtime
from typing import Any, Callable, Iterable, Sequence
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

try:
    import yfinance as yf
except ImportError:  # pragma: no cover - dependency check
    sys.exit("Missing dependency. Run:  pip install yfinance pandas numpy")


# =============================================================================
#  CONFIG — tune everything from here.
# =============================================================================

# ---- Tradable universe -------------------------------------------------------
# Anything yfinance understands. Symbols ending in "-USD" are treated as crypto
# (24/7 calendar, fractional sizing); everything else uses the US equity calendar.
EQUITY_UNIVERSE: list[str] = ["TQQQ", "SOXL", "NVDA", "TSLA"]
CRYPTO_UNIVERSE: list[str] = ["BTC-USD", "ETH-USD"]

# ---- Capital -----------------------------------------------------------------
STARTING_CASH: float = 10_000.0

# ---- Strategy: entry ---------------------------------------------------------
BREAKOUT_LOOKBACK: int = 20        # bars; enter when price clears this window's high
VOLUME_LOOKBACK: int = 20          # bars for the average-volume baseline
VOLUME_SPIKE_MULT: float = 1.5     # require volume > mult * average volume
TREND_FILTER_PERIOD: int = 50      # bars; 0 disables the trend filter
USE_TREND_FILTER: bool = True      # only go long above the SMA (short below it)

# ---- Strategy: exit ----------------------------------------------------------
ATR_PERIOD: int = 14
TRAIL_ATR_MULT: float = 2.5        # trailing stop distance, in ATRs
STOP_LOSS_PCT: float = 0.08        # hard stop from average entry
TAKE_PROFIT_PCT: float = 0.25      # 0 disables the profit target (ride the trail)
VOL_CONTRACTION_RATIO: float = 0.6 # exit if ATR falls below ratio * entry ATR
MAX_HOLD_BARS: int = 0             # 0 = no time stop

# ---- Risk / sizing -----------------------------------------------------------
POSITION_SIZE_PCT: float = 0.20    # target notional per position, as % of equity
MAX_OPEN_POSITIONS: int = 5
MAX_GROSS_EXPOSURE: float = 1.0    # multiple of equity; 1.0 = cash only, no margin
ALLOW_SHORTS: bool = False
ALLOW_PYRAMIDING: bool = False     # add to winners
MAX_ADDS_PER_POSITION: int = 0
PYRAMID_TRIGGER_PCT: float = 0.05  # add each time the position gains this much
DAILY_LOSS_LIMIT_PCT: float = 0.15 # halt new entries after this daily drawdown; 0 = off
MAINTENANCE_MARGIN_PCT: float = 0.25  # forced liquidation below this equity/gross ratio

# ---- Execution realism -------------------------------------------------------
SLIPPAGE_PCT: float = 0.001        # 0.1%, always applied against you
COMMISSION_PER_TRADE: float = 0.0  # flat $ per fill
ALLOW_FRACTIONAL_EQUITY: bool = False  # crypto is always fractional

# ---- Data / loop -------------------------------------------------------------
BAR_INTERVAL: str = "5m"           # 1m,2m,5m,15m,30m,60m,90m,1h,1d,1wk
HISTORY_PERIOD: str = "60d"        # must be legal for BAR_INTERVAL (validated)
POLL_INTERVAL_SECONDS: int = 300
USE_LAST_PARTIAL_BAR: bool = False # act only on closed bars
MAX_DATA_STALENESS_MINUTES: int = 60   # warn if the newest bar is older than this
FETCH_MAX_RETRIES: int = 4
FETCH_BACKOFF_BASE_SECONDS: float = 2.0
MIN_SECONDS_BETWEEN_REQUESTS: float = 0.4  # client-side rate limiting
SLEEP_WHEN_ALL_MARKETS_CLOSED: bool = True

# ---- Output ------------------------------------------------------------------
OUTPUT_DIR: str = "runs"
REPORT_EVERY_N_CYCLES: int = 12    # 0 disables periodic summaries

# ---- MAX-RISK MODE -----------------------------------------------------------
# Enable with --max-risk (or set this to True). These values overwrite the ones
# above at startup and are then re-validated. This profile is deliberately
# reckless: 3x gross exposure, half the account per position, shorts, no profit
# target, pyramiding into winners, and no daily circuit breaker. Expect deep
# drawdowns and a real chance of a simulated margin call wiping the account.
ENABLE_MAX_RISK_MODE: bool = False
MAX_RISK_PROFILE: dict[str, Any] = {
    "POSITION_SIZE_PCT": 0.50,
    "MAX_OPEN_POSITIONS": 6,
    "MAX_GROSS_EXPOSURE": 3.0,     # simulated 3x margin
    "STOP_LOSS_PCT": 0.15,         # wide stop, more room to be wrong
    "TAKE_PROFIT_PCT": 0.0,        # never take profit; ride the trailing stop
    "TRAIL_ATR_MULT": 4.0,
    "VOL_CONTRACTION_RATIO": 0.0,  # ignore volatility contraction exits
    "ALLOW_SHORTS": True,
    "ALLOW_PYRAMIDING": True,
    "MAX_ADDS_PER_POSITION": 3,
    "PYRAMID_TRIGGER_PCT": 0.04,
    "DAILY_LOSS_LIMIT_PCT": 0.0,   # circuit breaker OFF
    "BREAKOUT_LOOKBACK": 10,       # twitchier entries
    "VOLUME_SPIKE_MULT": 1.2,
    "USE_TREND_FILTER": False,
    "ALLOW_FRACTIONAL_EQUITY": True,
}

# =============================================================================
#  END OF CONFIG — implementation below.
# =============================================================================


DISCLAIMER = (
    "SIMULATION ONLY — real market data, fake money, no broker connection; "
    "this is not investment advice."
)

log = logging.getLogger("paper_trader")

NY = ZoneInfo("America/New_York")
UTC = timezone.utc

# yfinance history limits: interval -> max lookback yfinance will actually serve.
_INTERVAL_MAX_DAYS: dict[str, int] = {
    "1m": 7, "2m": 60, "5m": 60, "15m": 60, "30m": 60,
    "60m": 730, "90m": 60, "1h": 730, "1d": 100_000,
    "5d": 100_000, "1wk": 100_000, "1mo": 100_000, "3mo": 100_000,
}
_INTERVAL_SECONDS: dict[str, int] = {
    "1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800,
    "60m": 3600, "90m": 5400, "1h": 3600, "1d": 86_400,
    "5d": 432_000, "1wk": 604_800, "1mo": 2_592_000, "3mo": 7_776_000,
}

# US equity market holidays (NYSE/Nasdaq). Extend as needed — an unknown future
# year degrades gracefully to "weekdays are open", which only costs you a
# skipped-data cycle in the simulation.
_US_HOLIDAYS: set[date] = {
    date(2025, 1, 1), date(2025, 1, 9), date(2025, 1, 20), date(2025, 2, 17),
    date(2025, 4, 18), date(2025, 5, 26), date(2025, 6, 19), date(2025, 7, 4),
    date(2025, 9, 1), date(2025, 11, 27), date(2025, 12, 25),
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3),
    date(2026, 5, 25), date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7),
    date(2026, 11, 26), date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26),
    date(2027, 5, 31), date(2027, 6, 18), date(2027, 7, 5), date(2027, 9, 6),
    date(2027, 11, 25), date(2027, 12, 24),
}
# Early closes (1:00pm ET).
_US_HALF_DAYS: set[date] = {
    date(2025, 7, 3), date(2025, 11, 28), date(2025, 12, 24),
    date(2026, 11, 27), date(2026, 12, 24),
    date(2027, 11, 26),
}


class ConfigError(Exception):
    """Raised for configuration that would produce nonsensical trades."""


class DataUnavailable(Exception):
    """Raised when a symbol's data could not be fetched or is unusable."""


# =============================================================================
#  Configuration object
# =============================================================================

@dataclass
class Config:
    equity_universe: list[str]
    crypto_universe: list[str]
    starting_cash: float

    breakout_lookback: int
    volume_lookback: int
    volume_spike_mult: float
    trend_filter_period: int
    use_trend_filter: bool

    atr_period: int
    trail_atr_mult: float
    stop_loss_pct: float
    take_profit_pct: float
    vol_contraction_ratio: float
    max_hold_bars: int

    position_size_pct: float
    max_open_positions: int
    max_gross_exposure: float
    allow_shorts: bool
    allow_pyramiding: bool
    max_adds_per_position: int
    pyramid_trigger_pct: float
    daily_loss_limit_pct: float
    maintenance_margin_pct: float

    slippage_pct: float
    commission_per_trade: float
    allow_fractional_equity: bool

    bar_interval: str
    history_period: str
    poll_interval_seconds: int
    use_last_partial_bar: bool
    max_data_staleness_minutes: int
    fetch_max_retries: int
    fetch_backoff_base_seconds: float
    min_seconds_between_requests: float
    sleep_when_all_markets_closed: bool

    output_dir: str
    report_every_n_cycles: int
    max_risk_mode: bool = False

    @property
    def universe(self) -> list[str]:
        seen: dict[str, None] = {}
        for s in [*self.equity_universe, *self.crypto_universe]:
            seen.setdefault(s.strip().upper(), None)
        return list(seen)

    @property
    def min_bars_required(self) -> int:
        return max(
            self.breakout_lookback,
            self.volume_lookback,
            self.trend_filter_period if self.use_trend_filter else 0,
            self.atr_period,
        ) + 5

    def is_crypto(self, symbol: str) -> bool:
        sym = symbol.upper()
        return sym in {s.upper() for s in self.crypto_universe} or sym.endswith("-USD")


def build_config() -> Config:
    """Snapshot the module-level CONFIG block into a Config object."""
    return Config(
        equity_universe=list(EQUITY_UNIVERSE),
        crypto_universe=list(CRYPTO_UNIVERSE),
        starting_cash=STARTING_CASH,
        breakout_lookback=BREAKOUT_LOOKBACK,
        volume_lookback=VOLUME_LOOKBACK,
        volume_spike_mult=VOLUME_SPIKE_MULT,
        trend_filter_period=TREND_FILTER_PERIOD,
        use_trend_filter=USE_TREND_FILTER,
        atr_period=ATR_PERIOD,
        trail_atr_mult=TRAIL_ATR_MULT,
        stop_loss_pct=STOP_LOSS_PCT,
        take_profit_pct=TAKE_PROFIT_PCT,
        vol_contraction_ratio=VOL_CONTRACTION_RATIO,
        max_hold_bars=MAX_HOLD_BARS,
        position_size_pct=POSITION_SIZE_PCT,
        max_open_positions=MAX_OPEN_POSITIONS,
        max_gross_exposure=MAX_GROSS_EXPOSURE,
        allow_shorts=ALLOW_SHORTS,
        allow_pyramiding=ALLOW_PYRAMIDING,
        max_adds_per_position=MAX_ADDS_PER_POSITION,
        pyramid_trigger_pct=PYRAMID_TRIGGER_PCT,
        daily_loss_limit_pct=DAILY_LOSS_LIMIT_PCT,
        maintenance_margin_pct=MAINTENANCE_MARGIN_PCT,
        slippage_pct=SLIPPAGE_PCT,
        commission_per_trade=COMMISSION_PER_TRADE,
        allow_fractional_equity=ALLOW_FRACTIONAL_EQUITY,
        bar_interval=BAR_INTERVAL,
        history_period=HISTORY_PERIOD,
        poll_interval_seconds=POLL_INTERVAL_SECONDS,
        use_last_partial_bar=USE_LAST_PARTIAL_BAR,
        max_data_staleness_minutes=MAX_DATA_STALENESS_MINUTES,
        fetch_max_retries=FETCH_MAX_RETRIES,
        fetch_backoff_base_seconds=FETCH_BACKOFF_BASE_SECONDS,
        min_seconds_between_requests=MIN_SECONDS_BETWEEN_REQUESTS,
        sleep_when_all_markets_closed=SLEEP_WHEN_ALL_MARKETS_CLOSED,
        output_dir=OUTPUT_DIR,
        report_every_n_cycles=REPORT_EVERY_N_CYCLES,
        max_risk_mode=False,
    )


_CONFIG_FIELD_BY_GLOBAL = {
    "POSITION_SIZE_PCT": "position_size_pct",
    "MAX_OPEN_POSITIONS": "max_open_positions",
    "MAX_GROSS_EXPOSURE": "max_gross_exposure",
    "STOP_LOSS_PCT": "stop_loss_pct",
    "TAKE_PROFIT_PCT": "take_profit_pct",
    "TRAIL_ATR_MULT": "trail_atr_mult",
    "VOL_CONTRACTION_RATIO": "vol_contraction_ratio",
    "ALLOW_SHORTS": "allow_shorts",
    "ALLOW_PYRAMIDING": "allow_pyramiding",
    "MAX_ADDS_PER_POSITION": "max_adds_per_position",
    "PYRAMID_TRIGGER_PCT": "pyramid_trigger_pct",
    "DAILY_LOSS_LIMIT_PCT": "daily_loss_limit_pct",
    "BREAKOUT_LOOKBACK": "breakout_lookback",
    "VOLUME_LOOKBACK": "volume_lookback",
    "VOLUME_SPIKE_MULT": "volume_spike_mult",
    "USE_TREND_FILTER": "use_trend_filter",
    "TREND_FILTER_PERIOD": "trend_filter_period",
    "ALLOW_FRACTIONAL_EQUITY": "allow_fractional_equity",
    "ATR_PERIOD": "atr_period",
    "MAX_HOLD_BARS": "max_hold_bars",
    "MAINTENANCE_MARGIN_PCT": "maintenance_margin_pct",
    "SLIPPAGE_PCT": "slippage_pct",
    "COMMISSION_PER_TRADE": "commission_per_trade",
}


def apply_max_risk_profile(cfg: Config) -> Config:
    """Overlay MAX_RISK_PROFILE onto cfg. Unknown keys fail loudly."""
    unknown = sorted(set(MAX_RISK_PROFILE) - set(_CONFIG_FIELD_BY_GLOBAL))
    if unknown:
        raise ConfigError(
            "MAX_RISK_PROFILE contains keys that are not tunable config values: "
            + ", ".join(unknown)
        )
    for key, value in MAX_RISK_PROFILE.items():
        setattr(cfg, _CONFIG_FIELD_BY_GLOBAL[key], value)
    cfg.max_risk_mode = True
    return cfg


def _period_to_days(period: str) -> float | None:
    period = period.strip().lower()
    if period == "max":
        return None
    units = {"d": 1, "wk": 7, "mo": 30.44, "y": 365.25}
    for suffix, mult in sorted(units.items(), key=lambda kv: -len(kv[0])):
        if period.endswith(suffix):
            head = period[: -len(suffix)]
            if head.isdigit():
                return int(head) * mult
    raise ConfigError(f"HISTORY_PERIOD={period!r} is not a period yfinance accepts.")


def validate_config(cfg: Config) -> None:
    """Fail loudly on anything that would produce nonsensical trades."""
    errors: list[str] = []
    warnings: list[str] = []

    def check(cond: bool, msg: str) -> None:
        if not cond:
            errors.append(msg)

    check(bool(cfg.universe), "Universe is empty — set EQUITY_UNIVERSE or CRYPTO_UNIVERSE.")
    check(cfg.starting_cash > 0, f"STARTING_CASH must be > 0 (got {cfg.starting_cash}).")

    check(0 < cfg.position_size_pct <= 1.0,
          f"POSITION_SIZE_PCT must be in (0, 1.0]; {cfg.position_size_pct} means "
          f"{cfg.position_size_pct:.0%} of equity in one position.")
    check(cfg.max_open_positions >= 1,
          f"MAX_OPEN_POSITIONS must be >= 1 (got {cfg.max_open_positions}).")
    check(cfg.max_gross_exposure >= 1.0 or cfg.max_gross_exposure > 0,
          f"MAX_GROSS_EXPOSURE must be > 0 (got {cfg.max_gross_exposure}).")
    check(cfg.max_gross_exposure <= 10.0,
          f"MAX_GROSS_EXPOSURE={cfg.max_gross_exposure} exceeds the 10x sanity cap.")
    check(0 < cfg.stop_loss_pct < 1.0,
          f"STOP_LOSS_PCT must be in (0, 1.0); {cfg.stop_loss_pct} is not a survivable stop.")
    check(cfg.take_profit_pct >= 0,
          f"TAKE_PROFIT_PCT must be >= 0 (0 disables it); got {cfg.take_profit_pct}.")
    check(cfg.take_profit_pct == 0 or cfg.take_profit_pct > cfg.stop_loss_pct * 0.5,
          f"TAKE_PROFIT_PCT ({cfg.take_profit_pct}) is tiny relative to STOP_LOSS_PCT "
          f"({cfg.stop_loss_pct}) — every trade would need a >2:1 win rate to break even.")
    check(0 <= cfg.slippage_pct < 0.10,
          f"SLIPPAGE_PCT must be in [0, 0.10); got {cfg.slippage_pct}.")
    check(cfg.commission_per_trade >= 0,
          f"COMMISSION_PER_TRADE must be >= 0 (got {cfg.commission_per_trade}).")
    check(0 < cfg.maintenance_margin_pct < 1.0,
          f"MAINTENANCE_MARGIN_PCT must be in (0, 1.0); got {cfg.maintenance_margin_pct}.")
    check(0 <= cfg.daily_loss_limit_pct < 1.0,
          f"DAILY_LOSS_LIMIT_PCT must be in [0, 1.0); got {cfg.daily_loss_limit_pct}.")

    check(cfg.breakout_lookback >= 2,
          f"BREAKOUT_LOOKBACK must be >= 2 (got {cfg.breakout_lookback}).")
    check(cfg.volume_lookback >= 2,
          f"VOLUME_LOOKBACK must be >= 2 (got {cfg.volume_lookback}).")
    check(cfg.atr_period >= 2, f"ATR_PERIOD must be >= 2 (got {cfg.atr_period}).")
    check(cfg.volume_spike_mult > 0,
          f"VOLUME_SPIKE_MULT must be > 0 (got {cfg.volume_spike_mult}).")
    check(cfg.trail_atr_mult > 0,
          f"TRAIL_ATR_MULT must be > 0 (got {cfg.trail_atr_mult}).")
    check(0 <= cfg.vol_contraction_ratio < 1.0,
          f"VOL_CONTRACTION_RATIO must be in [0, 1.0); got {cfg.vol_contraction_ratio}.")
    check(cfg.max_hold_bars >= 0, "MAX_HOLD_BARS must be >= 0 (0 disables the time stop).")
    if cfg.use_trend_filter:
        check(cfg.trend_filter_period >= 2,
              "TREND_FILTER_PERIOD must be >= 2 when USE_TREND_FILTER is on.")
    if cfg.allow_pyramiding:
        check(cfg.max_adds_per_position >= 1,
              "ALLOW_PYRAMIDING is on but MAX_ADDS_PER_POSITION is 0 — pick one.")
        check(cfg.pyramid_trigger_pct > 0,
              "PYRAMID_TRIGGER_PCT must be > 0 when pyramiding is on.")

    check(cfg.bar_interval in _INTERVAL_SECONDS,
          f"BAR_INTERVAL={cfg.bar_interval!r} is not one of {sorted(_INTERVAL_SECONDS)}.")
    check(cfg.poll_interval_seconds >= 5,
          f"POLL_INTERVAL_SECONDS must be >= 5 (got {cfg.poll_interval_seconds}).")
    check(cfg.fetch_max_retries >= 1, "FETCH_MAX_RETRIES must be >= 1.")
    check(cfg.min_seconds_between_requests >= 0, "MIN_SECONDS_BETWEEN_REQUESTS must be >= 0.")

    if cfg.bar_interval in _INTERVAL_SECONDS:
        try:
            want_days = _period_to_days(cfg.history_period)
        except ConfigError as exc:
            errors.append(str(exc))
            want_days = None
        max_days = _INTERVAL_MAX_DAYS[cfg.bar_interval]
        if want_days is None and max_days < 100_000:
            errors.append(
                f"HISTORY_PERIOD='max' is not available for BAR_INTERVAL="
                f"{cfg.bar_interval!r} (yfinance caps it at {max_days}d)."
            )
        elif want_days is not None and want_days > max_days:
            errors.append(
                f"HISTORY_PERIOD={cfg.history_period!r} (~{want_days:.0f}d) exceeds what "
                f"yfinance serves for BAR_INTERVAL={cfg.bar_interval!r} (max {max_days}d). "
                f"You would silently get an empty frame."
            )
        # Enough bars to even compute the indicators?
        if want_days is not None:
            bars_per_day = 6.5 * 3600 / _INTERVAL_SECONDS[cfg.bar_interval]
            if cfg.bar_interval.endswith(("d", "wk", "mo")):
                bars_per_day = 1 / (_INTERVAL_SECONDS[cfg.bar_interval] / 86_400)
            approx_bars = want_days * min(bars_per_day, 1e6) * 0.7  # weekends/holidays
            if approx_bars < cfg.min_bars_required:
                errors.append(
                    f"HISTORY_PERIOD={cfg.history_period!r} at BAR_INTERVAL="
                    f"{cfg.bar_interval!r} yields roughly {approx_bars:.0f} bars, but the "
                    f"indicators need at least {cfg.min_bars_required}."
                )

    # Sizing coherence.
    max_deployed = cfg.position_size_pct * cfg.max_open_positions
    if max_deployed > cfg.max_gross_exposure + 1e-9:
        warnings.append(
            f"POSITION_SIZE_PCT * MAX_OPEN_POSITIONS = {max_deployed:.2f}x equity, above "
            f"MAX_GROSS_EXPOSURE = {cfg.max_gross_exposure:.2f}x. Exposure will bind first; "
            f"later signals get sized down or rejected."
        )
    if cfg.max_gross_exposure > 1.0:
        implied = cfg.stop_loss_pct * cfg.max_gross_exposure
        warnings.append(
            f"Leverage is ON ({cfg.max_gross_exposure:.1f}x gross). A full-book stop-out is "
            f"about {implied:.0%} of equity, and a gap through the stop can trigger a "
            f"simulated margin call."
        )
    if cfg.position_size_pct > 0.5:
        warnings.append(
            f"POSITION_SIZE_PCT={cfg.position_size_pct:.0%} — a single stop-out costs "
            f"~{cfg.position_size_pct * cfg.stop_loss_pct:.1%} of equity before slippage."
        )
    if cfg.allow_shorts:
        warnings.append(
            "Shorts enabled: simulated losses on a short are unbounded above; the hard stop "
            "is the only thing between this account and a margin call."
        )

    if errors:
        raise ConfigError(
            "Invalid configuration — refusing to start:\n"
            + "\n".join(f"  [{i + 1}] {e}" for i, e in enumerate(errors))
        )
    for w in warnings:
        log.warning("CONFIG: %s", w)


# =============================================================================
#  Market calendar
# =============================================================================

def is_us_equity_open(now_utc: datetime) -> bool:
    et = now_utc.astimezone(NY)
    if et.weekday() >= 5 or et.date() in _US_HOLIDAYS:
        return False
    close = dtime(13, 0) if et.date() in _US_HALF_DAYS else dtime(16, 0)
    return dtime(9, 30) <= et.time() < close


def next_us_equity_open(now_utc: datetime) -> datetime:
    et = now_utc.astimezone(NY)
    for offset in range(0, 10):
        day = (et + timedelta(days=offset)).date()
        if day.weekday() >= 5 or day in _US_HOLIDAYS:
            continue
        open_et = datetime.combine(day, dtime(9, 30), tzinfo=NY)
        if open_et > et:
            return open_et.astimezone(UTC)
    return now_utc + timedelta(hours=12)


def market_is_open(cfg: Config, symbol: str, now_utc: datetime) -> bool:
    return True if cfg.is_crypto(symbol) else is_us_equity_open(now_utc)


# =============================================================================
#  Data feed
# =============================================================================

class DataFeed:
    """yfinance wrapper with client-side rate limiting, backoff, and caching."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._last_request_at = 0.0
        self._cache: dict[str, pd.DataFrame] = {}
        self._cached_at: dict[str, datetime] = {}
        self.consecutive_failures: dict[str, int] = {}

    def _throttle(self) -> None:
        gap = time.monotonic() - self._last_request_at
        if gap < self.cfg.min_seconds_between_requests:
            time.sleep(self.cfg.min_seconds_between_requests - gap)
        self._last_request_at = time.monotonic()

    @staticmethod
    def _looks_like_rate_limit(exc: Exception) -> bool:
        text = f"{type(exc).__name__}: {exc}".lower()
        return any(k in text for k in ("429", "too many requests", "rate limit", "throttl"))

    def fetch(self, symbol: str) -> pd.DataFrame:
        """Return a normalized OHLCV frame. Raises DataUnavailable on failure."""
        last_error: Exception | None = None
        for attempt in range(1, self.cfg.fetch_max_retries + 1):
            try:
                self._throttle()
                raw = yf.Ticker(symbol).history(
                    period=self.cfg.history_period,
                    interval=self.cfg.bar_interval,
                    auto_adjust=True,
                    actions=False,
                    raise_errors=False,
                )
                df = self._normalize(raw)
                if df.empty:
                    raise DataUnavailable(f"{symbol}: yfinance returned no rows")
                self._cache[symbol] = df
                self._cached_at[symbol] = datetime.now(UTC)
                self.consecutive_failures[symbol] = 0
                return df
            except Exception as exc:  # noqa: BLE001 - yfinance raises many types
                last_error = exc
                if attempt >= self.cfg.fetch_max_retries:
                    break
                delay = self.cfg.fetch_backoff_base_seconds * (2 ** (attempt - 1))
                if self._looks_like_rate_limit(exc):
                    delay *= 3
                    log.warning("%s: rate limited, backing off %.1fs", symbol, delay)
                delay += random.uniform(0, 0.5)  # jitter, avoids lockstep retries
                log.debug("%s: fetch attempt %d failed (%s); retrying in %.1fs",
                          symbol, attempt, exc, delay)
                time.sleep(delay)

        self.consecutive_failures[symbol] = self.consecutive_failures.get(symbol, 0) + 1
        raise DataUnavailable(
            f"{symbol}: no data after {self.cfg.fetch_max_retries} attempts "
            f"({type(last_error).__name__}: {last_error})"
        )

    @staticmethod
    def _normalize(raw: Any) -> pd.DataFrame:
        if raw is None or not isinstance(raw, pd.DataFrame) or raw.empty:
            return pd.DataFrame()
        df = raw.copy()
        # Single-ticker history() is flat, but be defensive about MultiIndex columns.
        if isinstance(df.columns, pd.MultiIndex):
            for level in range(df.columns.nlevels):
                names = {str(c).lower() for c in df.columns.get_level_values(level)}
                if {"open", "high", "low", "close"} <= names:
                    df.columns = df.columns.get_level_values(level)
                    break
            else:
                df.columns = df.columns.get_level_values(0)
        df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
        required = ["open", "high", "low", "close"]
        if not all(c in df.columns for c in required):
            return pd.DataFrame()
        if "volume" not in df.columns:
            df["volume"] = np.nan
        df = df[[*required, "volume"]]

        idx = pd.to_datetime(df.index, utc=True, errors="coerce")
        df.index = idx
        df = df[~df.index.isna()]
        df = df[~df.index.duplicated(keep="last")].sort_index()

        df = df.astype({c: "float64" for c in df.columns})
        df = df.dropna(subset=required)
        df = df[(df[required] > 0).all(axis=1)]
        df["volume"] = df["volume"].fillna(0.0).clip(lower=0.0)
        return df

    def cached_age_minutes(self, symbol: str) -> float | None:
        ts = self._cached_at.get(symbol)
        return None if ts is None else (datetime.now(UTC) - ts).total_seconds() / 60


def drop_partial_bar(df: pd.DataFrame, cfg: Config, now_utc: datetime) -> pd.DataFrame:
    """Drop the still-forming final bar so signals only fire on closed bars."""
    if cfg.use_last_partial_bar or df.empty:
        return df
    bar_seconds = _INTERVAL_SECONDS[cfg.bar_interval]
    last_ts = df.index[-1].to_pydatetime()
    if last_ts.tzinfo is None:
        last_ts = last_ts.replace(tzinfo=UTC)
    if last_ts + timedelta(seconds=bar_seconds) > now_utc:
        return df.iloc[:-1]
    return df


# =============================================================================
#  Indicators (all causal — no lookahead)
# =============================================================================

def compute_indicators(df: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    out = df.copy()
    high, low, close, volume = out["high"], out["low"], out["close"], out["volume"]

    prev_close = close.shift(1)
    true_range = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    # Wilder smoothing.
    out["atr"] = true_range.ewm(alpha=1.0 / cfg.atr_period, adjust=False,
                                min_periods=cfg.atr_period).mean()

    # `.shift(1)` keeps the current bar out of its own breakout window.
    out["donchian_high"] = high.rolling(cfg.breakout_lookback).max().shift(1)
    out["donchian_low"] = low.rolling(cfg.breakout_lookback).min().shift(1)
    out["vol_avg"] = volume.rolling(cfg.volume_lookback).mean().shift(1)
    period = cfg.trend_filter_period if cfg.use_trend_filter else 2
    out["sma_trend"] = close.rolling(max(period, 2)).mean()
    return out


def _finite(value: Any) -> bool:
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


# =============================================================================
#  Portfolio
# =============================================================================

@dataclass
class Position:
    symbol: str
    direction: int          # +1 long, -1 short
    qty: float
    avg_entry: float        # average FILL price (slippage already included)
    avg_entry_ref: float    # average price before slippage, for measuring friction
    entry_time: datetime
    entry_atr: float
    peak_price: float       # best price seen since entry (favorable extreme)
    trail_stop: float
    hard_stop: float
    take_profit: float | None
    adds: int = 0
    bars_held: int = 0
    last_add_price: float = 0.0
    commissions_paid: float = 0.0

    @property
    def side(self) -> str:
        return "LONG" if self.direction > 0 else "SHORT"

    def market_value(self, price: float) -> float:
        return self.direction * self.qty * price

    def unrealized(self, price: float) -> float:
        return self.direction * self.qty * (price - self.avg_entry)

    def unrealized_pct(self, price: float) -> float:
        if self.avg_entry <= 0:
            return 0.0
        return self.direction * (price - self.avg_entry) / self.avg_entry

    def effective_stop(self) -> float:
        """The stop actually in force: the tighter of hard stop and trailing stop."""
        if self.direction > 0:
            return max(self.hard_stop, self.trail_stop)
        return min(self.hard_stop, self.trail_stop)


@dataclass
class Fill:
    timestamp: datetime
    symbol: str
    action: str             # BUY / SELL / SHORT / COVER
    side: str               # LONG / SHORT
    qty: float
    ref_price: float        # price before slippage
    fill_price: float       # price after slippage
    slippage_cost: float
    commission: float
    notional: float
    cash_after: float
    equity_after: float
    realized_pnl: float
    reason: str
    note: str = ""


@dataclass
class ClosedTrade:
    symbol: str
    side: str
    qty: float
    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    gross_pnl: float
    fees: float
    net_pnl: float
    return_pct: float
    hold_minutes: float
    exit_reason: str


class Portfolio:
    """Cash + positions with hard guarantees: equity never goes negative."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.cash = cfg.starting_cash
        self.starting_cash = cfg.starting_cash
        self.positions: dict[str, Position] = {}
        self.fills: list[Fill] = []
        self.closed_trades: list[ClosedTrade] = []
        self.equity_curve: list[tuple[datetime, float]] = []
        self.rejections: list[tuple[datetime, str, str]] = []
        self.blown_up = False
        self.halted_reason: str | None = None
        self.day_anchor_date: date | None = None
        self.day_anchor_equity: float = cfg.starting_cash
        self._last_prices: dict[str, float] = {}

    # -- valuation -------------------------------------------------------------
    def mark_prices(self, prices: dict[str, float]) -> None:
        for sym, px in prices.items():
            if _finite(px) and px > 0:
                self._last_prices[sym] = float(px)

    def price_of(self, symbol: str) -> float:
        return self._last_prices.get(symbol, 0.0)

    def positions_value(self) -> float:
        return sum(p.market_value(self.price_of(p.symbol)) for p in self.positions.values())

    def gross_exposure(self) -> float:
        return sum(abs(p.qty) * self.price_of(p.symbol) for p in self.positions.values())

    def equity(self) -> float:
        return self.cash + self.positions_value()

    def unrealized_pnl(self) -> float:
        return sum(p.unrealized(self.price_of(p.symbol)) for p in self.positions.values())

    def realized_pnl(self) -> float:
        return sum(t.net_pnl for t in self.closed_trades)

    def buying_power(self) -> float:
        """Notional still available before hitting MAX_GROSS_EXPOSURE."""
        room = self.cfg.max_gross_exposure * self.equity() - self.gross_exposure()
        if self.cfg.max_gross_exposure <= 1.0:
            # Cash-only mode: cash is the binding constraint and must never go < 0.
            room = min(room, self.cash)
        return max(room, 0.0)

    # -- bookkeeping -----------------------------------------------------------
    def record_equity(self, ts: datetime) -> None:
        eq = max(self.equity(), 0.0)
        self.equity_curve.append((ts, eq))
        if self.day_anchor_date != ts.date():
            self.day_anchor_date = ts.date()
            self.day_anchor_equity = eq

    def reject(self, ts: datetime, symbol: str, why: str) -> None:
        self.rejections.append((ts, symbol, why))
        log.info("REJECT %-9s %s", symbol, why)

    def daily_drawdown(self) -> float:
        if self.day_anchor_equity <= 0:
            return 0.0
        return max(0.0, (self.day_anchor_equity - self.equity()) / self.day_anchor_equity)

    # -- execution -------------------------------------------------------------
    def _slipped(self, price: float, direction_of_trade: int) -> float:
        """Slippage always works against the trade: buys fill higher, sells lower."""
        return price * (1.0 + direction_of_trade * self.cfg.slippage_pct)

    def _round_qty(self, symbol: str, qty: float) -> float:
        if self.cfg.is_crypto(symbol) or self.cfg.allow_fractional_equity:
            return math.floor(qty * 1e6) / 1e6
        return float(math.floor(qty))

    def open_position(self, ts: datetime, symbol: str, direction: int, price: float,
                      atr: float, reason: str) -> Position | None:
        cfg = self.cfg
        equity = self.equity()
        if equity <= 0:
            self.reject(ts, symbol, "equity is zero — account is done")
            return None

        target_notional = cfg.position_size_pct * equity
        room = self.buying_power()
        if room <= 0:
            self.reject(ts, symbol, f"no buying power left (gross "
                                    f"{self.gross_exposure():,.0f} / cap "
                                    f"{cfg.max_gross_exposure * equity:,.0f})")
            return None

        notional = min(target_notional, room)
        if notional < target_notional - 1e-9:
            log.info("SIZE-DOWN %-9s target $%.2f -> $%.2f (exposure cap)",
                     symbol, target_notional, notional)

        fill_price = self._slipped(price, direction)
        if fill_price <= 0:
            self.reject(ts, symbol, "non-positive fill price")
            return None

        qty = self._round_qty(symbol, notional / fill_price)
        cost = qty * fill_price
        commission = cfg.commission_per_trade if qty > 0 else 0.0

        # Cash-only longs may never overdraw the account.
        if cfg.max_gross_exposure <= 1.0 and direction > 0:
            while qty > 0 and cost + commission > self.cash:
                qty = self._round_qty(symbol, max(self.cash - commission, 0.0) / fill_price)
                cost = qty * fill_price
                if qty <= 0:
                    break

        if qty <= 0:
            self.reject(ts, symbol,
                        f"sized to zero — ${notional:,.2f} available vs ${fill_price:,.2f}/unit"
                        + ("" if (cfg.is_crypto(symbol) or cfg.allow_fractional_equity)
                           else " (whole shares only)"))
            return None
        if commission >= abs(cost):
            self.reject(ts, symbol, f"commission ${commission:.2f} >= trade value ${cost:.2f}")
            return None

        self.cash -= direction * cost
        self.cash -= commission
        slippage_cost = qty * abs(fill_price - price)

        hard_stop = fill_price * (1 - direction * cfg.stop_loss_pct)
        trail_stop = (fill_price - direction * cfg.trail_atr_mult * atr) if _finite(atr) and atr > 0 else hard_stop
        take_profit = (fill_price * (1 + direction * cfg.take_profit_pct)
                       if cfg.take_profit_pct > 0 else None)

        pos = Position(
            symbol=symbol, direction=direction, qty=qty, avg_entry=fill_price,
            avg_entry_ref=price,
            entry_time=ts, entry_atr=float(atr) if _finite(atr) else 0.0,
            peak_price=fill_price,
            trail_stop=trail_stop, hard_stop=hard_stop, take_profit=take_profit,
            last_add_price=fill_price, commissions_paid=commission,
        )
        self.positions[symbol] = pos
        self.mark_prices({symbol: price})

        self._log_fill(ts, symbol, "BUY" if direction > 0 else "SHORT", pos.side, qty,
                       price, fill_price, slippage_cost, commission, cost, 0.0, reason)
        log.info("OPEN  %-9s %-5s qty=%.6f @ %.4f  stop=%.4f  tp=%s  [%s]",
                 symbol, pos.side, qty, fill_price, pos.effective_stop(),
                 f"{take_profit:.4f}" if take_profit else "none", reason)
        return pos

    def add_to_position(self, ts: datetime, pos: Position, price: float, reason: str) -> None:
        cfg = self.cfg
        equity = self.equity()
        add_notional = min(cfg.position_size_pct * equity * 0.5, self.buying_power())
        if add_notional <= 0:
            self.reject(ts, pos.symbol, "pyramid add blocked — no buying power")
            return
        fill_price = self._slipped(price, pos.direction)
        qty = self._round_qty(pos.symbol, add_notional / fill_price)
        cost = qty * fill_price
        commission = cfg.commission_per_trade if qty > 0 else 0.0
        if cfg.max_gross_exposure <= 1.0 and pos.direction > 0 and cost + commission > self.cash:
            qty = self._round_qty(pos.symbol, max(self.cash - commission, 0.0) / fill_price)
            cost = qty * fill_price
        if qty <= 0:
            self.reject(ts, pos.symbol, "pyramid add sized to zero")
            return

        self.cash -= pos.direction * cost
        self.cash -= commission
        slippage_cost = qty * abs(fill_price - price)

        total_qty = pos.qty + qty
        pos.avg_entry = (pos.avg_entry * pos.qty + fill_price * qty) / total_qty
        pos.avg_entry_ref = (pos.avg_entry_ref * pos.qty + price * qty) / total_qty
        pos.qty = total_qty
        pos.adds += 1
        pos.last_add_price = fill_price
        pos.commissions_paid += commission
        # Re-anchor the hard stop to the new average entry.
        pos.hard_stop = pos.avg_entry * (1 - pos.direction * cfg.stop_loss_pct)
        if cfg.take_profit_pct > 0:
            pos.take_profit = pos.avg_entry * (1 + pos.direction * cfg.take_profit_pct)

        self._log_fill(ts, pos.symbol, "BUY" if pos.direction > 0 else "SHORT", pos.side,
                       qty, price, fill_price, slippage_cost, commission, cost, 0.0, reason)
        log.info("ADD   %-9s %-5s +%.6f @ %.4f (add #%d, avg=%.4f) [%s]",
                 pos.symbol, pos.side, qty, fill_price, pos.adds, pos.avg_entry, reason)

    def close_position(self, ts: datetime, symbol: str, price: float, reason: str) -> None:
        pos = self.positions.get(symbol)
        if pos is None:
            return
        cfg = self.cfg
        exit_direction = -pos.direction
        fill_price = self._slipped(price, exit_direction)
        proceeds = pos.qty * fill_price
        commission = cfg.commission_per_trade
        slippage_cost = pos.qty * abs(fill_price - price)

        self.cash += pos.direction * proceeds
        self.cash -= commission

        # net_pnl is the real cash-based result: both fill prices already carry
        # slippage, so only commissions are subtracted on top. gross_pnl is the
        # frictionless counterfactual, and the gap between them is total cost.
        net_pnl = (pos.direction * pos.qty * (fill_price - pos.avg_entry)
                   - pos.commissions_paid - commission)
        gross_pnl = pos.direction * pos.qty * (price - pos.avg_entry_ref)
        fees = gross_pnl - net_pnl
        basis = pos.avg_entry * pos.qty
        del self.positions[symbol]

        trade = ClosedTrade(
            symbol=symbol, side=pos.side, qty=pos.qty,
            entry_time=pos.entry_time, exit_time=ts,
            entry_price=pos.avg_entry, exit_price=fill_price,
            gross_pnl=gross_pnl, fees=fees, net_pnl=net_pnl,
            return_pct=(net_pnl / basis) if basis > 0 else 0.0,
            hold_minutes=(ts - pos.entry_time).total_seconds() / 60,
            exit_reason=reason,
        )
        self.closed_trades.append(trade)
        self._log_fill(ts, symbol, "SELL" if pos.direction > 0 else "COVER", pos.side,
                       pos.qty, price, fill_price, slippage_cost, commission,
                       proceeds, net_pnl, reason)
        log.info("CLOSE %-9s %-5s qty=%.6f @ %.4f  pnl=%+.2f (%+.2f%%)  [%s]",
                 symbol, pos.side, pos.qty, fill_price, net_pnl,
                 trade.return_pct * 100, reason)

    def liquidate_all(self, ts: datetime, reason: str) -> None:
        for symbol in list(self.positions):
            price = self.price_of(symbol)
            if price > 0:
                self.close_position(ts, symbol, price, reason)

    def enforce_solvency(self, ts: datetime) -> None:
        """Margin call + hard floor. The simulated balance can never go negative."""
        if not self.positions:
            if self.cash < 0:
                # Only reachable if leverage was on and everything was closed at a loss.
                log.critical("ACCOUNT WIPED OUT — cash %.2f clamped to 0", self.cash)
                self.cash = 0.0
                self.blown_up = True
                self.halted_reason = "account wiped out"
            return

        equity, gross = self.equity(), self.gross_exposure()
        if equity <= 0:
            log.critical("MARGIN CALL — equity %.2f <= 0; liquidating everything", equity)
            self.liquidate_all(ts, "margin_call_wipeout")
            self.cash = max(self.cash, 0.0)
            self.blown_up = True
            self.halted_reason = "margin call wiped the account"
            return

        if gross > 0 and equity < self.cfg.maintenance_margin_pct * gross:
            log.critical("MARGIN CALL — equity %.2f < %.0f%% of gross %.2f; liquidating",
                         equity, self.cfg.maintenance_margin_pct * 100, gross)
            self.liquidate_all(ts, "margin_call")
            self.cash = max(self.cash, 0.0)
            if self.equity() <= 0:
                self.blown_up = True
                self.halted_reason = "margin call wiped the account"

    def _log_fill(self, ts, symbol, action, side, qty, ref_price, fill_price,
                  slippage_cost, commission, notional, realized_pnl, reason) -> None:
        self.fills.append(Fill(
            timestamp=ts, symbol=symbol, action=action, side=side, qty=qty,
            ref_price=ref_price, fill_price=fill_price, slippage_cost=slippage_cost,
            commission=commission, notional=notional, cash_after=self.cash,
            equity_after=self.equity(), realized_pnl=realized_pnl, reason=reason,
        ))


# =============================================================================
#  Strategy
# =============================================================================

@dataclass
class Signal:
    action: str             # "enter" | "exit" | "add" | "none"
    direction: int = 0
    reason: str = ""
    fill_price: float | None = None   # None => fill at bar close


class BreakoutStrategy:
    """Volatility-breakout momentum: enter on an N-bar range break confirmed by a
    volume spike; exit on a trailing ATR stop, hard stop, target, or vol collapse.

    This is a well-known, heavily-arbitraged pattern. It is implemented here to
    be studied, not because it is expected to be profitable after costs.
    """

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def entry_signal(self, row: pd.Series) -> Signal:
        cfg = self.cfg
        close, volume = float(row["close"]), float(row["volume"])
        needed = ("donchian_high", "donchian_low", "vol_avg", "atr")
        if not all(_finite(row.get(k)) for k in needed):
            return Signal("none", reason="indicators not warmed up")
        if float(row["atr"]) <= 0:
            return Signal("none", reason="zero ATR")

        vol_avg = float(row["vol_avg"])
        # Some feeds return 0 volume for a symbol; don't let that gate every entry.
        volume_ok = vol_avg <= 0 or volume > cfg.volume_spike_mult * vol_avg
        sma = float(row["sma_trend"]) if _finite(row.get("sma_trend")) else close

        if close > float(row["donchian_high"]) and volume_ok:
            if not cfg.use_trend_filter or close > sma:
                return Signal("enter", 1, reason=(
                    f"{cfg.breakout_lookback}-bar high break @ {close:.4f} "
                    f"(> {float(row['donchian_high']):.4f}), vol "
                    f"{volume / vol_avg:.1f}x avg" if vol_avg > 0 else
                    f"{cfg.breakout_lookback}-bar high break @ {close:.4f}"))
            return Signal("none", reason="breakout below trend filter")

        if cfg.allow_shorts and close < float(row["donchian_low"]) and volume_ok:
            if not cfg.use_trend_filter or close < sma:
                return Signal("enter", -1, reason=(
                    f"{cfg.breakout_lookback}-bar low break @ {close:.4f} "
                    f"(< {float(row['donchian_low']):.4f})"))
        return Signal("none", reason="no breakout")

    def update_trailing_stop(self, pos: Position, row: pd.Series) -> None:
        """Ratchet the trailing stop; it may only ever move in your favor."""
        atr = float(row["atr"]) if _finite(row.get("atr")) else pos.entry_atr
        if pos.direction > 0:
            pos.peak_price = max(pos.peak_price, float(row["high"]))
            if atr > 0:
                pos.trail_stop = max(pos.trail_stop,
                                     pos.peak_price - self.cfg.trail_atr_mult * atr)
        else:
            pos.peak_price = min(pos.peak_price, float(row["low"]))
            if atr > 0:
                pos.trail_stop = min(pos.trail_stop,
                                     pos.peak_price + self.cfg.trail_atr_mult * atr)

    def exit_signal(self, pos: Position, row: pd.Series) -> Signal:
        """Check exits against the bar's range, not just its close.

        When an intrabar level is breached we fill at the level itself — unless
        the bar gapped past it, in which case we fill at the open. That is the
        pessimistic assumption, which is the right one for a simulator.
        """
        cfg = self.cfg
        o, h, l, c = (float(row["open"]), float(row["high"]),
                      float(row["low"]), float(row["close"]))
        stop = pos.effective_stop()

        if pos.direction > 0:
            if l <= stop:
                return Signal("exit", reason="stop_loss", fill_price=min(stop, o))
            if pos.take_profit is not None and h >= pos.take_profit:
                return Signal("exit", reason="take_profit",
                              fill_price=max(pos.take_profit, o) if o > pos.take_profit
                              else pos.take_profit)
        else:
            if h >= stop:
                return Signal("exit", reason="stop_loss", fill_price=max(stop, o))
            if pos.take_profit is not None and l <= pos.take_profit:
                return Signal("exit", reason="take_profit",
                              fill_price=min(pos.take_profit, o) if o < pos.take_profit
                              else pos.take_profit)

        if cfg.vol_contraction_ratio > 0 and pos.entry_atr > 0 and _finite(row.get("atr")):
            if float(row["atr"]) < cfg.vol_contraction_ratio * pos.entry_atr:
                return Signal("exit", reason="vol_contraction", fill_price=c)

        if cfg.max_hold_bars > 0 and pos.bars_held >= cfg.max_hold_bars:
            return Signal("exit", reason="time_stop", fill_price=c)

        if (cfg.allow_pyramiding and pos.adds < cfg.max_adds_per_position
                and pos.last_add_price > 0):
            move = pos.direction * (c - pos.last_add_price) / pos.last_add_price
            if move >= cfg.pyramid_trigger_pct:
                return Signal("add", pos.direction,
                              reason=f"pyramid +{move:.1%} since last entry", fill_price=c)

        return Signal("none")


# =============================================================================
#  Performance reporting
# =============================================================================

def compute_metrics(pf: Portfolio) -> dict[str, Any]:
    equity = pf.equity()
    trades = pf.closed_trades
    wins = [t for t in trades if t.net_pnl > 0]
    losses = [t for t in trades if t.net_pnl <= 0]

    curve = pd.Series(
        [e for _, e in pf.equity_curve],
        index=pd.to_datetime([t for t, _ in pf.equity_curve], utc=True),
    ) if pf.equity_curve else pd.Series(dtype="float64")

    max_dd, dd_peak_at, dd_trough_at = 0.0, None, None
    if len(curve) > 1:
        running_max = curve.cummax()
        drawdowns = (curve - running_max) / running_max.replace(0, np.nan)
        max_dd = float(-drawdowns.min()) if drawdowns.notna().any() else 0.0
        if drawdowns.notna().any():
            dd_trough_at = drawdowns.idxmin()
            dd_peak_at = running_max.loc[:dd_trough_at].idxmax()

    sharpe: float | None = None
    daily_points = 0
    if len(curve) > 1:
        daily = curve.resample("1D").last().dropna()
        rets = daily.pct_change().dropna()
        daily_points = len(rets)
        if daily_points >= 2 and float(rets.std()) > 0:
            sharpe = float(rets.mean() / rets.std() * math.sqrt(252))

    gross_win = sum(t.net_pnl for t in wins)
    gross_loss = abs(sum(t.net_pnl for t in losses))
    max_consec_losses, streak = 0, 0
    for t in trades:
        streak = streak + 1 if t.net_pnl <= 0 else 0
        max_consec_losses = max(max_consec_losses, streak)

    return {
        "starting_cash": pf.starting_cash,
        "final_equity": equity,
        "final_cash": pf.cash,
        "open_positions": len(pf.positions),
        "total_return_pct": (equity / pf.starting_cash - 1) * 100 if pf.starting_cash else 0.0,
        "realized_pnl": pf.realized_pnl(),
        "unrealized_pnl": pf.unrealized_pnl(),
        "max_drawdown_pct": max_dd * 100,
        "drawdown_peak_at": dd_peak_at,
        "drawdown_trough_at": dd_trough_at,
        "sharpe": sharpe,
        "sharpe_daily_points": daily_points,
        "num_trades": len(trades),
        "num_wins": len(wins),
        "num_losses": len(losses),
        "win_rate_pct": (len(wins) / len(trades) * 100) if trades else 0.0,
        "avg_win": (gross_win / len(wins)) if wins else 0.0,
        "avg_loss": (-gross_loss / len(losses)) if losses else 0.0,
        "largest_win": max((t.net_pnl for t in trades), default=0.0),
        "largest_loss": min((t.net_pnl for t in trades), default=0.0),
        "profit_factor": (gross_win / gross_loss) if gross_loss > 0
                         else (float("inf") if gross_win > 0 else 0.0),
        "expectancy": (sum(t.net_pnl for t in trades) / len(trades)) if trades else 0.0,
        "max_consecutive_losses": max_consec_losses,
        "total_fees": sum(t.fees for t in trades),
        "avg_hold_minutes": (sum(t.hold_minutes for t in trades) / len(trades)) if trades else 0.0,
        "rejections": len(pf.rejections),
        "blown_up": pf.blown_up,
    }


def _fmt(value: Any, spec: str = "", dash: str = "n/a") -> str:
    if value is None:
        return dash
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value > 0 else "-inf"
    return format(value, spec) if spec else str(value)


def _table(title: str, rows: Sequence[tuple[str, str]], width: int = 66) -> str:
    lines = ["", "=" * width, f" {title}", "=" * width]
    for label, value in rows:
        lines.append(f" {label:<34}{value:>{width - 36}}")
    lines.append("=" * width)
    return "\n".join(lines)


def render_summary(pf: Portfolio, cfg: Config, m: dict[str, Any]) -> str:
    mode = "MAX-RISK (leveraged)" if cfg.max_risk_mode else "standard"
    out = [_table(f"PAPER TRADING SUMMARY — {mode}", [
        ("Starting cash", f"${m['starting_cash']:,.2f}"),
        ("Final equity", f"${m['final_equity']:,.2f}"),
        ("  cash", f"${m['final_cash']:,.2f}"),
        ("  open positions", str(m["open_positions"])),
        ("Total return", f"{m['total_return_pct']:+.2f}%"),
        ("Realized P&L", f"${m['realized_pnl']:+,.2f}"),
        ("Unrealized P&L", f"${m['unrealized_pnl']:+,.2f}"),
        ("Max drawdown", f"{m['max_drawdown_pct']:.2f}%"),
        ("Sharpe (daily, annualized)",
         _fmt(m["sharpe"], ".2f", f"n/a ({m['sharpe_daily_points']} daily pts)")),
    ])]

    out.append(_table("TRADE STATISTICS", [
        ("Closed trades", str(m["num_trades"])),
        ("Win rate", f"{m['win_rate_pct']:.1f}%  ({m['num_wins']}W / {m['num_losses']}L)"),
        ("Average win", f"${m['avg_win']:+,.2f}"),
        ("Average loss", f"${m['avg_loss']:+,.2f}"),
        ("Largest win / loss",
         f"${m['largest_win']:+,.2f} / ${m['largest_loss']:+,.2f}"),
        ("Profit factor", _fmt(m["profit_factor"], ".2f")),
        ("Expectancy per trade", f"${m['expectancy']:+,.2f}"),
        ("Max consecutive losses", str(m["max_consecutive_losses"])),
        ("Fees + slippage paid", f"${m['total_fees']:,.2f}"),
        ("Average hold", f"{m['avg_hold_minutes']:.0f} min"),
        ("Orders rejected / resized", str(m["rejections"])),
    ]))

    if pf.positions:
        rows = []
        for p in pf.positions.values():
            px = pf.price_of(p.symbol)
            rows.append((f"{p.symbol} {p.side} {p.qty:.4f} @ {p.avg_entry:.2f}",
                         f"{p.unrealized(px):+,.2f} ({p.unrealized_pct(px):+.2%})"))
        out.append(_table("OPEN POSITIONS (marked to last price)", rows))

    if m["blown_up"]:
        out.append("\n  *** SIMULATED ACCOUNT WIPED OUT — margin call liquidated the book. ***")
    out.append(
        "\n  Reminder: real prices, fake money. Past simulated results say nothing about\n"
        "  future live results, and this strategy is not claimed to be profitable.\n"
    )
    return "\n".join(out)


def write_reports(pf: Portfolio, cfg: Config, m: dict[str, Any], run_dir: str) -> list[str]:
    os.makedirs(run_dir, exist_ok=True)
    written: list[str] = []

    trades_csv = os.path.join(run_dir, "trades.csv")
    with open(trades_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["symbol", "side", "qty", "entry_time", "exit_time", "entry_price",
                    "exit_price", "gross_pnl", "fees", "net_pnl", "return_pct",
                    "hold_minutes", "exit_reason"])
        for t in pf.closed_trades:
            w.writerow([t.symbol, t.side, f"{t.qty:.8f}", t.entry_time.isoformat(),
                        t.exit_time.isoformat(), f"{t.entry_price:.6f}",
                        f"{t.exit_price:.6f}", f"{t.gross_pnl:.4f}", f"{t.fees:.4f}",
                        f"{t.net_pnl:.4f}", f"{t.return_pct:.6f}",
                        f"{t.hold_minutes:.2f}", t.exit_reason])
    written.append(trades_csv)

    fills_csv = os.path.join(run_dir, "fills.csv")
    with open(fills_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "symbol", "action", "side", "qty", "ref_price",
                    "fill_price", "slippage_cost", "commission", "notional",
                    "cash_after", "equity_after", "realized_pnl", "reason"])
        for f in pf.fills:
            w.writerow([f.timestamp.isoformat(), f.symbol, f.action, f.side,
                        f"{f.qty:.8f}", f"{f.ref_price:.6f}", f"{f.fill_price:.6f}",
                        f"{f.slippage_cost:.4f}", f"{f.commission:.2f}",
                        f"{f.notional:.4f}", f"{f.cash_after:.4f}",
                        f"{f.equity_after:.4f}", f"{f.realized_pnl:.4f}", f.reason])
    written.append(fills_csv)

    equity_csv = os.path.join(run_dir, "equity_curve.csv")
    with open(equity_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "equity"])
        for ts, eq in pf.equity_curve:
            w.writerow([ts.isoformat(), f"{eq:.4f}"])
    written.append(equity_csv)

    summary_json = os.path.join(run_dir, "summary.json")
    payload = {
        "disclaimer": DISCLAIMER,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "max_risk" if cfg.max_risk_mode else "standard",
        "config": {k: v for k, v in asdict(cfg).items()},
        "metrics": {k: (v.isoformat() if isinstance(v, (pd.Timestamp, datetime)) else v)
                    for k, v in m.items()},
        "trades": [
            {**asdict(t),
             "entry_time": t.entry_time.isoformat(),
             "exit_time": t.exit_time.isoformat()}
            for t in pf.closed_trades
        ],
        "open_positions": [
            {**asdict(p), "entry_time": p.entry_time.isoformat(),
             "last_price": pf.price_of(p.symbol),
             "unrealized_pnl": p.unrealized(pf.price_of(p.symbol))}
            for p in pf.positions.values()
        ],
        "rejections": [{"timestamp": ts.isoformat(), "symbol": sym, "reason": why}
                       for ts, sym, why in pf.rejections],
    }
    with open(summary_json, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, default=str)
    written.append(summary_json)
    return written


# =============================================================================
#  Engine
# =============================================================================

class Engine:
    def __init__(self, cfg: Config, run_dir: str) -> None:
        self.cfg = cfg
        self.run_dir = run_dir
        self.feed = DataFeed(cfg)
        self.strategy = BreakoutStrategy(cfg)
        self.portfolio = Portfolio(cfg)
        self.stop_requested = False
        self.report_requested = False
        self.cycle = 0
        self._last_bar_seen: dict[str, pd.Timestamp] = {}

    # -- one live cycle --------------------------------------------------------
    def run_cycle(self, now_utc: datetime | None = None) -> None:
        cfg = self.cfg
        pf = self.portfolio
        now_utc = now_utc or datetime.now(UTC)
        self.cycle += 1
        log.info("--- cycle %d @ %s UTC ---", self.cycle, now_utc.strftime("%Y-%m-%d %H:%M:%S"))

        frames: dict[str, pd.DataFrame] = {}
        for symbol in cfg.universe:
            if not market_is_open(cfg, symbol, now_utc) and symbol not in pf.positions:
                log.debug("%s: market closed, skipping", symbol)
                continue
            try:
                raw = self.feed.fetch(symbol)
            except DataUnavailable as exc:
                log.warning("DATA %s — skipping this symbol for this cycle", exc)
                continue
            df = drop_partial_bar(raw, cfg, now_utc)
            if len(df) < cfg.min_bars_required:
                log.warning("%s: only %d closed bars, need %d — skipping",
                            symbol, len(df), cfg.min_bars_required)
                continue
            last_ts = df.index[-1]
            age_min = (now_utc - last_ts.to_pydatetime()).total_seconds() / 60
            if age_min > cfg.max_data_staleness_minutes and market_is_open(cfg, symbol, now_utc):
                log.warning("%s: newest bar is %.0f min old (limit %d) — stale, skipping",
                            symbol, age_min, cfg.max_data_staleness_minutes)
                continue
            frames[symbol] = compute_indicators(df, cfg)

        if not frames:
            log.warning("No usable data this cycle — nothing evaluated.")
            return

        prices = {s: float(f["close"].iloc[-1]) for s, f in frames.items()}
        pf.mark_prices(prices)
        self.process_bar(now_utc, {s: f.iloc[-1] for s, f in frames.items()},
                         new_bar={s: self._is_new_bar(s, f.index[-1]) for s, f in frames.items()})
        pf.record_equity(now_utc)

        log.info("EQUITY $%.2f | cash $%.2f | gross $%.2f (%.2fx) | open %d | trades %d",
                 pf.equity(), pf.cash, pf.gross_exposure(),
                 pf.gross_exposure() / pf.equity() if pf.equity() > 0 else 0.0,
                 len(pf.positions), len(pf.closed_trades))

        if cfg.report_every_n_cycles and self.cycle % cfg.report_every_n_cycles == 0:
            self.report_requested = True

    def _is_new_bar(self, symbol: str, ts: pd.Timestamp) -> bool:
        previous = self._last_bar_seen.get(symbol)
        self._last_bar_seen[symbol] = ts
        return previous is None or ts > previous

    # -- shared bar handling (live + replay) -----------------------------------
    def process_bar(self, ts: datetime, rows: dict[str, pd.Series],
                    new_bar: dict[str, bool] | None = None) -> None:
        cfg, pf = self.cfg, self.portfolio
        new_bar = new_bar or {s: True for s in rows}

        # 1) Manage open positions first — exits free up capital for entries.
        for symbol in list(pf.positions):
            row = rows.get(symbol)
            if row is None:
                continue
            pos = pf.positions[symbol]
            if new_bar.get(symbol, True):
                pos.bars_held += 1
            self.strategy.update_trailing_stop(pos, row)
            sig = self.strategy.exit_signal(pos, row)
            if sig.action == "exit":
                pf.close_position(ts, symbol, sig.fill_price or float(row["close"]), sig.reason)
            elif sig.action == "add" and new_bar.get(symbol, True):
                pf.add_to_position(ts, pos, sig.fill_price or float(row["close"]), sig.reason)

        pf.enforce_solvency(ts)
        if pf.blown_up:
            self.stop_requested = True
            return

        # 2) Circuit breaker.
        if cfg.daily_loss_limit_pct > 0:
            dd = pf.daily_drawdown()
            if dd >= cfg.daily_loss_limit_pct:
                if pf.halted_reason is None:
                    log.error("DAILY LOSS LIMIT hit (%.1f%% >= %.1f%%) — no new entries today",
                              dd * 100, cfg.daily_loss_limit_pct * 100)
                pf.halted_reason = f"daily loss limit ({dd:.1%})"
                return
            if pf.halted_reason and pf.halted_reason.startswith("daily loss"):
                pf.halted_reason = None

        # 3) Candidate entries, strongest breakout first.
        candidates: list[tuple[float, str, Signal, pd.Series]] = []
        for symbol, row in rows.items():
            if symbol in pf.positions or not new_bar.get(symbol, True):
                continue
            sig = self.strategy.entry_signal(row)
            if sig.action != "enter":
                continue
            atr = float(row["atr"])
            close = float(row["close"])
            ref = float(row["donchian_high"]) if sig.direction > 0 else float(row["donchian_low"])
            strength = abs(close - ref) / atr if atr > 0 else 0.0
            candidates.append((strength, symbol, sig, row))

        for _, symbol, sig, row in sorted(candidates, key=lambda c: -c[0]):
            if len(pf.positions) >= cfg.max_open_positions:
                pf.reject(ts, symbol, f"at MAX_OPEN_POSITIONS ({cfg.max_open_positions})")
                continue
            pf.open_position(ts, symbol, sig.direction, float(row["close"]),
                             float(row["atr"]), sig.reason)

        pf.enforce_solvency(ts)
        if pf.blown_up:
            self.stop_requested = True

    # -- replay over the fetched history ---------------------------------------
    def run_replay(self) -> None:
        cfg, pf = self.cfg, self.portfolio
        log.info("REPLAY: walking %s of real %s bars, bar by bar (no live loop).",
                 cfg.history_period, cfg.bar_interval)
        frames: dict[str, pd.DataFrame] = {}
        for symbol in cfg.universe:
            try:
                df = self.feed.fetch(symbol)
            except DataUnavailable as exc:
                log.warning("DATA %s — excluded from replay", exc)
                continue
            df = drop_partial_bar(df, cfg, datetime.now(UTC))
            if len(df) < cfg.min_bars_required:
                log.warning("%s: %d bars < %d required — excluded from replay",
                            symbol, len(df), cfg.min_bars_required)
                continue
            frames[symbol] = compute_indicators(df, cfg)
            log.info("%s: %d bars (%s -> %s)", symbol, len(df),
                     df.index[0].date(), df.index[-1].date())

        if not frames:
            log.error("Replay aborted: no symbol returned usable data.")
            return

        timeline = sorted(set().union(*(set(f.index) for f in frames.values())))
        start = cfg.min_bars_required
        log.info("Replaying %d timestamps across %d symbols...",
                 max(len(timeline) - start, 0), len(frames))

        for ts in timeline[start:]:
            if self.stop_requested:
                log.info("Replay interrupted.")
                break
            rows = {s: f.loc[ts] for s, f in frames.items() if ts in f.index}
            if not rows:
                continue
            pyts = ts.to_pydatetime()
            pf.mark_prices({s: float(r["close"]) for s, r in rows.items()})
            self.process_bar(pyts, rows)
            pf.record_equity(pyts)
            if pf.blown_up:
                log.critical("Replay stopped early: simulated account wiped out at %s", ts)
                break

        final_ts = pf.equity_curve[-1][0] if pf.equity_curve else datetime.now(UTC)
        if pf.positions:
            log.info("Closing %d open position(s) at the end of the replay window.",
                     len(pf.positions))
            pf.liquidate_all(final_ts, "replay_end")
            pf.record_equity(final_ts)

    # -- live loop -------------------------------------------------------------
    def run_forever(self) -> None:
        cfg = self.cfg
        log.info("Live paper loop started — every %ds. Ctrl+C to stop and report.",
                 cfg.poll_interval_seconds)
        while not self.stop_requested:
            try:
                self.run_cycle()
            except Exception:  # noqa: BLE001 - a bad cycle must not kill the run
                log.exception("Cycle %d raised; continuing to the next cycle.", self.cycle)

            if self.report_requested:
                self.report_requested = False
                print(render_summary(self.portfolio, cfg, compute_metrics(self.portfolio)))
            if self.stop_requested:
                break
            self._sleep(self._seconds_until_next_cycle())

    def _seconds_until_next_cycle(self) -> float:
        cfg = self.cfg
        now = datetime.now(UTC)
        if not cfg.sleep_when_all_markets_closed:
            return cfg.poll_interval_seconds
        if any(market_is_open(cfg, s, now) for s in cfg.universe):
            return cfg.poll_interval_seconds
        wait = (next_us_equity_open(now) - now).total_seconds()
        if wait > cfg.poll_interval_seconds:
            log.info("All markets closed — sleeping %.1f h until the next US open.", wait / 3600)
        return max(wait, cfg.poll_interval_seconds)

    def _sleep(self, seconds: float) -> None:
        """Interruptible sleep so Ctrl+C is responsive between cycles."""
        deadline = time.monotonic() + seconds
        while not self.stop_requested and time.monotonic() < deadline:
            time.sleep(min(0.5, deadline - time.monotonic()))

    # -- finish ----------------------------------------------------------------
    def finish(self) -> dict[str, Any]:
        pf = self.portfolio
        if not pf.equity_curve:
            pf.record_equity(datetime.now(UTC))
        metrics = compute_metrics(pf)
        print(render_summary(pf, self.cfg, metrics))
        files = write_reports(pf, self.cfg, metrics, self.run_dir)
        print("  Reports written:")
        for path in files:
            print(f"    {path}")
        print()
        return metrics


# =============================================================================
#  CLI / entrypoint
# =============================================================================

def setup_logging(run_dir: str, verbose: bool) -> None:
    os.makedirs(run_dir, exist_ok=True)
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    log.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)-8s %(message)s", "%Y-%m-%d %H:%M:%S")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    console.setLevel(logging.DEBUG if verbose else logging.INFO)
    log.addHandler(console)

    file_handler = logging.FileHandler(os.path.join(run_dir, "run.log"), encoding="utf-8")
    file_handler.setFormatter(fmt)
    file_handler.setLevel(logging.DEBUG)
    log.addHandler(file_handler)

    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Paper-trading simulator: real market data, fake money, no broker.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python paper_trader.py --once\n"
               "  python paper_trader.py --replay --max-risk\n"
               "  python paper_trader.py --symbols BTC-USD,ETH-USD --interval 15m\n",
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true",
                      help="run a single evaluation cycle, report, and exit")
    mode.add_argument("--replay", action="store_true",
                      help="replay the strategy bar-by-bar over the real fetched history")
    mode.add_argument("--validate-only", action="store_true",
                      help="validate config and exit without touching the network")

    p.add_argument("--max-risk", action="store_true",
                   help="enable MAX-RISK mode: leverage, shorts, pyramiding, no profit "
                        "target, no daily circuit breaker (expect ruin)")
    p.add_argument("--cash", type=float, help="override STARTING_CASH")
    p.add_argument("--symbols", help="comma-separated universe override, e.g. TQQQ,BTC-USD")
    p.add_argument("--interval", help="override BAR_INTERVAL (e.g. 5m, 1h, 1d)")
    p.add_argument("--period", help="override HISTORY_PERIOD (e.g. 60d, 2y)")
    p.add_argument("--poll", type=int, help="override POLL_INTERVAL_SECONDS")
    p.add_argument("--outdir", help=f"override OUTPUT_DIR (default {OUTPUT_DIR!r})")
    p.add_argument("--yes-i-understand-the-risk", action="store_true",
                   help="skip the MAX-RISK confirmation prompt (for unattended runs)")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return p.parse_args(argv)


def apply_cli_overrides(cfg: Config, args: argparse.Namespace) -> Config:
    if args.max_risk or ENABLE_MAX_RISK_MODE:
        cfg = apply_max_risk_profile(cfg)
    if args.cash is not None:
        cfg.starting_cash = args.cash
    if args.symbols:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        cfg.crypto_universe = [s for s in symbols if s.endswith("-USD")]
        cfg.equity_universe = [s for s in symbols if not s.endswith("-USD")]
    if args.interval:
        cfg.bar_interval = args.interval
    if args.period:
        cfg.history_period = args.period
    if args.poll is not None:
        cfg.poll_interval_seconds = args.poll
    if args.outdir:
        cfg.output_dir = args.outdir
    return cfg


MAX_RISK_BANNER = """
################################################################################
#  MAX-RISK MODE ENABLED  (still 100% simulated money)
#
#  {gross:.1f}x gross exposure  |  {size:.0%} of equity per position  |  shorts: {shorts}
#  pyramiding: {pyramid}  |  profit target: {tp}  |  daily circuit breaker: {breaker}
#
#  This profile is built to show what ruin looks like. A gap through the stop
#  can trigger a simulated margin call that liquidates the whole book. Nobody
#  is claiming this makes money — the expected outcome is a deep drawdown.
################################################################################
"""


def main(argv: Sequence[str] | None = None) -> int:
    print(f"\n  *** {DISCLAIMER} ***\n")
    args = parse_args(argv)

    run_dir = os.path.join(
        args.outdir or OUTPUT_DIR,
        datetime.now().strftime("run_%Y%m%d_%H%M%S") + ("_maxrisk" if args.max_risk else ""),
    )
    setup_logging(run_dir, args.verbose)

    try:
        cfg = apply_cli_overrides(build_config(), args)
        validate_config(cfg)
    except ConfigError as exc:
        log.critical("%s", exc)
        print("\nFix the CONFIG block at the top of paper_trader.py and re-run.\n",
              file=sys.stderr)
        return 2

    if cfg.max_risk_mode:
        print(MAX_RISK_BANNER.format(
            gross=cfg.max_gross_exposure, size=cfg.position_size_pct,
            shorts="on" if cfg.allow_shorts else "off",
            pyramid=f"up to {cfg.max_adds_per_position} adds" if cfg.allow_pyramiding else "off",
            tp=f"{cfg.take_profit_pct:.0%}" if cfg.take_profit_pct else "none (ride the trail)",
            breaker=f"{cfg.daily_loss_limit_pct:.0%}" if cfg.daily_loss_limit_pct else "OFF",
        ))
        if not args.yes_i_understand_the_risk and sys.stdin.isatty():
            try:
                if input("  Type 'yolo' to continue: ").strip().lower() != "yolo":
                    print("  Aborted.")
                    return 1
            except (EOFError, KeyboardInterrupt):
                print("\n  Aborted.")
                return 1

    if args.validate_only:
        log.info("Configuration is valid. Universe: %s", ", ".join(cfg.universe))
        return 0

    engine = Engine(cfg, run_dir)

    def request_stop(signum, _frame):  # noqa: ANN001
        if engine.stop_requested:
            log.warning("Second interrupt — exiting immediately.")
            raise SystemExit(130)
        log.info("Signal %s received — finishing up and reporting.", signum)
        engine.stop_requested = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    if hasattr(signal, "SIGUSR1"):  # on-demand report: kill -USR1 <pid>
        signal.signal(signal.SIGUSR1,
                      lambda *_: setattr(engine, "report_requested", True))

    log.info("Mode=%s | universe=%s | interval=%s | period=%s | cash=$%s",
             "max-risk" if cfg.max_risk_mode else "standard",
             ",".join(cfg.universe), cfg.bar_interval, cfg.history_period,
             f"{cfg.starting_cash:,.2f}")

    exit_code = 0
    try:
        if args.replay:
            engine.run_replay()
        elif args.once:
            engine.run_cycle()
        else:
            engine.run_forever()
    except KeyboardInterrupt:
        log.info("Interrupted.")
    except Exception:  # noqa: BLE001
        log.exception("Fatal error — reporting what we have before exiting.")
        exit_code = 1
    finally:
        engine.finish()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
