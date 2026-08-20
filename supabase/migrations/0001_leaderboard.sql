-- ═══════════════════════════════════════════════════════════════════════════
-- FRONTLINE COMMANDER — global leaderboard
--
-- The design rule this whole file exists to enforce:
--
--     Anything the browser sends is a CLAIM, not a fact.
--
-- The game is a single HTML file the player downloads. They can read every line,
-- open devtools and call any function. That is not a flaw to engineer around —
-- it is what shipping a client-side game means. So the question is never "how do
-- I stop them lying" but "how much does a lie buy?".
--
-- Two structural answers live here:
--   1. NOBODY can write to this table directly. There is deliberately no insert,
--      update or delete policy — under RLS, the absence of a policy is a denial.
--      Every write goes through the submit-run Edge Function, which holds the
--      service role key server-side and computes the sorting number itself.
--   2. The CHECK constraints are the last line of defence. Even a bug in that
--      function cannot land a score of 10^15 or a negative duration.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.runs (
  id            bigint generated always as identity primary key,
  player_id     uuid        not null references auth.users(id) on delete cascade,
  display_name  text        not null check (char_length(display_name) between 1 and 20),

  -- what the player claimed
  score         integer     not null check (score >= 0   and score <= 5000000),
  kills         integer     not null check (kills >= 0   and kills <= 100000),
  duration_s    integer     not null check (duration_s between 10 and 7200),
  won           boolean     not null,

  -- THE number the board sorts by. Computed server-side in the Edge Function and
  -- never accepted from the client: hand the client this field and you have handed
  -- it the only value that matters.
  rated_score   integer     not null check (rated_score >= 0 and rated_score <= 20000000),

  difficulty    text        not null check (difficulty in
                              ('recruit','veteran','elite','legendary','legendaryplus')),
  mode          text        not null check (mode in
                              ('skirmish','evolution','blitz','survival','domination','war')),
  doctrine      text        not null check (char_length(doctrine) between 1 and 24),
  game_version  text        not null check (char_length(game_version) between 1 and 16),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- ONE ROW PER PLAYER PER MODE — their best, not every run they have ever played.
  -- An append-only log would let a single player occupy the whole first page and
  -- would grow without bound. "Best run per person per mode" is also what a reader
  -- of a leaderboard actually expects to see.
  constraint runs_player_mode_unique unique (player_id, mode)
);

-- the board query: best-first, oldest-first as the tiebreak so an earlier identical
-- score outranks a later one (first to get there keeps the higher place)
create index if not exists runs_board_idx
  on public.runs (mode, rated_score desc, created_at asc);

comment on column public.runs.rated_score is
  'score x difficulty weight. Computed in the submit-run Edge Function. NEVER accepted from a client.';

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.runs enable row level security;

-- Anyone, signed in or not, may READ the board. It is a public leaderboard; there
-- is nothing in a row that is not meant to be seen.
drop policy if exists "runs are publicly readable" on public.runs;
create policy "runs are publicly readable"
  on public.runs for select
  using (true);

-- NO insert / update / delete policy, on purpose. With RLS enabled and no policy,
-- every write from the anon key is denied. The Edge Function bypasses RLS because
-- it uses the service role key, which never leaves the server.
--
-- If you ever find yourself adding "create policy ... for insert" here to make
-- something work, stop: that is the exact change that makes the board worthless.

-- ── keep updated_at honest ─────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists runs_touch_updated_at on public.runs;
create trigger runs_touch_updated_at
  before update on public.runs
  for each row execute function public.touch_updated_at();
