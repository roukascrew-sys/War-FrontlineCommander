-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: the cooldown compared against now(), which is TRANSACTION START TIME
--
-- Introduced by 0003. Found by tests/db.test.sh failing 1-2 times in 8 with:
--
--     trial 5 LOST: stored=150  200-call=rate_limited  150-call=improved
--
-- with the cooldown set to ZERO, which should make rate limiting impossible.
--
-- WHY IT HAPPENED
-- now() returns the timestamp the transaction STARTED, not the current instant, and
-- it does not advance while the transaction runs. The advisory lock added in 0003
-- serialises EXECUTION, but both transactions had already begun — and therefore
-- already fixed their now() — before either acquired the lock.
--
-- So for two concurrent submissions A and B:
--     B starts        (now() = T1)
--     A starts        (now() = T0, EARLIER than T1)
--     B takes the lock, writes its row with updated_at = T1, commits, releases
--     A takes the lock, reads v_last = T1, and evaluates T0 - T1  →  NEGATIVE
--     negative < any positive cooldown  →  A is rate-limited
--
-- A was not too fast. A was too EARLY — its clock reading predated the row it was
-- being compared against. With a real 30s cooldown this silently refuses a
-- legitimate submission, and as the test showed, it can refuse the BETTER run while
-- the worse one lands: exactly the failure HIGH-4 was supposed to have closed.
--
-- THE FIX
-- clock_timestamp() is the actual wall clock, read at the moment of the call, so
-- after acquiring the lock it is always at or after the timestamp of any row that
-- committed before the lock was released. Timestamps become monotonic with respect
-- to the serialisation the lock already provides.
--
-- updated_at must come from the same clock, or the comparison is against a value
-- stamped at transaction start again — which is what the trigger was doing.
-- ═══════════════════════════════════════════════════════════════════════════

-- The trigger stamps every UPDATE. It must use the same wall clock as the check.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;

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
  v_now   timestamptz;
  v_last  timestamptz;
  v_best  integer;
  v_wrote integer;
  v_dupe  boolean := false;
begin
  -- serialise every concurrent submission by THIS player for the rest of the
  -- transaction. Other players are unaffected. (0003: HIGH-3, HIGH-4)
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_player_id::text, 0));

  /* Read the clock AFTER the lock, not before, and not at transaction start. This is
     the whole fix: a transaction that queued on the lock must compare against the time
     it actually got to run, otherwise it is measured against a row that committed while
     it was waiting and appears to have travelled backwards. */
  v_now := pg_catalog.clock_timestamp();

  -- replay check, before anything is spent on this submission (0004: MEDIUM-1)
  if p_run_id is not null then
    begin
      insert into public.run_ids (run_id, player_id, created_at)
      values (p_run_id, p_player_id, v_now);
    exception when unique_violation then
      v_dupe := true;
    end;

    if v_dupe then
      select r.rated_score into v_best
        from public.runs r
       where r.player_id = p_player_id and r.mode = p_mode;
      return query select 'duplicate'::text, v_best, null::integer;
      return;
    end if;
  end if;

  select pg_catalog.max(r.updated_at) into v_last
    from public.runs r
   where r.player_id = p_player_id;

  if v_last is not null
     and v_now - v_last < pg_catalog.make_interval(secs => (p_cooldown_ms / 1000.0)::double precision)
  then
    if p_run_id is not null then
      delete from public.run_ids where run_id = p_run_id;
    end if;
    return query select
      'rate_limited'::text,
      null::integer,
      greatest(0, p_cooldown_ms - (pg_catalog.date_part('epoch', v_now - v_last) * 1000)::integer);
    return;
  end if;

  /* created_at and updated_at are set EXPLICITLY from the same clock reading rather
     than left to the column defaults, which are now() — the value this migration exists
     to stop trusting. */
  insert into public.runs as r (
    player_id, display_name, score, kills, duration_s, won,
    rated_score, difficulty, mode, doctrine, game_version, aar, run_id,
    created_at, updated_at)
  values (
    p_player_id, p_display_name, p_score, p_kills, p_duration_s, p_won,
    p_rated_score, p_difficulty, p_mode, p_doctrine, p_game_version, p_aar, p_run_id,
    v_now, v_now)
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
    where excluded.rated_score > r.rated_score;

  get diagnostics v_wrote = row_count;

  select r.rated_score into v_best
    from public.runs r
   where r.player_id = p_player_id and r.mode = p_mode;

  if v_wrote = 0 then
    return query select 'not_improved'::text, v_best, null::integer;
  else
    return query select 'improved'::text, v_best, null::integer;
  end if;
end;
$$;

revoke all on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer, uuid) from public, anon, authenticated;

grant execute on function public.submit_run(
  uuid, text, integer, integer, integer, boolean, integer,
  text, text, text, text, jsonb, integer, uuid) to service_role;
