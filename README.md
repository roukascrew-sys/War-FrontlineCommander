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
python paper_trader.py --replay --source csv --csv-dir data --interval 1d  # offline, your own CSVs
python paper_trader.py --once               # a single live evaluation cycle, then report
python paper_trader.py                      # live paper loop every 5 min; Ctrl+C to stop + report
python paper_trader.py --max-risk           # leverage, shorts, pyramiding (expect a blow-up)
```

**Data sources.** `--source yfinance` (default) pulls over the network.
`--source csv --csv-dir DIR` reads local `<SYMBOL>.csv` files — real data you
already have, no network, which is what you want for reproducible backtests or
behind a restrictive egress policy. Headers are matched case-insensitively with
common aliases, and if an adjusted-close column is present OHLC are rescaled by
`adj_close/close` so splits don't appear as fake breakouts. Both sources are
real data; neither fabricates prices. `csv` is replay-only.

Every run writes `runs/run_<timestamp>/` containing `trades.csv`, `fills.csv`,
`equity_curve.csv`, `summary.json`, and `run.log`. `--validate-only` checks your
config without touching the network; `kill -USR1 <pid>` prints a summary on demand.

## The adaptive layer

On by default (`--no-adaptive` turns it off). Two learners run beside the
strategy, both strictly walk-forward — they only ever use information that
existed at decision time.

**Entry model.** Scores each breakout candidate from features available at that
bar: breakout strength in ATRs, volume ratio and volume trend, prior-range
tightness, extension from trend, volatility percentile in its own history, 20-
and 60-bar momentum, distance from the running extreme, up-streak, close
position within the bar, gap, how stale the breakout is, **Kaufman efficiency
ratio** (net travel over total travel — clean trend versus chop, which is the
difference between a breakout from a base and one out of noise), and two
**cross-sectional** features: the symbol's momentum rank against the rest of the
universe today, and market breadth (the share of the universe above its own
trend). Everything else is single-symbol time series; relative strength and
breadth are a genuinely different axis. Direction-dependent features flip sign
for shorts.

Its veto and rank-sizing are **off by default** — measured, acting on its
ranking costs return (see below). It still runs, and the summary reports what it
would be doing, so you can watch whether it starts earning its keep on your data.

Candidates come from the **range break alone** — the volume and trend
confirmations are left off. This is a plain rule change and does not depend on
the learner (`ADAPTIVE_WIDE_CANDIDATES=False` restores the hand-written gate),
but it came out of the learner: on the strictly-filtered stream the model ranked
at chance because the rules had already removed the variation it would sort on.
Widening the pool turns out to be the largest single improvement in the whole
system, and it is the one the learning was useful for *finding* rather than
performing.

It learns from candidates it could not take as well as ones it did: each opens a
zero-capital **shadow trade** run through the base exits, and that outcome
becomes the training label. Shadows run **concurrently** per symbol — labelling
only whichever candidate arrived while no other shadow was open biased the
training set badly enough to destroy the model's ranking. By default it does
*not* learn from candidates on symbols already held, because that population is
not the one decisions are made about; see the covariate-shift section below.

Vetoing is **rank-based**: it skips the weakest `ADAPTIVE_SKIP_QUANTILE` of
recent candidates rather than applying a fixed score cutoff. That matters —
every candidate reaching the model has already cleared the range break, so raw
scores bunch together and an absolute threshold quietly stops binding. Ranking
depends only on the model ordering candidates correctly, not on it being
calibrated. Position size scales with the same rank, and `ADAPTIVE_EXPLORATION`
still takes a small slice of vetoed candidates at minimum size so the model
keeps getting labels on trades it dislikes.

The threshold is a **stochastic quantile tracker** — nudged down when it rejects
too often and up when it rejects too rarely — rather than a value read off a
sorted window. A static window goes stale as the model's score distribution
drifts. The summary prints the realized veto rate next to the target so you can
see it is honouring the config; the tests assert it holds under a drifting
distribution and on unbounded score scales.

`ADAPTIVE_SKIP_THRESHOLD` (an optional absolute floor, `None` by default) is
scale-dependent and easy to get wrong: for `win` the score is a probability, but
for `expected_r` it is a signed expected-R estimate centred near zero, where a
floor of `0.0` rejects every negative-expectancy candidate — about half — rather
than the configured 15%. That bug is why the default is now `None` and why
validation range-checks the floor only for probability scores.

**Exit bandit.** Thompson sampling over the `EXIT_PLAYBOOKS` presets
(tight/base/runner/loose), keyed by volatility regime × direction and rewarded
by realized R-multiple. It shifts toward whichever exit style has actually been
paying in each regime.

**State persists** to `runs/adaptive_state.json`, so a live run resumes where
the last one left off. Replays start fresh by default (keeping them honest
walk-forward); `--warm-start` loads saved state, `--fresh-brain` ignores it,
`--brain PATH` points somewhere else. A saved file whose feature schema no
longer matches is refused rather than silently misread.

**What the summary tells you.** The `ADAPTIVE LEARNER` block reports the rank
correlation with realized R and a plain-English verdict, the mean R of its
top-ranked 40% against the average candidate, AUC on win/loss, and — for the
`win` model — accuracy against the majority-class baseline and calibration. Rank
correlation is the one to watch: at or below 0 the model is not ranking usefully
and the size gate stays shut. A negative value means it is ranking *backwards*.

**The skill gate.** Size multipliers *above* 1.0x are withheld until the rolling
**rank correlation between the model's score and realized R** clears
`ADAPTIVE_MIN_RANK_CORR_TO_SIZE_UP` (default 0.05, where 0 means no
relationship) over at least `ADAPTIVE_MIN_ACCURACY_SAMPLES` labeled signals —
the objective itself rather than a proxy. Sizing *down* is always allowed:
trimming risk needs no proof. This exists because of a measured result, below.

### Measured on real data

Evaluated on 13 years of real daily bars (AAPL, IBM, MSFT, GOOG, 2000–2013,
~3,270 bars each), using **prequential validation** — every signal is scored
before the model trains on it, so every number is out-of-sample. Features were
developed on AAPL+IBM and validated on MSFT+GOOG, which were held out.

`--compare` runs the same rules with the learner off and on, so with the wide
pool now independent of the learner it isolates **what the learning adds** —
in practice the exit bandit, since the entry model's interventions ship off:

| | learner off | learner on |
|---|---|---|
| Total return | +102.9% | +127.9% |
| Max drawdown | 11.7% | 12.2% |
| Win rate | 44.5% | 47.7% |
| **Avg R-multiple** | **+0.28** | **+0.34** |
| Profit factor | 1.84 | 2.11 |
| Sharpe | 0.78 | 0.84 |
| Rank corr with realized R | — | −0.050 |

Against the original strict-gate rules the same run is +26.4% → +127.9%, but
most of that is the wide pool rather than anything learned — see the
decomposition below. Note the rank correlation of −0.050: the entry model is
ranking at chance on the population it is applied to, and says so.

Ranking quality is stable across time: AUC on win/loss computed *within* each of
8 sub-periods averages 0.72 on dev and 0.72 held-out, with every block above 0.58
including 2008 — so it is not an artifact of scores drifting with the win rate.

**Read the next section before believing this table.** It credits the whole
adaptive layer for a gap that controls show is almost entirely the widened
candidate pool. Note also that rank correlation on this single seed is +0.031,
essentially nothing — an earlier version of this table reported +0.291, which
was inflated by the veto bug described above.

### What actually earns the improvement

The headline table credits the whole adaptive layer. It shouldn't. Adding one
component at a time, 5 seeds each:

| variant | dev | held-out | all four |
|---|---|---|---|
| 1. fixed rules (strict gate) | +9.9% | +14.9% | +26.4% |
| 2. **+ wide candidate pool**, no learner | +56.0 | +30.7 | +102.9 |
| 3. **+ exit bandit** (shipped defaults) | **+63.4 ±14.9** | **+39.9 ±18.2** | **+130.9 ±27.7** |
| 4. + entry veto & rank sizing | +61.9 ±19.0 | +39.4 ±19.7 | +108.5 ±32.9 |
| 5. + correlation sizing 0.5 | +56.2 ±14.6 | +32.4 ±16.0 | +102.4 ±19.4 |

**The wide candidate pool is the single biggest effect** — a rule change, not
learning, and it came from noticing that the strict gate left the model nothing
to rank. **The exit bandit is the one learned component that pays**: step 3 beats
step 2 on return, avg R and Sharpe on all three sets (+7 / +9 / +28 points, with
avg R 0.316/0.303/0.342 against 0.308/0.254/0.284). The effect is roughly
0.5–1σ, consistent in direction everywhere, which is suggestive rather than
conclusive.

**The entry model does not pay, and its interventions are off by default.**
Turning its veto and rank-sizing on (step 4) costs return on all three sets.

### Why the entry model fails: a covariate shift worth understanding

Shadow trades are free, so an obvious improvement is to label *every* candidate,
including ones on symbols already held. Doing that lifted measured rank
correlation from ~0.05 to **+0.507 dev / +0.583 all-four** — a huge jump, and
the controls (random scores, shuffled labels) stayed at 0.00, so the signal is
real.

It also made trading **worse** (dev +43.4 against +56.8, avg R 0.283 against
0.347, drawdown 10.35 against 8.31).

The reason is that those two populations are not the same. A decision is only
ever made about a symbol we are *flat* in, but most candidates arrive while a
position is already open, inside a trend that is already running. The model
learns "trends continue", which is true and highly rankable on the training
population — and close to useless on the subset it is actually applied to.
Training only on the decision population (`ADAPTIVE_LEARN_FROM_HELD = False`,
the default) drops measured rank correlation to **+0.029 dev / −0.041 held-out**
and improves trading.

So the honest reading is that the earlier 0.5 was a measurement on a population
we never act on, and **on the population that matters the entry model has no
demonstrable skill.** Flip `ADAPTIVE_LEARN_FROM_HELD = True` to reproduce both
the impressive number and the worse results.

Earlier controls over 12 seeds — *random scores* and *shuffled labels*, holding
every other moving part fixed — put real learning within noise of both, which
pointed the same way. The test suite runs those controls on a synthetic stream
so the property is enforced rather than remembered.

**Two earlier versions failed, and the failures were the useful part:**

1. *Absolute-probability vetoing never fired.* Every signal reaching the model
   had already passed the entry gate, so probabilities clustered near 0.5 and a
   fixed cutoff silently stopped binding. Fixed by vetoing on **rank**.
2. *The model scored 45% accuracy — worse than the 56% you get by always
   predicting "loss".* An ablation showed selection contributed **nothing**
   (+26.1% vs a +26.4% baseline) and the entire apparent gain came from size
   multipliers, i.e. **betting bigger**: return and drawdown rose together while
   avg R *fell*. Two root causes, both now fixed:
   - **Accuracy was the wrong metric.** With a 44% base rate it is dominated by
     class balance. The gate now uses **AUC**, which matches how the model is
     actually used (ranking) and is immune to the base rate.
   - **The strict entry gate was starving the model**, and shadow trades ran
     **one per symbol at a time**, so most candidates were never labeled and the
     training set was biased. Widening the candidate pool and running shadows
     **concurrently** moved AUC from ~0.44 (chance) to ~0.60–0.70.

**Ranking by expected R.** `ADAPTIVE_SCORE_TARGET` chooses what the model scores
candidates by: `expected_r` (default) is a Huber regression on `tanh(R/2)` that
ranks by predicted payoff; `win` is a logistic on the *sign* of R with each
update weighted by |R|. In the live engine `expected_r` ranks realized R better
on every set — Spearman between score and realized R, and mean R of the
top-ranked 40% as a multiple of the average candidate:

| set | `win` rho / lift | `expected_r` rho / lift |
|---|---|---|
| dev | +0.091 / 1.11× | **+0.220 / 1.70×** |
| held-out | +0.053 / 1.12× | **+0.064 / 1.35×** |
| all four | +0.192 / 1.63× | **+0.226 / 2.12×** |

Returns run the other way and sit near the noise floor: on the combined set
`expected_r` returns +135.1% ±24.1 with avg R +0.349, against `win` at +116.0%
±25.4 and +0.313, with dev and held-out tied. `expected_r` is the default
because it ranks by expected payoff by construction and costs nothing in return.
`--score-target win` switches.

**An earlier version of this table was wrong.** It showed `expected_r` ranking
ahead (rho 0.291 vs 0.200), which was an artefact of the `ADAPTIVE_SKIP_THRESHOLD`
bug described above: the floor was rejecting ~50% of candidates under
`expected_r` and ~11% under `win`, so the two were being compared in different
selection regimes rather than like for like. With the bug fixed, `win` ranks
better on the combined set.

Do not read much into the choice either way — the controls below show the
learned weights barely move trading outcomes at all. A standalone offline
harness, which scores every candidate rather than only those position limits
admit, ranks `win` well ahead (rho ~0.50 vs ~0.35 on dev). Separately, the veto
stays deliberately light (0.15): a sweep found 0.15 beat both no veto and
heavier vetoing on dev *and* held-out, with 0.60 worse than not vetoing at all.

**Judge this by avg R-multiple and AUC, not by total return.** A higher return
with a lower R-multiple is leverage wearing a lab coat — that is exactly how
version 2 fooled itself. The summary prints all three, plus accuracy against the
majority-class baseline, so you can catch it.

Caveats that matter: four large-cap US equities, one 13-year window ending in
2013, long-only in practice, and ~230 labeled signals — AUC 0.60 on that sample
has a confidence interval roughly ±0.06. This is a measurement, not an edge.

### What this does and does not mean

The learner adapts; it does not manufacture an edge. It can only learn what has
recently worked on the symbols it has seen, which makes it *most* exposed
exactly when a regime it has learned ends. On synthetic fixtures with a
deliberately planted relationship it reliably finds it — that is what the test
suite verifies, and it is a test of the machinery, not evidence about markets.
On real markets it now ranks above chance on a held-out set, which is a real
result and a modest one. A better `--compare` number is evidence about that one
window and nothing more.

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

**`CORRELATION_PENALTY`** scales a new position down by its average positive
correlation with what is already held, on the grounds that four correlated names
breaking out together are one bet in four pieces. Measured, it behaves as a pure
de-levering dial: at 0.5 it cut both return and drawdown by roughly the same
proportion and left avg R unchanged, so it is off by default. Turn it on when you
want less risk, not more edge.

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
`ADAPTIVE_MIN_RANK_CORR_TO_SIZE_UP` is the skill gate — lowering it lets an
unproven model bet bigger, which is the most direct way to make this thing
aggressive and also the least honest; `0` disables the gate entirely.
`ADAPTIVE_WIDE_CANDIDATES` decides whether the model or the hand-written rules
choose trades, and is the single biggest behavioural switch in the layer.

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
verification suite (`python test_paper_trader.py`, ~10s) with 352 checks covering
P&L accounting, capital guardrails, exit logic, the calendar, config validation,
the learners' mechanics, the skill gate, the CSV source including split
adjustment, state persistence, and an end-to-end check that the learner finds a
relationship when one is present.
