# Balance notes — Standing Orders (v1.19.0)

> **Update, v1.21.0.** Item 1 below has been resolved, and not by any of the three options
> I listed. Bombardment now grinds an HQ to **1 HP and stops** (`BOMBARD_HQ_FLOOR`), so a gun
> line can flatten a base but never take one — somebody still has to walk in. The same floor
> now applies to drones under **Base Bomber**, which turned out to be the worse offender: on
> the lower difficulties the AI didn't defend against it at all and it was a repeatable
> five-second win.
>
> That is closest in spirit to option 2 (cap the damage) but cleaner: rather than tuning a
> fraction, the order simply cannot deliver the killing blow. It preserves the fantasy
> completely — the base *is* flattened — and removes the non-interactive win by construction
> rather than by number. Worth noting for next time: when a mechanic's problem is "it can win
> without engaging", the fix that worked was changing *what it can do*, not *how much*.
>
> Also since this document was written: orders lost their 30-second cooldown in favour of one
> change per battle, and stance gained the same budget. Anywhere below that reasons about
> swapping orders mid-fight, read "one change, then commit."


Written after implementing and measuring the three arm doctrines. These are the places I
think the system is most likely to break, ranked by how much I'd worry. Numbers come from
headless simulation, not from feel — where I say "measured", there's a probe behind it.

The one design rule everything below is judged against: **every order has to be a genuine
trade, never a straight upgrade.** A strictly-better option isn't a choice, it's a hidden
default that players discover once and then never think about again.

---

## 1. Bombardment is the one I'd watch first 🔴

**Measured:** one Artillery piece with Bombardment, completely unopposed, destroys a
1000 HP HQ in **~120 seconds** (8.3 dmg/sec). Four of them do it in ~30.

I already cut the per-shell multiplier from 0.42 → 0.25 after the first measurement (at
0.42 a *single* gun killed an HQ in ~24s, which made a gun line a faster win condition
than actually attacking). At 0.25 it's defensible, but it's still the order most likely to
need another pass.

**Why it's probably okay:** the guns have to walk to roughly `x = 1040` out of 1280 — deep
into enemy territory — and they're slow (spd 12) and fragile (60 HP). Against any real
defence they die on the way. The order is self-limiting *if* the enemy has units in the
lane.

**Why it might not be:** that "if" is doing a lot of work. Against a passive or
badly-positioned AI, or in a lane the enemy has abandoned, it's an uncontested clock. The
failure mode is a stalemate where neither side can push, and bombardment quietly wins on
timer without any interaction — the least interesting way a match can end.

**If it needs a nerf, in order of preference:**
1. Make bombardment shells damage the HQ **only while that lane is contested** (no friendly
   or enemy units in lane = no effect). Directly targets the boring case.
2. Cap total HQ damage from bombardment at some fraction (say 60%) so it can never be the
   killing blow — it becomes a softener, not a win button.
3. Drop the multiplier again (0.25 → 0.18). Simplest, but blunt.

I'd take option 1. It preserves the fantasy and kills the degenerate case specifically.

---

## 2. Marching Fire has a self-reinforcing failure state 🟠

Marching Fire sets up behind your front line and shells ahead of it. If your front line
**dies**, there is no front line — so the guns have nothing to anchor to.

Current behaviour: with no friendly unit in the lane, `friendlyFrontX` returns null and the
guns fall back to holding near their start position, firing at nothing (the targeting
branch requires a front to aim ahead of). So a collapsed lane means your artillery stops
contributing entirely, exactly when you most need it.

That's arguably correct — it's an order that depends on having infantry — and the picker
does say "it will not defend the guns themselves". But it's a **cliff**, not a slope: the
order goes from fully effective to completely inert the moment the last friendly in that
lane dies, and the player gets no signal about why.

**Suggested fix if it plays badly:** fall back to normal targeting when the lane has no
friendly front, rather than idling. Keeps the order honest (it still won't advance) without
the all-or-nothing edge.

---

## 3. Armour Breaker can be baited 🟠

Breaker treats armoured targets as an **absolute** priority (I had to make it absolute —
a ×4 distance multiplier wasn't enough, a rifle 70px away still beat a tank 300px away, so
the order silently did nothing in exactly the situation it exists for).

Absolute priority means a single cheap IFV can pull your entire tank line across a lane
while infantry walk past unopposed. Against a human that's an exploit; against the current
AI it'll happen by accident sometimes.

**Watch for:** tanks visibly ignoring a rifle squad chewing on them to chase an IFV. If
that reads as broken rather than as the stated cost, add a proximity override — engage
anything within ~40% of range regardless of class.

---

## 4. Stationary Batteries vs. the jammer counter 🟡

The counter works (measured: a jammer at 200px disrupts a battery at 150px, triples shot
scatter and adds suppression). My concern is the opposite direction: **is the counter too
strong?**

Enemy jammers reach `135 × 2.2 = 297px` against a dug-in battery. That's a large area, and
the AI builds jammers on its own weighting. If the AI happens to field two, a battery
strategy may be dead on arrival through no decision of the player's.

**Watch for:** batteries feeling unusable rather than counterable. If so, drop
`GROUP_JAM_MULT` from 2.2 → 1.6, which still makes jammers the answer without making them
an off-switch.

Also note this is currently the **only** order with a dedicated hard counter. That's an
asymmetry worth being deliberate about — either the others should get one, or batteries
should be understood as the "high ceiling, hard counter" option by design. I'd argue the
latter, but it should be a decision rather than an accident.

---

## 5. Support armour needed a speed allowance, which bends a rule 🟡

"Move in front with infantry without outpacing them" can't be implemented as a speed *cap*,
because **infantry are already faster than armour** in this roster (rifle 34 vs tank 24,
IFV 30). A cap would never bind and the order would do nothing.

So supporting armour gets up to **1.5× speed while catching up** to the infantry line, then
holds station. That works and measures correctly (peak lead 33px against a 34px cap), but
it's the first thing in the game that changes a *stat* rather than only behaviour — stances
are explicitly "behaviour only, never stats", and this sits next to them.

**The trade that justifies it:** the armour gives up ever leading a breakthrough alone. But
if this ever feels like a free buff, the honest alternative is to slow the *infantry* to the
armour instead of speeding the armour — same "arrive together" outcome, no stat inflation,
but a bigger tempo cost the player might not expect.

---

## 6. HVT Hunter probably wants a floor 🟡

HVT ranks purely by `maxHp` and ignores everything else. Two consequences:

- Against an all-infantry wave it picks the healthiest *rifleman* — technically correct,
  practically indistinguishable from normal behaviour, so the order feels like it does
  nothing in that matchup.
- Veterancy raises `maxHp`, so an Elite rifle can outrank a fresh IFV. That's arguably a
  feature (it *is* the highest-value target), but it will read as odd.

Not urgent. If it needs tuning, rank by `maxHp × cost` instead of `maxHp` alone — closer to
what "high value" actually means to a player.

---

## 7. Evasion is a flat multiplier and may be too generous 🟡

Evasive drones (HVT Hunter and Base Bomber) read as `×2.6` further away to enemy targeting.
That's a big number — it means an evasive drone at 100px is treated like one at 260px, so
it's picked last by almost everything.

Combined with Base Bomber ignoring troops entirely, a drone swarm on Base Bomber may be
very hard to stop while contributing nothing defensively. Whether that's balanced depends
on whether the HQ damage of a drone swarm is worth the total loss of lane presence — I
haven't measured a full drone-rush game, and that's the obvious next test.

---

## 8. Things I deliberately did *not* do

- **The AI does not get standing orders.** Giving it the same toolkit would change the
  tuning of every difficulty tier and the entire Gauntlet ladder at once. If the AI ever
  gets them, it needs its own balance pass, not a shared one.
- **Orders persist between battles.** They're a loadout choice, not an in-fight reaction.
  All three still default to off for everyone.
- **One change per 30 seconds, shared across all three arms.** Without this, orders become
  another micro-management channel — swap to Breaker when armour appears, swap back after —
  which is the opposite of a "standing order". The cooldown is what makes committing to a
  doctrine an actual decision.

---

## Quick reference — what to change if X

| Symptom | Change |
|---|---|
| Matches ending on a bombardment timer | Require a contested lane (option 1 above) |
| Artillery going inert when a lane collapses | Marching Fire falls back to normal targeting |
| Tanks ignoring what's killing them | Breaker gets a proximity override (~40% range) |
| Batteries feeling unusable | `GROUP_JAM_MULT` 2.2 → 1.6 |
| Support armour feeling like a free buff | Slow the infantry instead of speeding the armour |
| HVT feeling like it does nothing | Rank by `maxHp × cost` |
| Drone rushes unstoppable | `GROUP_EVADE_PENALTY` 2.6 → 1.8 |

All of these constants are named at the top of the `GROUP DOCTRINES` block in
`wargame.html`, so any of them is a one-line change.
