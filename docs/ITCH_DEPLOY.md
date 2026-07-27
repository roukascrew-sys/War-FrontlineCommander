# Deploying FRONTLINE COMMANDER to itch.io

## The one rule

**Never upload a zip of the repository.** itch.io serves every file in the zip at a
public URL — there is no private folder and no access control. The repo contains
internal documents that must not be public:

| File | Why it must not ship |
|---|---|
| `marketing_outlook_v1.html` | Pricing strategy and revenue projections |
| `game_report.html` | Internal market analysis |
| `marketing_campaign.html` | Campaign planning |
| `war.html` | 1.7 MB internal research simulator, not the game |
| `CODE_GUIDE.md`, `PHASES.md` | Internal engineering notes |
| `.agents/` | Internal review personas |

Use the build script. It works from an **allowlist**, so a new internal document
added to the repo can never silently end up in a release.

```bash
./build-itch.sh
# → dist/frontline-commander-itch.zip
```

The script also refuses to build if anything credential-shaped appears in the
output, and warns if the legal `[INSERT …]` placeholders are still unfilled.

## What ships

```
index.html     ← wargame.html, renamed (itch.io boots index.html and nothing else)
privacy.html
terms.html
```

That's it. The game is a single self-contained file — no assets, no CDN, no build step.

## Upload settings on itch.io

1. Upload the zip, then tick **"This file will be played in the browser"**.
2. **Viewport:** 1280 × 720.
3. Tick **"Mobile friendly"** — the game has full responsive/touch support.
4. Tick **"Automatically start on page load"** *(optional)* and
   **"Fullscreen button"** — see the storage note below for why fullscreen matters.
5. Classification: **Game**. Kind of project: **HTML**.

## The storage problem (read this)

itch.io runs HTML5 games inside a **cross-origin iframe** on `html-classic.itch.zone`.
In that context:

- Safari partitions or blocks third-party storage by default,
- Firefox in strict mode does the same,
- Chrome does it when third-party cookies are disabled,
- and private browsing gives a quota of 0.

When that happens `localStorage.setItem()` **throws**, and the player's rank,
unlocks and campaign progress cannot be saved.

The game handles this properly as of v1.14.3: it probes storage with a real
write/read/delete round-trip at boot, and if storage is unusable it shows a
one-time, dismissible banner telling the player their progress will not be kept
and to open the game in its own tab or fullscreen. The game stays fully playable
either way. This is covered by regression tests (`[storage blocked]` / `[storage ok]`).

**Practical consequence:** enable the fullscreen button, and consider mentioning
"open in fullscreen to save your progress" in the itch.io page description.

## Analytics

`ANALYTICS_SITE` in the game points at GoatCounter. The beacon is an image pixel,
so it works from inside the itch.io iframe without any CSP change. Page views will
be attributed to the itch.zone URL — that's expected and still gives usable
play-count numbers.

## Before charging money

- Fill in the `[INSERT CONTACT EMAIL]` and `[INSERT JURISDICTION]` placeholders in
  `privacy.html` and `terms.html`. The build script warns while they remain.
- Have both documents reviewed by a lawyer (see the warning box at the bottom of each).
- itch.io has its own terms and privacy policy that apply to their side of the
  transaction; they are not a substitute for yours.

## Sitemap / robots

An itch.io release needs neither — itch.io provides the game's public page and
does not read a `sitemap.xml` out of the game zip. If you later self-host on a
real domain, pass `SITE_URL` and the script emits a correct pair:

```bash
SITE_URL=https://your-real-domain.example ./build-itch.sh
```
