# War-FrontlineCommander

A paper-trading simulator: **real market data, fake money, no broker.** It pulls
live/historical prices from Yahoo Finance via `yfinance` and runs an aggressive
momentum / volatility-breakout strategy against a simulated account. It never
connects to a brokerage, never authenticates, and never places an order.

> Nothing here is investment advice, and nothing here claims this strategy has
> positive expected value in live markets. Breakout systems like this one
> routinely lose money after costs. `--max-risk` exists to make ruin risk
> visible, not to avoid it.

## How to run

```bash
pip install yfinance pandas numpy
python paper_trader.py --replay     # backtest bar-by-bar over the fetched history
python paper_trader.py --once       # a single live evaluation cycle, then report
python paper_trader.py              # live paper loop every 5 min; Ctrl+C to stop + report
python paper_trader.py --max-risk   # leverage, shorts, pyramiding (expect a blow-up)
```

Every run writes `runs/run_<timestamp>/` containing `trades.csv`, `fills.csv`,
`equity_curve.csv`, `summary.json`, and `run.log`. `--validate-only` checks your
config without touching the network; `kill -USR1 <pid>` prints a summary on demand.

## How to tune risk level

All knobs live in the `CONFIG` block at the top of `paper_trader.py`, above the
`END OF CONFIG` banner. You never need to edit logic to change the risk profile.

**More aggressive** — raise `POSITION_SIZE_PCT` (equity per position),
raise `MAX_GROSS_EXPOSURE` above `1.0` to enable simulated margin, widen
`STOP_LOSS_PCT`, set `TAKE_PROFIT_PCT = 0` to ride winners on the trailing stop
alone, shorten `BREAKOUT_LOOKBACK` and lower `VOLUME_SPIKE_MULT` for twitchier
entries, turn on `ALLOW_SHORTS` and `ALLOW_PYRAMIDING`, and set
`DAILY_LOSS_LIMIT_PCT = 0` to disable the circuit breaker.

**More conservative** — do the opposite: smaller `POSITION_SIZE_PCT`, keep
`MAX_GROSS_EXPOSURE = 1.0` (cash only), tighter `STOP_LOSS_PCT`, longer
`BREAKOUT_LOOKBACK`, higher `VOLUME_SPIKE_MULT`, `USE_TREND_FILTER = True`,
fewer `MAX_OPEN_POSITIONS`, and a non-zero `DAILY_LOSS_LIMIT_PCT`.

**The single biggest lever is `MAX_GROSS_EXPOSURE`.** At `1.0` the account can
never owe money. Above `1.0` you are on simulated margin, and a gap through your
stop can trigger a margin call that liquidates the whole book.

### `--max-risk` mode

Applies the `MAX_RISK_PROFILE` dict (also at the top of the file) over your
config, then re-validates: 3x gross exposure, 50% of equity per position, shorts
on, pyramiding up to 3 adds, no profit target, no daily circuit breaker. It
prompts for confirmation unless you pass `--yes-i-understand-the-risk`. Edit the
dict to define your own profile — unknown keys fail loudly at startup.

## Safety guarantees

- **The simulated balance can never end negative.** In cash-only mode cash never
  goes below zero; with leverage on, a maintenance-margin check liquidates the
  book and floors equity at zero rather than letting the account go negative.
- Oversized orders are **sized down or rejected with a logged reason**, never
  silently truncated.
- Fills apply slippage **against you** on both sides, plus commission. When a bar
  gaps past your stop, you fill at the open — the pessimistic assumption.
- Signals fire on **closed bars only**; indicators are strictly causal.
- Bad config **fails loudly at startup** — including `HISTORY_PERIOD` /
  `BAR_INTERVAL` combinations that yfinance would silently return empty for.
- Missing/stale data, closed markets, and rate limiting are handled per cycle
  (skip + log + exponential backoff), never by crashing.

## Layout

Single file on purpose — the tunables sit at the top, the logic below, and there
is no import path to fight. `test_paper_trader.py` is a dependency-free
verification suite (`python test_paper_trader.py`) covering P&L accounting,
capital guardrails, exit logic, the calendar, and config validation.
