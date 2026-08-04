# Adding a Backend to Frontline Commander

**Status:** the game is 100% client-side. There is no server, no accounts, and no network calls except analytics and (optionally) Twitch chat. This document explains what a backend would take, in the order you'd actually build it.

Read `SECURITY.md` alongside this — it contains the day-one hardening checklist (IDOR, RLS, JWT, rate limits) that every endpoint below has to satisfy. This document is the *what and how*; that one is the *don't get owned*.

---

## Do you actually need one?

Be honest about this first, because a backend converts a free, zero-maintenance, zero-cost game into a service with a bill, an uptime expectation, and a privacy-policy surface.

| Feature | Needs a backend? | Notes |
|---|---|---|
| Global leaderboard | **Yes** | The one genuinely blocked feature. Currently local-only and labelled as such. |
| Cross-device save | **Yes** | Requires accounts. |
| Real multiplayer | **Yes** | Much bigger than a backend — see the end of this doc. |
| Daily challenge | No | Already globally identical, derived from the date string. |
| Crate / cosmetics | No | Purely local, and should stay that way unless you monetise. |
| Analytics | No | GoatCounter already handles it. |
| Feedback | No | The in-game modal already works. |

**Recommendation:** build it for the global leaderboard, and only that, first. It's the smallest useful backend and it's the one thing players will actually ask for.

---

## Architecture

The cheapest thing that works, and what the code is already shaped for:

```
Browser (wargame.html)
        │  POST /scores      (submit a finished run)
        │  GET  /scores/top  (fetch the board)
        ▼
  Edge function / small API
        │
        ▼
   Postgres (or SQLite)
```

**Suggested stack** — pick on what you already know, not on benchmarks:
- **Supabase** — Postgres + auth + row-level security + edge functions, generous free tier. Best fit: it gives you auth and RLS without writing either.
- **Cloudflare Workers + D1** — cheapest at scale, no cold starts, but you write auth yourself.
- **Fly.io / Railway + Postgres** — a normal server if you'd rather not think in serverless.

Any of these will run this game's load for free or near-free. Do not build on anything that bills per-request without a hard cap.

---

## Step 1 — Identity

A leaderboard needs to know who submitted a score. You have three options, cheapest first:

**a) Anonymous device ID.** Generate a UUID on first run, store it in `localStorage`, send it with each score. No login, no PII, no privacy-policy change of substance.
*Trade-off:* anyone can spoof it, and clearing storage loses the identity. Fine for a friendly board, useless for a competitive one.

**b) Callsign + device ID.** The game already has a callsign screen. Same as (a) but with a display name.
*Trade-off:* name collisions and impersonation; needs profanity filtering on a public board.

**c) Real accounts.** Supabase Auth with email magic-link or OAuth.
*Trade-off:* real PII, so the privacy policy and terms both need updating, and you inherit account-recovery support requests.

**Recommendation:** start with (b). It's honest about what it is, needs no password reset flow, and can be upgraded to (c) later by linking a device ID to an account.

---

## Step 2 — Schema

```sql
create table scores (
  id           bigserial primary key,
  player_id    uuid        not null,           -- device id or auth.uid()
  callsign     text        not null check (length(callsign) between 1 and 24),
  score        integer     not null check (score >= 0 and score <= 1000000),
  rated        integer     not null check (rated >= 0 and rated <= 2000000),
  mode         text        not null check (mode in ('skirmish','blitz','survival','domination','evolution')),
  difficulty   text        not null check (difficulty in ('recruit','veteran','elite','legendary')),
  doctrine     text        not null,
  kills        integer     not null check (kills >= 0),
  duration_s   integer     not null check (duration_s between 5 and 7200),
  won          boolean     not null,
  game_version text        not null,
  created_at   timestamptz not null default now()
);

create index scores_board on scores (mode, rated desc, created_at);
create index scores_player on scores (player_id, created_at desc);
```

The `check` constraints matter more than they look. They are your first and cheapest line of defence against a modified client posting `score: 999999999` — see Step 4.

---

## Step 3 — Endpoints

Only two are needed.

### `POST /scores`
Body is exactly what `boardEntry()` already builds in `wargame.html`, plus identity:

```json
{
  "player_id": "…", "callsign": "…",
  "score": 2180, "rated": 3924,
  "mode": "skirmish", "difficulty": "legendary", "doctrine": "precision",
  "kills": 44, "duration_s": 196, "won": true,
  "game_version": "1.17.1"
}
```

Returns the inserted row's rank, or `429` if rate-limited.

### `GET /scores/top?mode=skirmish&limit=25`
Returns the top N by `rated` for that mode, best-first, plus the caller's own best if outside the top N. Cache it — a 60-second cache on this endpoint removes almost all read load.

---

## Step 4 — Score validation (the part everyone skips)

**Assume the client is hostile.** `wargame.html` ships unminified; anyone can open devtools and call your endpoint with whatever they like. You cannot prevent this from the client. What you can do is make the board boring to cheat and easy to clean.

Layered, cheapest first:

1. **Column constraints** (Step 2). Rejects absurd values for free.
2. **Plausibility rules** server-side. Derived from the real scoring formula:
   - `rated` must equal `round(score × weight[difficulty])` — the client's own arithmetic, re-checked. Any mismatch is a forged payload.
   - Score-per-second ceiling: the fastest legitimate scoring rate is bounded. A 200-point/second run is not real.
   - `kills` vs `duration_s`: there is a maximum sustainable kill rate.
   - Blitz runs cannot exceed 120s. Survival scores scale with time in a known way.
3. **Rate limiting.** One submission per player per 30 seconds, and a daily cap. The game cannot physically produce runs faster than that.
4. **Version gating.** Reject scores from `game_version` values you don't recognise.
5. **Soft moderation.** A `hidden boolean default false` column and an admin query beats trying to make submission unforgeable. You will never win the arms race; you only need the board to look sane.

**What NOT to do:** don't sign scores with a client-side secret. The secret is in the JavaScript, so it isn't a secret. It adds work and buys nothing.

---

## Step 5 — Wire it into the game

The seam already exists. In `wargame.html`:

```js
const LEADERBOARD_BACKEND=null;
```

Replace with an object implementing two methods:

```js
const LEADERBOARD_BACKEND={
  async submit(entry){
    await fetch('https://your-api/scores',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({...entry,player_id:deviceId(),callsign:SAVE.callsign,game_version:GAME_VERSION}),
    });
  },
  async top(mode,limit){
    const r=await fetch(`https://your-api/scores/top?mode=${encodeURIComponent(mode)}&limit=${limit}`);
    return r.ok?await r.json():[];
  },
};
```

Then:

1. **Update the CSP.** `wargame.html` has a `default-src 'none'` meta CSP that grants exactly two connect-src hosts. Add your API origin, or every request is blocked. This *will* be the first thing that catches you out.
2. **Add a GLOBAL tab** to `renderLeaderboard()` alongside Best Runs / Streaks / Beaten Today.
3. **Call `submit()`** from `endGame()`, right after the existing `boardRecord()` call.
4. **Remove the local-only disclaimer** from the runs tab — but only for the global tab. The personal board is still local and should still say so.
5. **Fail silently.** If the network is down, the local board must keep working exactly as it does now. Never block the results screen on a fetch.

---

## Step 6 — Legal and privacy

Submitting anything to a server changes your privacy posture:

- **Update `privacy.html`** — what you collect (callsign, scores, IP via server logs), why, how long you keep it, and how to request deletion.
- **Update `terms.html`** — conduct rules for a public board, and your right to remove scores.
- **Under-13 users.** COPPA is already named in your legal docs. A public board with user-chosen display names raises this meaningfully. Either filter names hard or don't display them.
- **GDPR deletion.** If you keep a `player_id`, you need a way to delete on request. A simple `DELETE /scores?player_id=` behind a confirmation is enough at this scale.

---

## Cost

At realistic beta scale (a few thousand plays, a few hundred submissions a day) every option above is **free**. Supabase's free tier covers this comfortably. Set a spend cap anyway — a runaway loop in a modified client is the realistic way a free tier becomes a bill.

---

## What about multiplayer?

Different, much larger problem. A leaderboard is a database with two endpoints. Real-time PvP means either:

- **Deterministic lockstep** — server relays inputs only, both clients simulate. Cheap to host, but requires the simulation to be bit-for-bit deterministic: every `Math.random()` becomes a seeded RNG, the variable-`dt` loop becomes a fixed tick, and every float-drift-sensitive path needs auditing. That's a core-loop refactor, not a bolt-on.
- **Authoritative server** — server runs the simulation, clients render. Robust against cheating, but means porting a large chunk of the combat engine to Node and paying compute per live match.

For an itch.io-scale free game, lockstep is the right call — but do the leaderboard first. It's a fraction of the work and it's what people are actually asking for.

---

## Order of work

1. Pick the stack (Supabase unless you have a reason not to)
2. Schema + constraints
3. `POST /scores` with server-side validation
4. `GET /scores/top` with caching
5. Wire `LEADERBOARD_BACKEND`, **update the CSP**
6. Add the GLOBAL tab
7. Update privacy + terms
8. Ship, then watch for absurd scores and add validation rules as needed
