#!/usr/bin/env python3
"""Verification suite for paper_trader.py.

Run:  python test_paper_trader.py

The OHLCV frames below are hand-built fixtures with known-good expected values.
They exist ONLY to verify accounting and control flow — paper_trader.py itself
never generates prices and always pulls real market data from yfinance.
"""

from __future__ import annotations

import json
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

import paper_trader as pt

UTC = timezone.utc
T0 = datetime(2025, 6, 2, 14, 0, tzinfo=UTC)  # a Monday, during US market hours

_failures: list[str] = []
_passes = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global _passes
    if condition:
        _passes += 1
    else:
        _failures.append(f"{name}{(' — ' + detail) if detail else ''}")


def close_to(a: float, b: float, tol: float = 1e-6) -> bool:
    return abs(a - b) <= tol


def make_cfg(**overrides) -> pt.Config:
    cfg = pt.build_config()
    cfg.equity_universe = ["TEST"]
    cfg.crypto_universe = []
    cfg.starting_cash = 10_000.0
    cfg.slippage_pct = 0.001
    cfg.commission_per_trade = 0.0
    cfg.position_size_pct = 0.20
    cfg.max_gross_exposure = 1.0
    cfg.allow_fractional_equity = False
    cfg.enable_adaptive = False          # fixed-rule tests; adaptive tests opt in
    cfg.adaptive_seed = 7
    cfg.output_dir = "/tmp/paper_trader_test_runs"
    for key, value in overrides.items():
        setattr(cfg, key, value)
    return cfg


# =============================================================================
#  Execution accounting
# =============================================================================

def test_long_round_trip() -> None:
    pf = pt.Portfolio(make_cfg())
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=2.0, reason="test")
    pos = pf.positions["TEST"]

    # 0.2 * 10000 = $2000 target; fill = 100 * 1.001 = 100.1; floor(19.98) = 19 shares.
    check("long: slippage pushes buy fill up", close_to(pos.avg_entry, 100.1))
    check("long: whole-share qty", close_to(pos.qty, 19.0), f"got {pos.qty}")
    check("long: cash debited", close_to(pf.cash, 10_000 - 19 * 100.1),
          f"got {pf.cash}")
    check("long: hard stop below entry", close_to(pos.hard_stop, 100.1 * (1 - 0.08)))

    cash_before = pf.cash
    pf.mark_prices({"TEST": 110.0})
    pf.close_position(T0 + timedelta(minutes=5), "TEST", 110.0, "test_exit")
    trade = pf.closed_trades[0]

    # Sell fill = 110 * 0.999 = 109.89.
    expected_net = 19 * (109.89 - 100.1)
    check("long: net_pnl equals real cash delta",
          close_to(trade.net_pnl, expected_net, 1e-6), f"got {trade.net_pnl}")
    check("long: cash reconciles with net_pnl",
          close_to(pf.cash - cash_before, 19 * 109.89))
    check("long: equity reconciles",
          close_to(pf.equity(), 10_000 + expected_net, 1e-6), f"got {pf.equity()}")
    check("long: frictionless gross > net", trade.gross_pnl > trade.net_pnl)
    check("long: fees == both-side slippage",
          close_to(trade.fees, 19 * 0.1 + 19 * 0.11, 1e-6), f"got {trade.fees}")
    check("long: no position left", not pf.positions)


def test_short_round_trip() -> None:
    cfg = make_cfg(allow_shorts=True)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", -1, 100.0, atr=2.0, reason="test")
    pos = pf.positions["TEST"]

    # Short fill = 100 * 0.999 = 99.9; floor(2000/99.9) = 20 shares.
    check("short: slippage pushes sell fill down", close_to(pos.avg_entry, 99.9))
    check("short: qty", close_to(pos.qty, 20.0), f"got {pos.qty}")
    check("short: cash credited", close_to(pf.cash, 10_000 + 20 * 99.9))
    check("short: equity drops by entry slippage only",
          close_to(pf.equity(), 10_000 - 20 * 0.1), f"got {pf.equity()}")
    check("short: hard stop above entry", close_to(pos.hard_stop, 99.9 * 1.08))

    pf.mark_prices({"TEST": 90.0})
    pf.close_position(T0 + timedelta(minutes=5), "TEST", 90.0, "test_exit")
    trade = pf.closed_trades[0]
    # Cover fill = 90 * 1.001 = 90.09.
    expected_net = -1 * 20 * (90.09 - 99.9)
    check("short: profits when price falls", trade.net_pnl > 0)
    check("short: net_pnl exact", close_to(trade.net_pnl, expected_net, 1e-6),
          f"got {trade.net_pnl} want {expected_net}")
    check("short: equity reconciles",
          close_to(pf.equity(), 10_000 + expected_net, 1e-6), f"got {pf.equity()}")


def test_commission_included() -> None:
    cfg = make_cfg(commission_per_trade=5.0)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=2.0, reason="test")
    pf.mark_prices({"TEST": 100.0})
    pf.close_position(T0 + timedelta(minutes=5), "TEST", 100.0, "flat")
    trade = pf.closed_trades[0]
    qty = trade.qty
    expected = qty * (100 * 0.999 - 100 * 1.001) - 10.0  # both commissions
    check("commission: charged on entry and exit",
          close_to(trade.net_pnl, expected, 1e-6), f"got {trade.net_pnl}")
    check("commission: flat trade still loses to friction", trade.net_pnl < 0)


# =============================================================================
#  Capital guardrails
# =============================================================================

def test_cash_never_negative() -> None:
    cfg = make_cfg(position_size_pct=1.0, starting_cash=1_000.0)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="test")
    check("cash-only: cash stayed >= 0", pf.cash >= 0, f"cash={pf.cash}")
    check("cash-only: position opened", "TEST" in pf.positions)
    check("cash-only: gross <= starting cash", pf.gross_exposure() <= 1_000.0 + 1e-9)


def test_unaffordable_trade_rejected() -> None:
    cfg = make_cfg(starting_cash=50.0, position_size_pct=1.0)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 500.0})
    pos = pf.open_position(T0, "TEST", +1, 500.0, atr=1.0, reason="test")
    check("reject: no position when unaffordable", pos is None)
    check("reject: cash untouched", close_to(pf.cash, 50.0))
    check("reject: reason logged", len(pf.rejections) == 1)
    check("reject: reason mentions sizing",
          "zero" in pf.rejections[0][2], pf.rejections[0][2] if pf.rejections else "")


def test_exposure_cap_sizes_down() -> None:
    cfg = make_cfg(position_size_pct=0.6, max_gross_exposure=1.0,
                   allow_fractional_equity=True, max_open_positions=5)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"A": 100.0, "B": 100.0})
    pf.open_position(T0, "A", +1, 100.0, atr=1.0, reason="t")
    pf.open_position(T0, "B", +1, 100.0, atr=1.0, reason="t")
    check("exposure: second trade sized down, not rejected", "B" in pf.positions)
    check("exposure: gross within cap",
          pf.gross_exposure() <= cfg.max_gross_exposure * pf.equity() + 1.0,
          f"gross={pf.gross_exposure():.2f} equity={pf.equity():.2f}")
    check("exposure: cash not negative", pf.cash >= -1e-9, f"cash={pf.cash}")


def test_leverage_allows_more_than_cash() -> None:
    cfg = make_cfg(position_size_pct=0.9, max_gross_exposure=3.0,
                   allow_fractional_equity=True, max_open_positions=5)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"A": 100.0, "B": 100.0, "C": 100.0})
    for sym in ("A", "B", "C"):
        pf.open_position(T0, sym, +1, 100.0, atr=1.0, reason="t")
    check("leverage: gross exceeds starting cash", pf.gross_exposure() > 10_000)
    check("leverage: gross within 3x cap",
          pf.gross_exposure() <= 3.0 * pf.equity() + 1.0,
          f"gross={pf.gross_exposure():.0f} equity={pf.equity():.0f}")
    check("leverage: cash went negative (margin loan)", pf.cash < 0)
    check("leverage: equity still positive", pf.equity() > 0)


def test_margin_call_floors_equity_at_zero() -> None:
    cfg = make_cfg(position_size_pct=0.95, max_gross_exposure=3.0,
                   allow_fractional_equity=True, max_open_positions=4,
                   maintenance_margin_pct=0.25)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"A": 100.0, "B": 100.0, "C": 100.0})
    for sym in ("A", "B", "C"):
        pf.open_position(T0, sym, +1, 100.0, atr=1.0, reason="t")
    # A catastrophic gap down, far worse than any stop would have allowed.
    pf.mark_prices({"A": 20.0, "B": 20.0, "C": 20.0})
    pf.enforce_solvency(T0 + timedelta(minutes=5))
    check("margin call: book liquidated", not pf.positions, f"{list(pf.positions)}")
    check("margin call: equity never negative", pf.equity() >= 0,
          f"equity={pf.equity()}")
    check("margin call: cash never negative", pf.cash >= 0, f"cash={pf.cash}")
    check("margin call: flagged as blown up", pf.blown_up)


def test_max_open_positions() -> None:
    """The position-count cap is enforced by the engine, so drive it end to end."""
    cfg = make_cfg(position_size_pct=0.1, max_open_positions=2,
                   allow_fractional_equity=True, use_trend_filter=False,
                   breakout_lookback=5, volume_lookback=5, atr_period=3)
    engine = pt.Engine(cfg, run_dir="/tmp")
    pf = engine.portfolio
    prices = {"A": 100.0, "B": 100.0, "C": 100.0}
    pf.mark_prices(prices)
    # Three simultaneous, identical breakout signals; only two may be taken.
    rows = {sym: _row(100, 106, 99, 105, atr=2.0, vol=300.0,
                      donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
            for sym in prices}
    engine.process_bar(T0, rows)
    check("max positions: cap enforced", len(pf.positions) == 2,
          f"opened {len(pf.positions)}: {list(pf.positions)}")
    check("max positions: the surplus signal was logged as rejected",
          any("MAX_OPEN_POSITIONS" in why for _, _, why in pf.rejections),
          f"rejections={pf.rejections}")


# =============================================================================
#  Exit logic
# =============================================================================

def _row(o, h, l, c, atr=2.0, vol=1000.0, **extra) -> pd.Series:
    base = {"open": o, "high": h, "low": l, "close": c, "volume": vol, "atr": atr,
            "donchian_high": 999999.0, "donchian_low": 0.0, "vol_avg": 100.0,
            "sma_trend": c}
    base.update(extra)
    return pd.Series(base)


def test_stop_fills_at_gap_open() -> None:
    cfg = make_cfg(stop_loss_pct=0.10, trail_atr_mult=100.0, take_profit_pct=0.0)
    strat = pt.BreakoutStrategy(cfg)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=2.0, reason="t")
    pos = pf.positions["TEST"]
    stop = pos.effective_stop()

    # Bar gaps wide open BELOW the stop: a real fill happens at the open, not the stop.
    gap_row = _row(o=70.0, h=72.0, l=68.0, c=71.0)
    sig = strat.exit_signal(pos, gap_row)
    check("gap: stop exit triggered", sig.action == "exit" and sig.reason == "stop_loss")
    check("gap: fills at the open, worse than the stop",
          close_to(sig.fill_price, 70.0), f"fill={sig.fill_price} stop={stop}")

    # Ordinary intrabar touch: fill at the stop level itself.
    touch_row = _row(o=95.0, h=96.0, l=stop - 0.5, c=95.0)
    sig2 = strat.exit_signal(pos, touch_row)
    check("touch: fills at the stop level", close_to(sig2.fill_price, stop),
          f"fill={sig2.fill_price} stop={stop}")


def test_stop_takes_priority_over_target() -> None:
    cfg = make_cfg(stop_loss_pct=0.05, take_profit_pct=0.05, trail_atr_mult=100.0)
    strat = pt.BreakoutStrategy(cfg)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=2.0, reason="t")
    pos = pf.positions["TEST"]
    # A bar that touches BOTH the stop and the target: assume the worse one.
    both = _row(o=100.0, h=120.0, l=80.0, c=100.0)
    sig = strat.exit_signal(pos, both)
    check("ambiguous bar: pessimistic — stop wins", sig.reason == "stop_loss",
          f"got {sig.reason}")


def test_trailing_stop_ratchets_one_way() -> None:
    cfg = make_cfg(trail_atr_mult=2.0, stop_loss_pct=0.5)
    strat = pt.BreakoutStrategy(cfg)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=2.0, reason="t")
    pos = pf.positions["TEST"]

    strat.update_trailing_stop(pos, _row(120, 120, 118, 119, atr=2.0))
    raised = pos.trail_stop
    check("trail: rises with price", close_to(raised, 120 - 4.0), f"got {raised}")
    strat.update_trailing_stop(pos, _row(105, 106, 104, 105, atr=2.0))
    check("trail: never falls back", close_to(pos.trail_stop, raised),
          f"got {pos.trail_stop}")
    check("trail: peak retained", close_to(pos.peak_price, 120.0))


def test_short_trailing_stop() -> None:
    cfg = make_cfg(trail_atr_mult=2.0, stop_loss_pct=0.5, allow_shorts=True)
    strat = pt.BreakoutStrategy(cfg)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", -1, 100.0, atr=2.0, reason="t")
    pos = pf.positions["TEST"]
    strat.update_trailing_stop(pos, _row(80, 82, 80, 81, atr=2.0))
    lowered = pos.trail_stop
    check("short trail: falls with price", close_to(lowered, 80 + 4.0), f"got {lowered}")
    strat.update_trailing_stop(pos, _row(95, 96, 94, 95, atr=2.0))
    check("short trail: never rises back", close_to(pos.trail_stop, lowered))


def test_vol_contraction_and_time_stop() -> None:
    cfg = make_cfg(vol_contraction_ratio=0.6, trail_atr_mult=100.0,
                   stop_loss_pct=0.9, take_profit_pct=0.0)
    strat = pt.BreakoutStrategy(cfg)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=10.0, reason="t")
    pos = pf.positions["TEST"]
    sig = strat.exit_signal(pos, _row(100, 101, 99, 100, atr=5.0))
    check("vol contraction: exits when ATR halves", sig.reason == "vol_contraction",
          f"got {sig.reason}")

    cfg2 = make_cfg(vol_contraction_ratio=0.0, trail_atr_mult=100.0,
                    stop_loss_pct=0.9, take_profit_pct=0.0, max_hold_bars=3)
    strat2 = pt.BreakoutStrategy(cfg2)
    pf2 = pt.Portfolio(cfg2)
    pf2.mark_prices({"TEST": 100.0})
    pf2.open_position(T0, "TEST", +1, 100.0, atr=10.0, reason="t")
    pos2 = pf2.positions["TEST"]
    pos2.bars_held = 3
    check("time stop: exits at max_hold_bars",
          strat2.exit_signal(pos2, _row(100, 101, 99, 100, atr=10.0)).reason == "time_stop")


# =============================================================================
#  Entry logic
# =============================================================================

def test_entry_requires_breakout_and_volume() -> None:
    cfg = make_cfg(volume_spike_mult=1.5, use_trend_filter=False)
    strat = pt.BreakoutStrategy(cfg)

    breakout = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
                    donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    check("entry: breakout + volume spike goes long",
          strat.entry_signal(breakout).action == "enter"
          and strat.entry_signal(breakout).direction == 1)

    no_volume = _row(100, 106, 99, 105, atr=2.0, vol=110.0,
                     donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    check("entry: no volume spike -> no trade",
          strat.entry_signal(no_volume).action == "none")

    no_breakout = _row(100, 103, 99, 102, atr=2.0, vol=300.0,
                       donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    check("entry: inside the range -> no trade",
          strat.entry_signal(no_breakout).action == "none")

    cold = _row(100, 106, 99, 105, atr=np.nan, vol=300.0,
                donchian_high=np.nan, donchian_low=np.nan, vol_avg=np.nan)
    check("entry: unwarmed indicators -> no trade",
          strat.entry_signal(cold).action == "none")


def test_shorts_gated_by_flag() -> None:
    breakdown = _row(100, 101, 89, 90, atr=2.0, vol=300.0,
                     donchian_high=120.0, donchian_low=95.0, vol_avg=100.0)
    off = pt.BreakoutStrategy(make_cfg(allow_shorts=False, use_trend_filter=False))
    check("shorts off: breakdown ignored", off.entry_signal(breakdown).action == "none")
    on = pt.BreakoutStrategy(make_cfg(allow_shorts=True, use_trend_filter=False))
    sig = on.entry_signal(breakdown)
    check("shorts on: breakdown goes short",
          sig.action == "enter" and sig.direction == -1)


def test_trend_filter_blocks_counter_trend() -> None:
    strat = pt.BreakoutStrategy(make_cfg(use_trend_filter=True))
    below_sma = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
                     donchian_high=104.0, donchian_low=90.0, vol_avg=100.0,
                     sma_trend=110.0)
    check("trend filter: blocks longs below the SMA",
          strat.entry_signal(below_sma).action == "none")


# =============================================================================
#  Indicators / data hygiene
# =============================================================================

def test_indicators_have_no_lookahead() -> None:
    cfg = make_cfg(breakout_lookback=5, volume_lookback=5, atr_period=3,
                   use_trend_filter=False)
    n = 30
    idx = pd.date_range("2025-06-02", periods=n, freq="1D", tz="UTC")
    df = pd.DataFrame({
        "open": np.full(n, 100.0), "high": np.full(n, 101.0),
        "low": np.full(n, 99.0), "close": np.full(n, 100.0),
        "volume": np.full(n, 1000.0),
    }, index=idx)
    df.loc[df.index[-1], "high"] = 500.0  # a spike on the FINAL bar only
    out = pt.compute_indicators(df, cfg)
    check("indicators: breakout window excludes the current bar",
          close_to(float(out["donchian_high"].iloc[-1]), 101.0),
          f"got {out['donchian_high'].iloc[-1]}")
    check("indicators: ATR is finite once warmed", np.isfinite(out["atr"].iloc[-1]))
    check("indicators: early bars are NaN, not fabricated",
          bool(pd.isna(out["donchian_high"].iloc[0])))


def test_normalizer_cleans_bad_rows() -> None:
    idx = pd.date_range("2025-06-02", periods=5, freq="1D", tz="UTC")
    raw = pd.DataFrame({
        "Open": [10, 11, np.nan, 13, 14], "High": [11, 12, 13, 14, 15],
        "Low": [9, 10, 11, 12, 13], "Close": [10.5, 11.5, 12.5, 0.0, 14.5],
        "Volume": [100, 200, 300, 400, np.nan],
    }, index=idx)
    out = pt.DataFeed._normalize(raw)
    check("normalize: drops NaN and non-positive rows", len(out) == 3,
          f"got {len(out)} rows")
    check("normalize: lowercases columns",
          list(out.columns) == ["open", "high", "low", "close", "volume"])
    check("normalize: fills missing volume with 0",
          close_to(float(out["volume"].iloc[-1]), 0.0))
    check("normalize: empty input is handled",
          pt.DataFeed._normalize(pd.DataFrame()).empty)
    check("normalize: None is handled", pt.DataFeed._normalize(None).empty)

    multi = raw.copy()
    multi.columns = pd.MultiIndex.from_product([["Open", "High", "Low", "Close", "Volume"],
                                                ["TEST"]]).swaplevel()
    multi.columns = pd.MultiIndex.from_tuples(
        [("TEST", c) for c in ["Open", "High", "Low", "Close", "Volume"]])
    check("normalize: handles MultiIndex columns",
          not pt.DataFeed._normalize(multi).empty)


def test_partial_bar_dropped() -> None:
    cfg = make_cfg(bar_interval="5m", use_last_partial_bar=False)
    now = datetime(2025, 6, 2, 14, 3, tzinfo=UTC)
    idx = pd.date_range("2025-06-02 13:45", periods=4, freq="5min", tz="UTC")
    df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
                       "volume": 1.0}, index=idx)
    # Final bar starts 14:00 and closes 14:05 — still forming at 14:03.
    trimmed = pt.drop_partial_bar(df, cfg, now)
    check("partial bar: still-forming bar dropped", len(trimmed) == 3,
          f"got {len(trimmed)}")
    cfg.use_last_partial_bar = True
    check("partial bar: kept when explicitly enabled",
          len(pt.drop_partial_bar(df, cfg, now)) == 4)


# =============================================================================
#  Calendar
# =============================================================================

def test_market_calendar() -> None:
    cfg = make_cfg(crypto_universe=["BTC-USD"])
    weekday_open = datetime(2025, 6, 2, 14, 0, tzinfo=UTC)      # Mon 10:00 ET
    weekday_closed = datetime(2025, 6, 2, 2, 0, tzinfo=UTC)     # Sun 22:00 ET
    saturday = datetime(2025, 6, 7, 15, 0, tzinfo=UTC)
    july4 = datetime(2025, 7, 4, 15, 0, tzinfo=UTC)
    half_day_late = datetime(2025, 11, 28, 18, 30, tzinfo=UTC)  # 13:30 ET, after 1pm close

    check("calendar: equity open midday Monday", pt.is_us_equity_open(weekday_open))
    check("calendar: equity closed overnight", not pt.is_us_equity_open(weekday_closed))
    check("calendar: equity closed Saturday", not pt.is_us_equity_open(saturday))
    check("calendar: equity closed July 4", not pt.is_us_equity_open(july4))
    check("calendar: half-day close respected", not pt.is_us_equity_open(half_day_late))

    check("calendar: crypto open on Saturday",
          pt.market_is_open(cfg, "BTC-USD", saturday))
    check("calendar: crypto open on a holiday", pt.market_is_open(cfg, "BTC-USD", july4))
    check("calendar: equity symbol closed Saturday",
          not pt.market_is_open(cfg, "TEST", saturday))
    check("calendar: -USD suffix detected as crypto", cfg.is_crypto("ETH-USD"))
    check("calendar: plain ticker is not crypto", not cfg.is_crypto("TQQQ"))

    nxt = pt.next_us_equity_open(saturday)
    check("calendar: next open skips the weekend", nxt.astimezone(pt.NY).weekday() == 0,
          f"got {nxt.astimezone(pt.NY)}")
    check("calendar: next open is 09:30 ET",
          nxt.astimezone(pt.NY).strftime("%H:%M") == "09:30")


# =============================================================================
#  Metrics
# =============================================================================

def test_metrics() -> None:
    pf = pt.Portfolio(make_cfg())
    base = datetime(2025, 6, 2, tzinfo=UTC)
    for i, eq in enumerate([10_000, 12_000, 6_000, 9_000, 11_000]):
        pf.equity_curve.append((base + timedelta(days=i), float(eq)))
    pf.cash = 11_000.0
    for pnl in (500.0, -200.0, 300.0, -100.0):
        pf.closed_trades.append(pt.ClosedTrade(
            symbol="TEST", side="LONG", qty=1, entry_time=base, exit_time=base,
            entry_price=100, exit_price=100, gross_pnl=pnl, fees=1.0, net_pnl=pnl,
            return_pct=pnl / 100, hold_minutes=60, exit_reason="t"))

    m = pt.compute_metrics(pf)
    check("metrics: max drawdown from peak", close_to(m["max_drawdown_pct"], 50.0),
          f"got {m['max_drawdown_pct']}")  # 12000 -> 6000
    check("metrics: total return", close_to(m["total_return_pct"], 10.0),
          f"got {m['total_return_pct']}")
    check("metrics: win rate", close_to(m["win_rate_pct"], 50.0))
    check("metrics: profit factor", close_to(m["profit_factor"], 800 / 300, 1e-9),
          f"got {m['profit_factor']}")
    check("metrics: expectancy", close_to(m["expectancy"], 125.0))
    check("metrics: sharpe computed with enough points", m["sharpe"] is not None)
    check("metrics: trade count", m["num_trades"] == 4)

    empty = pt.compute_metrics(pt.Portfolio(make_cfg()))
    check("metrics: empty run does not crash", empty["num_trades"] == 0)
    check("metrics: empty run reports no sharpe", empty["sharpe"] is None)


# =============================================================================
#  Config validation & max-risk mode
# =============================================================================

def test_validation_rejects_nonsense() -> None:
    cases = {
        "position size > 100%": {"position_size_pct": 1.5},
        "zero stop": {"stop_loss_pct": 0.0},
        "negative commission": {"commission_per_trade": -1.0},
        "absurd slippage": {"slippage_pct": 0.5},
        "zero cash": {"starting_cash": 0.0},
        "bad interval": {"bar_interval": "7s"},
        "lookback too small": {"breakout_lookback": 1},
        "exposure over cap": {"max_gross_exposure": 50.0},
        "empty universe": {"equity_universe": [], "crypto_universe": []},
        "period beyond interval limit": {"bar_interval": "1m", "history_period": "60d"},
        "pyramiding without adds": {"allow_pyramiding": True, "max_adds_per_position": 0},
    }
    for label, overrides in cases.items():
        try:
            pt.validate_config(make_cfg(**overrides))
            check(f"validation: rejects {label}", False, "no error raised")
        except pt.ConfigError:
            check(f"validation: rejects {label}", True)

    try:
        pt.validate_config(make_cfg())
        check("validation: accepts sane defaults", True)
    except pt.ConfigError as exc:
        check("validation: accepts sane defaults", False, str(exc))


def test_max_risk_profile() -> None:
    cfg = pt.apply_max_risk_profile(pt.build_config())
    check("max-risk: flag set", cfg.max_risk_mode)
    check("max-risk: leverage on", cfg.max_gross_exposure > 1.0)
    check("max-risk: shorts on", cfg.allow_shorts)
    check("max-risk: pyramiding on",
          cfg.allow_pyramiding and cfg.max_adds_per_position >= 1)
    check("max-risk: profit target removed", cfg.take_profit_pct == 0.0)
    check("max-risk: circuit breaker off", cfg.daily_loss_limit_pct == 0.0)
    check("max-risk: bigger positions",
          cfg.position_size_pct > pt.build_config().position_size_pct)
    try:
        pt.validate_config(cfg)
        check("max-risk: profile still passes validation", True)
    except pt.ConfigError as exc:
        check("max-risk: profile still passes validation", False, str(exc))

    original = dict(pt.MAX_RISK_PROFILE)
    try:
        pt.MAX_RISK_PROFILE["NOT_A_REAL_KNOB"] = 1
        pt.apply_max_risk_profile(pt.build_config())
        check("max-risk: unknown key fails loudly", False, "no error raised")
    except pt.ConfigError:
        check("max-risk: unknown key fails loudly", True)
    finally:
        pt.MAX_RISK_PROFILE.clear()
        pt.MAX_RISK_PROFILE.update(original)


def test_daily_loss_limit_halts_entries() -> None:
    cfg = make_cfg(daily_loss_limit_pct=0.10, allow_fractional_equity=True,
                   use_trend_filter=False)
    engine = pt.Engine(cfg, run_dir="/tmp")
    pf = engine.portfolio
    pf.record_equity(T0)
    pf.cash = 8_500.0            # a 15% loss on the day, past the 10% limit
    row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    engine.process_bar(T0 + timedelta(minutes=5), {"TEST": row})
    check("circuit breaker: no new entries after the daily limit",
          not pf.positions, f"opened {list(pf.positions)}")
    check("circuit breaker: reason recorded",
          pf.halted_reason is not None and "daily loss" in pf.halted_reason)


# =============================================================================
#  Engine integration (offline)
# =============================================================================

def test_engine_end_to_end_offline() -> None:
    """Drive the full engine loop over a scripted path: breakout, then collapse."""
    cfg = make_cfg(breakout_lookback=5, volume_lookback=5, atr_period=3,
                   use_trend_filter=False, position_size_pct=0.5,
                   allow_fractional_equity=True, stop_loss_pct=0.10,
                   take_profit_pct=0.0, trail_atr_mult=2.0,
                   vol_contraction_ratio=0.0, max_open_positions=2)
    engine = pt.Engine(cfg, run_dir="/tmp")
    pf = engine.portfolio

    closes = ([100.0] * 10 + [101, 102, 103, 115]        # base, then a breakout
              + [118, 120, 116, 108, 95, 80, 70])        # run-up, then collapse
    rows = []
    for i, c in enumerate(closes):
        rows.append({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c,
                     "volume": 1000.0 if i < 13 else 5000.0})
    idx = pd.date_range("2025-06-02", periods=len(rows), freq="1D", tz="UTC")
    df = pt.compute_indicators(pd.DataFrame(rows, index=idx), cfg)

    for i in range(cfg.min_bars_required, len(df)):
        ts = df.index[i].to_pydatetime()
        row = df.iloc[i]
        pf.mark_prices({"TEST": float(row["close"])})
        engine.process_bar(ts, {"TEST": row})
        pf.record_equity(ts)
        check("engine: equity never negative mid-run", pf.equity() >= 0,
              f"equity={pf.equity()} at bar {i}")

    check("engine: took at least one trade",
          len(pf.closed_trades) + len(pf.positions) > 0)
    check("engine: exited the collapse", not pf.positions,
          f"still holding {list(pf.positions)}")
    if pf.closed_trades:
        exits = {t.exit_reason for t in pf.closed_trades}
        check("engine: exit was a stop", "stop_loss" in exits, f"got {exits}")

    m = pt.compute_metrics(pf)
    check("engine: metrics computed", m["num_trades"] == len(pf.closed_trades))
    check("engine: fills recorded", len(pf.fills) >= 2 * len(pf.closed_trades))


def test_reports_written(tmp_dir: str = "/tmp/paper_trader_test_reports") -> None:
    import shutil
    shutil.rmtree(tmp_dir, ignore_errors=True)
    cfg = make_cfg()
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=2.0, reason="t")
    pf.mark_prices({"TEST": 110.0})
    pf.close_position(T0 + timedelta(minutes=5), "TEST", 110.0, "t")
    pf.record_equity(T0 + timedelta(minutes=5))
    files = pt.write_reports(pf, cfg, pt.compute_metrics(pf), tmp_dir)
    check("reports: four files written", len(files) == 4, f"got {files}")

    import json, os
    for path in files:
        check(f"reports: {os.path.basename(path)} is non-empty",
              os.path.exists(path) and os.path.getsize(path) > 0)
    with open(os.path.join(tmp_dir, "summary.json"), encoding="utf-8") as fh:
        payload = json.load(fh)
    check("reports: summary.json parses and has trades", len(payload["trades"]) == 1)
    check("reports: summary.json carries the disclaimer", "disclaimer" in payload)
    check("reports: summary.json records config", "config" in payload)

    trades = pd.read_csv(os.path.join(tmp_dir, "trades.csv"))
    check("reports: trades.csv readable by pandas", len(trades) == 1)
    check("reports: summary renders",
          "PAPER TRADING SUMMARY" in pt.render_summary(pf, cfg, pt.compute_metrics(pf)))
    shutil.rmtree(tmp_dir, ignore_errors=True)


# =============================================================================
#  Base-formula upgrades
# =============================================================================

def test_breakout_buffer_filters_marginal_pokes() -> None:
    strat = pt.BreakoutStrategy(make_cfg(breakout_buffer_atr=0.5, use_trend_filter=False))
    # ATR 2.0 -> buffer 1.0. Range high 104: a close of 104.5 is inside the buffer.
    inside = _row(100, 105, 99, 104.5, atr=2.0, vol=300.0,
                  donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    beyond = _row(100, 106, 99, 105.5, atr=2.0, vol=300.0,
                  donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    check("buffer: marginal poke ignored", strat.entry_signal(inside).action == "none")
    check("buffer: clean break taken", strat.entry_signal(beyond).action == "enter")


def test_risk_parity_sizing() -> None:
    # Stop 10%, huge trail so the hard stop is the nearer one. 2% risk budget on
    # $10k = $200 at risk -> $2,000 notional, below the 50% ($5k) cap.
    cfg = make_cfg(risk_per_trade_pct=0.02, stop_loss_pct=0.10, trail_atr_mult=100.0,
                   position_size_pct=0.5, allow_fractional_equity=True)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pos = pf.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="t")
    check("risk sizing: notional = risk budget / stop distance",
          pos is not None and close_to(pos.qty * pos.avg_entry, 2_000.0, 1.0),
          f"notional={pos.qty * pos.avg_entry if pos else None}")
    check("risk sizing: initial_risk_pct recorded",
          pos is not None and close_to(pos.initial_risk_pct, 0.10))

    # A tighter trailing stop (2 ATR of 1.0 on a $100 stock = 2%) defines the risk.
    cfg2 = make_cfg(risk_per_trade_pct=0.02, stop_loss_pct=0.10, trail_atr_mult=2.0,
                    position_size_pct=1.0, allow_fractional_equity=True)
    pf2 = pt.Portfolio(cfg2)
    pf2.mark_prices({"TEST": 100.0})
    pos2 = pf2.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="t")
    # Sizing estimates risk from the pre-slippage price; the position records it
    # from the actual fill (100.1), so the recorded risk is 2/100.1, not 2/100.
    check("risk sizing: nearer stop (trail) defines risk, measured at the fill",
          pos2 is not None and close_to(pos2.initial_risk_pct, 2.0 / 100.1, 1e-9),
          f"got {pos2.initial_risk_pct if pos2 else None}")
    check("risk sizing: notional scales up with a tight stop, but cash-capped",
          pos2 is not None and pos2.qty * pos2.avg_entry <= 10_000.0 + 1e-6)

    # risk_per_trade_pct = 0 restores plain notional sizing.
    cfg3 = make_cfg(risk_per_trade_pct=0.0, position_size_pct=0.3,
                    allow_fractional_equity=True)
    pf3 = pt.Portfolio(cfg3)
    pf3.mark_prices({"TEST": 100.0})
    pos3 = pf3.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="t")
    check("risk sizing: disabled -> fixed notional",
          pos3 is not None and close_to(pos3.qty * pos3.avg_entry, 3_000.0, 1.0))


def test_exit_playbooks_resolve() -> None:
    cfg = make_cfg(stop_loss_pct=0.10, trail_atr_mult=2.0, take_profit_pct=0.20)
    tight = pt.resolve_exit_params(cfg, "tight")
    loose = pt.resolve_exit_params(cfg, "loose")
    base = pt.resolve_exit_params(cfg, "base")
    unknown = pt.resolve_exit_params(cfg, "does-not-exist")
    check("playbook: tight scales stop down", close_to(tight.stop_loss_pct, 0.06))
    check("playbook: loose scales stop up", close_to(loose.stop_loss_pct, 0.15))
    check("playbook: loose removes the target", loose.take_profit_pct == 0.0)
    check("playbook: base is identity",
          close_to(base.stop_loss_pct, 0.10) and close_to(base.trail_atr_mult, 2.0))
    check("playbook: unknown name falls back to base", unknown.playbook == "base")

    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pos = pf.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="t", exit_params=tight)
    check("playbook: position carries its own stop",
          pos is not None and close_to(pos.hard_stop, pos.avg_entry * 0.94, 1e-6))
    check("playbook: position records playbook name", pos is not None and pos.playbook == "tight")


def test_r_multiple_recorded() -> None:
    cfg = make_cfg(stop_loss_pct=0.10, trail_atr_mult=100.0, allow_fractional_equity=True)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pf.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="t")
    pf.mark_prices({"TEST": 120.0})
    trade = pf.close_position(T0 + timedelta(hours=1), "TEST", 120.0, "t")
    # ~+20% on a 10% initial risk => roughly +2R (slightly less after slippage).
    check("R-multiple: close_position returns the trade", trade is not None)
    check("R-multiple: roughly +2R on a +20% move with a 10% stop",
          trade is not None and 1.8 < trade.r_multiple < 2.0, f"got {trade.r_multiple if trade else None}")


# =============================================================================
#  Adaptive layer
# =============================================================================

def test_online_logit_learns_a_pattern() -> None:
    rng = np.random.default_rng(0)
    model = pt.OnlineLogit(3, lr=0.1, l2=0.001)
    for _ in range(600):
        x = [1.0, float(rng.uniform(-1, 1)), float(rng.uniform(-1, 1))]
        y = 1.0 if x[1] > 0.1 else 0.0           # label depends on feature 1 only
        model.update(x, y)
    check("logit: positive class scored high", model.predict([1.0, 0.9, 0.0]) > 0.8,
          f"got {model.predict([1.0, 0.9, 0.0]):.2f}")
    check("logit: negative class scored low", model.predict([1.0, -0.9, 0.0]) < 0.2,
          f"got {model.predict([1.0, -0.9, 0.0]):.2f}")
    check("logit: irrelevant feature stays small",
          abs(float(model.w[2])) < abs(float(model.w[1])) * 0.3,
          f"w={model.w}")
    acc = model.rolling_accuracy()
    check("logit: rolling accuracy is high", acc is not None and acc > 0.85, f"acc={acc}")
    cal = model.calibration()
    check("logit: calibration reported", cal is not None and 0 <= cal[0] <= 1)


def test_bandit_converges_to_best_arm() -> None:
    rng = random.Random(3)
    bandit = pt.ThompsonBandit(["a", "b", "c"], rng)
    true_mean = {"a": -0.2, "b": 0.6, "c": 0.1}
    picks = {"a": 0, "b": 0, "c": 0}
    for _ in range(400):
        arm = bandit.choose("ctx")
        bandit.update("ctx", arm, rng.gauss(true_mean[arm], 0.5))
        picks[arm] += 1
    check("bandit: best arm chosen most often", picks["b"] > picks["a"] and picks["b"] > picks["c"],
          f"picks={picks}")
    check("bandit: best arm dominates", picks["b"] > 200, f"picks={picks}")
    check("bandit: unknown context still returns an arm", bandit.choose("never-seen") in ("a", "b", "c"))
    bandit.update("ctx", "zzz", 1.0)   # unknown arm must be ignored, not crash
    check("bandit: describe renders", "b" in bandit.describe("ctx"))


def test_entry_features_bounded() -> None:
    cfg = make_cfg(crypto_universe=["BTC-USD"])
    row = _row(100, 106, 99, 105, atr=2.0, vol=900.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0, sma_trend=95.0)
    feats = pt.entry_features(row, cfg, "BTC-USD", +1, T0, sym_ewma_r=0.4)
    check("features: length matches names", len(feats) == len(pt.FEATURE_NAMES))
    check("features: all bounded in [-1, 1]", all(-1.0 - 1e-9 <= f <= 1.0 + 1e-9 for f in feats),
          f"{feats}")
    check("features: bias is 1", feats[0] == 1.0)
    check("features: crypto flag set", feats[pt.FEATURE_NAMES.index("is_crypto")] == 1.0)
    check("features: volume ratio saturates at 5x",
          close_to(feats[pt.FEATURE_NAMES.index("vol_ratio")], 1.0))
    short_feats = pt.entry_features(row, cfg, "TEST", -1, T0, 0.0)
    check("features: direction sign carried", short_feats[pt.FEATURE_NAMES.index("direction")] == -1.0)


def test_shadow_trade_labels_the_model() -> None:
    cfg = make_cfg(enable_adaptive=True, stop_loss_pct=0.10, trail_atr_mult=100.0,
                   take_profit_pct=0.0, vol_contraction_ratio=0.0)
    learner = pt.AdaptiveLearner(cfg)
    row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    d = learner.decide_entry(T0, "TEST", +1, row)
    check("shadow: warm-up decisions are taken at full size", d.take and d.size_mult == 1.0)
    check("shadow: warm-up note explains itself", "warm-up" in d.note)
    learner.register_signal(T0, "TEST", +1, row, d.features, d.context)
    check("shadow: one shadow opened", "TEST" in learner.shadows)
    learner.register_signal(T0, "TEST", +1, row, d.features, d.context)
    check("shadow: no duplicate per symbol", len(learner.shadows) == 1)

    # Price collapses through the 10% stop: shadow exits, model gets a loss label.
    n_before = learner.model.n
    learner.observe_bar("TEST", _row(90, 91, 88, 89, atr=2.0), T0 + timedelta(hours=1))
    check("shadow: closed on stop", "TEST" not in learner.shadows)
    check("shadow: model received one label", learner.model.n == n_before + 1)
    check("shadow: labels counter bumped", learner.labels == 1)
    check("shadow: symbol EWMA went negative", learner.sym_ewma_r.get("TEST", 0.0) < 0)

    # A shadow that never exits is force-labeled after the max bar count.
    cfg2 = make_cfg(enable_adaptive=True, adaptive_shadow_max_bars=5, stop_loss_pct=0.5,
                    trail_atr_mult=100.0, take_profit_pct=0.0, vol_contraction_ratio=0.0)
    l2 = pt.AdaptiveLearner(cfg2)
    d2 = l2.decide_entry(T0, "TEST", +1, row)
    l2.register_signal(T0, "TEST", +1, row, d2.features, d2.context)
    for i in range(5):
        l2.observe_bar("TEST", _row(105, 106, 104, 105, atr=2.0), T0 + timedelta(hours=i + 1))
    check("shadow: expired after max bars", "TEST" not in l2.shadows and l2.model.n == 1)


def test_learner_absolute_floor_veto() -> None:
    """A uniformly pessimistic model is caught by the absolute floor, even when
    every signal ranks the same relative to its peers."""
    cfg = make_cfg(enable_adaptive=True, adaptive_min_samples=5, adaptive_skip_threshold=0.45,
                   adaptive_skip_quantile=0.0, adaptive_exploration=0.0)
    learner = pt.AdaptiveLearner(cfg)
    row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    learner.model.n = 10
    learner.model.w[:] = 0.0
    learner.model.w[0] = -3.0            # p ~ 0.05 for everything
    d = learner.decide_entry(T0, "TEST", +1, row)
    check("floor veto: low-probability signal rejected", not d.take, d.note)
    check("floor veto: counted", learner.vetoes == 1)
    check("floor veto: p reported", d.p_win is not None and d.p_win < 0.1)
    check("floor veto: reason names the floor", "floor" in d.note, d.note)

    learner.model.w[0] = +3.0            # p ~ 0.95 for everything
    d2 = learner.decide_entry(T0, "TEST", +1, row)
    check("floor veto: confident signal taken", d2.take, d2.note)


def test_learner_rank_based_veto_and_sizing() -> None:
    """Vetoing and sizing key off a signal's RANK among recent signals, so they
    keep working when the model's probabilities all cluster near 0.5 — which is
    the normal case, since every signal has already passed the entry gate."""
    cfg = make_cfg(enable_adaptive=True, adaptive_min_samples=5, adaptive_skip_quantile=0.25,
                   adaptive_skip_threshold=0.0, adaptive_exploration=0.0,
                   adaptive_size_min_mult=0.5, adaptive_size_max_mult=1.5)
    learner = pt.AdaptiveLearner(cfg)
    learner.model.n = 100
    # A realistic, tightly-clustered score history around 0.5.
    learner.recent_scores = [0.45 + 0.001 * i for i in range(100)]   # 0.450 .. 0.549
    # Grant demonstrated skill so the size-up gate is open; it is tested separately.
    learner.model.recent = [(0.8, 1.0)] * 40
    check("rank sizing: precondition — skill gate open", learner.has_demonstrated_skill())

    cutoff = learner.quantile_cutoff()
    check("rank veto: cutoff sits at the 25th percentile",
          cutoff is not None and close_to(cutoff, 0.475, 1e-6), f"got {cutoff}")
    check("rank: percentile of a mid score", close_to(learner.score_percentile(0.50), 0.50, 0.02))
    check("rank: percentile of a top score", learner.score_percentile(0.60) > 0.95)

    def decide_with_p(p: float) -> pt.EntryDecision:
        """Force the model to output p by setting the bias only."""
        learner.model.w[:] = 0.0
        learner.model.w[0] = math.log(p / (1 - p))
        row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
                   donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
        before = list(learner.recent_scores)
        d = learner.decide_entry(T0, "TEST", +1, row)
        learner.recent_scores = before      # keep the fixture history stable
        return d

    weak = decide_with_p(0.46)
    check("rank veto: bottom-quartile signal vetoed despite p near 0.5", not weak.take, weak.note)
    check("rank veto: reason names the quantile", "bottom" in weak.note, weak.note)

    strong = decide_with_p(0.549)
    check("rank sizing: top-ranked signal taken", strong.take, strong.note)
    check("rank sizing: top rank gets max multiplier",
          close_to(strong.size_mult, 1.5, 0.05), f"got {strong.size_mult}")

    middle = decide_with_p(0.50)
    check("rank sizing: mid rank gets mid multiplier",
          middle.take and close_to(middle.size_mult, 1.0, 0.1), f"got {middle.size_mult}")

    # Sizing is monotone in rank.
    mults = [decide_with_p(p).size_mult for p in (0.48, 0.50, 0.52, 0.54)]
    check("rank sizing: monotone in rank", all(a <= b for a, b in zip(mults, mults[1:])),
          f"got {mults}")

    # Exploration overrides a veto, at min size.
    cfg_x = make_cfg(enable_adaptive=True, adaptive_min_samples=5, adaptive_exploration=1.0,
                     adaptive_skip_quantile=0.25, adaptive_skip_threshold=0.0)
    lx = pt.AdaptiveLearner(cfg_x)
    lx.model.n = 100
    lx.recent_scores = [0.45 + 0.001 * i for i in range(100)]
    lx.model.w[:] = 0.0
    lx.model.w[0] = math.log(0.46 / 0.54)
    row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    dx = lx.decide_entry(T0, "TEST", +1, row)
    check("explore: vetoed signal still taken when exploring", dx.take and "explore" in dx.note)
    check("explore: at min size", close_to(dx.size_mult, cfg_x.adaptive_size_min_mult))
    check("explore: counted", lx.explores == 1)

    # Warm-up and thin history must not veto anything.
    cold = pt.AdaptiveLearner(make_cfg(enable_adaptive=True, adaptive_min_samples=50))
    d_cold = cold.decide_entry(T0, "TEST", +1, row)
    check("rank veto: silent during warm-up", d_cold.take and "warm-up" in d_cold.note)
    check("rank veto: no cutoff without enough history", cold.quantile_cutoff() is None)
    check("rank: neutral percentile without enough history",
          close_to(cold.score_percentile(0.9), 0.5))


def test_skill_gate_blocks_sizing_up() -> None:
    """A model that cannot beat a coin flip must not be allowed to bet bigger.

    Without this gate, size multipliers turn an unskilled model into plain
    leverage: returns and drawdown both rise and it reads as skill. Measured on
    real daily bars this model ran at 44-46% accuracy, so the gate is what
    stands between "adaptive" and "quietly levered".
    """
    cfg = make_cfg(enable_adaptive=True, adaptive_min_samples=5, adaptive_skip_quantile=0.0,
                   adaptive_skip_threshold=0.0, adaptive_exploration=0.0,
                   adaptive_size_min_mult=0.5, adaptive_size_max_mult=2.0,
                   adaptive_min_accuracy_to_size_up=0.52, adaptive_min_accuracy_samples=30)
    row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)

    def learner_with(correct: int, total: int) -> pt.AdaptiveLearner:
        L = pt.AdaptiveLearner(cfg)
        L.model.n = 200
        L.recent_scores = [0.4 + 0.002 * i for i in range(100)]
        # recent holds (predicted p, label); p>=0.5 vs label decides correctness.
        L.model.recent = ([(0.9, 1.0)] * correct) + [(0.9, 0.0)] * (total - correct)
        L.model.w[:] = 0.0
        L.model.w[0] = 5.0            # top of the score range -> would want max size
        return L

    thin = learner_with(20, 20)       # 100% accurate but only 20 samples
    check("skill gate: closed on too few samples", not thin.has_demonstrated_skill())
    check("skill gate: thin history capped at 1.0x",
          close_to(thin.decide_entry(T0, "TEST", +1, row).size_mult, 1.0))

    coin = learner_with(45, 100)      # 45% accuracy, like the real-data result
    check("skill gate: closed below the accuracy threshold", not coin.has_demonstrated_skill())
    d_coin = coin.decide_entry(T0, "TEST", +1, row)
    check("skill gate: unskilled model capped at 1.0x", close_to(d_coin.size_mult, 1.0),
          f"got {d_coin.size_mult}")
    check("skill gate: reason is visible in the note", "gated" in d_coin.note, d_coin.note)

    skilled = learner_with(70, 100)   # 70% accuracy
    check("skill gate: open above the threshold", skilled.has_demonstrated_skill())
    d_skill = skilled.decide_entry(T0, "TEST", +1, row)
    check("skill gate: skilled model may size up", d_skill.size_mult > 1.0,
          f"got {d_skill.size_mult}")

    # Sizing DOWN is always allowed — trimming risk needs no proof of skill.
    shy = learner_with(45, 100)
    shy.model.w[0] = -5.0             # bottom of the range
    d_shy = shy.decide_entry(T0, "TEST", +1, row)
    check("skill gate: sizing down is never gated", d_shy.size_mult < 1.0,
          f"got {d_shy.size_mult}")

    # Threshold 0 disables the gate entirely.
    off = make_cfg(enable_adaptive=True, adaptive_min_accuracy_to_size_up=0.0)
    check("skill gate: disabled at threshold 0",
          pt.AdaptiveLearner(off).has_demonstrated_skill())


def test_size_mult_respects_caps() -> None:
    cfg = make_cfg(position_size_pct=0.4, adaptive_size_max_mult=2.0, risk_per_trade_pct=0.0,
                   allow_fractional_equity=True)
    pf = pt.Portfolio(cfg)
    pf.mark_prices({"TEST": 100.0})
    pos = pf.open_position(T0, "TEST", +1, 100.0, atr=1.0, reason="t", size_mult=5.0)
    check("size cap: multiplier clamped to ADAPTIVE_SIZE_MAX_MULT",
          pos is not None and pos.qty * pos.avg_entry <= 0.4 * 2.0 * 10_000 + 1.0,
          f"notional={pos.qty * pos.avg_entry if pos else None}")
    check("size cap: cash never negative", pf.cash >= 0)


def test_learner_persistence_round_trip() -> None:
    import shutil
    path = "/tmp/paper_trader_test_brain/state.json"
    shutil.rmtree(os.path.dirname(path), ignore_errors=True)
    cfg = make_cfg(enable_adaptive=True)
    a = pt.AdaptiveLearner(cfg)
    a.model.w[:] = np.linspace(-1, 1, len(pt.FEATURE_NAMES))
    a.model.n = 42
    a.model.recent = [(0.6, 1.0), (0.3, 0.0)]
    a.bandit.update("hivol_long", "runner", 1.2)
    a.sym_ewma_r["TEST"] = 0.33
    row = _row(100, 106, 99, 105, atr=2.0, vol=300.0,
               donchian_high=104.0, donchian_low=90.0, vol_avg=100.0)
    d = a.decide_entry(T0, "TEST", +1, row)
    a.register_signal(T0, "TEST", +1, row, d.features, d.context)
    a.signals, a.vetoes = 9, 2
    a.save(path)
    check("persist: file written", os.path.exists(path))
    check("persist: dirty flag cleared", not a.dirty)

    b = pt.AdaptiveLearner(cfg)
    check("persist: load returns True", b.load(path))
    check("persist: weights restored", np.allclose(a.model.w, b.model.w))
    check("persist: sample count restored", b.model.n == 42)
    check("persist: recent history restored", b.model.recent == a.model.recent)
    check("persist: bandit stats restored",
          close_to(b.bandit.stats["hivol_long"]["runner"][1], 1.2))
    check("persist: symbol EWMA restored", close_to(b.sym_ewma_r["TEST"], 0.33))
    check("persist: open shadow restored",
          "TEST" in b.shadows and b.shadows["TEST"].entry_time == T0)
    check("persist: counters restored", b.signals == 9 and b.vetoes == 2)

    # Schema mismatch => refuse to load, stay fresh, don't crash.
    with open(path, encoding="utf-8") as fh:
        bad = json.load(fh)
    bad["feature_names"] = ["something", "else"]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(bad, fh)
    c = pt.AdaptiveLearner(cfg)
    check("persist: schema mismatch rejected", not c.load(path) and c.model.n == 0)

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("{not json")
    check("persist: corrupt file tolerated", not pt.AdaptiveLearner(cfg).load(path))
    check("persist: missing file tolerated", not pt.AdaptiveLearner(cfg).load(path + ".nope"))
    shutil.rmtree(os.path.dirname(path), ignore_errors=True)


def _scripted_frames(cfg: pt.Config, seed: int = 1) -> dict[str, pd.DataFrame]:
    """Deterministic multi-symbol OHLCV fixture with repeated breakouts of both
    kinds — ones that follow through and ones that fail — so the learner has
    something to separate. Test scaffolding only; never used by paper_trader."""
    rng = np.random.default_rng(seed)
    frames = {}
    for sym in ("AAA", "BBB", "CCC"):
        closes, vols = [100.0], [1000.0]
        for i in range(1, 400):
            step = rng.normal(0, 0.4)
            burst = (i % 40 == 0)
            if burst:
                # Half the bursts follow through (drift up), half fail (drift back).
                follow = (i // 40) % 2 == 0
                step += 6.0
                vols.append(4000.0)
                closes.append(closes[-1] + step)
                for _ in range(8):
                    closes.append(closes[-1] + (rng.normal(0.8, 0.3) if follow else rng.normal(-1.0, 0.3)))
                    vols.append(1200.0)
                continue
            closes.append(max(closes[-1] + step, 5.0))
            vols.append(1000.0 + rng.normal(0, 50))
        n = len(closes)
        idx = pd.date_range("2025-01-01", periods=n, freq="1h", tz="UTC")
        c = np.asarray(closes)
        df = pd.DataFrame({"open": c, "high": c * 1.004, "low": c * 0.996, "close": c,
                           "volume": np.asarray(vols[:n])}, index=idx)
        frames[sym] = pt.compute_indicators(df, cfg)
    return frames


def test_engine_adaptive_offline_and_compare() -> None:
    import shutil
    outdir = "/tmp/paper_trader_test_adaptive"
    shutil.rmtree(outdir, ignore_errors=True)
    common = dict(breakout_lookback=10, volume_lookback=10, atr_period=5,
                  use_trend_filter=False, position_size_pct=0.3, max_open_positions=3,
                  allow_fractional_equity=True, stop_loss_pct=0.05, take_profit_pct=0.0,
                  trail_atr_mult=3.0, vol_contraction_ratio=0.0, breakout_buffer_atr=0.0,
                  volume_spike_mult=1.5, adaptive_min_samples=8, adaptive_exploration=0.0,
                  equity_universe=["AAA", "BBB", "CCC"], output_dir=outdir)
    cfg_fixed = make_cfg(enable_adaptive=False, **common)
    cfg_adapt = make_cfg(enable_adaptive=True, **common)
    frames = _scripted_frames(cfg_fixed)

    fixed = pt.Engine(cfg_fixed, os.path.join(outdir, "fixed"))
    fixed.replay_frames(frames)
    adapt = pt.Engine(cfg_adapt, os.path.join(outdir, "adaptive"))
    adapt.replay_frames(frames)

    check("engine/adaptive: fixed run traded", len(fixed.portfolio.closed_trades) > 3,
          f"{len(fixed.portfolio.closed_trades)} trades")
    check("engine/adaptive: learner saw signals", adapt.learner is not None and adapt.learner.signals > 0)
    check("engine/adaptive: learner got labels", adapt.learner is not None and adapt.learner.model.n > 0,
          f"n={adapt.learner.model.n if adapt.learner else None}")
    check("engine/adaptive: model became ready", adapt.learner is not None and adapt.learner.ready)
    check("engine/adaptive: bandit updated on real closes",
          adapt.learner is not None and any(adapt.learner.bandit.stats.values()))
    check("engine/adaptive: trades carry playbooks",
          all(t.playbook in cfg_adapt.exit_playbooks for t in adapt.portfolio.closed_trades))
    check("engine/adaptive: equity never negative",
          all(eq >= 0 for _, eq in adapt.portfolio.equity_curve))
    check("engine/adaptive: brain saved at end of replay", os.path.exists(adapt.brain_path))

    m_fixed = pt.compute_metrics(fixed.portfolio)
    m_adapt = pt.compute_metrics(adapt.portfolio)
    text = pt.render_comparison(m_fixed, m_adapt)
    check("compare: table renders both columns", "fixed rules" in text and "adaptive" in text)
    summary = pt.render_summary(adapt.portfolio, cfg_adapt, m_adapt, adapt.learner)
    check("compare: adaptive summary has learner section", "ADAPTIVE LEARNER" in summary)
    files = pt.write_reports(adapt.portfolio, cfg_adapt, m_adapt, adapt.run_dir, adapt.learner)
    with open(os.path.join(adapt.run_dir, "summary.json"), encoding="utf-8") as fh:
        payload = json.load(fh)
    check("compare: summary.json embeds adaptive state", payload.get("adaptive") is not None)
    trades = pd.read_csv(os.path.join(adapt.run_dir, "trades.csv"))
    check("compare: trades.csv has playbook and R columns",
          {"playbook", "r_multiple", "size_mult"} <= set(trades.columns))

    # Determinism: same seed, same data => identical outcome.
    again = pt.Engine(make_cfg(enable_adaptive=True, **common), os.path.join(outdir, "again"))
    again.replay_frames(frames)
    check("compare: adaptive replay is deterministic under a seed",
          close_to(again.portfolio.equity(), adapt.portfolio.equity(), 1e-6),
          f"{again.portfolio.equity()} vs {adapt.portfolio.equity()}")
    shutil.rmtree(outdir, ignore_errors=True)


def _learnable_frames(cfg: pt.Config, seed: int = 1, n_sym: int = 4,
                      bars: int = 3000) -> dict[str, pd.DataFrame]:
    """Fixture with a DELIBERATELY learnable relationship: breakouts on a big
    volume spike follow through, breakouts on a small one fail.

    This exists to prove the learning pipeline can find a real relationship when
    one is present. It is NOT evidence about live markets — real breakouts come
    with no such guarantee, and this fixture is synthetic scaffolding, never a
    data source for paper_trader itself."""
    rng = np.random.default_rng(seed)
    out: dict[str, pd.DataFrame] = {}
    for s in range(n_sym):
        closes, vols, i = [100.0], [1000.0], 1
        while len(closes) < bars:
            if i % 25 == 0:
                strong = rng.random() < 0.5
                vols.append(6000.0 if strong else 1600.0)
                closes.append(closes[-1] + 5.0)
                for _ in range(10):
                    drift = rng.normal(0.9, 0.3) if strong else rng.normal(-0.9, 0.3)
                    closes.append(max(closes[-1] + drift, 5.0))
                    vols.append(1100.0)
            else:
                closes.append(max(closes[-1] + rng.normal(0, 0.4), 5.0))
                vols.append(1000.0 + rng.normal(0, 40))
            i += 1
        c = np.asarray(closes[:bars])
        idx = pd.date_range("2025-01-01", periods=bars, freq="1h", tz="UTC")
        out[f"S{s}"] = pt.compute_indicators(pd.DataFrame(
            {"open": c, "high": c * 1.004, "low": c * 0.996, "close": c,
             "volume": np.asarray(vols[:bars])}, index=idx), cfg)
    return out


def test_learner_finds_a_real_relationship() -> None:
    """End-to-end: on data where volume genuinely predicts follow-through, the
    model should learn a positive volume weight, actually veto weak signals, and
    lift the win rate versus the same rules with learning off."""
    import shutil
    outdir = "/tmp/paper_trader_test_learnable"
    shutil.rmtree(outdir, ignore_errors=True)
    common = dict(breakout_lookback=10, volume_lookback=10, atr_period=5,
                  use_trend_filter=False, position_size_pct=0.25, max_open_positions=4,
                  allow_fractional_equity=True, stop_loss_pct=0.05, take_profit_pct=0.0,
                  trail_atr_mult=3.0, vol_contraction_ratio=0.0, breakout_buffer_atr=0.0,
                  volume_spike_mult=1.4, adaptive_min_samples=40, adaptive_exploration=0.05,
                  equity_universe=[f"S{i}" for i in range(4)], output_dir=outdir)
    cfg_f = make_cfg(enable_adaptive=False, **common)
    cfg_a = make_cfg(enable_adaptive=True, **common)

    better, vetoed_any, weights = 0, 0, []
    for seed in (1, 2, 3, 4):
        frames = _learnable_frames(cfg_f, seed=seed)
        f = pt.Engine(cfg_f, os.path.join(outdir, f"f{seed}"))
        f.replay_frames(frames)
        a = pt.Engine(cfg_a, os.path.join(outdir, f"a{seed}"))
        a.replay_frames(frames)
        mf, ma = pt.compute_metrics(f.portfolio), pt.compute_metrics(a.portfolio)
        better += ma["win_rate_pct"] > mf["win_rate_pct"]
        vetoed_any += (a.learner.vetoes > 0)
        weights.append(float(a.learner.model.w[pt.FEATURE_NAMES.index("vol_ratio")]))

    check("learnable: model puts positive weight on volume on every seed",
          all(w > 0 for w in weights), f"weights={[round(w, 2) for w in weights]}")
    check("learnable: veto engages on most seeds", vetoed_any >= 3,
          f"vetoed on {vetoed_any}/4 seeds")
    check("learnable: win rate improves on most seeds", better >= 3,
          f"improved on {better}/4 seeds")
    shutil.rmtree(outdir, ignore_errors=True)


def test_adaptive_config_validation() -> None:
    bad = {
        "skip threshold >= 1": {"adaptive_skip_threshold": 1.0},
        "exploration > 1": {"adaptive_exploration": 1.5},
        "min mult > 1": {"adaptive_size_min_mult": 1.2},
        "max mult < 1": {"adaptive_size_max_mult": 0.9},
        "size * max mult > 100%": {"position_size_pct": 0.6, "adaptive_size_max_mult": 2.0},
        "learning rate 0": {"adaptive_learning_rate": 0.0},
        "too few samples": {"adaptive_min_samples": 1},
        "playbooks without base": {"exit_playbooks": {"x": {"trail_mult": 1, "stop_mult": 1, "tp_mult": 1}}},
        "playbook with zero stop": {"exit_playbooks": {"base": {"trail_mult": 1, "stop_mult": 0, "tp_mult": 1}}},
        "negative risk per trade": {"risk_per_trade_pct": -0.01},
        "negative breakout buffer": {"breakout_buffer_atr": -1.0},
    }
    for label, overrides in bad.items():
        try:
            pt.validate_config(make_cfg(**overrides))
            check(f"adaptive validation: rejects {label}", False, "no error raised")
        except pt.ConfigError:
            check(f"adaptive validation: rejects {label}", True)

    cfg = pt.apply_max_risk_profile(pt.build_config())
    try:
        pt.validate_config(cfg)
        check("adaptive validation: max-risk profile with adaptive knobs still valid", True)
    except pt.ConfigError as exc:
        check("adaptive validation: max-risk profile with adaptive knobs still valid", False, str(exc))
    check("adaptive validation: max-risk lowers the veto threshold",
          cfg.adaptive_skip_threshold < pt.build_config().adaptive_skip_threshold)


def test_cli_adaptive_flags() -> None:
    args = pt.parse_args(["--replay", "--compare", "--no-adaptive", "--seed", "5",
                          "--brain", "/tmp/x.json", "--fresh-brain"])
    cfg = pt.apply_cli_overrides(pt.build_config(), args)
    check("cli: --no-adaptive disables", not cfg.enable_adaptive)
    check("cli: --seed applied", cfg.adaptive_seed == 5)
    check("cli: --brain becomes absolute path", cfg.adaptive_state_file == "/tmp/x.json")
    try:
        pt.parse_args(["--compare"])
        check("cli: --compare without --replay rejected", False, "no error")
    except SystemExit:
        check("cli: --compare without --replay rejected", True)


def test_csv_feed() -> None:
    """The local-CSV source: flexible columns, split adjustment, clean errors."""
    import shutil
    d = "/tmp/paper_trader_test_csv"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)

    # A 2:1 split: raw close halves, but Adj Close makes the series continuous.
    rows = ["Date,Open,High,Low,Close,Volume,Adj Close"]
    for i in range(60):
        if i < 30:
            px, adj = 100.0 + i, (100.0 + i) / 2
        else:
            px, adj = (100.0 + i) / 2, (100.0 + i) / 2
        rows.append(f"2024-01-{i % 28 + 1:02d},{px},{px * 1.01},{px * 0.99},{px},1000,{adj}")
    # Distinct dates so nothing is deduplicated away.
    rows = [rows[0]] + [
        f"{pd.Timestamp('2024-01-01') + pd.Timedelta(days=i):%Y-%m-%d},"
        f"{(100.0 + i) if i < 30 else (100.0 + i) / 2},"
        f"{((100.0 + i) if i < 30 else (100.0 + i) / 2) * 1.01},"
        f"{((100.0 + i) if i < 30 else (100.0 + i) / 2) * 0.99},"
        f"{(100.0 + i) if i < 30 else (100.0 + i) / 2},1000,{(100.0 + i) / 2}"
        for i in range(60)
    ]
    with open(os.path.join(d, "TEST.csv"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + "\n")

    cfg = make_cfg(data_source="csv", csv_dir=d, bar_interval="1d", history_period="max",
                   equity_universe=["TEST"], crypto_universe=[])
    feed = pt.make_feed(cfg)
    check("csv feed: factory returns CsvFeed", isinstance(feed, pt.CsvFeed))
    df = feed.fetch("TEST")
    check("csv feed: all rows loaded", len(df) == 60, f"got {len(df)}")
    check("csv feed: columns normalized",
          list(df.columns) == ["open", "high", "low", "close", "volume"])
    check("csv feed: index is tz-aware UTC", str(df.index.tz) == "UTC")
    # Adjusted series must be continuous across the split.
    jump = df["close"].pct_change().abs().max()
    check("csv feed: split removed by adjustment", jump < 0.05,
          f"largest bar-to-bar move {jump:.1%} — split not adjusted")
    check("csv feed: adjusted close matches the adj column",
          close_to(float(df["close"].iloc[0]), 50.0, 1e-6), f"got {df['close'].iloc[0]}")

    # Lowercase/alias headers and a missing volume column.
    with open(os.path.join(d, "ALT.csv"), "w", encoding="utf-8") as fh:
        fh.write("timestamp,open,high,low,close\n")
        for i in range(40):
            p = 10.0 + i
            fh.write(f"{pd.Timestamp('2024-01-01') + pd.Timedelta(days=i):%Y-%m-%d},"
                     f"{p},{p * 1.01},{p * 0.99},{p}\n")
    alt = feed.fetch("ALT")
    check("csv feed: alias date column accepted", len(alt) == 40)
    check("csv feed: missing volume filled with 0", close_to(float(alt["volume"].iloc[0]), 0.0))

    # Case-insensitive filename lookup.
    check("csv feed: symbol case tolerated", len(feed.fetch("test")) == 60)

    # Failure modes are DataUnavailable, never a crash.
    for sym, label in (("NOPE", "missing file"),):
        try:
            feed.fetch(sym)
            check(f"csv feed: {label} raises DataUnavailable", False, "no error")
        except pt.DataUnavailable:
            check(f"csv feed: {label} raises DataUnavailable", True)
    with open(os.path.join(d, "BAD.csv"), "w", encoding="utf-8") as fh:
        fh.write("foo,bar\n1,2\n")
    try:
        feed.fetch("BAD")
        check("csv feed: no date column raises DataUnavailable", False, "no error")
    except pt.DataUnavailable:
        check("csv feed: no date column raises DataUnavailable", True)

    # HISTORY_PERIOD trims relative to the newest bar in the file.
    cfg_short = make_cfg(data_source="csv", csv_dir=d, bar_interval="1d",
                         history_period="30d", equity_universe=["TEST"], crypto_universe=[],
                         breakout_lookback=5, volume_lookback=5, atr_period=3,
                         use_trend_filter=False)
    trimmed = pt.make_feed(cfg_short).fetch("TEST")
    check("csv feed: history_period trims the window", len(trimmed) < 60,
          f"got {len(trimmed)}")

    # Config validation catches a bad directory.
    try:
        pt.validate_config(make_cfg(data_source="csv", csv_dir="/does/not/exist"))
        check("csv feed: bad CSV_DIR rejected at startup", False, "no error")
    except pt.ConfigError:
        check("csv feed: bad CSV_DIR rejected at startup", True)
    try:
        pt.validate_config(make_cfg(data_source="nope"))
        check("csv feed: unknown DATA_SOURCE rejected", False, "no error")
    except pt.ConfigError:
        check("csv feed: unknown DATA_SOURCE rejected", True)

    # A csv-sourced engine can replay end to end.
    engine = pt.Engine(cfg_short, "/tmp/paper_trader_test_csv/run")
    engine.run_replay()
    check("csv feed: engine replays from disk without network",
          len(engine.portfolio.equity_curve) > 0)
    shutil.rmtree(d, ignore_errors=True)


def test_no_brokerage_surface() -> None:
    """Static guard: nothing in this file should look like live order routing."""
    with open(pt.__file__, encoding="utf-8") as fh:
        source = fh.read().lower()
    banned = ["api_key", "api_secret", "apikey", "secret_key", "access_token",
              "alpaca", "ibapi", "ib_insync", "binance", "coinbase", "oauth",
              "place_order", "submit_order", "requests.post", "session.post"]
    hits = [term for term in banned if term in source]
    check("safety: no brokerage/credential surface in the source", not hits,
          f"found {hits}")


# =============================================================================

def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            _failures.append(f"{fn.__name__} raised {type(exc).__name__}: {exc}")

    print()
    if _failures:
        print(f"FAILED — {len(_failures)} check(s) failed, {_passes} passed:\n")
        for f in _failures:
            print(f"  FAIL  {f}")
        print()
        return 1
    print(f"OK — all {_passes} checks passed across {len(tests)} test groups.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
