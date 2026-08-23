-- ═══════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY — audit finding MEDIUM-1
--
-- Today nothing distinguishes "the same run submitted twice" from "a new game".
-- Capture one legitimate request and it can be replayed. Against the submitter's
-- own identity the damage is nil (the board keeps best-per-mode, so a replay of
-- the same score changes nothing) — the real abuse is replaying ONE good run from
-- many freshly-minted anonymous identities, filling the top of the board with the
-- same run under different names. The per-player rate limit does not touch that,
-- because each identity is new.
--
-- WHAT THIS DOES AND DOES NOT BUY, stated plainly:
--   IT DOES     stop a captured request from being banked more than once, by
--               anyone, because run_id is unique across the WHOLE table.
--   IT DOES NOT stop a cheater who generates a fresh uuid per submission. A
--               client-chosen id cannot; only a server-issued match token could,
--               and that means server-side simulation, which is out of scope.
-- So this closes REPLAY, not fabrication. Those are different problems.
-- ═══════════════════════════════════════════════════════════════════════════

-- A ledger of every submission that was ACCEPTED, separate from the board itself.
--
-- Why not just `unique (run_id)` on public.runs? Because runs holds only the best
-- run per player per mode: a better run REPLACES the row, and the replaced run's id
-- disappears with it. Replaying that older run would then sail through, because
-- nothing remembers it. A ledger remembers regardless of what the board currently
-- shows.
create table if not exists public.run_ids (
  run_id     uuid        primary key,
  player_id  uuid        not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists run_ids_player_idx on public.run_ids (player_id, created_at desc);

comment on table public.run_ids is
  'Idempotency ledger. One row per ACCEPTED submission. Globally unique run_id, so a '
  'captured request cannot be banked twice — including from a different anonymous '
  'identity. Does not stop a cheater who mints a new uuid: that is fabrication, not replay.';

-- Same posture as public.runs: RLS on, and no policy at all. Nothing about this
-- table is public — it is not a leaderboard, it is bookkeeping — so unlike runs it
-- gets NO select policy either. Under RLS the absence of a policy is a denial, and
-- the grants are revoked underneath that as a second, independent control.
alter table public.run_ids enable row level security;

revoke all on public.run_ids from public;
revoke all on public.run_ids from anon;
revoke all on public.run_ids from authenticated;

-- The board carries its run's id too, so a row can be traced back to its submission.
-- Nullable: rows written before this migration have no id, and an older client that
-- does not send one must still be able to post.
alter table public.runs add column if not exists run_id uuid;

-- ── submit_run, now idempotent ─────────────────────────────────────────────
--
-- Order matters. The ledger insert happens FIRST, inside the same transaction and
-- while the advisory lock from batch 1 is still held:
--   · if the id is already there, this is a replay -> return early, change nothing
--   · if the transaction later fails, the ledger insert rolls back with it, so a
--     failed submission does not permanently burn its own run_id
--
-- A null p_run_id keeps the old behaviour exactly. That is deliberate: a player on
-- an older build must not silently stop being able to post.

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
  p_cooldown_ms  integer default 30000,
  p_run_id       uuid    default null
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
  v_dupe  boolean := false;
begin
  -- serialise every concurrent submission by THIS player for the rest of the
  -- transaction. Other players are unaffected. (batch 1: HIGH-3, HIGH-4)
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_player_id::text, 0));

  -- ── replay check, before anything is spent on this submission ──
  if p_run_id is not null then
    begin
      insert into public.run_ids (run_id, player_id) values (p_run_id, p_player_id);
    exception when unique_violation then
      v_dupe := true;
    end;

    if v_dupe then
      select r.rated_score into v_best
        from public.runs r
       where r.player_id = p_player_id and r.mode = p_mode;
      -- Not an error. The caller asked for this run to be on the board and it is.
      -- A lost response followed by a retry must land here, not on a second row.
      return query select 'duplicate'::text, v_best, null::integer;
      return;
    end if;
  end if;

  select pg_catalog.max(r.updated_at) into v_last
    from public.runs r
   where r.player_id = p_player_id;

  if v_last is not null
     and pg_catalog.now() - v_last < pg_catalog.make_interval(secs => (p_cooldown_ms / 1000.0)::double precision)
  then
    -- Undo the ledger claim: this submission is being refused, so its id must stay
    -- usable. Without this a rate-limited retry could never be accepted.
    if p_run_id is not null then
      delete from public.run_ids where run_id = p_run_id;
    end if;
    return query select
      'rate_limited'::text,
      null::integer,
      greatest(0, p_cooldown_ms - (pg_catalog.date_part(
        'epoch', pg_catalog.now() - v_last) * 1000)::integer);
    return;
  end if;

  insert into public.runs as r (
    player_id, display_name, score, kills, duration_s, won,
    rated_score, difficulty, mode, doctrine, game_version, aar, run_id)
  values (
    p_player_id, p_display_name, p_score, p_kills, p_duration_s, p_won,
    p_rated_score, p_difficulty, p_mode, p_doctrine, p_game_version, p_aar, p_run_id)
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
        aar          = excluded.aar,
        run_id       = excluded.run_id
    -- the better-score rule, inside the same statement as the write (batch 1: HIGH-4)
    where excluded.rated_score > r.rated_score;

  get diagnostics v_wrote = row_count;

  select r.rated_score into v_best
    from public.runs r
   where r.player_id = p_player_id and r.mode = p_mode;

  if v_wrote = 0 then
    -- The run was accepted and judged, just not better than what is already there.
    -- Its id STAYS in the ledger: it was a real submission and must not be replayable.
    return query select 'not_improved'::text, v_best, null::integer;
  else
    return query select 'improved'::text, v_best, null::integer;
  end if;
end;
$$;

-- ── THE 13-ARGUMENT VERSION MUST NOT SURVIVE ───────────────────────────────
-- 0003 created submit_run with 13 arguments; this migration's version has 14, so
-- both would coexist and PostgreSQL would resolve a 13-argument call to the OLD one
-- — the one with NO replay check. That is a silent downgrade of a security control,
-- so the old signature is dropped rather than left lying around.
-- tests/db.test.sh asserts that exactly one submit_run exists afterwards.
drop function if exists public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer);

revoke all on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer, uuid) from public, anon, authenticated;

grant execute on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer, uuid) to service_role;

comment on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer, uuid) is
  'Atomic, idempotent leaderboard submission: per-player advisory lock, replay check '
  'against public.run_ids, then upsert-if-better in one statement. service_role only. '
  'See docs/SUPABASE_AUDIT.md (HIGH-3, HIGH-4, MEDIUM-1).';
