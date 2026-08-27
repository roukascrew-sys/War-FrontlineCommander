#!/usr/bin/env python3
"""
Fixing the previous sim's biggest lie: it let you spend 20 hours a month on
"residual" forever. You cannot. There are a finite number of HTML5 portals,
directories, wikis and tag pages in the world. Residual work is an INVENTORY
you exhaust, not a tap you leave running.

So the real question is not "what mix" but "what ORDER".

Also modelled here:
  - the measured funnel (127 -> 32 -> 17 -> 7), so traffic converts to players
  - what one hour buys at each funnel stage, to rank the work
"""
import math, random, statistics
random.seed(23)

# ---- finite residual inventory: (hours to do, p(lands), median daily visits) ----
RESIDUAL_INVENTORY = [
    ('itch page rebuild (gif, copy, tags, embed)', 4, 0.90,  9),
    ('HTML5 portal submissions x12',              14, 0.55, 22),
    ('web-game directories & wikis x15',           7, 0.45,  5),
    ('itch devlogs x6 (they surface in feeds)',    6, 0.50,  6),
    ('YouTube "how to" / longplay evergreen x3',   9, 0.30, 11),
    ('Discord server listings x8',                 4, 0.35,  4),
]
RESIDUAL_HOURS = sum(r[1] for r in RESIDUAL_INVENTORY)

SPIKY = (1.0, 0.18, 4.2, 1.5, 2)     # hrs, p, mu, sigma, half-life days
HOURS_PER_MONTH = 20
DAYS = 365

def run(order, trials=3000):
    """order='residual_first' or 'spiky_first' or 'blend'"""
    out_year, out_final = [], []
    for _ in range(trials):
        daily = [0.0] * (DAYS + 1)
        inv = list(RESIDUAL_INVENTORY)
        for month in range(12):
            day0 = month * 30
            budget = HOURS_PER_MONTH
            if order == 'residual_first':
                res_share = budget if inv else 0
            elif order == 'spiky_first':
                res_share = 0 if month < 6 else (budget if inv else 0)
            else:                                        # blend 50/50 throughout
                res_share = budget * 0.5 if inv else 0
            # spend on residual inventory
            spent = 0
            while inv and spent < res_share:
                name, hrs, p, dv = inv[0]
                if spent + hrs > res_share:
                    break
                work = min(hrs, res_share - spent)
                spent += work
                if work < hrs:
                    inv[0] = (name, hrs - work, p, dv)
                    break
                inv.pop(0)
                if random.random() < p:
                    for d in range(day0, DAYS + 1):
                        daily[d] += dv * random.lognormvariate(0, 0.5)
            # remainder on spiky posts
            rem = budget - spent
            hrs, p, mu, sigma, hl = SPIKY
            for _a in range(int(rem / hrs)):
                if random.random() < p:
                    peak = random.lognormvariate(mu, sigma)
                    lam = math.log(2) / hl
                    for d in range(day0, DAYS + 1):
                        daily[d] += peak * math.exp(-lam * (d - day0))
        out_year.append(sum(daily)); out_final.append(daily[DAYS])
    return statistics.median(out_year), statistics.median(out_final)

print(f"Residual inventory is finite: {RESIDUAL_HOURS} hours of work, total, ever.")
print(f"At {HOURS_PER_MONTH} h/month that is {RESIDUAL_HOURS/HOURS_PER_MONTH:.1f} months of work.\n")
print(f"{'order of work':<26} {'visits/yr':>11} {'visits day365':>14}")
for o, label in [('residual_first','residual FIRST'),
                 ('blend','blend 50/50'),
                 ('spiky_first','spiky first, residual later')]:
    y, f = run(o)
    print(f"{label:<26} {y:>11,.0f} {f:>14,.0f}")

# ---------------- FUNNEL LEVERAGE ----------------
print("\n" + "="*64)
print("WHERE DOES ONE HOUR BUY THE MOST PLAYERS?")
print("Measured funnel (GoatCounter, v1.17.1, n=127):")
F = {'visit_to_load': 32/127, 'load_to_tut': 17/32, 'tut_done': 4/17, 'load_to_battle': 7/32}
print(f"  visit->load {F['visit_to_load']:.0%} | load->battle {F['load_to_battle']:.0%}\n")

BASE_VISITS = 5000     # a year of modest traffic, for comparison purposes
def players(v2l, l2b):  return BASE_VISITS * v2l * l2b

now = players(F['visit_to_load'], F['load_to_battle'])
print(f"{'intervention':<44} {'hrs':>4} {'players':>9} {'per hour':>9}")
print(f"{'(do nothing)':<44} {'-':>4} {now:>9,.0f} {'-':>9}")
for name, hrs, v2l, l2b in [
    ('itch page: gif first, "no download" line',   4, 0.40, F['load_to_battle']),
    ('itch page + mobile embed + tags',            6, 0.48, F['load_to_battle']),
    ('tutorial hang fix (already shipped)',        0, F['visit_to_load'], 0.45),
    ('both page and on-ramp',                      6, 0.48, 0.45),
    ('2x the traffic, page left broken',          20, F['visit_to_load'], F['load_to_battle']),
]:
    p = players(v2l, l2b) * (2 if '2x the traffic' in name else 1)
    gain = p - now
    per = gain / hrs if hrs else float('inf')
    per_s = f"{per:,.0f}" if hrs else "shipped"
    print(f"{name:<44} {hrs:>4} {p:>9,.0f} {per_s:>9}")
