# Creator Mode — architecture summary & integration map

*Sections 1–8 were written before implementation, as the brief requires; §9 and §10 record
what actually shipped. Everything below was read out of `wargame.html` rather than assumed.
Line numbers are from v1.28.0 — they have already drifted by roughly the length of the
Creator Mode block itself, so treat them as a hint, not an address.*

## 1. What the existing game actually is

`wargame.html` is one self-contained file: no modules, no build step, no bundler. Every
system is a top-level function or `const` in a single script tag. There are two long-lived
objects and one transient one:

| Object | Lifetime | Meaning |
|---|---|---|
| `SAVE` | forever (localStorage) | career progress, unlocks, cosmetics, leaderboard opt-in, outbox |
| `G` | one battle | the live match: units, projectiles, economy, AI state, result |
| `LAUNCH` | one `newGame()` call | a launcher's scenario override, consumed and then ignored |

`newGame()` (≈5540) reads `LAUNCH` into a local `L` and builds `G` from it. `LAUNCH` is
therefore *the existing scenario-injection seam* — campaign missions, dailies, the
tutorial, Rivals, the Gauntlet, Indoctrination and War Mode all already arrive this way.
Creator Mode does not need a new entry path; it needs a new `LAUNCH` shape.

The fields `LAUNCH` already understands: `type, diff, weather, doctrine, groups, ecpMul,
startCp, allowed, enemyAllowed, enemyBias, banned, cdMul, experimental, rankFree,
openEnemy, timeTrial, parTime, mission, daily, secret, warName, rival, indoc, gauntlet,
infowar, nullArmy, mut`.

### Wrapper vs ruleset

```js
const kind = L ? L.type : sel.mode;                       // the wrapper
const mode = (kind==='blitz'||kind==='survival'||kind==='domination') ? kind : 'skirmish';
```

`kind` is *which screen launched this*; `mode` is *which rules apply*. Creator Mode is a
new **kind** (`'creator'`) that resolves to an existing **mode**. It invents no new rules.

## 2. The registries Creator Mode reads (never duplicates)

| Registry | Line | Count | Notes |
|---|---|---|---|
| `DOCTRINES` | 3101 | **9** | blitzkrieg, mass, airpower, precision, swarm, bastion, fires, recon, guerrilla |
| `UNITS` | 3143 | 22 | the real unit table, with cost/armour/damage type |
| `DIFFS` | 4274 | 5 | recruit, veteran, elite, legendary, **legendaryplus** |
| `STANCES` | 3349 | 3 | assault / defend / skirmish |
| `GROUP_DOCTRINES` | 3424 | 3 | arty, armor, drone |
| `STRIKES` | 5875 | 6 | commander powers |
| `WEATHERS` | 4622 | — | incl. `clear` |
| `COUNTRIES` | 3317 | — | cosmetic flavour |

Every Creator Mode picker enumerates these tables at runtime with `Object.keys()`. No
Creator file hard-codes a unit list, a doctrine list or a difficulty list, so a unit added
to `UNITS` tomorrow appears in the Creator UI with no further work — and a unit *removed*
cannot leave a dangling reference in the picker.

## 3. The three pivotal findings

### 3.1 `endGame()` is the single progression choke point

`endGame(winner, reason)` (≈9125) is the **only** place the game writes a battle outcome
anywhere durable. In order it performs: gauntlet commit → war resolve → doctrine unlocks →
`checkMedals` → `recordBattle` → `boardRecord` (local board) → **global submit** →
`streakRecord` → `beatTodayRecord` → `addXP` → `persist()`.

It already contains exactly the precedent Creator Mode needs:

```js
if(G.tutorial){ SAVE.seenTut=true; persist(); showResults(won,reason,0,0,false); return; }
```

Creator Mode gets the same early return, placed **above** every scoring line, so a creator
battle cannot reach XP, medals, the local board, the streak, the career record, or the
global submit — not because the UI hides them, but because control flow never arrives.

This is the answer to the brief's requirement: *"If the current leaderboard system has a
central submission function, identify and gate it explicitly rather than relying on UI
restrictions."* The choke point is `endGame()`, and the submit call itself
(`LEADERBOARD_BACKEND.submit`, ≈3959) is gated a second time, independently.

### 3.2 `aiStep(dt)` was hard-coded to RED

`aiStep` (≈6808) scans `u.side==='B'` to build a threat picture, spends `G.ecp` at
`G.ecpRate`, times itself off `G.aiT`/`G.aiThink`, reads `G.aiSmart`/`G.diffMul`/`G.diff`/
`G.gaunt`/`G.enemyBias`/`G.enemyAllowed`/`G.banned`, and finishes with
`spawn('R', key, pickLane())`.

**Every difficulty behaviour the brief insists on preserving lives in this one function** —
the Legendary surge (`surging`), the aggression-scaled commit fraction, the weak/strong
lane read, the smart unit cap. There is no separate "Legendary+ AI"; it is this function
plus `G.enemyStance` / `G.enemyGroups` / `G.enemyFire`, which `newGame()` grants.

`startAttract()` / `attractTick()` (≈13386) are **not** an AI. They deploy a random unit
every 0.45–0.95 s with a fixed CP grant. Using them for AI-vs-AI would ship a spectator
mode that never shows the real game.

So AI-vs-AI is implemented by **parameterising `aiStep`, not duplicating it**:

```js
function aiStep(dt){ aiStepSide(dt, aiCtx('R')); if(G.aiB) aiStepSide(dt, aiCtx('B')); }
```

`aiCtxR()` is a view whose accessors write straight through to the existing `G.ecp`,
`G.aiT` … fields, so **red's behaviour is byte-identical** and every other system that
reads `G.ecp` (the AI debug overlay, chaos mode, the HUD) is untouched. `aiCtxB()` reads
and writes a parallel `G.aiB` bag. Both sides run the same code, so blue gets the genuine
Legendary+ commander, not an aggression slider.

Two side-specific details had to be handled rather than papered over:

- **Unit quality.** `spawn()` applies `diff.qualMul` only to red, because only red was ever
  an AI. A creator battle applies the blue force's own `qualMul` when `G.aiB` exists —
  otherwise a spectated *Legendary+ vs Recruit* would field two identical armies and the
  matchup on screen would not be the matchup that was configured.
- **The surge warning.** `announce('⚠ ENEMY SURGE', …, 'brace')` is addressed to the
  player. In a spectated fight both sides are opponents and neither is "them", so it is
  suppressed there and unchanged everywhere else.

**Known limit, stated rather than faked: off-map fire support is red-only.**
`gauntStrikeTick()` and its helpers scan `u.side==='B'`, clamp the reticle to
`W*0.05 … W*0.62`, and lead the target in red's direction of travel throughout. Mirroring
that is a real piece of work, and a half-mirrored version would put a blue Legendary+'s
shells in the wrong half of the field. A blue AI therefore fights with the whole decision
layer — deployment, stance, standing orders, budget discipline, lane reads — and without
strikes. The editor says so at the point where it would be configured.

### 3.3 There is no existing hard cap on unit count

`spawn(side, key, lane, xOverride)` (≈5776) will create whatever it is asked to. The AI
self-limits (`maxUnits` ≈ 6–12 per decision) and the player is limited by CP, so no cap was
ever needed. A Creator Mode that lets someone type a quantity **must** impose its own —
see §6.

## 4. State separation

The brief requires the normal game and Creator Mode never share mutable state. Three
distinct objects, with the boundary drawn at `SAVE`:

```
SAVE          career, unlocks, board, streaks   ← Creator Mode NEVER writes this
SAVE.creator  scenario library + creator prefs  ← the ONLY key Creator Mode writes
G             the live battle (creator or not); G.creator marks which
CREATOR       the authoring session: draft scenario, UI state, generator seed
```

`G` is reused deliberately — a creator battle must be the *same simulation*, or the mode
is worthless for balance testing. The separation is not "a different `G`", it is
`G.creator === true` acting as a hard gate at every durable-write boundary. That is
strictly safer than a parallel state object, because a parallel object would silently
diverge from the real game as the file grows, and the gate would still have been needed.

## 5. Scenario schema

Versioned, serialisable, and **data only**:

As shipped (`creatorDefaultScenario()`):

```js
{ v: 1, name, notes, seed,
  field: { ruleset, weather, terrain:[3], prep, speed },
  sides: { B: force, R: force },
  rules: { banned:[], timeLimit, randomEvents, fog },
  meta:  { created, gameVersion } }
```

A `force` is:

```js
{ control:'human'|'ai', doctrine, diff, country, stance,
  groups:{arty,armor,drone}, allowed:[]|null, bias:key|null,
  opening:[{key,lane,count}], cpMul, startCp, hqMul, strikes }
```

Note what the economy fields are: **multipliers on the real numbers**, not replacements for
them. `cpMul` scales the income the doctrine and difficulty already produced; `hqMul` scales
the HQ the doctrine already sized. A scenario tilts the game's own arithmetic — it never
sets a stat directly, which is what keeps this an authoring layer rather than a cheat menu.

Import validation is **structural whitelisting**: a fresh default object is built and each
known field is copied across after being checked against the live registry or clamped to a
documented range. Nothing from the file is ever passed to `Function`, `eval`,
`setTimeout(string)`, or assigned to `innerHTML`. Unknown keys are dropped rather than
merged, so a payload cannot smuggle `__proto__` or a field a future version will read.

## 6. Limits (documented, enforced, and chosen for stability)

| Limit | Value | Why |
|---|---|---|
| units per opening order | 40 | one lane visibly saturates around 25 |
| total opening units per side | 80 | |
| opening orders per side | 12 | |
| total live units (creator only) | 260 | frame time degrades past ~300 |
| scenarios stored | 20 | localStorage budget shared with the career save |
| imported JSON bytes | 64 KB | a scenario is a few hundred bytes; this is 100× headroom |
| scenario name | 40 chars, normalised | reuses `normName`'s control-character stripping |
| notes | 240 chars, normalised | |
| per-side economy | ×0 – ×6 | |
| per-side starting CP | 0 – 2000 | |
| per-side HQ health | ×0.1 – ×10 | |
| scenario time limit | 0 – 1800 s | |

Exceeding a limit is a **validation error shown in the editor**, not a silent clamp,
except on import where clamping is safer than rejecting a whole file.

## 7. What Creator Mode reuses rather than reinvents

- `LAUNCH` → the launch path
- `spawn()` → placing the opening forces
- `setStance()` / `setGroupDoctrine()` → the real order system
- `aiStepSide()` → the real AI, both sides
- `announce()` (82 call sites) → the event source for the battle timeline
- `setSpeed()` / `SPEEDS=[0.5,1,2]` / `togglePause()` → time control
- `G.attract`'s `#hud.hidden` precedent → the observer view
- `DIFFS`, `DOCTRINES`, `UNITS`, `STANCES`, `GROUP_DOCTRINES`, `WEATHERS` → every picker

## 8. Integrity guarantees

1. `endGame()` returns before any scoring line when `G.creator`.
2. `LEADERBOARD_BACKEND.submit()` refuses a creator entry independently.
3. `boardRecord()`, `recordBattle()`, `streakRecord()`, `addXP()` are unreachable in a
   creator battle by control flow, and each additionally checks the flag.
4. Creator Mode writes exactly one `SAVE` key: `SAVE.creator`.
5. Imported scenarios are validated structurally; no code path executes imported content.
6. The retention funnel (`funnelOnce`, which writes `SAVE.funnel`) excludes creator
   battles alongside attract and the tutorial — a sandbox fight banked as somebody's
   "first battle done" is both a save write and a false number.
7. The regression suite (section 33) asserts all of the above, and asserts that a *normal*
   battle in the same session still reaches every one of them — without that second half
   the first is vacuous, since it would pass just as well if progression were broken.

Measured, not assumed: a full AI-vs-AI creator battle run start to finish changes **zero**
`SAVE` keys and issues **zero** submissions, while an ordinary skirmish in the same session
still banks a win, a local board place, a career row, a streak and one global submit.

## 9. What shipped

- Title → **🎬 Creator Mode** → the editor (`#creator`), a form over one plain data object.
- Per side: commander (human/AI), doctrine, difficulty, stance, all three standing orders,
  roster whitelist, AI lean, economy multiplier, starting CP, HQ multiplier, off-map fire
  (red), and an exact list of opening orders.
- Field: ruleset (skirmish / blitz / survival / domination / evolution), weather, per-lane
  terrain, prep length, starting speed, time limit, random-events and fog toggles, and a
  shared ban list.
- Library of up to 20 saved scenarios; plain-text export/import; a seeded generator.
- AI-vs-AI spectator with the commander's interface replaced by a two-side observer strip
  (`#crobs`), canvas and hotkeys inert except pause and speed.
- A battle report (`#creatorreport`) with both orders of battle, per-side deployed/lost/
  kills/HQ, and a timeline fed by `announce()`.

## 10. Deliberately not built, and why

**Battle replay.** The brief asked for replay *only if cheap*. It is not cheap here, and
the reason is specific: the simulation calls `Math.random()` directly at dozens of sites —
weapon jitter, lane picks, spawn scatter, the AI's own dice — so a replay would have to be
either (a) a full per-frame state recording, which for 260 units at 60fps is megabytes a
minute in a game whose entire storage is one localStorage key, or (b) a deterministic
re-simulation, which means threading a seeded RNG through every one of those call sites and
would change the *live* game's behaviour in the process. Both are larger and riskier than
the feature they serve.

What Creator Mode ships instead delivers most of the value at none of the risk: the
**scenario** is reproducible. Anyone with the seed or the exported JSON gets the same setup,
the same forces and the same commanders. The fight that plays out on top of it differs, and
for balance testing that is arguably the point — one run of a matchup was never evidence.

**Blue off-map fire support.** See §3.2. Red-only, stated in the editor rather than
silently absent.

**RED played by hand.** The whole interface — hotbar, fog, HQ bars, the camera's read of
the field — is written from blue's side. The validator rejects it with a message rather
than accepting the setting and producing a battle the player cannot see.
