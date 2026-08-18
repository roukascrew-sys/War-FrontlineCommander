#!/usr/bin/env python3
"""
Does spreading effort across channels beat committing to one?

The brief was "you stuck to the same path and don't experiment". That is a
testable claim, not a vibe, so this tests it.

MODEL
  A solo dev has a fixed budget of ATTEMPTS per month (one attempt = one post,
  one video, one outreach email, one submission). Each attempt in a channel:
      - hits with probability p_hit(channel, experience_in_that_channel)
      - if it hits, returns a LOGNORMAL number of visits (heavy tail: most hits
        are small, a rare one is enormous). Heavy tails are the whole reason
        this question is interesting.
  Specialising is not free to abandon: p_hit rises with reps in the SAME channel
  (a learning curve), which is the real argument for concentration.

EVERY NUMBER BELOW IS AN ASSUMPTION, not a measurement. They are set to be
pessimistic-to-middling and are all tunable. What matters is not the absolute
output but which STRATEGY wins across a wide sweep of assumptions - that
conclusion turns out to be very stable, which is the actual finding.
"""
import random, math, statistics

random.seed(7)

# name: (base hit rate, lognormal mu, lognormal sigma, learning cap multiplier)
# mu/sigma are on log(visits). sigma>1.4 = genuinely heavy tailed.
CHANNELS = {
    'reddit_niche':   (0.18, 4.2, 1.5, 2.0),   # r/incremental_games, r/WebGames...
    'reddit_big':     (0.04, 6.0, 1.9, 1.6),   # r/gaming, r/pcgaming - rare, huge
    'shortform_video':(0.06, 5.4, 2.1, 2.4),   # TikTok/Shorts/Reels - heaviest tail
    'hn_devto':       (0.09, 5.0, 1.7, 1.8),   # dev-audience writeups
    'portals':        (0.30, 5.6, 1.0, 1.3),   # HTML5 portal submissions - reliable, capped
    'streamer_dm':    (0.07, 4.8, 1.6, 2.2),   # direct creator outreach
    'itch_events':    (0.22, 4.0, 1.2, 1.5),   # jams, itch sales/bundles, tag surfing
    'forums_discord': (0.15, 3.6, 1.3, 1.7),   # niche communities, Discord servers
}
NAMES = list(CHANNELS)

def p_with_learning(base, reps, cap):
    """Hit rate improves with reps in the same channel, saturating at base*cap."""
    return base * (cap - (cap - 1.0) * math.exp(-reps / 8.0))

def run_month_plan(k, attempts, months, rng):
    """Spread `attempts` per month evenly over the k channels this dev picked."""
    picks = rng.sample(NAMES, k)
    reps = {c: 0 for c in picks}
    total = 0.0
    for _ in range(months):
        for i in range(attempts):
            c = picks[i % k]
            base, mu, sigma, cap = CHANNELS[c]
            p = p_with_learning(base, reps[c], cap)
            reps[c] += 1
            if rng.random() < p:
                total += rng.lognormvariate(mu, sigma)
    return total

def simulate(k, attempts=12, months=6, trials=20000):
    rng = random.Random(1000 + k)
    out = [run_month_plan(k, attempts, months, rng) for _ in range(trials)]
    out.sort()
    n = len(out)
    return {
        'k': k,
        'mean': statistics.mean(out),
        'median': out[n // 2],
        'p10': out[n // 10],
        'p90': out[9 * n // 10],
        # "flop" = six months of work for less traffic than one decent Reddit post
        'p_flop': sum(1 for v in out if v < 2000) / n,
        # "breakout" = enough traffic to actually change the project's trajectory
        'p_breakout': sum(1 for v in out if v > 50000) / n,
    }

print("SIX MONTHS · 12 attempts/month · 20,000 simulated dev-lifetimes each")
print(f"{'channels':>9} {'median':>9} {'mean':>10} {'p10':>8} {'p90':>10} {'P(flop)':>9} {'P(breakout)':>12}")
for k in range(1, 9):
    r = simulate(k)
    print(f"{r['k']:>9} {r['median']:>9,.0f} {r['mean']:>10,.0f} {r['p10']:>8,.0f} "
          f"{r['p90']:>10,.0f} {r['p_flop']:>8.1%} {r['p_breakout']:>12.1%}")

print("\nSENSITIVITY — does the answer survive a much stronger learning curve?")
print("(if specialising paid off far more, k=1 should start winning)")
for cap_boost in (1.0, 2.0, 3.5):
    saved = dict(CHANNELS)
    for c, (b, mu, sg, cap) in saved.items():
        CHANNELS[c] = (b, mu, sg, 1.0 + (cap - 1.0) * cap_boost)
    best = max(range(1, 9), key=lambda k: simulate(k, trials=6000)['median'])
    print(f"  learning curve x{cap_boost:<4} -> best k by median = {best}")
    CHANNELS.update(saved)
