#!/usr/bin/env python3
"""Verification suite for paper_trader.py.

Run:  python test_paper_trader.py

The OHLCV frames below are hand-built fixtures with known-good expected values.
They exist ONLY to verify accounting and control flow — paper_trader.py itself
never generates prices and always pulls real market data from yfinance.
"""

from __future__ import annotations

import math
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
