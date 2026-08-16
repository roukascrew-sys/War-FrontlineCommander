# Frontline Commander — Complete Unit & Synergy Tier List

**As of v1.22.0.** Every unit, every commander power, every secret, ranked — plus the combos
that matter, because in this game a unit's tier is mostly decided by what it's standing next
to.

Ratings are read off the actual stat tables and the damage matrix, then sanity-checked
against headless simulation. Where I'm uncertain I say so rather than inventing confidence.

---

## How to read this

**The counter web is the game.** Damage type × armour class decides almost everything:

| | vs INF | vs LIGHT | vs HEAVY | vs AIR | vs STRUCT |
|---|---|---|---|---|---|
| **Small arms** | 1.25 | 0.70 | **0.28** | 0.55 | 0.35 |
| **Armour-piercing** | 0.60 | 1.35 | **1.70** | 0.55 | 0.85 |
| **High explosive** | 1.30 | 1.15 | 0.72 | **0.30** | **1.45** |
| **Anti-air** | 0.35 | 0.50 | 0.30 | **2.40** | 0.20 |

Three consequences worth internalising before anything below:

1. **Small arms cannot hurt heavy armour** (0.28). A wall of riflemen loses to two tanks.
2. **HE is the only thing that levels bases** (1.45) — and is nearly useless against air (0.30).
3. **AA is a hard specialist** (2.40 vs air, ≤0.50 vs everything else).

**Tiers:** S = warps how you build · A = strong, always considerable · B = solid, situational
· C = needs a specific plan · D = niche or outclassed.

---

## S TIER

### 🚀 AT Team — 38 CP · 32 HP · 24 dmg · AP · 130 rng
*The best cost-per-value unit in the game, and v1.20.0 made it better (was 26 HP / 22 dmg / 120 rng).*

AP damage **×3.0 vs armour** on top of the 1.70 AP-vs-heavy matrix bonus. That stacks to a
tank taking roughly five times what a rifleman deals. For 38 CP.

- **Ceiling:** stops any armour push cold if you have three of them
- **Floor:** 32 HP, and 0.60 AP-vs-infantry means it's badly outmatched by a rifle squad
- **Never field alone.** It's a specialist that dies to the thing it doesn't counter.

**Combos:** AT + Rifle is the cheapest complete front in the game — rifles hold infantry
off, AT deletes anything armoured. AT + Medic turns the fragility into a non-issue.
**Countered by:** Sniper (0.35 vs armour is irrelevant — it's shooting *infantry*),
Artillery, Flame.

### 📵 EW Jammer — 52 CP · 84 HP · jam 0.62 / 152 radius
*Buffed in v1.20.0 (was 74 HP / 0.55 / 135) and now the single highest-leverage support piece.*

It does three separate jobs, and v1.20.0 added a fourth:

1. Suppresses all enemy fire in a large radius
2. Fries drones (`antiDrone`)
3. **Hard-counters Stationary Batteries** — reaches ×2.2 further against a dug-in gun and
   scatters its shots
4. **Enables the smoke pin** — anything in smoke inside its reach is immobile and can't fire

That's four roles on one 52 CP chassis with no weapon. Suppression is multiplicative with
everything you own, which is what makes it S rather than A.

**Combos:** Jammer + **Smoke Screen** is the strongest two-piece combo in the game (see
Specials). Jammer + Tank pushes a suppressed lane that can't shoot back.
**Countered by:** Artillery, Sniper (74→84 HP still isn't much), anything that outranges it.

### 🎯 Sniper — 40 CP · 18 HP · 34 dmg · SA · 210 rng · 24% crit
*The highest raw damage-per-shot of any infantry unit, at a range only artillery beats.*

`vsArmor: 0.35` is a real limitation but the 24% crit chance on a 34-damage shot means it
one-shots most infantry. 210 range means it kills the things that counter your AT teams
before they arrive.

- **Absurd against:** AT Teams, Medics, Jammers, other Snipers — every 18–84 HP support unit
- **Useless against:** anything armoured. Genuinely useless, not "weak".

**Combos:** Sniper behind an IFV screen is the standard "kill their support" package.
**Countered by:** Tank, IFV, anything that closes distance.

---

## A TIER

### 🛡 Tank — 70 CP · 180 HP · 26 dmg · AP · 100 rng · splash 14
The armour benchmark. 180 HP with `heavy` class means small arms deal **0.28** — a rifleman
needs ~24 hits. Splash 14 means it clears infantry while it advances.

**Weakness is specific, not general:** AT Teams and Attack Helis (both AP, both ×2.2–3.0 vs
armour) delete it. Against anything else it's a wall.

**Combos:** Tank + **Support order** (Rank 38) arrives *with* your infantry instead of alone
— fixes armour's biggest failure mode. Tank + Medic is a genuine problem for the AI to solve.
**Countered by:** AT Team, Attack Heli, Kamikaze Drone, Armour Breaker order.

### 🚙 IFV — 48 CP · 108 HP · 18 dmg · SA · 96 rng · splash 6
*Buffed in v1.20.0 (was 96 HP / 16 dmg / 90 rng / 6 splash).*

The most flexible unit in the roster. `light` armour still resists small arms (0.70), splash
shreds infantry, `rof 0.7` counts as **rapid fire** which lets it swat low-flying drones —
one of only three units that can hit air without being AA.

Post-buff it's close to A+. Watch it: 108 HP on a 48 CP chassis with anti-drone utility is a
lot of value, and if IFV spam becomes the default opener that's the number to revisit.

**Combos:** IFV + Sniper (screen + damage). IFV + AT (covers each other's blind spots
completely — this is the classic).
**Countered by:** AT Team, Attack Heli, Artillery.

### 🎆 Artillery — 60 CP · 60 HP · 34 dmg · HE · 230 rng · splash 26
HE with splash 26 at 230 range. Deletes infantry clusters and does **1.45 to structures**.

v1.20.0 changed its strategic role significantly: with three standing orders (Rank 30) it's
now three different units depending on which you pick, and it gained a dedicated hard
counter in the Counter-Battery.

**Combos:** Artillery + **Marching Fire** shells ahead of your advance. Artillery + Jammer
protects the guns from *their* guns.
**Countered by:** **Counter-Battery** (hard), Attack Heli, Kamikaze Drone, anything that
closes.

### 🚁 Attack Heli — 80 CP · 70 HP · 22 dmg · AP · 120 rng · ×2.2 vs armour · flies
Flies over the entire ground war and deletes armour. Only AA, interceptors, other fliers and
rapid-fire units can touch it.

**The check on it is real:** AA Vehicle does **2.40** to air and costs 44 CP. Two AA and
helis stop being a strategy.

**Combos:** Heli + Interceptor (the interceptor clears AA cover... no — it clears *enemy
air*; the heli still needs the AA dead).
**Countered by:** AA Vehicle, Interceptor, IFV/rifle rapid fire (vs low fliers only).

### 🌫 Smoke Screen *(power, Rank 20)* — free, 26s cooldown
*New in v1.20.0.* Blocks LOS **both ways**, walls out kamikaze drones, and pins anything
caught in it inside a jammer's reach.

Rated A on its own and **S in the jammer combo**. The symmetry is what keeps it honest —
you're blinding yourself too, so it's a commitment, not free value.

---

## B TIER

### 🪖 Rifleman — 20 CP · 34 HP · 5 dmg · SA · 70 rng
The cheapest body in the game and the reason every other unit's positioning works. SA does
1.25 to infantry, so rifles beat rifles — but **0.28 vs heavy** means they cannot meaningfully
hurt a tank. Ever.

Rifles are a *screen*, not a win condition. As a screen they're excellent and essentially
mandatory.

**Combos:** Rifle + literally anything. Rifle + Medic is a line that doesn't move backwards.
Rifles are also what Marching Fire artillery anchors to — no infantry, no marching fire.

### 🚨 AA Vehicle — 44 CP · 80 HP · 30 dmg · AA · 150 rng · `onlyAir`
2.40 vs air is the biggest multiplier in the matrix. It also **literally cannot shoot ground
units** — `onlyAir` is absolute.

A pure insurance policy. B tier because its rating is bimodal: S when they bring air, D when
they don't. Two in a mixed force is correct; more is a wasted lane.

### ✚ Medic — 30 CP · 44 HP · heal 10 / 66 radius · `fixCats: inf`
### 🔧 Engineer — 34 CP · 48 HP · heal 11 / 70 radius · `fixCats: veh, arty`
*Split in v1.21.0.* The old 42 CP Medic healed everything; these two each cover half the
roster and cannot cover the other half. Both are cheaper than the unit they replace, so a
single-arm army pays **less** than before and a mixed army pays more — which is the correct
direction, because a mixed army is the stronger army.

Both hold station `SUPPORT_TRAIL` (30px) **behind** whatever they're mending and walk back to
it at 0.55× pace if they drift ahead. That positioning is most of their value: the previous
Medic jogged into the front rank and died before it healed anything worth healing.

With nothing of theirs left alive in the lane they stop being support and **charge** — full
speed, 11–13 melee damage. It's a bad attack on purpose. A support unit standing in an empty
field is a worse outcome than a bad attacker.

Both scale entirely with what they're protecting: an Engineer behind two Tanks is A tier, an
Engineer behind one IFV is C. **Medic + AT Team is the single best CP-for-CP pairing in the
game** at 68 CP total.

**The split's real cost:** an all-armour push that used to travel with one Medic now needs an
Engineer specifically, and an infantry line that wants its Tank repaired needs both. Watch for
this reading as a tax rather than a decision — see *Balance items I'd watch*.

### 🧨 Rocket Artillery — 82 CP · 52 HP · 20 dmg × 4 salvo · HE · 270 rng · splash 30
Four-shell salvo with 30 splash at the longest range in the game. Against a clustered
infantry push it's the highest burst damage available.

**52 HP is the catch.** Anything reaching it kills it instantly, and Counter-Battery
now out-ranges it — though at 265 the rocket battery out-ranges it *back*, which is the trade.

### 🛰 Counter-Battery — 78 CP · 70 HP · 46 dmg · HE · 265 rng · `counterBattery`
*New in v1.20.0, retuned in v1.21.0.* Engages **artillery and nothing else** and suppresses
guns at range (0.75/s, comfortably above the 0.34/s natural decay) so a battery goes quiet
before it dies. **265 range** out-ranges the howitzer's 230 but sits under Rocket Artillery's
270 — at 300 it beat every gun in the game with no reply at all, which is a hard counter with
no counter-play. A rocket player can now trade back.

B tier as a *rating*, but the rating is entirely matchup-dependent: **S against a gun line,
D against anything else.** Against Stationary Batteries (a fixed, known coordinate) and
Bombardment (parks at the edge of *its* range, well inside yours) it's close to a hard
counter. Bring it when you see guns; never bring it blind.

### 💣 Kamikaze Drone — 11 CP · 11 HP · 38 dmg · AP · one-shot · flies
Eleven CP for 38 AP damage (×2.5 vs armour) that flies. Individually disposable; in numbers
genuinely threatening.

**Hard-countered by three separate things:** EW Jammer (`antiDrone`), any rapid-fire unit
(×2.4 vs drones), and now **Smoke Screen** (walls them out entirely). Three counters is a lot
— B rather than A.

**Under the Base Bomber order (v1.21.0) they can no longer close a game.** Drones on that
order flatten an HQ to 1 and stop, exactly like Bombardment; someone who isn't on a suicide
run has to walk in. This was a five-second repeatable win on the lower difficulties, where
the AI didn't defend against it at all. A *normal* drone dive still finishes a base — the
floor is a property of the order, not of the unit.

---

## C TIER

### 🛩 Interceptor — 70 CP · 150 HP · 26 dmg · AA · 150 rng · orbits · `vsAir 3`
150 HP flying with ×3 vs air and a wide orbital patrol — a lasting air shield rather than a
single engagement. C only because it needs enemy air to exist to matter at all. Against a
heli/gunship build it's A.

### ✈ Gunship — 165 CP · 230 HP · 15 dmg · HE · 210 rng · loiters, strafes all lanes
The most expensive unit in the game. Loiters mid-field hitting all three lanes with HE.
Powerful, but 165 CP is nearly three tanks and it **needs interceptor cover** — a lone
gunship against AA is a very expensive delivery of free XP.

### ♨ Flame Trooper — 34 CP · SA · burn DOT (9 dps / 3.5s)
The only damage-over-time in the game, and it refreshes rather than stacking. Strong against
clustered infantry, poor against everything else. The burn's kill credit is correctly
attributed even after the trooper dies (fixed in v1.17.3).

---

## D TIER — situational only

Nothing here is *bad*; each is narrow enough that fielding it without the specific matchup is
a mistake. The 🚨 AA Vehicle drops here against a pure-ground opponent, 🛰 Counter-Battery
drops here against a gun-less one, and 🛩 Interceptor drops here against a grounded one.

**That's a healthy pattern, not a flaw** — these are the units that make scouting matter.

---

## THE SPECIALS

| Power | Rank | CD | Rating |
|---|---|---|---|
| 🎯 Precision Munitions | — | 11s | **A** — fast cycle, reliable, always useful |
| 🚁 Gunship Run | — | 30s | **B** — rakes one lane; needs a target-rich lane |
| 💥 Rolling Barrage | — | 75s | **A** — 60s of walking fire across all three lanes |
| 📡 Recon Flare | — | 20s | **B** — free intel; better in fog/night than clear |
| ⚡ EMP Pulse | 3 | 32s | **A** — near-total lane suppression, free |
| 🌫 **Smoke Screen** | **20** | **26s** | **A alone, S with a jammer** |
| 🛰 **Rods from God** | secret | once | **S** — see below |

### ☢ Rods from God *(secret — clear the Glitch Front)*
Once per battle. Orbital kinetic bombardment across **all three lanes**, 105 damage per
impact with AP typing, ~21 impacts. It is the single most destructive thing in the game and
it is correctly balanced by being once-per-match: it's a "break the game open" button, not a
rotation piece.

**Best used:** on a stalled push where all three lanes are contested, not on a lane you're
already winning.

### 🕳 Drone Swarm *(secret unit — same unlock)*
Rated separately from the Kamikaze Drone because it isn't one. Treat it as an S-tier finisher
in the same category as Rods — it's a reward for clearing the hardest content, and it plays
like one.

---

## COMBOS THAT ACTUALLY CHANGE GAMES

Ranked by how much they outperform their parts.

### 1. 🌫 Smoke + 📵 EW Jammer — *S+*
The best combo in the game. Anything caught in the smoke inside the jammer's 152 radius is
**immobile and cannot fire**. Not suppressed — pinned. It costs one 52 CP unit and one free
power, and it deletes a lane's worth of enemy tempo for its duration.

**Why it's fair:** you're blind in there too, and you have to have set both pieces up in
advance.

### 2. 🚀 AT Team + 🚙 IFV — *S*
The classic, and post-v1.20.0 buffs it's stronger than ever. IFV's splash and small arms
handle infantry (which AT can't), AT's AP handles armour (which IFV can't). Each covers the
exact hole in the other. ~86 CP for a complete front.

### 3. 🛰 Counter-Battery + anything — *S vs guns*
Not a combo so much as a hard read. If they're playing artillery — especially Stationary
Batteries or Bombardment — this single unit invalidates their entire plan from outside their
range.

### 4. 🎆 Artillery (Marching Fire) + 🪖 Rifle screen — *A+*
Marching Fire anchors to your front line, so it *requires* infantry to function. Rifles push,
the barrage walks ahead of them. **Warning:** if your infantry die, the guns go inert — see
`BALANCE_NOTES.md`.

### 5. 🛡 Tank (Support order) + 🪖 Infantry — *A*
Fixes armour's oldest problem. Infantry are faster than tanks in this roster (34 vs 24), so
armour normally arrives alone or late. Support order lets it hurry to the line then pace to
it, so the whole force lands together.

### 6. ✈ Gunship + 🛩 Interceptor — *A (expensive)*
235 CP for the pair. The interceptor clears enemy air so the gunship can loiter. Genuinely
strong and genuinely a lot of your economy — a mid-game investment, not an opener.

### 7. ✚ Medic + 🎯 Sniper / 🚀 AT — *A+*
Both of those are high-damage, low-HP units that die to a stiff breeze. Sustained healing
converts them from trades into sustained damage — and at 30 CP the Medic is now cheap enough
that Medic + AT (68 CP total) is the best CP-for-CP pairing available.

### 7b. 🔧 Engineer + 🛡 Tank — *A*
The armour half of the same idea, and the reason the split exists. 104 CP buys a 180 HP heavy
that keeps being a 180 HP heavy. The Engineer sits 30px behind it and repairs through the
engagement rather than after it.

**The trap:** the Engineer cannot touch your infantry and the Medic cannot touch your tank. An
army that fields both arms and one support unit is worse off than it was in v1.20.0.

### 8. ⚡ EMP + any push — *A*
Free, 32s cooldown, near-total lane suppression. Time it with a tank push and you get a free
window. Under-used because it's not damage.

### 9. 💣 Drone mass + 🌫 *your own* Smoke — *B, and a trap*
Smoke blocks **your** drones too. This is the combo that looks clever and isn't. Listed
because it's the mistake people will make.

---

## Balance items I'd watch

Ordered by how likely they are to need a pass. Full detail with fix options in
`docs/BALANCE_NOTES.md`.

1. **The Medic/Engineer split as a support tax** — this is the one I'd watch first. A mixed
   army now pays 64 CP for support where it paid 42. That's the intended cost, but the failure
   mode is players simply fielding neither and the whole support role going unused. If that
   happens, the fix is *radius*, not price: widen `healR` so one of them covers more of the
   line, rather than making them cheap enough to spam.
2. **One stance and one order change per battle** — now **opt-in**, behind Experimental Mode,
   and off by default as of v1.22.0. Measured over six full battles with a deliberate player:
   40 changes wanted, 7 granted, 33 refused. That is the right feel for someone who wants a
   posture to mean something and the wrong default for someone still learning the postures.
   If it reads as punishing rather than decisive *for the players who opted in*, the dial is
   the Field Reassessment event's frequency, not the budget itself — two free changes would
   put us straight back to micro.
3. **Smoke + Jammer pin** — a *complete* denial effect. I capped it by requiring two pieces
   and by making the smoke symmetrical, but "cannot move and cannot shoot" is the strongest
   crowd control in the game. If it's oppressive, make the pin reduce fire rate by 80% rather
   than stopping it entirely.
4. **AT Team at 38 CP** — was already the best value in the game before I buffed it. Watch
   whether armour becomes unplayable rather than merely counterable.
5. **Base Bomber and Bombardment both flooring at 1 HP** — correct, but it means two of the
   nine standing orders now cannot close a game by themselves. If both feel dead rather than
   supporting, the answer is a *finisher* incentive (bonus for the unit that walks in), not
   removing the floor.
6. **Rifleman vs heavy at 0.28** — working as designed, but new players consistently discover
   this the hard way. Not a balance problem; possibly a *communication* one.

*Resolved since v1.20.0:* the IFV's splash buff (rolled back to 6) and Counter-Battery at 300
range (dropped to 265) were both on this list and both have been acted on.
