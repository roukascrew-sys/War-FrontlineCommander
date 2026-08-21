# Security audit — keys, API calls and the shipped artefact

**Build:** v1.25.0 · audited by inspection **and by measurement** — every claim below that
could be tested was tested, and the command is given so you can re-run it.

---

## 1. Can a secret reach a player?

**No, and it is enforced three ways.**

| Defence | Where | Verified by |
|---|---|---|
| Both credentials ship empty | `LB_URL=''`, `LB_ANON_KEY=''` | `tests/backend.test.js` §8 |
| A `service_role` key is *refused at runtime* | `lbConfigOk()` decodes the JWT payload and disables the board if `role !== 'anon'`, logging a rotate-now error | `tests/verify-live.js` check 0 |
| The build ships an allowlist, not a directory | `build-itch.sh` copies 3 named files and scans the output for credential-shaped strings | every build |

```bash
grep -cE 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}' dist/index.html   # → 0
```

> **The one rule.** The `anon` key is *designed* to be public — it is in the HTML of every
> Supabase app on the internet, and it is safe **only because RLS restricts it**. The
> `service_role` key must never be in `wargame.html`, a commit, or the zip. If it ever is,
> rotate it: deleting the file does not help, because the zip has already been downloaded.

---

## 2. What can the public key actually do?

Everything rests on this, so it is asserted twice — once against the SQL, once against a
live server.

`public.runs` has **RLS enabled**, a **public SELECT policy**, and **deliberately no
insert, update or delete policy at all**. Under RLS the absence of a policy is a denial.

```
anon key CAN     read the board
anon key CANNOT  insert · update · delete   (no policy exists)
service_role     everything — and lives only in the Edge Function's environment
```

`tests/backend.test.js` parses the migration and fails if any policy other than `SELECT`
ever appears. `tests/verify-live.js` proves it against the real server by *attempting* a
direct insert, update and delete and requiring all three to be refused.

That verifier was itself tested against a deliberately mis-configured mock, so it is known
to **fail** when the deployment is wrong rather than passing regardless:

```
FAIL  a DIRECT insert with the anon key is DENIED (HTTP 201)
      ↳ THE ANON KEY CAN WRITE TO THE BOARD. Anyone who views source can post any score.
```

---

## 3. Every network call the game can make

Measured, not listed from memory — a full session (title, every screen, a complete battle,
results) with a request log attached:

```
localhost:8080            1 request    the page itself
zeusrgr.goatcounter.com   5 requests   analytics beacon
```

**Nothing else.** With no leaderboard configured, the Supabase paths never execute.

| Call | When | Disclosed in privacy.html |
|---|---|---|
| GoatCounter beacon | page load + milestone events | §3 row 1 |
| Twitch IRC (`wss://`) | only if you connect a channel | §3 row 2 |
| Supabase leaderboard | only if configured **and** opted in | §3 row 3 |
| Crash reports | on an internal error, capped at 5/session | §3 row 4 |
| Google Form | only if you click through — a navigation, not a fetch | §3 "The feedback button" |

The disclosure list and the measured list agree. Re-run it with:

```bash
node tests/net-audit.js               # prints every host contacted in a full session
```

---

## 4. Content-Security-Policy

```
default-src 'none';  script-src 'self' 'unsafe-inline';  style-src 'self' 'unsafe-inline';
connect-src 'self' wss://irc-ws.chat.twitch.tv https://*.goatcounter.com https://*.supabase.co;
img-src 'self' data: https://*.goatcounter.com;
media-src 'none'; worker-src 'none'; frame-src 'none';
form-action 'none'; object-src 'none'; base-uri 'none'
```

`default-src 'none'` means every capability is granted explicitly — the strong form.
`'unsafe-inline'` on scripts is unavoidable because all game logic is inline by design (a
hash policy would need recomputing on every edit and would break silently the first time
someone forgot). It still blocks an injected external script, which is the realistic bar
for a page with no server and no injection sink.

**The `*.supabase.co` grant is harmless while the board is off** — a CSP grant permits, it
does not initiate.

---

## 5. Untrusted input

Two sources of text this game does not author:

**Twitch chat.** `chatMsgRaw()` escapes both the username and the message with
`escapeHTML()`, and validates the user colour against `/^#[0-9a-fA-F]{3,8}$/` rather than
interpolating it raw. Correct pattern, correct place.

**Leaderboard display names.** Defended twice, on purpose:
- *Server:* `cleanName()` strips C0/C1 controls, zero-width characters and the bidi
  overrides used to make text render deceptively, collapses whitespace, caps at 20.
- *Client:* escaped again with `escapeHTML()` at render time.

Either alone would be one refactor away from being the only defence. Tested with
`<img src=x onerror=alert(1)>` as a display name: no element is injected.

The client mirrors that rule in `normName()` so a name cannot render one way locally and
another way on the board. The two are held in step by a test that runs nine adversarial names
through **both** implementations and fails on a single character of divergence:

```bash
node tests/regression.js | grep 'normalises a display name'
```

The mirror is not a security control — the server normalises regardless — but the divergence
it removed was real: 5 of those 9 names disagreed under the previous client rule, and writing
the test exposed a genuine ordering bug in `cleanName()` itself (invisible characters were
stripped *before* whitespace was collapsed, so a pasted two-line name became `GeneralDust`).

---

## 6. Things that are *not* secured, and should not be

Stated plainly so nobody mistakes them for oversights:

- **The save file is player-editable.** It is `localStorage` in a game they downloaded.
  This is a sandbox, not a vulnerability — every score is local. The leaderboard is
  precisely where that stops being acceptable, which is why the board's sort key is
  computed server-side and the client cannot write to the table at all.
- **Dev codes are plain text in the file.** Documented as convenience, not security.
  Nothing behind them is worth protecting.
- **`window.G` is exposed.** Deliberate, for testing.
- **A determined cheater can still post a plausible fake run.** The gate rejects the
  *impossible*, not the untrue. That is the honest ceiling for a client-side game.

---

## 7. Residual risks

| Risk | Severity | Note |
|---|---|---|
| Anonymous identities can be farmed by clearing storage | Low | Acceptable for a leaderboard; would not be for anything with stakes |
| A portal ad SDK would require loosening the CSP | **High if pursued** | Do it as a separate build target, never the itch build |
| Free-tier Supabase pauses when idle | Low | Board reads fail with a visible message; the game is unaffected |
| `evil.example` appears in a CSP explanatory comment | Informational | Inert (inside an HTML comment) but may trip a naive automated scanner during store review |

---

## Re-running the whole audit

```bash
node tests/backend.test.js                    # 35 offline checks — rules, secrets, RLS shape
node tests/regression.js                      # full game suite
node tests/verify-live.js                     # the live deployment, once keys are pasted
./build-itch.sh                               # allowlist + credential scan, 3 files
```
