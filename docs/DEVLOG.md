# FRONTLINE COMMANDER — Devlog

Written to be **copied straight into an itch.io devlog post**. Newest first. Each entry is
already in prose — headings, bold and lists all paste cleanly into itch's editor.

Keep entries player-facing: what changed and why it matters to someone playing. The
engineering detail lives in the patch notes inside the game and in the commit history.

---

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
