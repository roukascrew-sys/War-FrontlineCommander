#!/usr/bin/env python3
"""
"Increase profits" assumes a way to receive money exists. It does not: the only
'donate' string in 12k lines is a fake donation-alert gag. Current revenue
ceiling is $0 at infinite traffic.

This prices each surface that could be installed for $0, and answers the one
spend question honestly: is Steam Direct's $100 defensible?

ALL RATES BELOW ARE ASSUMPTIONS. Indie donation/ad/conversion rates vary by an
order of magnitude. They are set deliberately LOW. The output to trust is the
RANKING and the BREAK-EVEN, not the dollar amounts.
"""
MONTHLY_PLAYS = [500, 2_000, 10_000, 50_000]

SURFACES = {
    # name:                      (setup hrs, $ per 1k plays, notes)
    'itch donate / PWYW':        (0.5, 0.30, 'free, instant, ~0.1-0.5% donate at $2-5'),
    'Ko-fi link (page+Discord)': (1.0, 0.20, 'free; overlaps with itch donations'),
    'HTML5 portal rev-share':    (14.0, 1.60, 'needs their ad SDK - see CSP warning'),
    'portal flat licence':       (14.0, 0.00, 'one-off $200-1500 per portal, not per play'),
    'cosmetic IAP (own store)':  (40.0, 2.50, 'needs a backend + payments - NOT free'),
}

print("MONTHLY REVENUE BY SURFACE (assumed rates, deliberately conservative)\n")
hdr = f"{'surface':<28}" + "".join(f"{p:>10,}" for p in MONTHLY_PLAYS) + f"{'setup h':>9}"
print(hdr); print("-" * len(hdr))
for name, (hrs, per_k, _) in SURFACES.items():
    row = f"{name:<28}"
    for p in MONTHLY_PLAYS:
        row += f"${p/1000*per_k:>9,.0f}"
    print(row + f"{hrs:>9.0f}")

print("\nNOTE: at today's ~32 plays/month EVERY row is $0. Traffic is the")
print("binding constraint, not the surface. But a surface takes <1 hour and")
print("earns nothing until it exists, so it is still the correct first move.\n")

print("=" * 66)
print("THE $100 QUESTION — Steam Direct\n")
PRICE, CUT = 4.99, 0.30
net = PRICE * (1 - CUT)
print(f"  Net per sale at ${PRICE:.2f} after Steam's {CUT:.0%}: ${net:.2f}")
print(f"  Sales needed to recoup $100: {100/net:.0f}\n")
print(f"  {'store visits':>13} {'@2% conv':>10} {'@6% conv':>10} {'@12% conv':>10}")
for v in (500, 1500, 5000, 15000):
    r = f"  {v:>13,}"
    for c in (0.02, 0.06, 0.12):
        r += f"{v*c*net:>10,.0f}"
    print(r.replace('  ', ' $', 1) if False else r)
print("\n  (cells are $ revenue; anything under $100 is a loss)\n")
print("  BREAK-EVEN TRIGGER — do not pay the $100 until BOTH are true:")
print("    1. >=1,500 monthly plays sustained for 2 months (traffic exists at all)")
print("    2. >=150 Discord members or >=8% D7 return rate (an audience exists)")
print("  Rationale: Steam wishlists convert from an AUDIENCE, not from traffic.")
print("  With no audience the $100 buys a page nobody visits, and the real cost")
print("  is not $100 - it is the 30-40 hours of store assets, builds and review.\n")

print("=" * 66)
print("OPPORTUNITY COST — what else is 30-40 hours?\n")
print("  30-40h on Steam prep       -> a store page with no traffic")
print("  44h on residual inventory  -> ~35,000 visits/yr (sim/plan.py)")
print("  6h on the itch page+onramp -> 4x the players from traffic you ALREADY have")
