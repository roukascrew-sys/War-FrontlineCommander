# Agent Review — full checklist, build v1.23.0

Every persona in `.agents/` run over the build, then consolidated by the Executive Board.

**Build reviewed:** `wargame.html` v1.23.0 · 13,215 lines · 916 KB · single file, zero dependencies
**Tests:** 419 headless regression checks · **Measured funnel:** GoatCounter, n=127 (v1.17.1)

Where a finding rests on something I could not verify from inside the repo, it says so. Nothing
below is invented to fill a section.

---

## The one finding that outranks everything else

> **The save is client-side, unsigned, and trivially editable — and the next planned feature is a
> global leaderboard.**
>
> Today this is harmless: every score is local, every unlock is cosmetic, and a player who edits
> their own save only cheats themselves. The moment a shared board exists, that same file becomes
> the submission payload, and the board is worth exactly nothing.
>
> This is not a bug in the current build. It is a **design constraint on the next one**, and it is
> cheaper to accept now than to retrofit after launch. `docs/SUPABASE_GUIDE.md` already states the
> rule — *`rated_score` must be computed server-side, never sent by the client* — and that rule is
> the whole answer. Ship the board only when it holds.

---

# 01 · CTO — long-term technical quality

| # | Finding | Severity | Blocks release |
|---|---|---|---|
| 1.1 | 13,215 lines in a single file | **High** | No |
| 1.2 | 91 `innerHTML` assignments | Medium | No |
| 1.3 | `sanitizeSave()` validates top level only | Medium | No |
| 1.4 | Explicit spawn whitelist fails silently | Medium | No |
| 1.5 | No build step, so no minification or tree-shaking | Low | No |

**1.1 — The single file is both the product and the debt.**
It is genuinely the right call for distribution: one file is what makes the game embeddable
anywhere, mirrorable by unblocked-games sites, and archivable. It is also why navigating it now
depends on `CODE_GUIDE.md` rather than on structure. *Recommendation:* do **not** split it. Instead
keep doing what the last three releases did — every new subsystem gets a banner comment and a
`CODE_GUIDE.md` section in the same commit. The cost is discipline, not architecture.

**1.2 — `innerHTML` is used heavily, but the untrusted paths are clean.**
I checked the one genuinely untrusted source, Twitch chat. `chatMsgRaw()` escapes both the username
and the message with `escapeHTML()`, and validates the user colour against `/^#[0-9a-fA-F]{3,8}$/`
rather than interpolating it raw. That is the correct pattern and it is applied at the right place.
The remaining 90 sites interpolate values this file itself owns. *Recommendation:* keep the rule
"any string that came from outside this file goes through `escapeHTML`" written down — it is
currently true by practice, not by enforcement.

**1.3 — Nested save structures are hand-normalised.**
`sanitizeSave()` iterates `Object.keys(DEFAULT_SAVE)` and type-checks one level. Nested objects
(`SAVE.gauntlet`, `SAVE.rivals`, `SAVE.groups`) are accepted wholesale if they are objects at all,
and are re-normalised by hand where they are read (`gauntletState()` does this properly). This
works, but it is a convention rather than a guarantee. *Recommendation:* when the backend lands,
that is the moment to add per-key validators — not before, because the current failure mode is
"one player's own edited save behaves oddly".

**1.4 — The spawn whitelist has now bitten three times.**
A flag added to `UNITS` does nothing until it is also copied in `spawn()`, and it fails *silently*.
There is a regression check asserting every boolean flag survives a spawn, which is the right
mitigation. This release added four more flags (`nullStealth`, `cpDrain`, `nullField`, `nullDecoy`)
and they were copied. *Verdict:* mitigated, keep the check.

**Technical health: 78/100.** The engineering discipline (393→419 tests, empirical balance, banner
comments) is well above what a solo browser game normally carries. The score is held down by file
size and by validation that depends on convention.

---

# 02 · QA Lead — attempt to break it

| # | Finding | Severity | Blocks release |
|---|---|---|---|
| 2.1 | `AudioContext` is never closed | Low | No |
| 2.2 | Two `setInterval` timers run outside battles | Low | No |
| 2.3 | Chaos mode caps at 110 units; nothing else caps | Medium | No |
| 2.4 | UMBRA/Glitch King are reachable only very late | Medium | No |
| 2.5 | Deep-linked settings row depends on layout | Low | No |

**2.1 / 2.2 — Long-session behaviour.**
`MUSIC.timer` (40 ms) and `WARAMB.timer` (900 ms) are both cleared by their stop functions, and the
new mixer buses are rebuilt if the context is ever replaced (`b.context !== c`). A browser tab left
open for hours holds one `AudioContext` and at most those two intervals. That is acceptable.
*Recommendation:* none — this was checked specifically because the mixer added a long-lived node,
and the node is a single `GainNode` per channel.

**2.3 — Only chaos mode caps unit count.**
`G.units.length < 110` guards chaos spawns. Ordinary battles have no hard cap; they are limited by
CP economy instead, which has held in every long-running simulated fight. *Recommendation:* watch
Survival at high waves specifically — it is the only mode where the enemy budget grows without a
matching player cap. Not a blocker; no failure observed.

**2.4 — The new content is behind a very deep gate.**
UMBRA requires clearing all five rivals *and* prestiging. On the measured funnel — 32 loads, 7
first battles — the number of players who will ever see it rounds to zero. That is defensible for
a secret, but it means the most novel fight in the game is invisible to almost everyone.
*Recommendation:* leave the gate, but make the Rivals screen say a reset exists once the roster is
clear — which it now does. That is the only breadcrumb needed.

**2.5 — `settingsFocus()` runs on the next animation frame** precisely because `scrollIntoView`
inside a `display:none` ancestor silently does nothing. Verified working; noted here because it is
the sort of thing that breaks quietly if the settings screen is ever re-parented.

**Stability: 84/100.** No crash, hang or state-corruption path found. Zero unexpected page errors
across the full suite.

---

# 03 · Security Engineer — assume hostile attackers

| # | Finding | Severity | Blocks release |
|---|---|---|---|
| 3.1 | Save editing / console cheating | **Critical *when the board ships*** | No, today |
| 3.2 | CSP is strict and correct | — (positive) | — |
| 3.3 | Twitch chat is escaped and colour-validated | — (positive) | — |
| 3.4 | Dev codes are plain text in the file | Low (by design) | No |
| 3.5 | A portal ad SDK would require loosening CSP | **High** *if pursued* | No |

**3.1 — See the headline finding.** `localStorage` is readable and writable by the player, `window.G`
is exposed deliberately for testing, and `SAVE.debugUnlockAll` exists. For a single-player game with
local-only scores this is not a vulnerability — it is a sandbox. It becomes a real one the instant a
score leaves the machine.

**3.2 — The CSP is unusually good for a game.** `default-src 'none'` with everything granted
explicitly; `connect-src` limited to the Twitch IRC socket and GoatCounter; `object-src 'none'`,
`base-uri 'none'`, `form-action 'none'`. `script-src` uses `'unsafe-inline'` because all logic is
inline by design, and the comment in the file explains that trade honestly — it still blocks an
injected external script, which is the realistic bar here.

**3.4 — Dev codes are documented as convenience, not security.** Correct framing. Anyone reading the
file finds them; nothing behind them is worth protecting.

**3.5 — The portal decision is a security decision.** Most HTML5 portals that pay revenue share
require their ad SDK from their own domain. Taking that money means loosening the CSP that makes
this file safe to embed anywhere. *Recommendation:* if pursued, do it as a **separate build target**
and never in the itch build. This is already stated in `docs/growth-plan.html`; repeating it here
because it is the one growth move with a security cost.

**Security posture: 82/100 today · 41/100 the day a global leaderboard ships without server-side
scoring.**

---

# 04 · Legal / IP — General Counsel

| # | Finding | Severity | Blocks release |
|---|---|---|---|
| 4.1 | Zero third-party assets — everything is procedural | — (strong positive) | — |
| 4.2 | Privacy/Terms contain unfilled placeholders | **High** | **Yes, for a paid launch** |
| 4.3 | Trademark on "FRONTLINE COMMANDER" not cleared | Medium | No |
| 4.4 | Emoji used as UI glyphs | Low | No |
| 4.5 | Twitch chat is user-generated content shown on stream | Medium | No |
| 4.6 | Analytics processor terms not verified | Medium | No |

**4.1 — This is the strongest part of the whole project.** No external fonts, no image files, no
audio files, no models, no textures, no libraries. Music and every sound effect are synthesised at
runtime with WebAudio; every sprite and every UI figure is drawn from CSS shapes or canvas
primitives. There is no third-party licence to comply with, no attribution to carry, and no
takedown surface. Very few games can say that. *Keep it that way* — the first `<img src>` or npm
dependency changes this section entirely.

**4.2 — CORRECTION: the legal pages were already complete.** This review originally listed
unfilled placeholders as a High-severity blocker. That was **wrong**. Commit `6c4440c` ("Indiana
governing law — both documents are now fully filled in") had already set the controller name,
contact address and governing jurisdiction, and `build-itch.sh`'s placeholder guard does not fire.
I asserted the finding from the *existence* of the guard rather than by running it. *No action;
the item is closed.*

**4.2b — What the legal pages DID need (v1.24.0).** The global leaderboard is the first feature in
the game that ever sends anything a player would recognise as their own. `privacy.html` (a new row
in "What the game sends", plus a rewritten retention section naming Supabase and the deletion
route), `terms.html` (a leaderboard conduct rule and a new §7a) and the in-game privacy panel were
all updated in the same commit as the feature — which is the rule the code comment already
stated.

**4.3 — Name clearance is unverified.** "Frontline" and "Commander" are both heavily used in games.
I cannot run a trademark search from here. *Assumption stated:* none has been done. *Action:* a
basic search before any paid storefront listing; renaming after a Steam launch is far more
expensive than before one.

**4.4 — Emoji are OS-supplied font glyphs**, not embedded assets, so no licence travels with the
file. Worth knowing they render differently per platform — a cosmetic risk, not a legal one.

**4.5 — Live Twitch chat is displayed in-game.** The integration is anonymous, read-only IRC, which
is the right design. But it means arbitrary viewer text appears on a streamer's screen. It is
escaped (no XSS), but it is not *filtered*. *Action:* consider a profanity filter toggle before
promoting the feature to streamers, whose platforms have their own content obligations.

**4.6 — GoatCounter is a data processor.** The game sends event names and page views. I could not
verify its current terms, hosting region or cookie behaviour from inside this repo. *Action:*
confirm and make sure `privacy.html` matches what it actually does. The in-game privacy section is
exhaustive and well written; keep the rule that any new network call gets a row in the same commit.

**Legal Readiness 71/100 · IP Protection 88/100 · Commercial Readiness 58/100**
(Commercial is low for one reason only: there is still no way to receive money.)

---

# 05 · Product Manager — player experience

| # | Finding | Severity |
|---|---|---|
| 5.1 | Tutorial hang fixed; effect unmeasured | **High** |
| 5.2 | 75% of page visitors never press Run Game | **Critical** |
| 5.3 | Depth is now enormous; the on-ramp is one tutorial | High |
| 5.4 | Experimental Mode is correctly opt-in | — (positive) |
| 5.5 | Field School answers "what does this do?" | — (positive) |

**5.1** — Tutorial completion was 4/17. The hang was reproduced directly and fixed in v1.17.2. The
fix has **not been re-measured**, and it is the single number most worth checking.

**5.2** — Still the biggest leak in the product, and it is not in the product: it is the itch page.
Six hours of page work returns ~134 players/hour against ~14 for promotion work.

**5.3** — The game now has 21 units, 9 doctrines, 8 modes, standing orders, stances, Experimental
Mode, a 14-lesson school, an adaptive Gauntlet and two secret rivals. One tutorial carries all of
it. Field School genuinely helps, but it is opt-in and behind the title menu. *Recommendation:* the
highest-value remaining onboarding work is a **prompt after the first won battle** pointing at the
one lesson matching what the player just did.

**5.4** — Gating Doctrine Commitment behind an opt-in switch was the right call, and the measurement
that drove it (40 changes wanted, 7 granted) is the kind of evidence more of these decisions
deserve.

**Player Experience: 74/100** — high ceiling, narrow door.

---

# 06 · Marketing Director

Covered in full by `docs/growth-plan.html`. The three findings that matter here:

1. **No Steam page exists**, and both prior GTM documents route every funnel through one.
2. **The game's actual shape** — one self-contained HTML file — has a distribution economy
   (portals, directories, embeds, school Chromebooks at 13% of measured traffic) that neither
   prior plan mentions.
3. **v1.23.0 is a strong devlog beat**: an enemy that fights your interface, a skull that changes
   what it is rather than getting angrier, and units you cannot see. That is more postable than any
   balance change.

**Marketing Readiness: 46/100** — the assets are good, the channels are unbuilt.

---

# 07 · CFO — long-term profitability

| Line | Status |
|---|---|
| Hosting cost | **$0** — single static file, itch serves it |
| AI/runtime cost | **$0** — no server, no inference, no API |
| Development cost | Time only |
| Marketing spend | $0 |
| **Revenue** | **$0, structurally** — no collection mechanism exists |
| Player acquisition cost | $0 — and 32 players |

**The margin is infinite and the numerator is zero.** This is the cheapest possible product to
operate: no servers, no assets, no dependencies, no per-user cost. That is a genuine strategic
asset, because it means the break-even point is *one donation*.

**Recommendation, unchanged:** one hour of work — Ko-fi plus itch pay-what-you-want — moves the
revenue ceiling off zero. Every other financial question is downstream of that and not worth
modelling until it is done. The Steam Direct $100 has explicit trigger conditions in the growth
plan; until both are met the answer is no.

**Financial Health: 62/100** — excellent cost structure, no revenue path switched on.

---

# 08 · Release Manager — would 10,000 users on day one survive?

**Yes, and this is the easiest "yes" in the review.** The game is a single static file with no
server, no database and no per-user state. 10,000 concurrent players cost exactly the same as one.
itch.io serves the file from its own CDN. There is no scaling story to get wrong.

| Category | Finding | Level |
|---|---|---|
| Stability | Zero unexpected page errors across 419 checks | ✔ |
| Performance | Runs on ChromeOS and phones (41% of measured traffic) | ✔ |
| Deployment | `build-itch.sh` allowlist — exactly 3 files, verified each build | ✔ |
| Rollback | itch retains prior uploads; revert is a re-upload | ✔ |
| Save compatibility | `sanitizeSave()` fills defaults; old saves load | ✔ |
| Boot failure | Watchdog + fallback screen, and it no longer false-positives | ✔ |
| Error reporting | Capped at 5 distinct errors/session via GoatCounter | **MEDIUM** |
| Monitoring | Event counts only — no dashboard, no alerting | **MEDIUM** |
| Legal pages | Placeholders unfilled | **HIGH** (paid launch only) |
| Onboarding | One tutorial for a very large game | **HIGH** |

**Release Readiness: 81/100 · Confidence: high · Decision: GO WITH MINOR FIXES**

The build is shippable as an open playtest today. It is not ready for a *paid* launch until the
legal placeholders are filled and a name search is done.

---

# 09 · Executive Board — consolidation

Disagreement to resolve: **the CTO wants the file split; Marketing and the Release Manager both
depend on it staying one file.** The Board sides with keeping the single file — its distribution
value is measurable and its maintenance cost is being managed by documentation. Revisit only if a
second developer joins.

## Top 10 priorities

| # | Action | Owner | Effort | Why it is here |
|---|---|---|---|---|
| 1 | **Ko-fi + itch pay-what-you-want** | CFO | 1h | Revenue ceiling is $0 until this exists |
| 2 | **Rebuild the itch page** (GIF first, "no download" opening line, mobile embed, tags) | Marketing | 4h | 75% leak; ~10× the return of promotion work |
| 3 | **Re-measure the tutorial funnel** | Product | 0h | The fix shipped six versions ago and was never verified |
| 4 | ~~Fill the legal placeholders~~ **— already done (6c4440c); this review was wrong** | Legal | 0h | Closed. See 4.2 |
| 5 | ~~Decide the leaderboard rule before building it~~ **— built to that rule in v1.24.0** | Security | 0h | `rated_score` is derived in the Edge Function; `runs` has no insert policy at all. 35 tests in `tests/backend.test.js` |
| 6 | **Submit to Newgrounds + Internet Archive** (no SDK needed) | Marketing | 2h | Permanent placements; no CSP cost |
| 7 | **Post-first-win nudge to the matching Field School lesson** | Product | 3h | Largest remaining onboarding gap |
| 8 | **Trademark search on the name** | Legal | 1h | Cheap now, expensive after a store listing |
| 9 | **Profanity filter toggle for live chat** | Legal/Product | 2h | Before promoting the feature to streamers |
| 10 | **Keep the zero-dependency rule written down** | CTO | — | It is the single best legal and technical asset the project has |

## Launch recommendation

**GO for open playtest. HOLD for paid launch** until items 4 and 8 are done.

## Studio health

**Engineering 8/10** — unusually rigorous for the scale.
**Product 7/10** — deep game, narrow entrance.
**Commercial 3/10** — no revenue path connected, no channels built.
**Legal 7/10** — outstanding asset position, routine paperwork outstanding.

The pattern across all eight reviews is the same: **the thing being built is in good shape, and
almost nothing that turns it into a business has been switched on.** Nine of the ten priorities
above are under four hours each.
