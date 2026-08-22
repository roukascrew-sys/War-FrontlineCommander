-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING — audit findings HIGH-2, HIGH-3, HIGH-4, LOW-1
-- See docs/SUPABASE_AUDIT.md for the full write-up of each.
--
-- Nothing here changes what the game does. It changes what is possible when
-- something else goes wrong.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── HIGH-2 · RLS must not be the ONLY thing stopping writes ────────────────
--
-- Supabase's bootstrap runs, in effect:
--     alter default privileges in schema public grant all on tables to anon, authenticated;
-- so public.runs carries INSERT/UPDATE/DELETE grants for both public roles. Today
-- those grants are unreachable because RLS is enabled and no write policy exists —
-- and that is the problem: the board rests on a single switch. One
-- `alter table ... disable row level security` in a future debugging session and
-- the table is world-writable through the anon key that ships in every copy of the
-- game.
--
-- After this, blocking a write takes TWO independent failures instead of one.
-- Costs nothing: the only writer is service_role, which is not affected by grants.

revoke insert, update, delete, truncate on public.runs from anon;
revoke insert, update, delete, truncate on public.runs from authenticated;
revoke all on public.runs from public;

-- SELECT stays. The board is public on purpose, and RLS still governs which rows.
grant select on public.runs to anon, authenticated;

-- The identity sequence must not be manipulable either.
revoke all on sequence public.runs_id_seq from public, anon, authenticated;

-- ── LOW-1 · the trigger does not need to be SECURITY DEFINER ───────────────
--
-- It assigns new.updated_at and nothing else. PostgREST does not expose functions
-- returning `trigger`, so it was not callable — but PostgreSQL grants EXECUTE on new
-- functions to PUBLIC by default, and DEFINER + a public EXECUTE grant is standing
-- privilege with no purpose. search_path stays pinned either way.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- ── HIGH-3 + HIGH-4 · make the submission atomic ───────────────────────────
--
-- WHAT IT DOES TODAY (submit-run/index.ts): three separate round trips —
--   1. read the player's most recent updated_at   → enforce a 30s cooldown
--   2. read their existing row for this mode      → keep only their best
--   3. update or insert
--
-- Nothing holds between them, so:
--   HIGH-3  N concurrent requests all read the same updated_at at step 1 and all
--           pass the cooldown. The limit fails in exactly the case it exists for.
--   HIGH-4  Two concurrent runs (rated 200 and 150) both read the old best at
--           step 2, both pass "is this better?", and both write. Whichever lands
--           second wins, so a player can silently lose their own better score.
--
-- Both races are per-player and only per-player, so a transaction-scoped advisory
-- lock keyed on player_id serialises them exactly and nothing else. It is released
-- automatically when the transaction ends, including on error.
--
-- The upsert then carries the better-score rule in its own WHERE clause, so the
-- comparison and the write are one statement that cannot interleave.
--
-- TIME COMES FROM THE DATABASE. now() is the server clock; a client that lies about
-- its own clock changes nothing here.

create or replace function public.submit_run(
  p_player_id    uuid,
  p_display_name text,
  p_score        integer,
  p_kills        integer,
  p_duration_s   integer,
  p_won          boolean,
  p_rated_score  integer,
  p_difficulty   text,
  p_mode         text,
  p_doctrine     text,
  p_game_version text,
  p_aar          jsonb,
  p_cooldown_ms  integer default 30000
)
returns table (outcome text, best integer, retry_in_ms integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_last  timestamptz;
  v_best  integer;
  v_wrote integer;
begin
  -- serialise every concurrent submission by THIS player for the rest of the
  -- transaction. Other players are unaffected.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_player_id::text, 0));

  select pg_catalog.max(r.updated_at) into v_last
    from public.runs r
   where r.player_id = p_player_id;

  if v_last is not null
     and pg_catalog.now() - v_last < pg_catalog.make_interval(secs => (p_cooldown_ms / 1000.0)::double precision)
  then
    return query select
      'rate_limited'::text,
      null::integer,
      greatest(0, p_cooldown_ms - (pg_catalog.date_part(
        'epoch', pg_catalog.now() - v_last) * 1000)::integer);
    return;
  end if;

  insert into public.runs as r (
    player_id, display_name, score, kills, duration_s, won,
    rated_score, difficulty, mode, doctrine, game_version, aar)
  values (
    p_player_id, p_display_name, p_score, p_kills, p_duration_s, p_won,
    p_rated_score, p_difficulty, p_mode, p_doctrine, p_game_version, p_aar)
  on conflict (player_id, mode) do update
    set display_name = excluded.display_name,
        score        = excluded.score,
        kills        = excluded.kills,
        duration_s   = excluded.duration_s,
        won          = excluded.won,
        rated_score  = excluded.rated_score,
        difficulty   = excluded.difficulty,
        doctrine     = excluded.doctrine,
        game_version = excluded.game_version,
        aar          = excluded.aar
    -- the better-score rule, inside the same statement as the write
    where excluded.rated_score > r.rated_score;

  get diagnostics v_wrote = row_count;

  select r.rated_score into v_best
    from public.runs r
   where r.player_id = p_player_id and r.mode = p_mode;

  if v_wrote = 0 then
    -- the conflict target existed and the new run was not better
    return query select 'not_improved'::text, v_best, null::integer;
  else
    return query select 'improved'::text, v_best, null::integer;
  end if;
end;
$$;

-- Only the Edge Function may call this. It is not a privileged function — it runs as
-- its caller — but there is no reason for a browser to reach it, and an ungranted
-- function is one less thing to reason about.
revoke all on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer) from public, anon, authenticated;

grant execute on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer) to service_role;

comment on function public.submit_run is
  'Atomic leaderboard submission: per-player advisory lock + upsert-if-better in one '
  'statement. Replaces a read-then-write sequence that raced under concurrency '
  '(see docs/SUPABASE_AUDIT.md, HIGH-3 and HIGH-4). service_role only.';
