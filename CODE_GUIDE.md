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

## Depth systems (added after the initial ship)

**Veterancy** (`VET_RANKS`, `grantVetXP()`) — any unit, either side, that racks
up kills mid-battle ranks up (Seasoned → Veteran → Elite) at 3/7/14 kills,
gaining a permanent hp/dmg multiplier for the rest of that match and a
chevron drawn under it in `drawUnit()`. `spawn()` stores `baseHp`/`baseDmg` so
rank multipliers always apply to the unit's true base stats, not whatever it
was last scaled to. Called from `killUnit()` on the killer, if it's still alive.

**Lane terrain** (`TERRAINS`, `G.laneTerrain`) — each match randomises one of
`open`/`forest`/`hill` per lane (fixed to `open` in the tutorial). Affects
`spdMul`/`rngEff` in `updateUnits()` and a `catDmgMul` bonus applied in
`fire()`. Badges are drawn in `drawField()`.

**Commander Powers** — a second and third active ability beyond the missile
strike, both selected the same way (`G.selCard`) and cast into a lane:
- `tryRecon(lane)` — free, `R` key, exposes an entire lane through fog/weather
  for ~6.5s (`G.flareLane`/`G.flareT`, read by `computeSpotting()`).
- `tryEmp(lane)` — unlocks at Rank 3, `F` key, near-fully suppresses every
  enemy in a lane for ~3.4s (`G.empLane`/`G.empT`, applied in `updateUnits()`).
Both have their own cooldowns (`G.reconCd`/`G.empCd`) ticked in `step()`, cards
built in `buildHotbar()`, cooldown UI in `syncHUD()`.

**Rival enemy generals** (`GENERALS`) — each battle picks a named opposing
commander whose `bias` field drives the AI's unit-composition weighting in
`aiStep()` (reusing the existing `enemyBias` mechanism campaign/daily already
used). Shows an intro line at battle start and periodic taunts
(`showRival()`, the `#rivalbox` subtitle — deliberately separate from the
Iron Marshal's box so the two don't read as the same character). If a
mission/daily already fixed `enemyBias`, the matching general is picked so
flavor and behavior stay consistent (e.g. the "Night Raid" mission's tank
bias always pairs with Gen. Korvinov).

## Later systems (speed / stances / tech tree / live chat / visuals)

**Game speed** (`SPEEDS`, `G.speed`, `SAVE.speed`) — the `loop()` scales `dt`:
0.5×/1× run one scaled step, 2× runs two capped sub-steps (avoids tunnelling).
Controlled by the SPEED cluster in the HUD (`#speedbar`, `setSpeed`).

**Troop stances** (`STANCES`, `G.stance`) — **behaviour only, never stats**.
Applied in the movement branch of `updateUnits()` for player (side B) units:
`defend` slows the advance and clamps units to a hold line (`W*0.42`, behind
centre) with a shield drawn in `drawUnit()`; `skirmish` makes them give ground
when an enemy crowds inside `range*0.55`. Nothing touches dmg/hp/rof. Set via
the STANCE cluster or Z/X/C (`setStance`).

**In-battle tech tree** (`UNIT_TIER`, `TIER_UNLOCK`, `G.unlocked`, `G.techMode`)
— only the "normal" modes (skirmish/blitz/survival) start with just tier-1
units; tiers 2–3 must be bought once per battle with CP (`tryUnlock`) before
they can be deployed (`tryDeploy` gate). Locked cards show a cost overlay
(`.lockov`); clicking one buys the unlock. Campaign/daily/tutorial unlock
everything up front.

**Live Twitch chat** (`CHATLINK`, Phase 2) — `chatConnect()` opens an anonymous
read-only Twitch IRC WebSocket (`justinfan` nick, no OAuth). `handleIRC()`
parses PRIVMSG lines; `onChatMsg()` reads `top/mid/bot` lane votes and `boss`
votes. `chatVoteTick()` (called from `step()`) applies the winning lane as an
enemy surge on a timer and summons a `spawnBoss()` at the boss threshold. When
not connected but Streamer Mode is on, it simulates votes so the mechanic demos
offline. All incoming chat text is `escapeHtml()`-escaped before display. UI is
the `#twitchmodal` (topbar "📡 Live Chat") plus the `#votebar` tally.

**Visual depth** — `drawField()` now layers a weather-aware sky, horizon glow,
two rows of hill silhouettes, a depth-graded ground, terrain-tinted lane bands,
and per-lane scenery (`buildScenery()` precomputes trees for forest lanes, rock
mounds for hills, small rocks + grass elsewhere — stored on `G.scenery`).
`drawUnit()` adds ground shadows and a radial-gradient body via the `shade()`
hex helper; `drawHQ()` got a glow, shading, and an antenna.

## Boot flow, title/attract & War Mode

**Boot sequence:** `runLoader()` (cosmetic progress bar + rotating `LOAD_TIPS`)
→ `showTitle()` (dynamic title with `TITLE_TAGS`) → the player picks PLAY
(`openMenu`), War Mode (`showWarMap`), or Tutorial. The old "menu is the first
thing you see" flow is gone — `#menu` now boots hidden.

**Attract mode** — the title's animated background. `startAttract()` builds a
normal skirmish, flags `G.attract=true`, and `attractTick()` auto-deploys for
the player while the AI plays the enemy. `narr()` is muted and the HUD hidden
during attract; when an HQ falls, `loop()` just calls `startAttract()` again for
an endless demo. `checkWin()` short-circuits for attract (no results screen).

**War Mode (conquest)** — `SAVE.war` holds the persistent map: `nodes` (fixed
`WAR_LAYOUT` positions, each with `owner`/`str`/`weather`/`bias`), `edges`
(auto-connected between adjacent columns), and `momentum`. `showWarMap()` /
`renderWarMap()` draw it (SVG edges + DOM `.wnode` buttons). A node is
attackable (`warAttackable`) when it's enemy-held and borders one of yours;
`warFight()` launches a battle via `LAUNCH={type:'war',…}` with difficulty
derived from the node's `str` (`warDiffFor`). `endGame()` calls `warResolve()`:
**a win captures the node and cuts `str` on every enemy neighbour** (the
inter-battle effect), raises momentum, and wins the war if it was the enemy
capital; **a loss reinforces the target and, at low momentum, lets the enemy
counter-attack and retake a forward node.** All of it persists to localStorage,
so a war spans sessions. The results screen shows a "🗺 War Map" button for
`G.kind==='war'`.

## Deeper combat & Age-of-War mode

**Damage types × armour classes** (`DMG_MATRIX`, `UNIT_DMGTYPE`,
`UNIT_ARMORCLASS`) — the real counter web. Every weapon has a damage type
(`sa`/`ap`/`he`/`aa`) and every unit a body class (`inf`/`light`/`heavy`/`air`/
`struct`); `dmgMul(type,class)` decides how well one bites the other and is
applied once, in `damage()`. Small arms shred infantry but ping off tanks, AP
kills armour, HE clears groups and levels bases, AA owns the sky. `fire()` no
longer holds matchup multipliers — only shooter-side modifiers (terrain,
ambush). Precision units carry a `crit` chance (double damage). Infantry in a
forest lane get a `cover` flag = 40% less incoming. HQ siege damage scales by
the attacker's type-vs-`struct` value, so HE units are the real base-breakers.

**Kill bounty** — in `killUnit()`, a kill grants the killer's side CP (~30% of
the victim's cost) with a floating `+N`, so aggression pays and combat feeds the
economy. Both sides earn it.

**Age-of-War "Evolution" mode** (`AGES`, `UNIT_MINAGE`) — a fifth game mode. You
start in the Trench Era with only tier-0 units; kills earn Evolution points
(`G.evo`), and `tryEvolve()` advances you through five ages
(Trench→Blitz→Cold War→Modern→Future), each unlocking new units
(`buildHotbar()` re-gates by `UNIT_MINAGE`), hardening your HQ, scaling deployed
units (`spawn()` applies `AGES[age].unit`), and powering up the missile-strike
ultimate (`tryStrike` reads `AGES[age].sup`). The enemy auto-ages on a timer
(`ageTick`). Age panel + Evolve/Turret buttons live in `#agepanel`
(`syncAgeUI`), keys `V`/`T`.

**Base turrets** (`G.turrets`, `turretTick`, `drawTurrets`) — in Evolution mode
each age grants turret slots; `tryBuildTurret()` spends CP to place an
auto-firing emplacement on your HQ (the enemy builds its own at higher ages).
Turrets acquire the nearest in-range enemy and fire real projectiles through the
same pipeline, so the damage matrix applies to them too.

## Title flow, buttons & AI debug

- `start()` now hides **every** menu screen including `#title` and `#warmap`
  before showing the HUD — the earlier War-Mode bug (battle rendering *behind*
  the still-visible map) came from those two not being hidden.
- The title screen leads with two headline buttons — **PLAY** (`t-play` → the
  options menu) and **EVOLUTION** (`t-evo` → `launchEvolution()`, straight into
  Age-of-War) — with War Mode / Tutorial as colour-coded secondaries. Buttons
  are keyed to function by colour (gold = play, purple = evolution/age, blue =
  conquest, green = learn); mode-select chips and topbar toggles follow the same
  colour language.
- **AI debug readout** (`#aidebug`, `recordAIThought`, `syncAIDebug`) — toggle
  with the 🧠 topbar button or the `` ` `` key (`SAVE.aiDebug`). `aiStep()`
  records each enemy decision — budget, the composition it counted
  (armour/air/infantry), the threat it's countering, its top unit weights, and
  what it actually built — into a rolling `G.aiThoughts` log shown live during
  the battle. Reads like `12s £84 saw 3▣/1✈/5i → vs ARMOR ⇒ atgm+drone`.

## Artillery, balance, spawners, countries, polish

- **Artillery fix** — arc rounds no longer use straight-line velocity + gravity
  (which made them undershoot). `fire()` gives an arc shell an impact point
  `(ix,iy)`; `updateProjs()` interpolates launch→impact with a parabolic hop and
  **always detonates at the aimed point** with splash. `drawProj()` shows a
  ground target ring that tightens as the shell falls.
- **Age-of-War balance** — `ageTick()` now (a) grants passive evo (`G.evo +=
  dt*4.2`) so the player always advances even in a quiet, low-count game, (b)
  scales the enemy's evolve cadence by difficulty (`AGE_INTERVAL`), and (c)
  **caps the enemy to at most one age ahead of the player** (`G.enemyAge <
  G.age+1`) — no more runaway tech on low difficulty.
- **Production spawners** (`SPAWNERS`, `G.spawners`, `spawnerTick`,
  `drawSpawners`) — high-cost factory cards (Barracks/Motor Pool/Drone Bay) built
  just ahead of your HQ that emit a unit on a timer (`spawn()` gained an
  `xOverride` so they emerge at the building). Capped at `MAX_SPAWNERS`.
- **Countries** (`COUNTRIES`, `unitName()`) — pick a nation in the options menu
  (`sel.country`); units are renamed to that nation's real hardware (US → M1
  Abrams, RU → T-90M, …). Flavour only, no stat change. The enemy fields a
  different nation. Applied in `spawn()`'s `name` and on the hotbar cards.
- **Visual polish** — a screen-space vignette, projectile glow + tracers with a
  `px,py` last-position trail, artillery scorch craters (`scorch()`, drawn in
  `drawField`) with lingering smoke, a deploy ripple, and a hovered-lane
  highlight (`G.hoverLane` from a canvas `pointermove`).

## Music, war-map ambience & the news wire

- **Background music** (`MUSIC`, `THEMES`) — an **original**, epic/orchestral
  procedurally-sequenced score (WebAudio), styled after Age-of-War-type battle
  themes but composed here, not any external track. A step-sequencer
  (`musicSchedule`/`musicStepAt`) layers a bass + arpeggio, a **choir pad**
  (`mChoir`, once per bar), **timpani** hits on strong beats (`mTimp`), drums,
  and a **brass-doubled lead** (`mBrass`, octave-stacked) over a per-theme chord
  progression. Themes carry `brass`/`timp`/`pad` flags. Three themes — `menu`,
  `battle`, `victory` — swapped by game state (`musicStart`/`musicSetTheme`,
  called from `showTitle`/`start`/`endGame`/`openMenu`/`showWarMap`). Starts on
  the first user gesture; toggle via the 🎵 topbar button or the Settings modal
  (`SAVE.music`, `SAVE.musicVol`).
- **War-map ambient explosions** (`startWarFx`/`warFxTick`) — while the
  conquest map is open, a timer pops `.warflash` radial-gradient bursts at
  random board positions with a muffled distant boom, so the whole theatre
  feels alive. Self-stops when the map closes.
- **Generated news wire** (`NEWS`, `pushNews`, `renderNews`, `#newsbar`) —
  **archived for now**: `SAVE.news` is forced `false` at boot, the 📰 topbar
  button is `hidden`, and there is no Settings toggle. All the code is intact,
  so re-enabling it is a one-liner (drop the `SAVE.news=false;` after `load()`
  and un-hide the button). What it does when on: a toggleable right sidebar.
  World headlines are built
  from templates (`WORLD_NEWS` with `nn()/nc()/nk()` fills) on a timer that runs
  even on the menu/title/war map; battle events push tagged **FRONT** and
  **FLASH** headlines via `frontNews()`/`pushNews(...,'flash')` (first blood,
  combo tiers, HQ hits, evolution, boss, war captures/losses, win/lose). All
  text is `escapeHtml()`-escaped. `body.news-open` shifts the right-side HUD
  and the full-screen menus clear of the bar.
  During a live battle the wire runs on a **slower cadence** (`newsTick` →
  `rnd(17,27)s`) and mostly pushes **battle-derived** headlines
  (`genBattleNews()`, ~78% of the time) that read live `G` state — country
  demonyms, front name, HQ %, kills, deploys, ages, terrain, best combo — with
  the occasional world headline mixed in.

## Field Manual, Settings & the hype meter (manageability overhaul)

- **Field Manual / wiki** (`#manual`, `openManual`/`buildManualTabs`/
  `renderManualBody`) — a tabbed in-game encyclopedia reachable from the title
  (📖 Field Manual). Tabs: **Basics, Roster, Counter Web, Doctrines, Ages,
  Modes, Tips**. Every tab is **generated from the live data tables** (`UNITS`,
  `UNIT_DMGTYPE`/`UNIT_ARMORCLASS`, `DMG_MATRIX`, `DOCTRINES`, `AGES`,
  `SPAWNERS`, `LOAD_TIPS`) so it can never drift from the real numbers. The
  Counter Web tab renders `DMG_MATRIX` as a colour-graded table.
- **Settings modal** (`#settings`, `openSettings`/`renderSettings`) — from the
  title (⚙ Settings). Toggles for music, sound, narrator, **battlefield
  ambience** (`SAVE.ambient`), **reduce-motion** (`SAVE.reduceMotion`), a
  music-volume slider, and a **🎲 Random Events** group (master `randomEvents`
  plus `evSupply`/`evVoice`/`evCutscene`/`evBarrage`/`evDefector`). Reduce-
  motion suppresses screen shake (in `draw()`) and dampens the HQ-hit flash.
- **Hotbar clarity** (`buildHotbar`) — each unit card now carries a **damage-
  type dot** (top-right, coloured by `DTDOT_COL`) and an **armour-class tag**
  (bottom-right: INF/LGT/HVY/AIR), with thin **group separators** (`HB_GROUP_END`
  → `.hb-sep`) between infantry · armour · fires · air/AD · support. Tooltips
  spell out what each unit is strong against.
- **Hype meter** (Phase 2, `G.hype`/`bumpHype`/`chatVoteTick`) — while streamer
  mode or a live Twitch chat is connected, chat reactions (`chatReact`) feed a
  hype bar shown in `#votebar`. A full bar is a **hype train**: it showers bonus
  CP (scaling with `G.hypeTrains`), fires a clip moment, drops a crate, and
  pushes a FRONT headline. The bar decays when the action cools off.

## Combat audio, ambience & random events

- **Per-weapon audio** — the old square-wave `SND.shot` is replaced by
  synthesized reports: filtered white-noise bursts (`noiseHit` via a cached
  `noiseBuffer`) for the *crack* of gunfire, low sine drops (`thump`) for the
  *body* of cannon fire, composed into `gunshot()`/`cannon()`/`burst()`.
  `SND.fireFor(u)` dispatches by `u.key` so rifles crack, tanks & artillery
  boom, IFV/AA rip short bursts, missiles whoosh, etc. `fire()` calls it (with a
  small skip-rate so mass battles don't distort). `SND.boom`/`hqhit` are cannon
  voices too.
- **Battlefield ambience** (`WARAMB`, `ambientStart`/`ambientStop`) — a looping
  low-pass noise rumble bed plus a timer that fires panned distant gunfire &
  muffled shelling under the fight. Starts in `start()` (non-attract), stops on
  `endGame`/`showTitle`/`openMenu`/`showWarMap`. Gated by `SAVE.sound &&
  SAVE.ambient`.
- **Random occurrences** (`REVENTS`, `fireRandomEvent`, `randomEventTick`) — a
  clock (`G.revT`) rolls one enabled event every ~30–55 s. Events:
  **supply** (airdrop a crate → `airdrop`/`dropTick`/`drawDrops`, lands for CP +
  heals, or enemy resupply), **voice** (`CRAZY_LINES` outburst), **cutscene**
  (`playCutscene` → the `#cutscene` letterbox overlay with a live caption),
  **barrage** (a shelling rakes a lane), **defector** (flip a random enemy unit
  to your side). Each event honours its own `SAVE.ev*` flag and the master
  `SAVE.randomEvents`. A legendary 12-kill combo also auto-fires a cutscene
  (the "director").
- **Phase-2 chat commands** — beyond `top/mid/bot` and `boss`, viewers can type
  `drop` (meter → friendly airdrop), `chaos` (meter → `fireRandomEvent`), and
  `hype`/`pog`/`W` (feed the meter). Thresholds live on `CHATLINK`.

## Prep phase, air support, air power & difficulty

- **10-second prep** (`PREP_TIME`, `G.prep`/`G.frozen`) — every non-tutorial
  battle opens frozen: `step()` decrements `G.prep`, keeps CP flowing, idles all
  units (`updateUnits` early-continues on `G.frozen`), and skips `aiStep`/
  turrets/spawners until it ends, then fires `battleStart`. `#prepbanner` shows
  the countdown; click it to skip (`G.prep=0.001`).
- **Air support — three strikes** (`STRIKES`, `G.strikeCds`) replace the old
  single bomb: `tryGunshipRun(lane)` rakes one lane with a marching strafe;
  `tryBarrage()` sets `G.barrage` and `barrageTick()` walks a wall of fire up all
  three lanes over 60 s; `tryPrecision(lane,x)` is the old strike with a shorter
  CD and less punch. Cards `card-gunship/-barrage/-precision`, keys G/B/0,
  dispatched through `tryStrike(type,lane,x)`.
- **Gunship & interceptor units** — `gunship` (`u.gunship`) loiters mid-field via
  `gunshipTick()` (glides to a home x on its side, patrols the lane band, strafes
  one target per lane) and never sieges the HQ; `interceptor` (`u.hunter`) is an
  air-superiority fighter — `nearestEnemy` returns the nearest flier for hunters,
  and its `aa` damage type shreds air. The AI fields both (`aiStep` choices
  weight interceptor by air-threat, gunship at high budget on smart tiers).
  New flags must be copied in `spawn()` (`lowAir/gunship/hunter/antiDrone`).
- **Drone rebalance** — drones are dirt-cheap (cost 11) glass cannons.
  `nearestEnemy` now lets rapid-fire ground units (`rof<=0.75`) target a
  low-flying drone (`u.lowAir`); `damage()` multiplies drone hits ×2.4 from
  rapid fire; and an EW jammer (`u.antiDrone`) fries drones in `supportTick`
  (cancels the dive, pins them, burns them down).
- **Difficulty** (`DIFFS`) — each tier now carries `cpMul` (enemy economy),
  `qualMul` (enemy stats), `think` (AI cadence), `open` (opening enemy count),
  `smart` (focus-fire / hard-counter / budget-hoard AI in `aiStep`), and
  `playerCp` (a leg-up on the player's income). Recruit is a teaching cakewalk;
  Veteran/Elite are a real fight; Legendary is brutal (measured: it beats a
  strong scripted player ~2⁄3 of the time). Tune in the `DIFFS` table.
- **War Mode reserve CP** (`w.cpBank`/`w.alloc`) — before an assault the player
  allocates reserve CP (stepper in the war-info panel) that becomes starting CP
  (`LAUNCH.startCp` → `newGame`); on a win `warResolve` returns half the
  leftover CP plus a bonus to the bank, so you snowball deeper pushes.
- **Humanised narrator** — `splitClauses` now breaks on sentence *and* clause
  boundaries and folds tiny fragments; `narrSpeakOffline` gives each clause a
  human contour (open brighter, settle/slow to the close, lift on emphatic
  lines, drag on trail-offs), per-clause jitter, and short randomized breathing
  pauses with radio key-clicks between clauses.

## Air-support fixes, interceptor CAP, chat powers & chaos mode

- **Strike/unit key un-collision** — the gun-run strike key was `gunship`, which
  collided with the `gunship` *unit* (duplicate `card-gunship` id + same
  `selCard`, so selecting the unit fired the strike). The strike is now `gunrun`
  (`card-gunrun`, key G). If you add a strike, never reuse a unit key.
- **Gun run is step-driven** (`G.gunrun`/`gunrunTick`/`drawGunrun`) instead of
  `setTimeout` chains, so it stays in sync with 0.5×/2× speed and pause; a 🚁
  sprite flies the lane with a strafe line.
- **Interceptor = loitering CAP** (`u.orbit`/`interceptorTick`) — flies a wide
  elliptical orbit over the middle whose vertical sweep spans all three lanes,
  and damages any enemy aircraft within ~95 px of its path. It never touches the
  ground or the HQ, so it's a lasting air shield (hp 150) that only dies to
  enemy air. Flag copied in `spawn()`.
- **Tech-lock cards** now show the unit's name (`.lk-nm`), the tier-unlock cost,
  and the per-unit deploy cost (`TIER n · then X ea`).
- **Big-vote chat powers** (`CHAT_POWERS`, `chatPower`, `G.chatPowers`) — many
  *unique* chatters chanting the same word triggers a gameplay effect:
  `fortify` (16) heals your army, `storm` (22) shells all lanes, `blitz` (26)
  spawns a free wave, `nuke` (50) wipes the whole field. Progress pings fire at
  the quarters.
- **🤪 Chaos / Meme mode (beta)** (`SAVE.chaosMode`, `G.chaos`, `chaosTick`) — a
  Settings toggle; when on, `newGame` cranks economy/caps and shortens prep, and
  `chaosTick` rains cosmetic explosions, free-spawns both sides, and fires
  events/strikes/meme-text on timers. HUD shows a "🤪 CHAOS MODE BETA" tag.

## Unit sprites, title difficulty, A-10/AC-130 audio, chaos v2

- **Representational unit sprites** (`drawUnitSprite`, `rr` helper) — `drawUnit`
  no longer draws "coloured disc + glyph"; it calls `drawUnitSprite(u,x,y)` which
  draws a little model per unit (soldier/AT/sniper/medic, tank, IFV, AA with
  radar + missile rack, SPG/MLRS with barrels/tubes, EW dish, helicopter with
  rotor disc, quad-rotor drone, interceptor jet, AC-130-style gunship). Drawn in
  a ±14 box, scaled by `u.r`, mirrored to face the enemy (`f = side==='B'?1:-1`).
  To add a unit's look, add a branch keyed on `u.key`/`u.cat`.
- **Global difficulty on the title** (`buildTitleDiff`, `#title-diff`) — chips on
  the title set `sel.diff`, which every launcher already reads (`launchEvolution`,
  the options menu, etc.), so difficulty is chosen once for all modes (War Mode
  still derives its own per-node difficulty by design).
- **A-10 / AC-130 audio** — `a10Brrrt(dur,vol)` is a ~60 Hz sawtooth buzz +
  gritty bandpassed noise (the GAU-8 "BRRRT"), retriggered on a cadence in
  `gunrunTick`; `ac130(vol)` is a heavy 105 mm "THOOMP" (muzzle clank + deep
  `cannon` body + long low `thump` tail) used by the gunship unit in
  `gunshipTick`.
- **Chaos v2** (`chaosTick`) — cranked hard: economy ×3.2/×3.0, multiple
  detonations per tick, 2–4 free spawns per wave (capped at 110 units), events/
  strikes/big-chat-powers/meme-shouts every ~1.6–4 s, and a strobing overload
  tint. Everything still honours `reduceMotion`.

## 🧠 Information warfare (streamer gaslighting chat commands)

Chat commands that sabotage the **streamer's perception/UI** (not game balance),
routed through the same big-vote `chatPower` system with `IW_POWERS` thresholds.
State lives on `G.info`; `infoTick(dt)` decays timers and `infoClear()` wipes
everything on `endGame`/`showTitle`. Effects:

- **`iwPhantom`** — flags healthy player units with `u.phantom` (fake skull +
  red flash drawn in `drawUnit`, fake death sound); no real damage.
- **`iwGaslight`** (`G.info.gaslightT`) — `syncHUD` forces the strike/recon/emp
  cards to look ready (`.iw-fakeready` glow, timers hidden); every ability's
  `try*` calls `iwGaslightBlock()` first, so clicks fizzle with a denial buzz.
- **`iwFog`** (`G.info.fog`, `drawInfoFog`) — a black radial blob hides a random
  slice of the field in world space.
- **`iwPing`** (`G.info.ping`, `drawInfoPing`, `iwSiren`) — a pulsing "UNDER
  ATTACK" marker + air-raid siren in an empty corner (screen space).
- **`iwGray`** — `body.iw-gray` grayscales `#hud`/`#cv` for 15 s.
- **`iwTunnel`** — `#iw-tunnel` radial-mask vignette whose hole follows the
  cursor (window `pointermove` sets `--mx/--my`).
- **`iwJumble`** (`jumbleUI`) — randomises flex `order` on hotbar cards + tilts
  the bar; fully reversible (ids/handlers untouched).
- **`iwDonate`** — a stylised `#iw-donate` fake-donation gag popup (generic, no
  real brand — a self-aware in-game bit, not a real record).

Everything honours `SAVE.reduceMotion` where it shakes, and only fires in a live
battle (`onChatMsg` guards) — the simulated offline chat never sends these words.

## ⭐ v1.0 — launch build (roadmap complete)

`GAME_VERSION='1.0.0'` (shown in the title footer). Phases 1–3 of the roadmap
are done: content & campaign (P1), streamer/chat integration incl. big-vote
powers + information warfare + chaos mode (P2), and launch polish — prep phase,
title difficulty, sprites, per-weapon audio, Field Manual, Settings (P3).

**Career backend** (the depth layer under the frontend):
- `recordBattle(won,score)` in `endGame` feeds `SAVE.career` (battles/W-L/kills/
  deploys/CP/strikes/damage/time + per-unit tallies from `G.built`),
  `SAVE.history` (rolling 25-battle log), and `SAVE.rivalry` (per-general W/L).
- `rivalIntroFor(gen)` makes generals greet you based on the head-to-head
  record — revenge lines, taunts, dead-even challenges.
- **🎖 Service Record** screen (`openRecord`/`renderRecord`, title button
  `t-record`): career tiles, most-fielded unit bars, rivalry table, medal wall,
  recent-battle log. Results screens also carry an **AAR line** (force
  committed, CP spent, strikes, opposing general).

**Gags (all individually toggleable in Settings → Fun & Gags):**
- `gagChatter` — deploy/kill quips (`CHATTER_DEPLOY/KILL`) floated over units.
- `gagGolden` — the Golden Drone (a `REVENTS` entry): a harmless gold CP piñata
  that crosses the field; shooting it pays a jackpot, and it despawns harmlessly
  at the HQ line (`u.golden` guard in the siege block).
- `gagVictory` — confetti + jet flypast on the win screen (`.vic-conf/.vic-jet`).

Design intent: streamer spectacle (chaos, chat powers, gags) is **all opt-out**,
so a strategist can run a clean, systems-driven match — counters, terrain,
weather, veterancy, tech, war-map logistics — with none of the noise.

## Tutorial audio-overlap fix & per-step freeze

- **Root cause of overlapping tutorial voices**: `narr(ev)` — the generic
  battle-event narrator hook (firstBlood, comboN, wave, hqYours/hqTheirs) —
  was never gated for tutorial. The tutorial's own scripted `say(...,2)` lines
  and these ambient triggers could both fire narration at once (most visibly:
  the scripted tank kill in `TUT_STEPS[5]` sets `G.firstBlood`, which used to
  fire `narr('firstBlood')` right on top of the tutorial's own line). Fixed by
  a single guard at the top of `narr()`: `if(G&&G.tutorial&&!G.tutDone)return;`
  — the tutorial owns the mic until it hands off (`tutFinish`), then normal
  narration resumes.
- **Secondary hardening** (belt-and-suspenders, not the primary cause but real
  races worth closing): `RADIO` (the command-net static bed) could briefly
  double-loop — `radioStop()` schedules the actual node stop 200ms later, and
  a `radioStart()` inside that window used to spin up a second node before the
  first had faded out. `radioStart()` now clears any pending stop timer and
  hard-stops the old node immediately. Both `narrSpeakOffline` and
  `narrSpeakPremium` also now capture a `NARR.gen` generation token at the
  start of their speak chain and check it in every `onend`/`onerror`/retry
  callback, so a chain interrupted mid-flight (by `narrStop()` or a fresh
  `say()`) can never race a newer chain into simultaneous `speak()`/`play()`
  calls. `narrStop()` bumps `NARR.gen` too.
- **Per-step freeze** (`G.frozen`, reusing the same flag the 10-second prep
  phase uses) — `tutTick` sets `G.frozen=(s.freeze!==false)` when entering each
  `TUT_STEPS` entry, so by default a step holds the whole field still (units
  just idle-breathe in `updateUnits`) while its line plays and the player
  reads/acts. Two steps opt out with `freeze:false` because they need a live
  action to actually resolve: the counter-kill demo (the player must be able
  to fire on the scripted enemy tank) and the air-support demo (`strikeReady()`
  refuses to fire any strike while `G.frozen`, so that step would otherwise
  deadlock — the tutorial could never satisfy `strikeUsedCount>=1`). `tutFinish`
  clears `G.frozen` on hand-off. As a side effect this also closes a latent
  pre-existing gap where a fast player's early deploys could wander forward and
  land real siege damage on the enemy HQ before the script finished.

## Hotbar tabs, the shrink-to-fit bug, and the custom voice slot

- **Tabbed hotbar** (`HB_TABS`, `hbTab`, `buildHotbar`) — the deploy hotbar
  used to render all ~22 cards (14 units + 3 strikes + recon + emp + 3
  spawners) in one `flex-wrap` row. On real viewport widths that wrapped to
  2-3 rows and grew tall enough to cover the bottom lane. `buildHotbar` now
  renders a row of category-tab buttons into `#hbtabs` and only builds the
  cards belonging to the active tab (`ground`/`air`/`support`/`strikes`/
  `production`) into `#hotbar`, capping it at 7 cards (one row) in the worst
  case. Number-key hotkeys (`keydown` handler) still resolve by index into
  the global `HOTBAR` array regardless of which tab is showing — they were
  already decoupled from the DOM, so this didn't need to change. Anything
  that looks up a card by `getElementById('card-'+key)` (cooldown/afford
  -ability refresh, tutorial, gaslight FX) was already null-guarded, so
  cards from inactive tabs just silently no-op until their tab is active.
- **The real bug underneath**: `#hbwrap` is `position:absolute;left:50%`
  with `transform:translateX(-50%)` to center it, and had `max-width:97vw`
  but no explicit `width`. For an absolutely-positioned box with
  `width:auto`, the browser's shrink-to-fit algorithm bounds the available
  width using the box's own `left` offset against its containing block —
  with `left:50%` that caps it at roughly **half** the containing block's
  width, regardless of `max-width`. That's why the bar wrapped far earlier
  than 97vw would suggest, on both the old flat bar and, initially, the new
  tabs. Fixed with `width:max-content` on `#hbwrap`, which forces true
  intrinsic sizing (still capped by `max-width:97vw`). Worth remembering
  before centering any other `position:absolute` flex container in this
  file the same way.
- **`jumbleUI`** used to set `hb.style.transform='translateX(-50%) rotate(...)'`
  on `#hotbar` itself, back when `#hotbar` was the self-centered element.
  Now that centering lives on `#hbwrap` and `#hotbar` is a plain flow child,
  that translateX would have double-shifted the bar off-screen during the
  UI-jumble infowar effect. It now only applies the rotation.
- **Custom voice slot** (`ELEVEN_VOICES.custom`, `SAVE.ttsVoiceCustomId`,
  `SAVE.ttsVoiceCustomName`, `activeVoiceId()`) — the premium narrator picker
  only shipped with four fixed voice IDs (Arnold/Adam/Josh/Antoni). Added a
  fifth "Custom" slot with its own Voice ID text field in the voice modal, so
  any voice from the player's own ElevenLabs library (cloned or from the
  Voice Library) can be used without a code change — there's no way to
  resolve a voice *name* to its ID from this codebase without calling
  ElevenLabs' list-voices endpoint, so the UI just asks the player to paste
  the ID directly (My Voices → ⋯ → Copy Voice ID). Defaults to
  `ttsVoice:'custom'` with the name pre-labeled `'Thaddeus'`; falls back to
  the free offline voice exactly like an empty/invalid key does until both a
  key and an ID are actually saved.

## v1.1 batch — voice fix, drone fix, difficulty FX, DOT, debug mode, rank-up

- **Premium voice was silently falling back**: `activeVoiceId()` returned `''`
  whenever the Custom slot was selected with no ID typed in, which threw and
  fell back to the free voice with no visible error. Fixed by baking in a
  `THADDEUS_VOICE_ID` fallback (voice IDs aren't secret, only the API key is)
  used both at runtime and pre-filled in the modal's field.
- **Real drone bug, two parts**: `spawn()` gives every unit a randomised
  initial `cd:rnd(0,u.rof)`, and the drone's `rof:99` (meant as "no reload,
  it's one-shot") meant a drone could sit fully stalled for up to 99s the
  instant it entered its old 16px engagement range. Kamikaze units now fire
  the moment they're in range, ignoring the cd gate entirely. Also widened
  `drone.rng` 16→50 and added y-axis homing while closing (previously only
  x moved, so an off-lane target could get flown straight past).
- **Screen shake** already existed (`G.shake`, decayed in `step`, applied via
  `cx.translate` in render) but was weak for artillery (5) and asymmetric for
  HQ hits (only fired on your own HQ, not the enemy's). Strengthened both and
  slowed the decay so it actually reads.
- **`DIFFS[k].glyph`/`.fx`** — per-tier icon + FX severity (0-3). `diffFx(key)`
  spawns crossing tracer/flame elements into `#diff-fx` on the title screen
  and shakes `#title-inner` at severity 3 (Legendary). No 5th "Ultimate" tier
  was added — reused Legendary as the top of the existing four.
- **Burn DOT** (`u.burnDps`/`u.burnDur`/`u.burnT`, `damage()`, `burnTick()`) —
  applied on hit from any `src.burnDps` unit, ticks in `updateUnits` before
  the frozen/prep check. Real bug caught in testing: `spawn()` never copied
  `burnDps`/`burnDur` from the unit definition onto the live instance, so a
  spawned Flame Trooper would deal its direct hit but never actually ignite
  anyone — fixed by adding those fields to the `spawn()` push.
- **Flame Trooper** (`UNITS.flame`) appended to the *end* of `HOTBAR` rather
  than grouped with the other infantry, specifically so no existing number
  hotkey (1-9) or tutorial "press N" instruction shifts.
- **`chaosScars()`** — a rare (`G.chaosRareT`, ~14-26s) chaos-mode event that
  drops lingering bullet-hole + fire decals (`G.decals`) onto the field,
  independent of the existing `explode()`/`scorch()` transient FX.
- **Debug panel** (`#debugmodal`, `DEBUG_GROUPS()`) — every scripted event
  (infowar effects, `REVENTS[k].run()`, chaos scars, shake/flash, difficulty
  FX previews, a flame-trooper spawn, a rank-up preview) gets a button that
  calls the real function directly, wrapped individually in try/catch so one
  broken trigger can't take down the panel.
- **Rank-up screen** (`#rankup`, `showRankUp(fromLvl,toLvl,onContinue)`) —
  shown before the results screen on a level-up, listing every reward earned
  across all levels gained that battle (handles multi-level jumps from a big
  XP gain in one pass). Rewards are `COMMANDER_TITLES` (flavour text next to
  "Rank N" everywhere it's shown) and `HQ_BADGES` (a glyph shown on the HQ
  label and title screen) — both purely cosmetic, computed from `SAVE.lvl`
  with no separate unlock-list to desync, and neither gates any mode, unit,
  or doctrine, so the full roster stays playable from rank 1.

## ◈ The Gauntlet (v1.18.0) — the adaptive opponent

One opponent ("The Adjutant") that learns your habits between fights. The whole
design rests on one invariant, and it is the thing to preserve above all else if
you touch this code:

> **It adapts BETWEEN fights and never DURING one.**

That is enforced structurally by two objects that must never be confused:

- **`G.gaunt`** — the FROZEN profile the current battle fights with. Built once
  by `gauntletSnapshot()` at `newGame()` time and never recomputed. Everything
  the AI reads (counter weights, hardening percentages, lane bias, which strikes
  are armed) comes from here.
- **`G.gauntRec`** — a write-only ledger of what the player did this fight.
  Nothing in the running battle is allowed to read it. It is folded into the
  persistent dossier by `gauntletCommit()` from `endGame()`, and only there.

If you ever need the opponent to react to something new, add it to the snapshot,
not to a live lookup. An enemy that re-learns mid-fight makes a run unwinnable by
effort, which is exactly the failure mode this structure exists to prevent.

Other things worth knowing:

- **Persistence** lives in `SAVE.gauntlet` and is normalised on *every* read by
  `gauntletState()`. `sanitizeSave()` only validates top-level fields and copies
  nested objects through wholesale, so a hand-edited or partial save can put
  anything in here — every field is rebuilt with a checked default. `mem.fights`
  is a **fractional decaying weight**, not a battle count; do not floor it (that
  bug pinned it at 1 forever and silently broke the tempo read).
- **Tiers**: `tier === clears`. `GAUNTLET_TIERS` is the ladder — nine rungs, each
  arming exactly one system so a returning player can name what's new.

  **Do not escalate by stepping through the `DIFFS` tiers.** That was the first
  cut and it produced a cliff: those four tiers are enormous steps apart
  (elite→legendary is +73% economy, +49% quality, double the opening, twice the
  thinking speed) because they are *choices a player picks between*, not a
  progression. Simulated win margin ran 97/93/66/52% and then fell straight to
  −100% in one rung. Each rung now carries its own `qual`/`econ`/`open`
  multipliers on top of a base tier that changes rarely, and multipliers **below
  1.0** deliberately pull a new base tier back down on the rung where it first
  appears. Target shape: ~3–7% effective power per rung, no step above 20%, and
  never decreasing — the regression suite asserts all three.
- **`open` REPLACES `diff.open`** (see `newGame`) rather than adding to it;
  stacking an ambush on legendary's built-in 8 put 14 enemies on the field
  before the player could act.
- **`qualMul` must actually be applied** — it is read in `spawn()`. It was once
  computed and printed in the dossier but never used, so every Ascendant tier
  advertised quality scaling that did not exist and played identically.
- **Adaptive hardening** hooks `damage()` and keys off `src.key`, so it only
  applies to real unit damage. Commander strikes pass literal `{side,dmgType}`
  objects with no `key` and are deliberately never blunted — the player always
  keeps one un-hardened answer available.
- **Enemy fire support** (`gauntStrikeTick` / `gauntStrikeFire` / `drawGauntFx`)
  is the only enemy-side strike system in the game. Every strike is telegraphed
  for `GAUNT_TELE_TIME` seconds first; keep that. It is all `dt`-driven, not
  `setTimeout`, so it obeys pause, the prep freeze and the speed control.
- **Purge** (`gauntletPurge()`) clears `mem` and `clears` but must never touch
  `lifetime` or `deepest`. A loss costs no tier either.
- **`gauntletReasoning()`** backs the dev-facing Adjutant File screen
  (`openGauntFile()`, Debug panel → The Gauntlet). It explains decisions NOT
  taken as well as taken ones, with the threshold that stopped them — when this
  system looks broken it is nearly always an unmet threshold rather than bad
  maths, and a readout that only lists what fired cannot tell you which. Every
  threshold it quotes is read from the same constants the live snapshot uses, so
  it cannot drift into describing behaviour the game no longer has.

## Save transfer (`SAVE_TRANSFER_FIELDS`)

Progress moves between devices as an `FC1-…` code. The one rule that matters if you
touch save code:

> **A code carries only what is in the `SAVE_TRANSFER_FIELDS` manifest.**
> Adding a field to `DEFAULT_SAVE` does *not* make it transfer.

That indirection is the entire hardening strategy. Because the format is a declared
manifest rather than `JSON.stringify(SAVE)`, the code shape is decoupled from `SAVE`'s
internal shape, which gives all of this for free:

- adding a manifest entry later doesn't invalidate existing codes (importers fill the
  new field from current defaults)
- removing one doesn't break old codes (unknown keys are ignored and reported)
- device-local settings can never leak — audio, accessibility, palette, Chaos Mode and
  the debug switches are deliberately absent, and a regression check asserts it
- every value is re-validated and every collection capped on import, so a hand-edited
  code can't inject `lvl: 9e99` or an array big enough to fill localStorage
- a truncated or altered code fails its checksum and is refused **whole**

`SAVE_TRANSFER_VERSION` describes the *envelope*, not the manifest. Adding or removing
manifest entries must **not** bump it — that would break compatibility the design already
handles. Bump it only if the envelope itself changes, and keep reading the old version.

`parseSaveCode()` validates without writing, which is what lets the UI show the player
what a code contains before they overwrite a career. Keep that separation.

## Screens: use `hideAllScreens()`

Every screen opener hides the others through `hideAllScreens(exceptId)`. It used
to be a hand-written list of sibling screens inside each opener, which meant a new
screen had to be added to a dozen lists and any single miss left two screens
stacked on top of each other (this was patched by hand twice before being fixed
properly). `#hud` is **not** a `.screen` — it's the battle itself — so openers
that need it hidden still say so explicitly. The regression suite checks every
opener pair leaves exactly one screen visible.

## 🧪 Experimental Mode (v1.22.0)

`SAVE.experimental` is one switch, off by default, that gates rule changes — things that
alter how the game is *played* rather than what is *in* it. Three rules govern it:

1. **`EXPERIMENTS` is the registry.** One entry per experiment, carrying the copy the
   Settings screen renders. Adding the next experiment should be a table entry, not another
   scattered `if(SAVE.something)`.
2. **Battles read `G.experimental`, menus read `experimentalOn()`.** Use `battleExperimental()`
   in gameplay code — it returns the battle's snapshot when a battle exists and the live
   switch otherwise. Reading `SAVE.experimental` directly inside a battle is a bug: Settings
   is reachable from the pause menu, so a player could change the rules of a fight they were
   losing, and a battle could begin permissive and end restrictive.
3. **A lesson can force it on** (`INDOC_FIELD` entries with `experimental:true`), because the
   lesson teaching a rule has to be able to demonstrate it regardless of the setting. That is
   the only override; nothing else raises the flag.

An experiment that is off must be **absent, not hidden**. The rule does not run, the UI says
nothing about it (`syncStanceUI` resets the row label to plain `STANCE`), and anything whose
only purpose is to relieve the rule — `REVENTS.orders` — falls through to something real
rather than firing a no-op.

## Field School: system lessons in Indoctrination (v1.22.0)

`INDOC` (nine doctrine lessons) and `INDOC_FIELD` (five system lessons) concatenate into
`INDOC_ALL`. Everything else keys off `indocId(L)`, which is `L.id || L.doctrine`.

**The nine original lessons must keep `id === doctrine`.** That is what they were already
keyed by in `SAVE.indocDone`, so existing cleared progress survives; changing one silently
resets a player's school. There is a regression check asserting exactly this.

Field lessons carry three optional escape hatches, all off for the original nine:

| Field | Effect |
|---|---|
| `rankFree` | `G.rankFree` — bypasses `unitRankOk` in the deck, `strikeRankOk` for powers, and `groupUnlocked` for orders |
| `experimental` | forces the commitment rules on for that lesson |
| `groups` | the lesson arrives with a standing order already given |

`strikeRankOk(key)` exists because a power's rank gate had **three** call sites — the deck
card, the hotkey and the ability function itself — and all three have to agree or the card
lights up and the button does nothing.

The exemptions are scoped to `G`, so they vanish the moment the lesson ends. There is a
regression check that a Rank 5 player who has just played the Counter-Battery lesson cannot
see the card in a normal battle.

## Exits: `closeTopLayer()` and `escapeOneLevel()` (v1.22.0)

One stack, walked one level at a time:

```
crate overlay → modal overlay (OVERLAY_IDS) → orders popover → .screen → (Escape only) pause
```

- `closeTopLayer()` closes one layer and returns whether there was one. **`#menu` is
  deliberately excluded** — it is the destination, not a panel, and a Menu button that walked
  you off the menu would be a trap.
- `escapeOneLevel()` is `closeTopLayer()` plus a pause fallback over a live battle. Escape
  must never be destructive, so it pauses rather than quitting.
- The ☰ Menu button calls `closeTopLayer()` **first** and only offers to abandon the battle
  when nothing is stacked.
- `firstrun` is intentionally absent from `OVERLAY_IDS`: it is a question the player has to
  answer, not a panel they wandered into.

Both the Escape handler and the dev-tools chord (Ctrl/⌘+Shift+D) bail out when the
event target is an `input`, `textarea` or `contenteditable`. Typing a dev code into the panel
would otherwise toggle the panel out from under you. The chord deliberately avoids backtick —
that key is already the AI thinking overlay, and a capture-phase handler taking it would have
silently killed an existing binding.

## Commitment budgets: stance & standing orders (v1.21.0)

Stance and standing orders share one model, and it is worth knowing why before touching
either. Both are **free during prep and cost one change once the fight is live**:

```js
const STANCE_FREE_CHANGES=1;   // G.stanceChanges
const GROUP_FREE_CHANGES=1;    // G.groupChanges
```

Three things about it are load-bearing:

1. **The prep test is `G.prep>0`, never `G.frozen`.** `G.frozen` is only raised by the first
   `step()`, so a change made in the window between the battle being created and that first
   tick landing gets billed against the live budget. This was a real bug; both call sites now
   test `G.prep` alone.
2. **The tutorial is exempt outright** (`G.prep>0||G.tutorial`). It runs with `prep:0` and its
   whole job is letting a new player press the buttons to see what they do.
3. **`REVENTS.orders` (Field Reassessment) is the only refund**, and it grants one of *each*.
   Adding a second source of changes is the thing most likely to quietly undo the design —
   the budget is what makes the choice a decision.

`setStance()` and `setGroupDoctrine()` both return a **boolean** for whether the change
landed. Callers that assume they always succeed will silently desync their UI.

Spent stances get the `.spent` class via `syncStanceUI()`, which is called on change, on the
event, and at the moment prep ends. If you add a fourth stance, nothing else needs touching.

## Support units: `support`, `fixCats` and `charging` (v1.21.0)

`support:true` means "never shoots" — it gates fire through `const canShoot=!u.support||u.charging;`.
The EW Jammer carries it too, so a change to support behaviour touches the jammer as well as
the Medic and Engineer.

`fixCats` is what splits the Medic (`['inf']`) from the Engineer (`['veh','arty']`), and it
drives **two** separate things: which units `supportTick` will heal, and which units the
positioning block will anchor behind. Both go through `canFix(u,o)`; keep them consistent or
you get a unit that follows something it cannot mend.

The anchor search deliberately **skips other support units** (`if(o.support)continue;`).
Without that, two Medics pair off and shelter behind each other while the line they exist to
support goes untreated.

`u.charging` is a one-way latch: once a support unit finds nothing left to anchor on it stops
being support for the rest of its life, even if a friendly later arrives. That is intentional
— a unit that oscillated between charging and retreating looked broken.

## Win-condition floors (v1.20.0 / v1.21.0)

`BOMBARD_HQ_FLOOR=1` is applied in **two** places and both matter:

- the arc-projectile landing handler, for the Bombardment order — and it deliberately never
  calls `checkWin()`;
- the HQ-contact branch of `updateUnits`, for drones under the Base Bomber order, keyed on
  `unitGroup(u).mode==='bomber'`.

Both exist so an order that ignores the enemy army entirely cannot close a game. If you add a
third "hit the HQ without fighting" behaviour, it needs the same floor, or it becomes the
fastest win in the game within a day of shipping.

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
