# Frontline Commander — Development Phases

This file tracks which development phase built which part of the codebase, so
Phase 1 (alpha/playtesting) work never gets mixed up with Phase 2 (website)
work as the project moves toward a hosted lite version ahead of the full
Steam release.

## Phase 1 — Alpha & Playtesting (complete)

**Versions:** `1.0.0` – `1.8.0` (see the in-game Patch Notes screen, or the
`PATCH_NOTES` array in `wargame.html`, for the full version-by-version list).

Scope: build the game itself as a single self-contained `wargame.html` file,
shared directly with playtesters (Discord/email/download) rather than hosted.
Covers all core gameplay (units, doctrines, damage-type/armor matrix, modes:
Skirmish/Evolution/Blitz/Survival/Domination/War/Chaos/Rivals/Campaign/Daily),
the rank/progression system to 100, streaming/Twitch integration, narrator,
music, visual polish, mobile/touch responsiveness, and a security-hardening
pass (XSS audit, encrypted API-key storage, CSP). Ends with the
`docs/FRONTLINE_COMMANDER_Overview.pdf` mechanics guide.

## Phase 2 — Website / Lite Version (in progress)

**Starts at:** `1.9.0`

Scope: turn the playtested game into a hosted, functional website — a lite
version of the eventual Steam release. This covers anything that only makes
sense once the game is served from a real domain rather than opened as a
local file: usage analytics/telemetry, hosting-specific glue, and any
web-only onboarding/marketing surface bolted onto the existing game.

Planned/in-flight items:
- [x] Usage analytics — **GoatCounter** (privacy-friendly, cookieless).
      Wired in `wargame.html` in the Phase 2 block as a self-contained
      image-pixel beacon (no external script, so the standalone file still
      works offline). It counts a page open plus a lightweight per-mode
      battle-start event. **Live** — `ANALYTICS_SITE` is set to
      `https://zeusrgr.goatcounter.com` in both `wargame.html` and
      `index.html`. Note: GoatCounter's own snippet
      (`<script data-goatcounter=... src="//gc.zgo.at/count.js">`) was
      intentionally *not* used — it's an external script the page's CSP
      blocks and it would break the standalone offline copy. The
      image-pixel beacon hits the same `/count` endpoint and shows up
      identically on the GoatCounter dashboard.
- [x] Removed the placeholder "N commanders beaten it today" figure from the
      Daily panel — it was a seeded fake number (`dailyClearsToday()`), and
      with GoatCounter now live there's still no *readable* real count on the
      client (GoatCounter's dashboard API needs a private token, which can't
      be embedded in a page anyone can view-source). Real daily clears are
      still tracked as GoatCounter events (`daily-played`, `daily-cleared`,
      `daily-streak-N`) — visible to us on the dashboard — just not echoed
      back into the game UI until a real backend exists.
- [x] Committed regression suite (`tests/regression.js`) — boots the game in real
      Chromium and checks browser-compat guardrails, all 5 modes, deploy sounds,
      and the loader failsafe under an injected parse error. `tests/README.md`
      has run instructions. Exits non-zero on failure — wireable into CI.
- [x] Aggregate crash telemetry — `_logErr()` now also fires a GoatCounter event
      per distinct error class (kind + source file + line, NEVER the message
      text) so a broken build is visible on the dashboard instead of only
      surfacing when a player self-reports through Feedback. Capped at 5
      distinct events per session.
- [ ] Hosting setup (domain, static hosting or CDN).
- [x] Copyright/licensing: added a `LICENSE` file (all-rights-reserved
      placeholder — swap the holder name and get it lawyer-reviewed before a
      commercial release), a copyright header comment at the top of
      `wargame.html`/`index.html`, and a visible in-game/landing-page
      copyright line. **Important limit:** this is a legal/attribution
      marker, not a technical protection — `wargame.html` is a browser game,
      so anyone who loads it can always open dev tools / view-source and read
      the full HTML/CSS/JS. There is no way to make client-side source
      literally unreadable; minifying/obfuscating it would only make it
      harder to read, not impossible, and would also break the
      easy-to-share single-file workflow this project depends on.

## How Phase 2 code is marked in `wargame.html`

The file stays a single self-contained HTML/CSS/JS document on purpose (see
git history — splitting it into separate files previously broke sharing).
To keep phases distinguishable inside that one file:

1. A banner comment — `PHASE 2 — WEBSITE / LITE-VERSION ADDITIONS BELOW THIS
   LINE` — sits at the very end of the `<script>` block, right before
   `</script>`. Everything above it is Phase 1. New Phase 2 code is appended
   below it, in its own clearly-commented sub-block (e.g.
   `/* ── ANALYTICS (Phase 2) ── */`).
2. `GAME_VERSION` and `PATCH_NOTES` mark the boundary: `1.9.0` is tagged in
   `PATCH_NOTES` as "Phase 2 begins" — every release from here on is Phase 2
   unless a future note says otherwise.
3. This file (`PHASES.md`) is the source of truth for phase scope — update
   its checklist as Phase 2 items land.

## Bugs fixed at the Phase 1 → 2 boundary

- **Pause → Menu soft-lock:** clicking the topbar `☰ Menu` button while the
  battle was paused called `openMenu()` without hiding `#pauseScreen` first.
  `openMenu()` also nulls out the active game (`G = null`), so the `Resume`/
  `Abandon` buttons on the still-visible PAUSED overlay stopped doing
  anything (`Resume` silently no-op'd, `Abandon` threw trying to read
  `G.paused` on a null `G`), leaving the player stuck looking at the PAUSED
  screen with no way out. Fixed by having `openMenu()` unconditionally hide
  `#pauseScreen` itself, and hardening the `Abandon` handler against `G`
  already being null.
