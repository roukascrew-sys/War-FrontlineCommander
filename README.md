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
python paper_trader.py --replay --compare   # fixed rules vs adaptive on the same real bars
python paper_trader.py --once               # a single live evaluation cycle, then report
python paper_trader.py                      # live paper loop every 5 min; Ctrl+C to stop + report
python paper_trader.py --max-risk           # leverage, shorts, pyramiding (expect a blow-up)
```

Every run writes `runs/run_<timestamp>/` containing `trades.csv`, `fills.csv`,
`equity_curve.csv`, `summary.json`, and `run.log`. `--validate-only` checks your
config without touching the network; `kill -USR1 <pid>` prints a summary on demand.

## The adaptive layer

On by default (`--no-adaptive` turns it off). Two learners run beside the
strategy, both strictly walk-forward — they only ever use information that
existed at decision time.

**Entry model.** An online logistic regression scores each breakout signal from
features available at that bar: breakout strength in ATRs, volume ratio,
volatility regime, distance from trend, close position within the bar,
direction, asset class, time of day, and the symbol's recent performance. It
learns from *every* signal, not just the ones that got capital: each signal
opens a zero-capital **shadow trade** run through the base exits, and that
outcome becomes the training label. This is the main reason it learns at a
usable rate — you get labels from signals you skipped and signals you had no
room for.

Vetoing is **rank-based**: it skips the weakest `ADAPTIVE_SKIP_QUANTILE` of
recent signals rather than applying a fixed probability cutoff. That matters —
every signal reaching the model has already passed the entry gate, so the raw
probabilities cluster near 0.5 and an absolute threshold quietly stops binding.
Ranking depends only on the model ordering signals correctly, not on it being
calibrated. Position size scales with the same rank, and
`ADAPTIVE_EXPLORATION` still takes a small slice of vetoed signals at minimum
size so the model keeps getting labels on trades it dislikes.

**Exit bandit.** Thompson sampling over the `EXIT_PLAYBOOKS` presets
(tight/base/runner/loose), keyed by volatility regime × direction and rewarded
by realized R-multiple. It shifts toward whichever exit style has actually been
paying in each regime.

**State persists** to `runs/adaptive_state.json`, so a live run resumes where
the last one left off. Replays start fresh by default (keeping them honest
walk-forward); `--warm-start` loads saved state, `--fresh-brain` ignores it,
`--brain PATH` points somewhere else. A saved file whose feature schema no
longer matches is refused rather than silently misread.

**What the summary tells you.** The `ADAPTIVE LEARNER` block reports rolling
accuracy and a calibration line (mean predicted vs mean realized win rate). If
those two numbers drift apart, the model is confidently wrong and you should
distrust its sizing. Watch it.

### What this does and does not mean

The learner adapts; it does not manufacture an edge. It can only learn what has
recently worked on the symbols it has seen, which makes it *most* exposed
exactly when a regime it has learned ends. On synthetic fixtures with a
deliberately learnable relationship it reliably finds it (that is what the test
suite verifies). On real markets, a better `--compare` number is evidence about
that one window and nothing more.

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

**Sizing now defaults to risk parity.** `RISK_PER_TRADE_PCT` (default 2%) sizes
each position so a stop-out costs about that share of equity, using whichever
stop is nearer — hard or trailing. `POSITION_SIZE_PCT` remains a hard notional
cap on top. Set `RISK_PER_TRADE_PCT = 0` for plain fixed-notional sizing. Raising
it is a more direct aggression lever than `POSITION_SIZE_PCT`, because it scales
with how far away your stop actually is.

**Adaptive knobs.** `ADAPTIVE_SKIP_QUANTILE` sets how much gets filtered (0.25
skips the weakest quarter; `0` disables rank vetoing). `ADAPTIVE_SIZE_MAX_MULT`
sets how hard it presses a high-ranked signal — it is validated so
`POSITION_SIZE_PCT × ADAPTIVE_SIZE_MAX_MULT` can never exceed 100% of equity.
`ADAPTIVE_MIN_SAMPLES` is how many labeled signals it wants before vetoing
anything, and `ADAPTIVE_EXPLORATION` is the fraction of vetoed signals still
taken at minimum size to keep labels flowing.

### `--max-risk` mode

Applies the `MAX_RISK_PROFILE` dict (also at the top of the file) over your
config, then re-validates: 3x gross exposure, 50% of equity per position, 5% of
equity at risk per trade, shorts on, pyramiding up to 3 adds, no profit target,
no daily circuit breaker, and a learner that vetoes less and presses harder. It
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
- Signals fire on **closed bars only**; indicators are strictly causal, and the
  adaptive layer trains only on bars it has already passed — **no lookahead**.
- Bad config **fails loudly at startup** — including `HISTORY_PERIOD` /
  `BAR_INTERVAL` combinations that yfinance would silently return empty for.
- Missing/stale data, closed markets, and rate limiting are handled per cycle
  (skip + log + exponential backoff), never by crashing.

## Layout

Single file on purpose — the tunables sit at the top, the logic below, and there
is no import path to fight. `test_paper_trader.py` is a dependency-free
verification suite (`python test_paper_trader.py`, ~9s) with 248 checks covering
P&L accounting, capital guardrails, exit logic, the calendar, config validation,
the learners' mechanics, state persistence, and an end-to-end check that the
learner actually finds a relationship when one is present.
