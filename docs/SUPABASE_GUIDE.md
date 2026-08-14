# Supabase — how to actually use it for Frontline Commander

You've connected Supabase to your GitHub. Here's what that gives you, what it doesn't, and
the specific path from "connected" to "a global leaderboard that isn't full of cheaters".

This assumes the game stays what it is: a single self-contained HTML file that runs on
itch.io. That constraint shapes every decision below.

---

## What "connected to GitHub" actually did

It set up **deploy integration** — Supabase can watch a repo branch and apply database
migrations from it, and give preview branches their own database. That's about *managing
the database as code*. It did **not**:

- give your game a backend endpoint
- create any tables
- give the browser permission to read or write anything

Those are all still ahead of you. The GitHub link mostly means your schema lives in version
control next to the game, which is the right setup — it just isn't the feature that makes
the leaderboard work.

**What to do with it right now:** nothing urgent. Create the project, then come back to the
GitHub integration when you have migrations worth versioning (step 2 below).

---

## The one thing that decides everything: never trust the client

Your game is a single HTML file the player downloads. They can read every line of it, open
devtools, and call any function you expose. This is not a flaw you can engineer around — it
is what shipping a client-side game means.

So the rule is absolute:

> **Anything the browser sends is a claim, not a fact.**

A score arriving from the client saying "I got 250,000 on Legendary" is a *claim*. The
question is never "how do I stop them lying" (you can't), it's **"how much do I let a lie
buy?"**

That's why you were right to lock the save transfer tool. Everything below follows the same
logic.

---

## Step 1 — Create the project and get the two keys

In Supabase, create a project. Then find **Project Settings → API**. You get two keys:

| Key | Safe in the game file? | What it can do |
|---|---|---|
| `anon` (publishable) | **Yes** | Only what your Row Level Security policies allow |
| `service_role` (secret) | **NEVER** | Bypasses every security policy, full database access |

The `anon` key is *designed* to be public — it's in the HTML of every Supabase app on the
internet. It is safe **only because RLS restricts what it can do**. If you skip RLS, the
anon key is a full read/write handle on your database for anyone who views source.

> ⚠️ If the `service_role` key ever ends up in `wargame.html`, in a commit, or in the itch
> zip, treat it as compromised and rotate it immediately. It is not recoverable by deleting
> the file — the zip has already been downloaded.

Add a CSP note to yourself: the game's Content-Security-Policy will need
`connect-src https://YOUR-PROJECT.supabase.co` before the browser will allow any request.
This bites people who forget it and see only opaque network errors.

---

## Step 2 — The schema (put this in a migration file)

Create `supabase/migrations/0001_leaderboard.sql` in the repo. This is where the GitHub
integration earns its keep — your schema is reviewable in a PR alongside the game code.

```sql
create table public.scores (
  id            bigint generated always as identity primary key,
  player_id     uuid not null,                    -- anonymous, per-device
  display_name  text not null check (char_length(display_name) between 1 and 20),
  score         integer not null check (score >= 0 and score <= 5000000),
  rated_score   integer not null,                 -- score weighted by difficulty
  difficulty    text not null check (difficulty in ('recruit','veteran','elite','legendary')),
  mode          text not null,
  game_version  text not null,
  duration_s    integer not null check (duration_s between 10 and 7200),
  kills         integer not null check (kills >= 0 and kills <= 100000),
  created_at    timestamptz not null default now()
);

create index scores_board_idx on public.scores (rated_score desc, created_at asc);
create index scores_player_idx on public.scores (player_id, created_at desc);

alter table public.scores enable row level security;

-- anyone may READ the board
create policy "public read" on public.scores
  for select using (true);

-- nobody may write directly. Submissions go through the Edge Function in step 4.
-- (deliberately no insert/update/delete policy — absence of a policy denies)
```

Note the CHECK constraints. They're your last line of defence: even if a bug in your
function lets something through, the database itself refuses a score of 10^15.

Apply it locally with the Supabase CLI (`supabase db push`) or let the GitHub integration
apply it on merge.

---

## Step 3 — Identity without accounts

You don't want a login screen in a browser game. Use **anonymous auth**:

```js
const { data, error } = await supabase.auth.signInAnonymously();
```

This gives each browser a persistent `user.id` (a UUID) with no signup friction. It
survives reloads on that device, which is exactly the granularity you want — one board
entry per device-career, matching how the save already works.

Enable it under **Authentication → Providers → Anonymous**. Turn on the built-in rate
limiting while you're there.

Two honest caveats:
- Clearing browser storage = a new identity. Someone can farm fresh identities. That's fine
  for a leaderboard; it would not be fine for anything with real stakes.
- This is also why **your save transfer code and the leaderboard identity should stay
  separate**. Don't let importing a save also import someone's board identity.

---

## Step 4 — Submit through an Edge Function, never directly

This is the part that matters. Do **not** let the browser insert into `scores`. Instead,
write an Edge Function that validates the claim first.

`supabase/functions/submit-score/index.ts`:

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization')
  if (!auth) return new Response('unauthorized', { status: 401 })

  // client-scoped: this resolves WHO is calling, using their own token
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  )
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return new Response('unauthorized', { status: 401 })

  const body = await req.json()

  // ── PLAUSIBILITY GATE ───────────────────────────────────────────────
  // Not "is this true" (unknowable) but "is this physically possible".
  const DIFF_WEIGHT = { recruit: 0.6, veteran: 1.0, elite: 1.35, legendary: 1.9 }
  const w = DIFF_WEIGHT[body.difficulty]
  if (!w) return new Response('bad difficulty', { status: 400 })

  if (body.duration_s < 20 || body.duration_s > 7200)
    return new Response('implausible duration', { status: 400 })

  // a hard ceiling on score-per-second, derived from your own best real runs
  const MAX_RATE = 900
  if (body.score > body.duration_s * MAX_RATE)
    return new Response('implausible score rate', { status: 400 })

  // kills and score have to roughly agree with each other
  if (body.kills > body.duration_s * 12)
    return new Response('implausible kill rate', { status: 400 })

  const rated = Math.round(body.score * w)

  // ── WRITE with the service role (server-side only, never shipped) ───
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // rate limit: one submission per player per 30s
  const { data: recent } = await admin.from('scores')
    .select('created_at').eq('player_id', user.id)
    .order('created_at', { ascending: false }).limit(1)
  if (recent?.length && Date.now() - new Date(recent[0].created_at).getTime() < 30_000)
    return new Response('too fast', { status: 429 })

  const { error } = await admin.from('scores').insert({
    player_id: user.id,
    display_name: String(body.display_name ?? 'Commander').slice(0, 20),
    score: body.score, rated_score: rated,
    difficulty: body.difficulty, mode: body.mode,
    game_version: body.game_version, duration_s: body.duration_s, kills: body.kills,
  })
  if (error) return new Response(error.message, { status: 400 })
  return new Response(JSON.stringify({ ok: true, rated }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

Set the secrets with `supabase secrets set` — they live on the server, never in the game.

**What this buys you:** a cheater can still submit a *plausible* fake score. They cannot
submit 10^12, cannot submit 400 kills in 8 seconds, and cannot spam the table. That's the
realistic ceiling for a client-side game, and it's enough to keep a board meaningful.

**Notice what's missing:** difficulty weighting is computed **server-side**. If you let the
client send `rated_score`, you've handed it the one number the board actually sorts by.

---

## Step 5 — Wire it into the game

The game already has a `LEADERBOARD_BACKEND` seam (see `docs/BACKEND_GUIDE.md`). Keep the
integration behind it so the game still works offline — itch.io players with a blocked
network should get the existing local board, not an error.

Three things to hold to:

1. **Never block the results screen on a network call.** Submit in the background; if it
   fails, keep the local board and say "not submitted" quietly. A failed leaderboard write
   must never cost someone their post-match screen.
2. **Add the Supabase host to your CSP `connect-src`.** Nothing works until you do.
3. **Update `privacy.html` and the Settings privacy section in the same commit.** You'll be
   sending a display name and a device-scoped ID to a third-party server — that's a genuine
   change to your data story, and that file is currently exhaustive and honest. Keep it that
   way.

---

## Step 6 — The board query

Add a view so the client can't ask for the whole table:

```sql
create view public.leaderboard_top as
  select display_name, rated_score, difficulty, mode, game_version, created_at
  from public.scores
  order by rated_score desc
  limit 100;
```

The client reads only this. No `player_id` is exposed — that's an internal identifier and
there's no reason to publish it.

---

## What to do about the save transfer tool

You locked it behind a code for exactly the right reason. When the backend lands, the clean
resolution is:

- **Progress stays local and transferable.** Rank, unlocks, crate collection — none of it
  affects anyone else, so let players move it freely. Re-open the tool then.
- **Leaderboard scores are server-side only** and are never part of a transfer code. A score
  exists because the server accepted a plausible run, not because a save file claims it.

That split means an imported save gives you your career back, and gives you nothing on the
board. Which is the outcome you actually want.

---

## Suggested order of work

1. Create the project, enable anonymous auth, **turn on RLS before anything else**
2. Write the migration, commit it, let the GitHub integration apply it
3. Write and deploy the Edge Function; test it with `curl` before touching the game
4. Add the CSP host and wire `LEADERBOARD_BACKEND`, keeping the local board as fallback
5. Update `privacy.html` and the in-game privacy section
6. Only then re-open save transfer

Steps 1–3 are entirely outside the game file. That's deliberate — you can have a working,
tested backend before `wargame.html` changes at all.
