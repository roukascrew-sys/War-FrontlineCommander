-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER-ACTION REPORTS
--
-- The top three runs in every mode show HOW they were won — force composition,
-- stance, standing orders, commander powers, what was spent. A leaderboard that
-- shows only a number tells you someone is better than you; one that shows the
-- shape of the run tells you what to try next.
--
-- Stored as jsonb, but NOT as "whatever the client sent". The Edge Function
-- rebuilds this object field by field against a whitelist (cleanAar() in
-- _shared/validate.js) before it ever reaches this column: unknown unit or power
-- ids are dropped, counts are clamped, and any key not explicitly copied does not
-- survive. The column constraint below is the second line of the same defence —
-- it bounds what can physically be stored even if the function is ever changed
-- carelessly.
--
-- Nullable on purpose. An older client, or a run with no deployments, simply has
-- no report; that must never cost anyone their score.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.runs
  add column if not exists aar jsonb;

-- A hard ceiling on what one row can carry. The validated object is well under a
-- kilobyte; 4 KB leaves generous room for future fields while making it impossible
-- to use this column as free storage. Nulls pass (there is nothing to bound).
alter table public.runs
  drop constraint if exists runs_aar_small;
alter table public.runs
  add constraint runs_aar_small
  check (aar is null or pg_column_size(aar) <= 4096);

-- It must be an object, never a bare array or scalar. The renderer reads named
-- fields; anything else is malformed by definition.
alter table public.runs
  drop constraint if exists runs_aar_object;
alter table public.runs
  add constraint runs_aar_object
  check (aar is null or jsonb_typeof(aar) = 'object');

-- ── NOTE ON POLICIES ───────────────────────────────────────────────────────
-- Nothing here grants any new access. `runs` keeps exactly one policy — public
-- SELECT — and adding a column does not change that. The anon key still cannot
-- write to this column, or any other, because no insert policy exists.
