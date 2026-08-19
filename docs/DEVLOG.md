# FRONTLINE COMMANDER — Devlog

Written to be **copied straight into an itch.io devlog post**. Newest first. Each entry is
already in prose — headings, bold and lists all paste cleanly into itch's editor.

Keep entries player-facing: what changed and why it matters to someone playing. The
engineering detail lives in the patch notes inside the game and in the commit history.

---

## v1.23.0 — Two commanders who were never on the roster

### 🔊 One audio button

Narrator, Voice, Sound and Music were four separate mute switches sitting in the topbar. They're
now a single **🔊 Audio** button that opens a mixer with a real level for **Master, Music, Effects,
Narrator and Ambience**.

Four on/off toggles became five sliders — and the topbar got *less* cluttered, not more. Mute All
remembers your levels, so unmuting restores your mix instead of resetting everything to full.
Settings now points at the mixer rather than keeping a second, competing copy of the same controls.

### ☠ Legendary+ has its own face

It was borrowing Legendary's cackling skull. Adding more fire would only have been the same idea
louder, so the **ASCENDED** skull changes *what you're looking at* instead: the bone is charred
through, something has split the cranium open from the inside, and what's burning in the sockets
isn't fire.

Horns, fangs, a halo of static, and a jitter that never quite settles. It's also the only tier with
**no cigar** — a lit cigar says a person is enjoying this, and that's the wrong idea entirely.

### 🤪 The Chaos button goes to Chaos

It used to open Settings at the top and leave you to find the switch. It now scrolls straight to
the Chaos row and pulses it.

---

## Two rivals that are not on the roster

### ⌬ THE GLITCH KING

Appears once you've cleared the Glitch Front. It saw you look at it.

It's the only enemy in the game that fights your **interface** rather than your army — phantom
casualties on healthy units, false fog, a greyed screen, a jammed command net. Everything it does
is real, and none of it is your army losing.

It never touches the first twenty seconds, so you always get one clean look at the board before it
starts lying to you.

### ⬤ UMBRA "The Long Dark"

Harder to reach: clear every rival, then **reset the roster** from the Rivals screen. Resetting
keeps your badge, your record and every unlock — it only marks the five fightable again.

UMBRA fields nothing but **null units**:

- **⬤ Wraith** — invisible until it fires, and every hit bleeds Command Points off whatever it hit.
  A recon flare won't find it. It reveals itself for a beat after each shot; that window is your
  only counter-play.
- **⧗ Nullifier** — carries no weapon at all. It simply switches your commander powers **off**
  inside its reach. Ignoring it costs you nothing in damage and everything in options.
- **◇ Effigy** — wears the shape of one of *your* units until it dies, so the board reads wrong.

None of them out-stat you. All three make your information wrong, which is the one resource the
counter web has nothing to say about.

### Beating them pays

- **The Glitch King** yields **⌬ ROLLBACK** (press `Y`) — the only commander power that deals no
  damage. It rewinds your HQ to what it was fifteen seconds ago and refunds the Command Points of
  everything of yours that died in that window. It cannot bring the units back.
- **UMBRA** yields the **⬤ Wraith** as a unit of your own.

---

### 📋 A share line after a Gauntlet clear

One tap copies a line naming the rung, your attempt count, and the thing the Adjutant had *actually*
hardened against — read from its live file on you, so it's true and specific rather than a generic
boast. It spoils nothing and makes no network call.

### Bugfix worth naming

The Golden Drone gag spawned an enemy drone **directly**, walking straight past the one-sided roster
whitelist. An Indoctrination lesson whose entire point was "you will only face infantry" could be
handed a drone, and UMBRA's roster could be broken by a bright gold one. It now falls through to a
supply drop when the enemy roster is restricted.

---

## v1.22.0 — Experimental Mode, Field School, and one way out

This is a build about **restraint**. Last update added a rule that changes how the whole
game is played. This one takes that rule, measures it honestly, and then puts it behind a
switch — because a good rule and a good default are not the same thing.

---

### 🧪 Experimental Mode

There is a new **EXPERIMENTAL** section in Settings. It is **off by default**, and it is
meant to stay that way for most people.

Everything behind it changes how the game is *played* rather than what is *in* it. Nothing
behind it is needed to see any content, unlock anything, or finish anything. Turning it on
or off never touches your progress, and you can flip it back the moment you decide you
don't like it.

**Right now it contains one experiment: ⚑ Doctrine Commitment.**

#### Why it isn't the default

Last build made stance and standing orders one-change-per-battle. Before shipping that as
the way the game works, I played it properly — six full battles with a commander that
re-reads the field every two seconds and only acts on a read it has held for six, which is
roughly how a thoughtful player behaves.

**40 stance changes wanted. 7 granted. 33 refused.**

The budget binds inside the first minute and stays bound for the rest of the fight. That is
*exactly* the intended feel if you want a posture to mean something — you commit, you live
with it, and the fight is decided by the plan you brought. It is also *exactly* the wrong
first experience for someone who is still working out what the three postures even do. Being
told "no" by a rule you haven't learned yet isn't depth, it's a wall.

So: veterans get the rule, newcomers get the game. Same build.

#### One detail worth calling out

**A battle reads the switch once, when it starts.** Settings is reachable from the pause
menu, so reading it live would let someone flip the rules of a fight they were losing — and
would mean a battle could begin permissive and end restrictive. The snapshot makes that
impossible by construction.

#### With it on

- Stance and orders are **free during prep** — try every combination, cost nothing.
- **One change of each** once the line is live.
- The budget is shown **on the row label** (`STANCE · 1 LEFT`) *before* it runs out. Greyed
  chips shouldn't be the first time you learn a rule exists; by then you've already spent it.
- The uncommon **Field Reassessment** event hands one of each back.
- With the switch off, that event now falls through to a supply drop instead of firing a
  no-op nobody would understand.

---

### 🎓 Field School — five new Indoctrination lessons

Indoctrination goes from **nine lessons to fourteen**.

The original nine teach a **doctrine**: here's a playstyle, here's an enemy it beats. The
five new ones teach a **system** — each drops you into the one situation where a mechanic
obviously matters, with the roster cut to just that, and an enemy built to make the point.

| Lesson | Teaches |
|---|---|
| ⚑ **One Plan, One Fight** | Doctrine Commitment |
| 🔧 **Two Kinds Of Repair** | Medic vs Engineer |
| 🛰 **Answer The Guns** | Counter-Battery |
| 🌫 **Blind And Pinned** | Smoke + EW Jammer |
| 💣 **Somebody Has To Walk In** | The HQ floor |

Same rules as the original nine: recruit difficulty, stacked deck, one sentence to leave
with. Losing here teaches nothing, so they're easy on purpose.

**One Plan, One Fight forces Commitment on for itself**, regardless of your Settings switch.
The entire point is to let you *feel* the rule before deciding whether you want it — sending
you to Settings first is the exact friction the opt-in exists to remove. The enemy opens
with infantry and follows with armour, so the posture that beats the opening is not the
posture that beats what comes after it. That's the lesson.

**A lesson also hands you the unit or power it's about, even if your rank hasn't earned it.**
A Counter-Battery lesson whose card a Rank 5 player can't see teaches nothing. This is the
same rule that has always let you play a locked doctrine in the school — and the exemption
does not leak: at the same rank, outside the lesson, the unit is still absent and the power
still refuses to fire.

---

### ⎋ One way out

Every overlay used to own its own exit — a Close button here, a ◀ Back there, and a couple
with neither. Fine until you're three panels deep on a phone.

**Escape now walks exactly one step back** up whatever is stacked:

> crate overlay → modal → orders popover → screen → pause a live battle

It never skips a level and it never quits a battle, so it is always safe to press. Over a
live fight with nothing stacked it pauses — one more step back, still not destructive.

**☰ Menu is now also the Close button.** It sits in the topbar above every panel, so when a
panel is open it's already the button under your thumb. It now closes the top layer first
and only acts as Menu once nothing is stacked. Previously it ignored the panel entirely and
offered to abandon the battle underneath, which is a destructive answer to "close this".

The menu screen itself is never treated as a layer, so Menu can't walk you off the menu.

### 🐞 Dev tools on a key

**Ctrl+Shift+D** opens *and* closes the Debug/Dev panel from anywhere, mid-battle included.
Escape and ☰ Menu close it too. It doesn't fire while you're typing in a field, so entering a
dev code can't toggle the panel out from under you. Backtick is untouched — that's still the
AI thinking overlay.

---

### Also in this build

- **The Engineer has a real sprite.** It had no branch of its own and was falling through to
  the plain infantry body — the same defect the Counter-Battery had last build. It now reads
  as the Medic's opposite number: same silhouette, tool roll on the back, wrench in hand
  instead of a cross on the chest.
- The stance tooltips, the battle hint bar and the tutorial all now say what the commitment
  rule is, when it applies, and that prep is free.

---

## v1.21.0 — Decide, then fight

This build is mostly about one idea: **the plan should be a decision, not a stream of
adjustments.** Prep is now as long as you want it, and what you settle there is what you
take into the fight.

### ⏳ Prep runs until you say go

The old ten-second countdown is gone. The phase now lasts as long as you need — up to three
minutes, so an abandoned tab can't sit frozen forever — and ends the moment you tap.

**CP does not tick during prep.** An open-ended phase that also printed money would just be
a wait with a right answer: sit there for three minutes, start rich. Instead, the income the
old fixed prep would have generated is handed to you **up front**. Your opening wave is
exactly the size it always was. You just get to think about it.

### ⚑ One stance. One change of orders.

> **Updated in v1.22.0:** this rule is now **opt-in**, behind Experimental Mode, and off by
> default. Everything below describes it with the switch turned on.

Stance used to be free and unlimited, which quietly made it a micro channel rather than a
posture — flick to Skirmish while they push, back to Assault the second they stop. Standing
orders had a 30-second timer, which really only said *wait, then micro anyway*.

Both now work the same way:

- **Free during prep.** Try every combination, cost nothing.
- **One change once the line is live.** That's the whole budget.
- A posture you can no longer take **greys out**, so a spent commitment is something you can
  see rather than something you discover at the worst possible moment.

### 📋 Field Reassessment (new event)

An uncommon battlefield event that hands you back one change of stance *and* one change of
orders. It's deliberately uncommon rather than rare — the commitment has to be the normal
experience for it to mean anything, but a fight that's gone completely sideways should
occasionally offer a road back. It can be switched off with the other random events.

### ☠ New difficulty — Legendary+

Not "Legendary with bigger numbers". Its stat line is barely a step above: quality 1.85 →
1.92, economy 2.2 → 2.5. Another +50% economy would only have been a bigger number to
out-grind.

What actually changes is that it's the only difficulty whose AI **plays the game you play**.
It picks a stance for the battle and calls in commander strikes, under exactly your
constraints — one posture for the whole fight, real cooldowns, and fire support telegraphed
the same way yours is. You get the same warning you'd give an opponent.

### ✚🔧 The Medic is now two units

- **✚ Medic — 30 CP.** Patches **infantry**.
- **🔧 Engineer — 34 CP.** Repairs **vehicles and guns**.

Both are cheaper than the single unit they replace, and neither can do the other's job. A
mixed army now wants both, and an all-armour push that used to travel with a Medic has to
actually pay for its own support.

They also behave like support now: they hold station **behind** whatever they're mending and
walk back to it at half pace if they drift ahead, instead of jogging into the front rank and
dying first. And if there's nothing of theirs left alive in the lane, they stop being support
entirely and **charge** — full speed, straight ahead, with a poor little melee attack. It is
meant to be poor. A support unit with nothing to do standing in a field is a worse outcome
than a bad attacker.

### 💣 Base Bomber can't take a base either

Same problem Bombardment had. A drone swarm on that order ignores the enemy army completely,
and on the lower difficulties the AI simply didn't defend against it — a repeatable
five-second win with no engagement in it at all.

Drones under **Base Bomber** now flatten an HQ to 1 and stop, exactly like shelling.
Somebody who isn't on a suicide run has to walk in. A normal drone dive still finishes a base
as it always did — this is a property of the *order*, not of drones.

### Also in this build

- **Skirmish no longer charges for tech tiers.** It's the mode a new player meets first and
  the one everything else is measured against; being the only place you also had to buy your
  way up a tree made the main mode feel unlike the rest of the game. Blitz and Survival keep
  it — both are short-form modes where the escalating unlock *is* the shape of the run.
- **IFV splash back to 6.** The buff landed on what was already the most flexible unit in
  the roster.
- **Counter-Battery range 300 → 265**, just under Rocket Artillery's 270, so a gun player can
  trade back instead of being answered with no reply at all.
- **The Counter-Battery has a real sprite.** It had no branch of its own and was falling
  through to the generic vehicle body, which is why it looked like it came from a different
  game. Same wheels and hull as the rest of the fleet now, with a flat phased-array panel and
  a sweeping track blip.

---

## v1.20.0 — Shelling can't take a base

**Bombardment can no longer win a battle.** Shelling now grinds an enemy HQ down to 1 and
stops there. It can flatten a base; it cannot take one. Somebody still has to walk in and
finish the job — exactly like holding ground needs troops standing on it.

Without that floor, a gun line was a win condition that never had to touch the enemy army,
and a match could end on a timer with no interaction at all. That was the single worst
outcome available in the game and it's now impossible by construction.

### 🛰 New unit — Counter-Battery (Rank 30, 78 CP)

The realistic answer to guns. Real counter-battery works by tracking incoming shells back to
the tube that fired them, so this unit engages **artillery and nothing else**. It out-ranges
every gun in the game (300 vs artillery's 230) and suppresses them at range, so a dug-in
battery goes quiet before it dies.

Against anything that isn't a gun it's a very expensive paperweight. That's the point — it
answers the artillery orders without becoming another general-purpose gun line. It unlocks at
the same rank as the first artillery standing order, because arriving earlier would be
answering nothing.

### 🌫 New power — Smoke Screen (Rank 20, `S`)

Lays a smoke bank across a lane. Three effects:

1. **Blocks line of sight both ways.** That symmetry is what makes placing it a decision
   rather than free value — you're blinding yourself too.
2. **Walls out kamikaze drones.** They stall at the edge instead of crossing. This is what
   makes smoke a genuine answer to a drone rush.
3. **Pins anything caught inside an EW jammer's reach** — immobile, unable to shoot.

That third one is the combo the whole thing is built around. It needs two separate
investments and it's the strongest crowd control in the game. Two units inside the same bank
can still see each other, so smoke never becomes a total combat freeze.

### Rebalance

- **AT Team** — 26→32 HP, 22→24 damage, 120→130 range
- **IFV** — 96→108 HP, 16→18 damage, 90→96 range, 6→8 splash
- **EW Jammer** — 74→84 HP, 0.55→0.62 jam strength, 135→152 radius

The first two answer the pacing help armour got from the Support order. The jammer now
counters artillery stacking, drones *and* enables the smoke pin — three jobs on one chassis
earns more body.

### The Adjutant now uses your toolkit

From the **ANTICIPATING** rung it fights in a stance of its own, chosen against your tempo.
From **RELENTLESS** it issues standing orders to its own guns, armour and drones — drawn from
the same dossier as everything else it does.

Bring armour and it runs Armour Breaker. Play a gun line and it answers with Bombardment.
Rush it and its guns dig in. It's the clearest signal yet that you're fighting a commander
rather than a spawn table.

---

### Also in this build

**A crash shipped in 1.19.0, and it's worth explaining how.** The helper that decides which
way a side advances was declared inside one function but referenced from the targeting code,
so the Assault order threw the moment an enemy came into range.

It survived testing because every probe for those orders ran with an *empty enemy side* — the
loop containing the reference never executed a single iteration. All nine orders are now
tested against a live, mixed engagement on both sides, which is what should have been there
the first time.

**Two more of the same family:** hold lines were only ever honoured for the blue side (fine
while stances were player-only, wrong the moment the Adjutant got orders), and a drone that
had already committed to its dive flew straight through smoke because a committed dive skips
the rest of the movement code.

## v1.19.0 — Standing Orders

**Your artillery, armour and drones can now be given their own orders.**

A new **ORDERS** row sits above STANCE with one chip per arm. Each arm gets a standing
order, they run independently of each other, and for the units they cover they **override
the stance entirely** — a gun battery told to dig in doesn't care that the army is in
Assault.

All three start off, unlock at Rank 30 / 38 / 46, and share a single 30-second change
cooldown. That last part is deliberate: without it, orders become another micro-management
channel — swap to Breaker when armour shows up, swap back after — which is the opposite of
a *standing* order. The cooldown is what makes committing to a doctrine a real decision.

### 🎆 Artillery

- **Marching Fire** — sets up behind your front line and walks its fire ahead of the
  advance, using your troops' eyes rather than its own. *Won't defend the guns themselves.*
- **Stationary Batteries** — digs in five steps from the HQ and never moves, working at
  full range. *Enemy EW jammers reach far further against a dug-in battery and scatter its
  shots — massing guns in one spot is exactly what a jammer is for.*
- **Bombardment** — ignores troops completely, walks to the edge of its range and shells
  the enemy HQ. *Reduced damage, and no defensive value at all. It's a clock, not a line.*

### 🛡 Armour

- **Assault** — drives for the enemy HQ and only engages what's physically in the way.
  *Artillery and support walk free behind your tanks.*
- **Support** — hurries to your infantry line and paces to it so the line arrives together.
  *Gives up leading a breakthrough alone.*
- **Armour Breaker** — hunts armoured targets as an absolute priority. *Will cross a lane
  full of infantry to reach a tank, and ignore them while it does.*

### 💣 Drones

- **Straightforward** — flies its lane and never deviates. *Will fly straight past a target
  slightly off its line.*
- **HVT Hunter** — evades what it can and dives only the single toughest enemy on the field.
  *A swarm of infantry is invisible to it.*
- **Base Bomber** — evades what it can and flies for the enemy HQ. *No defensive value
  whatsoever.*

### Every order names its own downside

That's a rule, not decoration. A strictly-better option isn't a choice — it's a hidden
default players find once and then stop thinking about. Each order's cost is printed right
under it in the picker.

Units acting on an order carry a **dashed ring in their arm's colour** with its glyph, so
an ordered unit is never mistaken for a bugged one. A jammed battery says **JAMMED** on
itself rather than just quietly missing.

---

## 🗂 Deck Layout

**Settings → Advanced → Deck Layout.** Build your own hotbar tabs instead of the built-in
categories: up to 5 tabs of up to 9 units each, named however you like.

Production stays pinned on the end. Factories aren't units, so they can't live in a custom
tab — and a layout that simply replaced all four built-in tabs would have silently deleted
the only route to the Barracks, Motor Pool and Drone Bay for the rest of the game.

---

### Also in this build

**A Bombardment gun could permanently fail to fire.** It worked out where to stop using its
*raw* range but checked whether it could shoot using its *effective* range — and weather and
terrain both shorten range. In rain, the gun parked exactly two pixels outside its own reach
and sat there for the whole match. Fixed, and now verified across every weather.

**Transfer Progress is behind a developer code for now.** Import/export can hand an account
any rank and every unlock in one paste, which is exactly what it's for while the game is
offline and single-player — but a global leaderboard is coming, and a board seeded with
self-granted maxed accounts is worth nothing to the people who earned their place on it.
It'll be revisited once there's a backend that can check progress server-side.

## v1.18.2 — Take your progress with you

**Your save now moves between devices.**

Progress has always lived in browser storage, which means it lives on *one device, in one
browser*. Play on your phone and your laptop and you had two unrelated careers with no way
to reconcile them. That's now fixed.

**Debug/Dev → 💾 Transfer Progress** exports everything you've earned as a single
copy-pasteable code, and imports it on the other device. It carries rank and XP, every
doctrine, medals, campaign clears and stars, time trials, the secret level, rivals, doctrine
lessons, your whole crate collection, daily streaks, the Gauntlet dossier and lifetime
record, career stats and your leaderboard.

### Built to survive updates

The code deliberately isn't a dump of the save file. It carries an explicit list of progress
fields, each one validated on the way in. That indirection is the whole point:

- A future update adding something new **won't invalidate codes you already have** — the new
  field just takes its default.
- A code carrying something an older build doesn't recognise still imports everything else,
  and tells you what it skipped.
- A code that's been truncated or edited **fails its integrity check and is refused
  outright**, rather than half-applied. Arriving with half a career is worse than being told
  to re-copy it.

Nothing is written until you've pressed Check, seen exactly what the code contains — rank,
wins, campaign, medals, crate items, Gauntlet record — and confirmed it.

**Your device settings deliberately don't travel.** Audio, reduce motion, the colourblind
palette, Chaos Mode and the debug switches all stay as they are on the receiving device.
Importing someone's progress should never reach into their accessibility settings.

### 🎯 No Luck

One switch in Settings that silences every chance-driven event: supply drops, defectors,
surprise barrages, the Golden Drone, crazy voicelines, cutscenes, and the ultra-rare hidden
events. A battle is then decided by what you commit and nothing else.

Worth being precise about what it does *not* cover: weather and lane terrain still vary
between battles. Those are rolled once before the fight and shown to you, rather than sprung
on you during it, so they're a condition you plan around rather than luck that lands on you.

### Cutscenes

Now its own setting rather than an item buried in the Random Events sub-list, and it's
honoured at the source — which means it also silences the cinematic a legendary kill streak
earns. That one isn't a random event, so the old sub-toggle never covered it and cutscenes
could still appear for a player who'd turned them off.

## v1.18.1 — Pacing the Adjutant

The Gauntlet shipped climbing far too steeply. Player feedback said it "grew incredibly
fast", and simulating it confirmed exactly that: win margin ran 97% → 93% → 66% → 52% and
then fell straight off to −100%, with fights collapsing from 212 seconds to 30 in a single
rung.

### Why it happened

The ladder was escalating by stepping through the game's four difficulty tiers. That sounds
reasonable and is completely wrong, because those tiers are enormously far apart — Elite to
Legendary is +73% enemy economy, +49% unit quality, double the opening wave and twice the
thinking speed, arriving all at once. They were designed as four experiences you *choose
between*, not as a staircase you walk up one step at a time.

### What changed

**Nine rungs instead of six**, and each one now carries its own scaling on top of a base
tier rather than jumping between them:

> CALIBRATING → PROFILING → ANALYSING → ADAPTING → PREDICTING → ANTICIPATING → RELENTLESS
> → IMPLACABLE → ASCENDANT

Effective power now climbs roughly 3–7% per rung, never steps more than 20%, and never goes
backwards. The wall lands around tiers 7–8 instead of 4.

**Abilities ramp in rather than switching on at full strength.** Counter-doctrine opens at
half weight before reaching full. Adaptive hardening now opens at 35% of its eventual bite
and grows over the following rungs — so you feel each system arrive and get a chance to
answer it, instead of meeting it fully formed.

**The opening wave is bounded.** It used to stack on top of the difficulty tier's own
opener, which combined with Legendary's built-in eight to put fourteen enemies on the field
before you could act.

### And one thing that was quietly fake

The Ascendant tiers advertised "+N% unit quality" that was never actually applied to
anything. The number was computed, printed in the dossier, and then never reached a single
enemy unit — so every tier past the top of the ladder played identically to the one before
it. Those tiers are now genuinely stronger, which is also what makes the endless climb past
rung 8 mean something.

### The Adjutant File

New in the Debug/Dev panel: a full analytics view of what the Adjutant has learned.

- **Reasoning** — every adjustment explained as *observed → reasoning → action*, in plain
  English. It also reports the decisions it **declined** to make and the threshold that
  stopped them ("no lane crossed 40%, so it is not massing anywhere"), which is nearly
  always the answer when an adaptive system looks broken.
- **Analytics** — charts of what you commit, your lane distribution, hardening measured
  against its hard cap, and counter-doctrine weighting.
- **Curve** — the effective power climb across every rung, plus the full rung table.
- **Raw** — the live state objects.

---

## v1.18.0 — The Gauntlet

**An opponent that keeps a file on you.**

This build adds a new mode built around a single idea: an enemy that studies you between
fights and comes back rebuilt to beat the player you were last time.

### Meet the Adjutant

The Gauntlet is one opponent, fought over and over. It is not a ladder of different
generals — it is the same machine, getting better at *you* specifically.

After every fight it reviews what you did and files it. Next time out it:

- **fields the counters** to whatever units you leaned on
- **masses in the lane** you favour
- and **hardens against your most-used weapon**, so it does measurably less damage the
  next time you bring it

That last one is the heart of the mode. Your favourite unit doesn't stop working — it's
capped well short of immunity on purpose — but it stops being *enough* on its own. The
answer is always "bring something else as well", never "the thing you like is now useless".

### It only ever learns between fights

This is the rule everything else is built around, and it's worth being explicit about:
**the Adjutant never adapts during a battle.** Everything it fights with is locked in from
the first second.

An enemy that re-learns mid-fight punishes you for whatever you're doing right now, which
reads as cheating and makes a run unwinnable by effort — you can't out-play something that
rewrites itself faster than you can commit to a plan. Freezing it means every individual
battle is a fixed, solvable puzzle. Hard, but beatable by a player who reads it and
commits. Several clears in a row are absolutely possible. What changes is the next puzzle.

### It escalates on a named ladder

Each rung arms exactly one new system, so you can always name the thing that's new:

| Tier | | What it arms |
|---|---|---|
| 0 | **CALIBRATING** | No file yet. It fights straight, and it watches. |
| 1 | **PROFILING** | Counter-doctrine against what you leaned on. |
| 2 | **ADAPTING** | Adaptive hardening comes online. |
| 3 | **PREDICTING** | Off-map precision strikes, aimed at the lane you love. |
| 4 | **RELENTLESS** | Gunship runs, plus an opening ambush shaped to your tempo. |
| 5 | **ASCENDANT** | Rolling barrages and full proficiency. This is the wall. |

Five clears takes it to Legendary. Past that, every further clear buys it more unit quality
and income, and it does not stop.

> **Superseded in v1.18.1** — this ladder climbed too steeply and was re-paced to nine rungs
> reaching Legendary around tier 7. See the v1.18.1 entry above for the current shape.

### The only enemy in the game with a commander's toolkit

The Adjutant is the only opponent that uses commander strikes of its own — and every one of
them is **telegraphed** with a marked lane and a closing reticle 2.6 seconds before it
lands.

That's deliberate. Off-map damage you can't see coming is just a tax on having units alive.
A warning turns exactly the same damage into a decision: pull back, spend elsewhere, or eat
it and push through.

### You get to read the file

Before you commit to a fight, the Gauntlet screen shows you **its file on you** in plain
language — what it noticed, the exact hardening percentages, which abilities are armed.

An opponent that adapts invisibly just feels like the game cheating. Told exactly what it
learned, the same difficulty reads as a puzzle with a stated solution — and it turns every
clear into a deliberate choice about what to show it next.

### Purging, and what can't be purged

**Purge its memory** wipes the file it has built on you and resets the current run to tier
0 — for when you want a fresh climb, or to experiment without an Adjutant that's already
solved you.

Your **lifetime beats** and **deepest tier** are permanent and are never erased by it.
Purging is for starting over, not for undoing your record.

Losing doesn't cost you a tier either. Losing is already the punishment; taking the climb
away as well would make the deep tiers something you don't dare attempt. The file just gets
thicker.

---

### Also in this build

**The reload screen that appeared over a working game is fixed.** This one was worth
chasing down properly. Players were getting "Trouble loading — Reload" a few seconds into a
Campaign mission or the Daily Challenge, mostly on mobile.

The game has a boot guard whose job is to make sure nobody ever gets stuck staring at a
loading screen. It decided the page was dead if no menu was on screen — but **during a
battle every menu is hidden by design**. So a perfectly healthy fight looked identical to a
crash, and an unconditional 8-second check painted the reload notice straight over it.

Tapping into a mission between roughly 4.5 and 8.7 seconds after the page loaded hit it;
tapping earlier or later missed it entirely. That's why it seemed random. A live battle now
counts as proof of life, and the guard stands down for good once the game is up — while
still rescuing every genuine boot failure.

**The Motor Pool is now actually buyable.** The CP bank capped at 280 while the Motor Pool
cost 300, which meant that structure could never be afforded at any point in any battle.
The cap is now 350 — real headroom above the dearest structure, while still making it a
genuine save-up.

**Chaos Mode now stays out of the modes that matter.** It no longer applies to Campaign,
War, Rivals, the Gauntlet or the doctrine lessons. Those modes bank permanent progress or
adapt to how you play, and a mission "won" under free spawns and triple income made the
record meaningless. They now always run under their real rules however the toggle is set.
Skirmish, Blitz, Survival, Domination and Evolution keep it — those are the throwaway
fights it was built for.

**The Daily Challenge can no longer fail to start.** Generating the day was the only thing
standing between the tap and a battle, so any hiccup meant the button appeared to do
nothing. It now falls back to a plain, fully scoring, streak-eligible fight rather than
silently refusing.
