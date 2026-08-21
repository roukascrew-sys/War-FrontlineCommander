# Security audit — keys, API calls and the shipped artefact

**Build:** v1.26.0 · audited by inspection **and by measurement** — every claim below that
could be tested was tested, and the command is given so you can re-run it.

---

## 1. Can a secret reach a player?

**No, and it is enforced three ways.**

| Defence | Where | Verified by |
|---|---|---|
| Only an **anon** key ever ships | every JWT in the build is decoded and required to be `role:"anon"` | `tests/backend.test.js` §8 |
| The URL and key must be from the SAME project | the key's `ref` claim must appear in `LB_URL` | `tests/backend.test.js` §8 |
| A `service_role` key is *refused at runtime* | `lbConfigOk()` decodes the JWT payload and disables the board if `role !== 'anon'`, logging a rotate-now error | `tests/verify-live.js` check 0 |
| The build ships an allowlist, not a directory | `build-itch.sh` copies 3 named files | every build |
| The build **aborts** on a non-anon key | it decodes every JWT in the output; a `service_role` key exits 1 and names the file | every build |

The build now legitimately carries a JWT, so counting them proves nothing — the role inside
the payload is the whole question, and grep cannot see it. Verified by decoding instead:

```
▸ Checking every JWT in the build is an anon key
  ✓ 1 JWT(s), all role="anon"
```

Proven to bite, by pasting a forged `service_role` key of identical shape into the build:

```
  ✖ index.html: JWT with role="service_role"
  ✖ ABORT: a non-anon key is in the build. ROTATE IT NOW — the zip may already be downloaded.
  exit=1
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
zeusrgr.goatcounter.com   4 requests   analytics beacon
```

**Nothing else.** That session was measured with the board **configured but not opted in**,
which is the shipped default — so this is the shape of a real player's first session, not of
an inert build. Opting in adds `*.supabase.co` and nothing else. A regression check asserts
the zero separately, on the wire:

```
PASS  a full battle finishes with opt-in OFF and contacts Supabase ZERO times (saw 0)
```

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

**After-action reports (v1.26.0).** The first *structured* data one player submits that
another player's browser renders, and handled accordingly:

- *The payload carries ids, never words.* The renderer looks every id up in this build's own
  `UNITS` / `STRIKES` / `STANCES` / `GROUP_DOCTRINES` tables and draws the name from there.
  Nothing from the payload is ever printed. A hand-crafted report therefore cannot put text
  on anyone's screen at all — at worst it names a real unit it did not use.
- *The server rebuilds rather than filters.* `cleanAar()` copies field by field against a
  whitelist, so an unexpected key, a nested object or a 10KB string does not survive to the
  column. A malformed report is dropped and the run is still **accepted** — a bad report must
  cost the player their report, never their score.
- *The column is bounded in SQL.* `pg_column_size(aar) <= 4096` and `jsonb_typeof(aar) =
  'object'`, so the Edge Function is not the only thing between a player and that column.

Two real bugs surfaced while testing this, both worth recording because both would have
shipped:

```
'__proto__' as a power id PASSED the whitelist and rendered "undefined undefined"
   ↳ STRIKES['__proto__'] is Object.prototype — truthy. Every lookup now goes through
     Object.prototype.hasOwnProperty.call(). The server was already safe (it tests array
     membership, not property lookup), so only the client was affected.

a count sent as the STRING "9" was accepted by the client and refused by the server
   ↳ the two disagreed about what a valid report was. Both now refuse it.
```

Both are covered by tests that push a deliberately hostile report through and assert on what
comes out — client-side in `tests/regression.js` §30, server-side in `tests/backend.test.js`
§9, and end-to-end in `tests/verify-live.js`, which submits a hostile AAR to the real
deployment and reads the row back to prove the stored object was rebuilt.

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
node tests/backend.test.js                    # 49 offline checks — rules, secrets, RLS shape, AAR
node tests/regression.js                      # full game suite
node tests/verify-live.js                     # the live deployment, once keys are pasted
./build-itch.sh                               # allowlist + credential scan, 3 files
```
