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
