#!/usr/bin/env python3
"""
The first sim asked "how many channels?" and got a boring answer, because it
assumed every attempt costs the same hour. That is the wrong model for a solo
dev with no money: EFFORT is the only currency, and channels differ enormously
in both cost per attempt and whether the result keeps paying after you stop.

Two kinds of marketing action:
  DECAYING  - a Reddit post, a TikTok, a tweet. Spikes, then dies in ~48h.
              Stop working, traffic goes to zero.
  RESIDUAL  - a portal listing, an itch tag page, a wiki entry, a YouTube
              tutorial that ranks, a Discord bot listing. Placed once, keeps
              trickling forever. Compounding, not spiky.

The question that actually matters: with N hours a month, what mix maximises
traffic at month 12 - and how much of your traffic still exists if you get
sick, bored, or busy for a month?

ASSUMPTIONS, all tunable and all guesses until measured:
  hrs           = hours of work per attempt
  p             = probability an attempt lands at all
  peak          = median visits on the day it lands (lognormal median)
  half_life     = days for daily traffic to halve (999 = effectively permanent)
"""
import math, random, statistics
random.seed(11)

ACTIONS = {
  # name                hrs    p     mu   sigma  half_life(days)
  'reddit_post':      (1.0,  0.18,  4.2,  1.5,     2),
  'shortform_video':  (1.5,  0.06,  5.4,  2.1,     4),
  'devlog_writeup':   (3.0,  0.09,  5.0,  1.7,    14),
  'streamer_dm':      (0.4,  0.07,  4.8,  1.6,     3),
  'portal_submit':    (2.0,  0.30,  4.4,  1.0,   999),   # permanent placement
  'itch_tags_seo':    (1.5,  0.55,  3.2,  0.8,   999),   # permanent discoverability
  'wiki_directory':   (1.0,  0.40,  2.9,  0.9,   999),   # permanent, small
  'jam_entry':        (6.0,  0.45,  4.6,  1.1,   180),   # long tail, not forever
}

DAYS = 365
HOURS_PER_MONTH = 20     # a realistic solo-dev marketing budget alongside dev work

def simulate_mix(weights, trials=4000, abandon_month=None):
    """weights: dict action -> share of monthly hours. Returns traffic stats."""
    tot = sum(weights.values())
    w = {k: v / tot for k, v in weights.items()}
    finals, totals, resid = [], [], []
    for _ in range(trials):
        daily = [0.0] * (DAYS + 1)
        for month in range(12):
            if abandon_month is not None and month >= abandon_month:
                break
            day0 = month * 30
            for act, share in w.items():
                hrs, p, mu, sigma, hl = ACTIONS[act]
                n = (HOURS_PER_MONTH * share) / hrs
                whole = int(n) + (1 if random.random() < (n - int(n)) else 0)
                for _a in range(whole):
                    if random.random() >= p:
                        continue
                    peak = random.lognormvariate(mu, sigma)
                    lam = math.log(2) / hl
                    for d in range(day0, DAYS + 1):
                        daily[d] += peak * math.exp(-lam * (d - day0))
        finals.append(daily[DAYS])          # traffic on the last day
        totals.append(sum(daily))           # traffic over the whole year
        resid.append(daily[DAYS])
    return {
        'total_year': statistics.median(totals),
        'day365': statistics.median(finals),
    }

MIXES = {
  'ALL-IN reddit (the "same path")':      {'reddit_post': 1},
  'ALL-IN short video':                   {'shortform_video': 1},
  'Steam-style push (video+DMs+devlog)':  {'shortform_video': .5, 'streamer_dm': .3, 'devlog_writeup': .2},
  'ALL-IN residual (portals+tags+wiki)':  {'portal_submit': .5, 'itch_tags_seo': .3, 'wiki_directory': .2},
  'BARBELL 60 residual / 40 spiky':       {'portal_submit': .3, 'itch_tags_seo': .2, 'wiki_directory': .1,
                                           'reddit_post': .2, 'shortform_video': .2},
  'BARBELL + one jam a year':             {'portal_submit': .28, 'itch_tags_seo': .17, 'wiki_directory': .08,
                                           'reddit_post': .17, 'shortform_video': .17, 'jam_entry': .13},
}

print("MEDIAN OUTCOMES · 20 marketing-hours/month · 12 months · 4,000 runs each\n")
print(f"{'strategy':<38} {'visits/yr':>11} {'visits on':>11}")
print(f"{'':<38} {'':>11} {'day 365':>11}")
for name, mix in MIXES.items():
    r = simulate_mix(mix)
    print(f"{name:<38} {r['total_year']:>11,.0f} {r['day365']:>11,.0f}")

print("\nBURNOUT TEST — you stop all marketing after month 6.")
print("How much daily traffic still exists at day 365?\n")
print(f"{'strategy':<38} {'day 365':>10} {'% of never-stopping':>21}")
for name, mix in MIXES.items():
    full = simulate_mix(mix, trials=2500)['day365']
    quit6 = simulate_mix(mix, trials=2500, abandon_month=6)['day365']
    pct = (quit6 / full * 100) if full > 0 else 0
    print(f"{name:<38} {quit6:>10,.0f} {pct:>20.0f}%")
