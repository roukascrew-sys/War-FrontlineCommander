# Code Guide — how these files work

A practical map of the codebase so you can make edits and additions yourself.
Two self-contained HTML files, no build step, no dependencies. Open either in a
browser and it just runs. All the logic lives in one `<script>` at the bottom of
each file.

| File | What it is | Size | Edit it when you want to… |
|------|-----------|------|---------------------------|
| `war.html` | The **simulator** — the serious war-college engine | ~26,500 lines | Change realism, physics, doctrines, validation (WARVAL) |
| `wargame.html` | **FRONTLINE COMMANDER** — the fun/streamable game fork | ~1,090 lines | Change gameplay, add units, tutorial, narrator, juice |
| `game_report.html` | Static market/functions report | ~700 lines | Update the pitch/analysis (no game logic) |

The rest of this guide is in two parts: **Part 1** is `wargame.html` (small,
where most new game work happens — read this first). **Part 2** is a high-level
map of `war.html` (huge, so you get orientation not line-by-line).

---

# PART 1 — `wargame.html` (the game)

## The big picture

It's a **canvas lane-battler**. Three horizontal lanes. You bank *Command
Points* (CP), spend them to drop units on the left, the AI drops units on the
right, they walk toward each other and shoot. Destroy the enemy HQ before yours
falls. Everything is drawn by hand on a `<canvas>` at 60fps.

The whole thing is **one global object `G`** (the live match) plus a **`SAVE`
object** (persistent progress in `localStorage`). When you're in a menu, `G` is
`null`. When a battle is running, `G` holds every unit, projectile, particle,
and counter.

```
 BOOT ──► buildMenu() ──► [Main Menu screen]
                              │  click ▶ DEPLOY
                              ▼
                          start() ──► newGame()  (creates G)
                              │
                              ▼
        ┌────────── loop() runs forever @60fps ──────────┐
        │  step(dt)  → advance the simulation one frame   │
        │  draw()    → paint the canvas                    │
        │  syncHUD() → push numbers into the DOM HUD       │
        └─────────────────────────────────────────────────┘
                              │  HQ hits 0
                              ▼
                          endGame() ──► showResults() ──► Menu
```

`loop()` (near the bottom, ~line 1028) is the heartbeat. It computes `dt` (delta
time in seconds, capped at 0.05 so a lag spike can't teleport units), then calls
`step`, `draw`, `syncHUD` every frame.

## The data model (read this before editing anything)

Everything is plain JS objects and lookup tables near the **top** of the script.
To add content you mostly just add entries to these tables.

**`DOCTRINES`** (~line 285) — the loadout you pick in the menu. Each has a
`perk` object of multipliers (`vehCostMul`, `airDmgMul`, `hpMul`, etc.) and an
`unlock` level. Perks are applied in `unitCost()`, `unitCD()`, and `spawn()`.

**`UNITS`** (~line 308) — the unit roster. Each entry is a stat block:
```js
tank:{name:'Tank', glyph:'◼', cat:'veh', cost:70, cd:2.2, hp:180, dmg:26,
      rof:1.3, rng:100, spd:24, col:'#ffb347', splash:14, r:12, armor:true,
      desc:'armoured breakthrough'},
```
- `cat` — `inf/veh/air/arty/dro`. Decides which doctrine perk applies.
- `cd` — deploy cooldown in seconds. `rof` — seconds between shots.
- `rng` — how close an enemy must be to fire. `spd` — walk speed (see SPD_SCALE).
- `splash` — area-damage radius (0 = single target). `armor` — takes 65% less
  from small arms. `flies` — airborne (only AA / arty / other fliers / kamikaze
  can hit it). `aa`+`onlyAir` — anti-air that *only* shoots fliers.
- `vsArmor`/`vsAir` — damage multipliers vs those target classes. `kamikaze` —
  one-shot diver. `arc` — lobbed (artillery) projectile.

**`HOTBAR`** (~line 326) — array of unit keys shown as cards 1–8. Card 8 is the
special missile strike.

**`MODES`** (~line 329) — skirmish / blitz / survival. **`DIFFS`** (~line 334) —
Recruit→Legendary, each a CP and quality multiplier for the AI.

**`MEDALS`** (~line 914) — achievement definitions checked in `checkMedals()`.

## The two state objects

**`G` (the match)** is built in `newGame()` (~line 363). Key fields:
- `units[]` `projs[]` `parts[]` `floats[]` `rings[]` — everything on screen.
- `cp / cpRate / cpMax` — your economy. `ecp / ecpRate` — the AI's economy.
- `hq:{B,R}` — HQ health (B=blue=you, R=red=enemy). `hqMax` — starting values.
- `combo / comboT / bestCombo` — kill-streak meter (resets when `comboT` runs out).
- `cds{}` — per-unit deploy cooldowns. `strikeCd` — missile cooldown.
- `shake / flash / slowmo` — screen-juice accumulators.
- `wave / clock` — survival wave counter / blitz countdown.

**`SAVE` (progress)** persists to `localStorage['FRONTLINE_SAVE_v1']`
(`DEFAULT_SAVE`, ~line 276): `xp, lvl, wins, losses, best, unlocked[], medals{},
sound, streamOn, seenTut`. `load()`/`persist()` read/write it; `addXP()` handles
level-ups. **Note:** if you add a new field, add it to `DEFAULT_SAVE` so old
saves get it via the `Object.assign` merge in `load()`.

## The frame, step by step

`step(dt)` (~line 549) runs the simulation each frame in this order:
1. tick down cooldowns and the missile timer
2. grow CP by `cpRate*dt`
3. tick the combo timer (expire the streak if it lapsed)
4. mode clocks (blitz countdown / survival wave spawns)
5. `aiStep(dt)` — the enemy banks CP and spends it (see below)
6. `updateUnits(dt)` — the core: each unit acquires a target, fires or advances,
   and if it reaches the enemy HQ it deals damage and dies
7. `checkWin()` — did an HQ hit 0?
8. `updateProjs` / `updateFX` — move bullets and particles
9. decay screen shake/flash

**Targeting** is `nearestEnemy(u)` (~line 572): nearest enemy in the same-ish
lane, respecting the air/AA rules. **Firing** is `fire()` (~line 500): spawns a
projectile (or sets `u.diving` for kamikazes). **Damage** is `damage()` (~line
459) → `killUnit()` (~line 467) → `addCombo()` on a player kill.

**The AI** (`aiStep`, ~line 520) is deliberately simple: it counts your armor/
air/infantry, builds a weighted pick list that counters your composition, and
spends its budget on 1–3 units. Make the AI smarter here.

## Rendering

`draw()` (~line 662) clears the canvas, applies screen-shake as a translate,
then paints field → HQs → ground units → projectiles → air units → particles.
Each `drawX()` is isolated, so you can restyle one thing without touching the
rest. Units are just circles with a glyph; HP bars, muzzle flashes, and shadows
are drawn inline in `drawUnit()` (~line 717).

The HUD is **DOM, not canvas** — `syncHUD()` (~line 757) pushes numbers into the
HTML elements defined in `<div id="hud">`. The announcer, combo counter,
killfeed, and streamer chat are all DOM too (functions ~line 833+).

## Input

- Canvas `pointerdown` (~line 823) → figure out the lane from Y, then deploy the
  selected card there (or fire the missile strike).
- `keydown` (~line 1038) → number keys pick a card, Q/W/E quick-deploy into
  top/mid/bottom lane, Space pauses.

## How to make common changes

**Add a new unit type:** add an entry to `UNITS`, add its key to `HOTBAR`. Done —
the card, cost, cooldown, and AI awareness all read from the table. (If you want
the AI to build it, add it to `AI_POOL`/the `choices` weights in `aiStep`.)

**Add a doctrine:** add an entry to `DOCTRINES` with a `perk` object and an
`unlock` level, then make sure the perk keys you invented are actually read
somewhere (`unitCost`, `unitCD`, or `spawn`).

**Tune the feel:** `SPD_SCALE` (~line 409) scales all movement. `G.cpRate`/
`cpMax` in `newGame` set economy pace. `announce()` calls drive the hype text.

**Add a sound:** add a function to the `SND` object (~line 351) using `beep()`.

**The narrator ("Iron Marshal")** lives in its own block (search `NARRATOR —`).
Two voice paths, picked automatically by `narrSpeakNow()`:
- **Offline** (default, free): `narrSpeakOffline()` splits a line into clauses
  (`splitClauses`), speaks each as a separate `SpeechSynthesisUtterance` with
  drifting pitch/rate so it doesn't read flat, over a WebAudio static/click bed
  (`radioStart`/`radioStop`/`radioClick`). `narrPickVoice()` scores the
  browser's available voices and picks the best-sounding one it can find.
- **Premium** (opt-in): if `SAVE.ttsKey` is set, `narrSpeakPremium()` calls the
  ElevenLabs TTS API, caches the resulting audio per line text (`NARR.cache`),
  and plays it through an `<audio>` element. Any failure (no key, offline, bad
  request) falls through to the offline path automatically — the game never
  blocks on this. The key lives only in `localStorage` on the player's machine
  and is sent only to `api.elevenlabs.io`. Managed from the "🔑 Voice" topbar
  button → `#voicemodal`.
Add a new line: put it in `NARR_LINES` (event → mood + line pool + optional
cooldown), then call `narr('eventName')` from wherever that moment happens.
For a one-off custom line, call `say(text, mood, priority)` directly.

**Add a medal:** add to `MEDALS`, then a check in `checkMedals()`.

## Known rough edges (good first fixes)
- `checkMedals()` `alldocs` line (~930) has a leftover ternary typo
  (`'allocs'`) — the Grand Marshal medal never grants. Fix: just pass
  `'alldocs'`.
- `sel.doctrine` is set to a misspelled value on line 341 then immediately
  corrected on 342 — harmless but confusing; collapse to one line.
- `streamOn` isn't in `DEFAULT_SAVE`; it works (falsy by default) but adding it
  makes intent clear.

---

# PART 2 — `war.html` (the simulator), a map

This file is ~26,500 lines but it's **layered**: a base engine, then dozens of
versioned feature blocks bolted on before `</script>`, each wrapped in its own
IIFE and `try/catch` so a failure in one never breaks the others. You rarely
read it top-to-bottom — you `Ctrl-F` to the system you care about.

## How to navigate it
- Search for a **version banner** comment (e.g. `v75`, `v76`) to find that
  release's additions — they're grouped together near the end of the script.
- Search for a **system name** (the globals below) to jump to a subsystem.
- The patch-notes panel HTML (`#pnInner`) near the top lists every version in
  plain English — a good table of contents.

## The core globals (the engine's nouns)
- **`WAR`** — the theatre: `WAR.nodes` (6 sectors), `WAR.lines` (supply routes/
  MSRs), `WAR.reserves`, `munMul` (munitions multiplier).
- **`FORCE[side]`**, **`COUNTRIES`**, **`TYPES`** / **`TKEYS`** / **`SUBTYPES`** —
  the order of battle and the unit catalog (the simulator's equivalent of
  `UNITS`, but far deeper — real calibers, tonnage, etc.).
- **`TACTICS`**, **`FORMATIONS`**, **`GENERALS`**, **`COMMANDERS`**,
  **`PROSPECT.DOCTRINES`** — the doctrine/command layer.
- **`STAFF`** — campaign reasoning, psychology, political/industrial warfare
  (the "General Staff", v74).

## Key subsystems (grouped by the version that added them)
- **v75 "Real War Layer":**
  - `CASREP` — casualty *states* (incapacitated / injured / functional / healed)
    instead of binary alive/dead. Hooks `killUnit` via `CASREP_intercept`.
  - `AMMOREAL` / `AMMOLOG` — typed ammunition (real rounds per weapon, not
    one-size-fits-all). Hooks `fireAt`.
  - `LOGRE` — real-tonnage logistics (~3,600 t/day truck battalion math) and a
    war-map supply overlay. Hooks `recomputeLines` and `drawWarMap`.
  - `AAR_V75` — expanded after-action report pulling data from every other tab.
  - `WIKI_V75` — in-game encyclopedia of the new weapons/doctrines.
- **v76 "WARVAL 2.0"** — the validation & verification program. Five layers:
  1. historical validation (26-conflict roster vs real outcomes/percentages)
  2. mechanism validation (deterministic probes: does EW/ammo/armor actually do
     what it claims — reads engine internals to beat battle noise)
  3. expert validation (doctrine sanity vs Lanchester/Pape theory)
  4. sensitivity analysis (one-variable elasticity via `mirrorMatchup`)
  5. emergence (surfaces unforeseen-but-plausible campaigns)
  Runs **both** a Monte-Carlo abstract resolver (`resolveWar2`) **and** live-
  engine real simulations, then cross-validates them (`crossValidate`). Keeps a
  per-version record in `localStorage['WARVAL2_RECORDS']`. Entry points:
  `WARVAL.record / history / compare / export`.

## The safe way to add to `war.html`
Follow the existing pattern so you don't destabilize the engine:
1. Write your feature as a **self-contained IIFE** placed just before `</script>`.
2. Expose a single hook function on `window` (e.g. `window.MYTHING_onShot`).
3. Call it from the relevant engine function inside a `try{…}catch(e){}` so a
   bug in your code can never crash the frame:
   ```js
   try{ if(window.MYTHING_onShot) MYTHING_onShot(u); }catch(e){}
   ```
4. Bump the version banner and add a line to the patch-notes panel.

This is exactly how CASREP, AMMOREAL, LOGRE, and WARVAL were all added without
touching the base combat loop.

---

## Testing either file
Both are static HTML — just open in a browser. For automated checks I drive them
headless with Playwright (Chromium at `/opt/pw-browsers/...`, launched with
`--no-sandbox`). The game exposes `window.G` so a test can read/poke live match
state (e.g. set `window.G.cp=300` to deploy freely). Test scripts live in the
scratchpad (`test_game.js`, `test_combat.js`, etc.).
