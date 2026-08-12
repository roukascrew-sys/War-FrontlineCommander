# FRONTLINE COMMANDER — Devlog

Written to be **copied straight into an itch.io devlog post**. Newest first. Each entry is
already in prose — headings, bold and lists all paste cleanly into itch's editor.

Keep entries player-facing: what changed and why it matters to someone playing. The
engineering detail lives in the patch notes inside the game and in the commit history.

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
