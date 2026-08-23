# Backend — deploying the global leaderboard

Everything here is written and tested. What remains is **five commands and pasting two
values into `wargame.html`**. Until you paste them the game ships exactly as before:
the constants are empty, `LEADERBOARD_BACKEND` is `null`, there is no Global tab, and not
one byte leaves a player's device. That is verified by a regression check.

---

## What is in this folder

| File | What it is |
|---|---|
| `migrations/0001_leaderboard.sql` | The `runs` table, its CHECK constraints, and the RLS policies |
| `functions/submit-run/index.ts` | The only thing allowed to write to `runs` |
| `functions/submit-run/_shared/validate.js` | The rules that decide what a false claim is worth |
| `config.toml` | Project config. Contains no keys and never should |

`validate.js` is deliberately plain `.js` rather than `.ts`: Deno runs it as-is inside the
function, and Node imports it directly from `tests/backend.test.js`. The anti-cheat rules
that decide whether the board is worth reading are therefore the *same code* that is
tested, not a re-implementation of it. Run them with:

```bash
node tests/backend.test.js
```

---

## Deploy

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) and your project ref
(the subdomain of your project URL: `https://<ref>.supabase.co`).

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF

# 1. create the table, the constraints and the RLS policies
supabase db push

# 2. deploy the only writer
supabase functions deploy submit-run
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected into
Edge Functions automatically — you do **not** need `supabase secrets set` for those three.

Then turn on anonymous sign-in: **Authentication → Providers → Anonymous → Enable**, and
switch on the built-in rate limiting on the same screen while you are there.

---

## Switch it on in the game

Project Settings → API gives you two keys. Paste the **anon** one:

```js
const LB_URL='https://YOUR_PROJECT_REF.supabase.co';
const LB_ANON_KEY='eyJ...';   // the anon / publishable key
```

Rebuild (`./build-itch.sh`) and the Global tab appears by itself.

### The one mistake that matters

> The **`service_role`** key must never appear in `wargame.html`, in a commit, or in the
> itch zip. It bypasses every security policy. If it ever does get in, **rotate it
> immediately** — deleting the file does not help, because the zip has already been
> downloaded.

The game defends against this specific slip: `lbConfigOk()` decodes the JWT payload and
refuses to enable the board if the key's `role` claim is anything other than `anon`,
logging a rotate-now error. It is a guard, not a substitute for care.

The **anon** key *is* meant to be public — it sits in the HTML of every Supabase app on
the internet. It is safe **only because RLS restricts what it can do**.

---

## Why writes go through a function

`runs` has a public `SELECT` policy and **deliberately no insert, update or delete policy
at all**. Under RLS the absence of a policy is a denial, so the anon key can read the
board and can do nothing else. Every write goes through `submit-run`, which holds the
service role key server-side.

That function re-derives `rated_score` — the number the board sorts by — from the raw
score and difficulty. **It never reads a client-supplied one.** Handing the client that
field would make every other check in the file decorative.

What this buys, stated honestly: a cheater can still submit a *plausible* fake run. They
cannot submit 10¹², cannot submit 400 kills in eight seconds, cannot spam the table, and
cannot choose their own place in the ordering. For a client-side game that is the
realistic ceiling, and it is enough to keep a board worth reading.

---

## Operating it

**Remove an entry.** The privacy policy promises deletion on request. In the SQL editor:

```sql
delete from public.runs where display_name = 'the name they gave you';
```

**Reset the board** (e.g. after a balance change makes old scores incomparable):

```sql
truncate public.runs;
```

**Find suspicious rows** — plausible enough to pass the gate, implausible next to everyone else:

```sql
select display_name, mode, difficulty, score, kills, duration_s,
       round(score::numeric / duration_s, 1) as score_per_sec
from public.runs
order by score_per_sec desc
limit 25;
```

If a cluster of rows sits far above everyone else on `score_per_sec`, tighten
`MAX_SCORE_PER_SEC` in `_shared/validate.js`, add a test for the new bound, and redeploy.
Tune it from real data rather than from imagination — set too tight, it rejects a
genuinely excellent run and the player never learns why.

---

## Costs

Supabase's free tier covers a board of this size comfortably: the table holds one row per
player per mode, the read is a single indexed query capped at 200 rows by `config.toml`,
and writes are rate-limited to one per player per 30 seconds. The realistic first cost is
not the database — it is the free tier pausing an inactive project, which the dashboard
warns about and which a single query resumes.

## Applying the hardening migration (0003)

`0003_hardening.sql` closes audit findings HIGH-2/3/4 and LOW-1 (docs/SUPABASE_AUDIT.md).
Apply it **before** redeploying the function — the new `submit-run` calls `public.submit_run()`
and will fail without it.

```bash
supabase db push                      # applies 0003, 0004 and 0005
supabase functions deploy submit-run  # uses the atomic, idempotent path
node tests/verify-live.js             # confirms the board still works end to end
./tests/db.test.sh                    # 28 checks against a throwaway local PostgreSQL
```

**0005 is required.** It fixes a cooldown that compared against `now()` — transaction START
time — which could rate-limit a submission that had merely queued on the advisory lock, and
in doing so refuse the BETTER of two concurrent runs. See docs/SUPABASE_AUDIT.md.

It is idempotent — re-running it is safe, and that is asserted by the test suite.
