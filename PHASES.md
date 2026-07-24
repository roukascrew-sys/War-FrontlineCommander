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
- [ ] Usage analytics (page-load / battle-started tracking) — provider
      choice pending (leaning GoatCounter for a privacy-friendly free
      dashboard; alternatives: GA4, Cloudflare Web Analytics, self-hosted
      counter). Needs a site code/measurement ID from the project owner
      before it can be wired in.
- [ ] Hosting setup (domain, static hosting or CDN).

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
