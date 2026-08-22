# Frontline Commander — Supabase security & anti-cheat audit

**Audited build:** v1.26.0 · **Date:** 21 August 2026 · **Batch 1 remediation applied 22 August 2026**
**Scope:** `wargame.html`, `supabase/**`, `tests/**`, `build-itch.sh`, and 123 commits of git history.

> **One limitation stated up front.** This session's egress policy blocks `*.supabase.co`
> (HTTP 403 from the proxy — `goatcounter.com` is blocked identically, so it is the sandbox,
> not the project). Every finding below is derived from **code, SQL and git history**, which
> is where all of them live. Findings marked **[UNVERIFIED-LIVE]** additionally depend on the
> *deployed* state of the hosted project and can only be confirmed by running
> `node tests/verify-live.js` from a machine with network access.


## Remediation status

| Finding | Severity | Status | Proof |
|---|---|---|---|
| HIGH-1 config.toml ≠ deployed state | High | **Detection added** | `verify-live.js` now probes email signup, the row ceiling, and direct RPC access — must be run against the live project |
| HIGH-2 grants never revoked | High | **FIXED** | `db.test.sh`: reproduced on the unhardened schema, then anon cannot insert/update/delete/truncate **with RLS disabled** |
| HIGH-3 rate-limit race | High | **FIXED** | `db.test.sh`: old pattern let **5/5** concurrent writers through; now **5/5** refused |
| HIGH-4 worse run overwrites better | High | **FIXED** | `db.test.sh`: 8 concurrent races, better run survives every time |
| LOW-1 needless SECURITY DEFINER | Low | **FIXED** | `db.test.sh`: `prosecdef = false`, no EXECUTE for anon |
| MEDIUM-1..4, LOW-2 | Med/Low | **Deferred to Batch 2/3** | see §6 |

All fixes are in `supabase/migrations/0003_hardening.sql` and the rewritten
`submit-run`. They are verified by **executing the real migrations against a real
PostgreSQL 16** (`tests/db.test.sh`, 19 checks) — not by reading the SQL.

---

## 0. What is actually here

The brief anticipates a much larger system than exists. Recording what is **absent** matters
as much as what is present, because absent subsystems cannot be vulnerable:

| Subsystem | Status |
|---|---|
| Database tables | **One** — `public.runs` |
| Migrations | Three — `0001_leaderboard.sql`, `0002_aar.sql`, `0003_hardening.sql` |
| Views | **None** |
| Database functions | **Two** — `public.touch_updated_at()` (trigger), `public.submit_run()` (service_role only, added by 0003) |
| Edge Functions | **One** — `submit-run` |
| Storage buckets | **None** — no bucket, no client storage call |
| Realtime channels | **None** — no subscription anywhere |
| RLS policies | **One** — `runs are publicly readable` (SELECT) |
| Admin/moderator/premium roles | **None exist**, in code or schema |
| Multiplayer | **None** — no PvP, no shared match state |
| Turn/tick sync | **None** — the simulation is local and real-time |
| Client→Supabase write paths | **One** — `POST /functions/v1/submit-run` |
| Client→Supabase read paths | **Two** — `/auth/v1/*`, `GET /rest/v1/runs` |
| External integrations | GoatCounter beacon, Twitch IRC (read-only), Google Form (navigation) |

Whole categories of the brief — fog of war between players, replay uploads, matchmaking,
diplomacy, privilege escalation to admin, Storage ACLs, Realtime channel authorisation — have
**no attack surface at all** because the features do not exist. They are marked N/A below
rather than padded with invented findings.

`war.html` (1.7 MB, "THEATRE COMMAND") is a **separate game in the same repo with zero network
calls of any kind** — `grep -c "fetch(\|XMLHttpRequest\|new WebSocket\|sendBeacon" war.html` →
**0**. It has no backend and is out of scope.

---

## 1. Security map

```
PLAYER (untrusted)
  │
  ├─ localStorage  ── freely editable, NEVER transmitted, NEVER proof of anything
  │
BROWSER (wargame.html — untrusted, fully readable)
  │
  ├─→ POST /auth/v1/signup ............... anonymous identity, no signup data
  ├─→ POST /auth/v1/token?grant_type=... . refresh
  │
  ├─→ POST /functions/v1/submit-run ...... THE ONLY WRITE PATH
  │      │  verify_jwt (platform)          [UNVERIFIED-LIVE]
  │      │  auth.getUser() → player_id from the VERIFIED token, never the body
  │      │  validateRun() → whitelist, coerce, plausibility, DERIVE rated_score
  │      │  30 s cooldown (read-then-write, NOT atomic)     ← FINDING H-3
  │      │  service_role client → bypasses RLS
  │      ↓
  └─→ GET  /rest/v1/runs?select=… ........ public read, RLS policy `using (true)`
         ↓
       public.runs
         ├─ RLS: SELECT only. No insert/update/delete policy → all writes denied.
         ├─ GRANTS: NOT revoked → RLS is the SOLE control              ← FINDING H-2
         └─ CHECK constraints: score/kills/duration/rated/difficulty/mode bounds
```

**The trust boundary, stated honestly:** the Edge Function is the only place where a claim
becomes a record. Everything to its left is untrusted and is *supposed* to be.

---

## 2. Findings

### CRITICAL — none

No finding in this audit permits unauthorised database modification, secret exposure,
privilege escalation, or leaderboard takeover. I am not going to manufacture one. The two
structural decisions that earn this — **no write policy on the table** and **`rated_score`
derived server-side and never read from the body** — are both correct and both tested.

---

### HIGH-1 · `supabase/config.toml` describes intent, not the deployed project **[UNVERIFIED-LIVE]**

**Location:** `supabase/config.toml`

**What it claims:**
```toml
[api]     max_rows = 200          # "a scripted client cannot pull the entire table"
[auth]    jwt_expiry = 3600
          enable_refresh_token_rotation = true
[auth.email] enable_signup = false
[functions.submit-run] verify_jwt = true
```

**Why it works.** `config.toml` configures a **local** `supabase start` stack. On a hosted
project these are dashboard settings. **We have direct evidence they are not being applied:**
anonymous sign-in had to be switched on by hand in the dashboard, even though the whole design
depends on it. If that setting did not come from `config.toml`, neither did any of the others.

**Attack scenario.** If hosted `max_rows` is the 1000 default, a scraper pulls five times more
per request than the file claims. If hosted `enable_signup` is on, **email/password signup is
open** on a project whose design has no accounts — free identity minting with less friction
than anonymous auth, and an auth surface (password reset, email enumeration) that nothing in
this repo defends.

**Fix.** Do not let a committed file assert unverified server state. Add live assertions to
`tests/verify-live.js` — probe `enable_signup` and the row ceiling — and annotate the file so
it stops reading as a description of production.

---

### HIGH-2 · Table grants are never revoked; RLS is a single point of failure

**Location:** `supabase/migrations/0001_leaderboard.sql` — the omission

**Why it works.** Supabase's bootstrap runs
`alter default privileges in schema public grant all on tables to anon, authenticated, …`.
A table created in `public` therefore carries `INSERT`, `UPDATE` and `DELETE` grants for both
public roles. Writes are blocked **only** because RLS is enabled and no write policy exists.

**Attack scenario.** Not exploitable today — RLS is on, and `tests/verify-live.js` proves the
anon key cannot insert, update or delete. But the entire board rests on one switch. One
`alter table … disable row level security` during a future debugging session, or one migration
that forgets to re-enable it, and the table is world-writable through the anon key that ships
in every copy of the game. The grants would still be sitting there.

**Fix.** `revoke insert, update, delete on public.runs from anon, authenticated;` — two
independent controls instead of one. Costs nothing: the only writer is `service_role`.

---

### HIGH-3 · The 30-second rate limit is a read-then-write race

**Location:** `supabase/functions/submit-run/index.ts:100-112`

```ts
const { data: recent } = await admin.from('runs').select('updated_at')…limit(1);
if (recent?.length) { const age = Date.now() - new Date(recent[0].updated_at).getTime();
  if (age < SUBMIT_COOLDOWN_MS) return json({ error: 'too fast' }, 429); }
```

**Why it works.** The check and the write are separate round trips with no lock and no
transaction. Fire N requests concurrently and all N read the same `updated_at` before any
write lands, so all N pass the cooldown.

**Attack scenario.** A scripted client bypasses the cooldown entirely and issues unbounded
concurrent writes. The `unique (player_id, mode)` constraint stops table flooding, so the
impact is **write amplification and cost**, not corruption — but the control the code claims
to have does not hold under the exact condition it exists for.

**Fix.** Move the decision into the database so the check and the write are one atomic
statement — a single `insert … on conflict (player_id, mode) do update … where` clause that
encodes both the cooldown and the better-score rule.

---

### HIGH-4 · Best-score update can be overwritten by a *worse* concurrent run

**Location:** `supabase/functions/submit-run/index.ts:118-131`

Read `existing.rated_score`, compare, then `update`. Two concurrent submissions (rated 200 and
150) both read the old best of 100, both pass `existing.rated_score >= rated`, and both write.
Whichever lands second wins — a player can silently **lose their own better score**.

Self-inflicted only, so it is not an integrity threat to other players, but it makes the board
wrong. Fixed by the same atomic upsert as HIGH-3, with `where excluded.rated_score >
runs.rated_score`.

---

### MEDIUM-1 · No idempotency key — a legitimate run is replayable across identities

**Location:** the submission payload (`wargame.html:3867`), `validate.js` — no `run_id`

Nothing distinguishes "the same run submitted twice" from "a new game". Capture one legitimate
request and replay it. Against *your own* identity the damage is nil: the upsert is
best-per-mode, so a replay of the same score changes nothing. The real abuse is **replaying one
good run across many freshly-minted anonymous identities**, filling the top of the board with
the same run under different names.

The rate limit is per player, so fresh identities dodge it entirely. Fix: a client-generated
`run_id` (UUID) with a `unique` constraint, so the same run cannot be banked twice — by anyone.
It does not stop identity farming, but it decouples "one run" from "unlimited rows".

---

### MEDIUM-2 · Unlimited anonymous identities

**Location:** design-level — `wargame.html:3827`, `config.toml [auth]`

Clearing storage mints a new identity with a fresh per-player rate limit and a fresh board slot.
This is **already documented and accepted** in `config.toml` and `docs/SUPABASE_GUIDE.md`, and
it is the correct trade for a no-signup game. It is listed so it is not mistaken for an
oversight. Genuinely mitigating it requires either accounts or per-IP limits at the edge —
both of which cost more than they buy here. **Recommend: accept, keep documented.**

---

### MEDIUM-3 · No request size limit on the Edge Function

**Location:** `submit-run/index.ts:79` — `body = await req.json()`

No `Content-Length` check before parsing. The platform imposes its own ceiling, but nothing in
our code refuses a multi-megabyte body before spending CPU on it. Cheap fix: reject over ~16 KB
up front. (The `aar` field is already independently bounded to 4 KB *in the column*, which is
what stops storage abuse — this is about parse cost.)

---

### MEDIUM-4 · `game_version` is shape-checked but not membership-checked

**Location:** `validate.js:146-149` — `/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/`

Any well-formed version string is accepted, including `9999.0.0`. Today nothing scores by
version, so the impact is cosmetic — a fabricated version on a board row. It becomes a real
problem the moment scoring, filtering or "runs from the current season" depend on it. Flagging
now, while it is cheap.

---

### LOW-1 · `touch_updated_at()` is needlessly `SECURITY DEFINER`

**Location:** `0001_leaderboard.sql:81-91`

A trigger that assigns `new.updated_at = now()` needs no elevated privilege. It correctly sets
`search_path = ''`, and PostgREST does not expose `trigger`-returning functions, so it is not
callable — but PostgreSQL grants `EXECUTE` on new functions to `PUBLIC` by default, so the
combination is unnecessary standing privilege. Make it `SECURITY INVOKER` and revoke `EXECUTE`.

---

### LOW-2 · Prototype-chain keys in chat vote maps

**Location:** `wargame.html` — `onChatMsg()` and `chatPower()`

Vote dedupe uses viewer names as object keys on `{}` literals: `G.bossVoters[user]`,
`p.voters[user]`. Twitch usernames match `\w+`, so `__proto__` is impossible — but
`constructor`, `toString` and `valueOf` are all valid usernames and all resolve truthy through
the prototype chain. A viewer named `constructor` **can never vote** for boss/drop/chaos or any
chat power, and in the lane-vote path drives `G.cvVotes[old]` to `NaN`.

Not a security hole — nothing escalates, nothing crosses a trust boundary. It is exactly the
same class as the `__proto__` bug fixed in the AAR renderer this week, and worth fixing for
consistency: `Object.create(null)` for the maps.

---

### LOW-3 · Error messages are already safe — confirmed, not assumed

`submit-run` returns fixed strings (`'bad numbers'`, `'unknown mode'`, `'write failed'`) and
logs detail server-side via `console.error`. No SQL text, stack trace, or internal identifier
reaches the client. **No change needed.**

---

## 3. What the brief asked about that is genuinely fine

Verified, not assumed — each has a test named:

| Claim | Evidence |
|---|---|
| `rated_score` never accepted from the client | `body.rated_score` appears nowhere in `validate.js`; `backend.test.js` submits `rated_score: 999999999` and asserts the stored value is `9000 × 1.8` |
| **No mass assignment** | `validateRun` returns a **literal object**; unknown keys cannot survive. `{admin:true, verified:true}` is structurally impossible to persist |
| `player_id` cannot be spoofed | Taken from `auth.getUser()`, never the body; test submits `player_id: 'someone-else'` and asserts the token's id wins |
| Difficulty weights agree client↔server | Parity test parses **both files**; `legendaryplus` 2.1 > `legendary` 1.8 |
| Numeric coercion is strict | `int()` refuses strings, NaN, Infinity, objects, out-of-range. `'9000'` is refused, not coerced — `|0` is **not** the security control |
| Display names are safe | Server strips C0/C1, zero-width and bidi overrides, caps at 20; client escapes again at render. Nine adversarial names parity-tested |
| No XSS sink | `eval`, `new Function`, `document.write`, `insertAdjacentHTML`, `outerHTML`, string-`setTimeout`: **zero occurrences**. Twitch names/messages escaped, colour regex-validated |
| No secret ever committed | 123 commits scanned: only the **anon** key (`role:"anon"`, decoded) appears. No `service_role`, no `sb_secret_`, no password |
| Build cannot ship a bad key | `build-itch.sh` decodes every JWT and aborts on non-anon — proven by pasting a forged `service_role` key: exit 1 |
| Opt-out is real | Measured on the wire: a full battle with opt-in off contacts Supabase **zero** times |

**Fog of war (Phase 15):** the simulation is local, so the browser necessarily holds all state.
`computeSpotting()` is a **gameplay** system, not a security one. There is no second player to
hide it from, and no server that could withhold it. Making it genuinely secret would require
moving the simulation server-side — explicitly out of scope per Phase 23. **Documented boundary,
not a defect.**

**Twitch (Phase 16):** read-only anonymous IRC (`justinfan` nick, no token sent). Viewers can
only trigger *gameplay* effects, all threshold-gated by unique voter count. **No developer or
admin functionality is reachable from chat.** Connection attempts are throttled to one per 3 s.

**Local saves / dev codes (Phase 14, 21):** `localStorage` is freely editable and never
transmitted — `debugUnlockAll` and `DEV_CODES` unlock *local* content only and confer nothing
on the board. Correct model: local cheating does not become global cheating, which is the whole
point.

---

## 4. What a determined cheater can STILL do

Stated plainly, because Phase 25 asks and because pretending otherwise would be dishonest:

1. **Submit a plausible fake run.** Play nothing, POST `score: 40000, kills: 180,
   duration_s: 400, won: true, difficulty: legendaryplus`. Every field is inside the limits.
   The gate rejects the *impossible*, never the *untrue*.
2. **Fabricate `won`.** It is a boolean the client asserts. Nothing corroborates it.
3. **Farm identities** for fresh rate limits and board slots.
4. **Fabricate an after-action report** using real ids — a strategy they never played.

None of this is fixable without moving the simulation server-side. **The achievable goal is
that local cheating does not become global cheating**, and that holds: editing your save,
using a dev code, or hacking `G` in devtools changes nothing on the board, because the board
only accepts a bounded, server-scored claim.

---

## 5. Scores

Scored on **this implementation**, not on the fact that Supabase is used.

| Area | Before | After Batch 1 | Reasoning |
|---|---|---|---|
| Supabase configuration | 5 | **6** | Still not verifiable from the repo, but `verify-live.js` now *detects* the drift instead of assuming it away |
| RLS | 8 | **9** | Unchanged and still correct — no longer the only control, so a single mistake no longer opens the table |
| Edge Functions | 7 | **9** | Both races gone; the function no longer writes to the table at all, it calls one atomic operation |
| Leaderboard integrity | 8 | **9** | The best run now survives concurrency; the writer is unreachable from a browser |
| Anonymous auth security | 6 | **6** | Unchanged — unlimited identities is accepted-by-design (MEDIUM-2) |
| Anti-cheat architecture | 6 | **6** | Unchanged. The ceiling is the client-side simulation, and Batch 1 does not move it |
| Input validation | 9 | **9** | Already strong. `game_version` membership (MEDIUM-4) is Batch 2 |
| Replay resistance | 4 | **4** | Unchanged — idempotency is MEDIUM-1, Batch 2 |
| Rate limiting | 4 | **8** | Now holds under concurrency, measured 5/5 refused, and enforced by the database clock |
| XSS / DOM security | 9 | **9** | No dangerous sinks; double-escaped untrusted text |
| External integration security | 8 | **8** | LOW-2 (prototype-chain vote keys) is Batch 3 |
| Secret management | 10 | **10** | No secret in 123 commits; the build decodes JWTs and aborts on non-anon |
| Local-save security model | 10 | **10** | Explicitly not a boundary |
| **Overall** | **7** | **8** | The three concurrency/permission findings are closed and proven against a real database. What remains is replay/idempotency and the inherent client-side ceiling |

Scores are for **this implementation**, not for the fact that Supabase is used. Nothing here
scores 10 for anti-cheat and nothing should: the simulation runs in a browser.

---

## 6. Proposed remediation batches

**Batch 1 — HIGH**
1. `0003_hardening.sql`: revoke write grants; `touch_updated_at` → `SECURITY INVOKER` + revoke EXECUTE.
2. `submit_run_atomic()` — one atomic statement carrying the cooldown *and* the better-score
   rule, replacing the two races.
3. Live assertions for the deployment settings `config.toml` cannot guarantee.

**Batch 2 — MEDIUM**
4. `run_id` + `unique` constraint for idempotency.
5. Request size cap in the Edge Function.
6. `game_version` membership check.

**Batch 3 — LOW**
7. `Object.create(null)` for chat vote maps.
8. Documentation corrections.

Batches 1 and 2 are additive: no existing mechanic changes, no gameplay changes, and the game
continues to work with the board unreachable.
