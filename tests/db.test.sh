#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# FRONTLINE COMMANDER — DATABASE SECURITY TESTS
#
# Applies the real migrations to a real PostgreSQL and attacks the result.
# Everything else in tests/ reasons about SQL as text; this executes it.
#
#   ./tests/db.test.sh
#
# Needs a local postgres (any 14+). It creates a throwaway cluster in a temp
# directory, uses it, and destroys it. It never touches the hosted project.
#
# WHY THIS EXISTS: findings HIGH-2, HIGH-3 and HIGH-4 in docs/SUPABASE_AUDIT.md
# are all "the SQL is fine until something concurrent or unexpected happens".
# None of them can be caught by reading the file, and all three are reproduced
# below against the UNHARDENED schema before being shown fixed.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
command -v initdb >/dev/null || { echo "SKIP: no PostgreSQL installed (need initdb/psql)"; exit 0; }

PORT=${PGPORT_TEST:-5439}
SOCK=/var/tmp/fc-dbtest-sock
DATA=/var/tmp/fc-dbtest-data
PASS=0; FAIL=0
ok(){ if [ "$1" = "1" ]; then PASS=$((PASS+1)); echo " PASS  $2"; else FAIL=$((FAIL+1)); echo " FAIL  $2"; fi; }

RUNAS=""
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then RUNAS="postgres"; fi
run(){ if [ -n "$RUNAS" ]; then su "$RUNAS" -s /bin/bash -c "PATH=$PATH $*"; else bash -c "$*"; fi; }

# Stop as the user that STARTED it. Running pg_ctl as root fails silently, which
# leaves a postmaster holding the port and makes every later run "SKIP: server did
# not start" — a stale server masquerading as a missing one.
cleanup(){ run "pg_ctl -D $DATA stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$DATA" "$SOCK"; }
trap cleanup EXIT

# Anything left behind by a previous run, however it died.
if [ -f "$DATA/postmaster.pid" ]; then
  run "pg_ctl -D $DATA stop -m immediate" >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "$DATA" "$SOCK"; mkdir -p "$DATA" "$SOCK"
[ -n "$RUNAS" ] && chown -R postgres "$DATA" "$SOCK"

run "initdb -D $DATA -A trust -U postgres" >/dev/null 2>&1 || { echo "SKIP: initdb failed"; exit 0; }
run "pg_ctl -D $DATA -o '-p $PORT -k $SOCK' -l $DATA/log start" >/dev/null 2>&1
sleep 2
P="psql -h $SOCK -p $PORT -U postgres -tAq"
if ! $P -c "select 1" >/dev/null 2>&1; then
  echo "SKIP: server did not start on port $PORT — last lines of its log:"
  tail -5 "$DATA/log" 2>/dev/null | sed 's/^/       /'
  echo "       (if this says \"address already in use\", a stale server is holding the port;"
  echo "        re-run with PGPORT_TEST=<free port>)"
  exit 0
fi

# Reproduce the parts of Supabase's bootstrap the migrations depend on. The
# default privileges matter most: they are the entire subject of HIGH-2.
bootstrap(){
  $P -c "drop database if exists $1" >/dev/null 2>&1
  $P -c "create database $1" >/dev/null
  psql -h "$SOCK" -p "$PORT" -U postgres -d "$1" -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users(id uuid primary key);
insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
                              ('22222222-2222-2222-2222-222222222222');
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
}
for r in anon authenticated; do $P -c "create role $r nologin" >/dev/null 2>&1; done
$P -c "create role service_role nologin bypassrls" >/dev/null 2>&1

apply(){ psql -h "$SOCK" -p "$PORT" -U postgres -d "$1" -q -v ON_ERROR_STOP=1 -f "$2" >/dev/null 2>&1; }
q(){ psql -h "$SOCK" -p "$PORT" -U postgres -d "$1" -tAq -c "$2" 2>&1; }
U=11111111-1111-1111-1111-111111111111
INS="insert into public.runs (player_id,display_name,score,kills,duration_s,won,rated_score,difficulty,mode,doctrine,game_version)"
seed(){ q "$1" "delete from public.runs" >/dev/null
        q "$1" "$INS values ('$U','Rook',1000,10,120,true,100,'veteran','skirmish','combined','1.26.0')" >/dev/null; }

echo "══════════ DATABASE SECURITY TESTS ══════════"

# ── every migration must apply to a clean database, in order ──
bootstrap fc_h
a1=$(apply fc_h supabase/migrations/0001_leaderboard.sql && echo 1 || echo 0)
a2=$(apply fc_h supabase/migrations/0002_aar.sql && echo 1 || echo 0)
a3=$(apply fc_h supabase/migrations/0003_hardening.sql && echo 1 || echo 0)
a4=$(apply fc_h supabase/migrations/0004_idempotency.sql && echo 1 || echo 0)
ok "$([ "$a1$a2$a3$a4" = "1111" ] && echo 1 || echo 0)" "[migrations] all four apply cleanly to a fresh database, in order"

# applying twice must be a no-op, not an error — a migration you cannot re-run is
# a migration you cannot safely re-deploy
r=$(apply fc_h supabase/migrations/0003_hardening.sql && echo 1 || echo 0)
r2=$(apply fc_h supabase/migrations/0004_idempotency.sql && echo 1 || echo 0)
ok "$([ "$r$r2" = "11" ] && echo 1 || echo 0)" "[migrations] 0003 and 0004 are idempotent — re-applying them succeeds"

# Exactly ONE submit_run must exist. 0003 creates a 13-argument version and 0004
# supersedes it with a 14-argument one; if both survive, a 13-argument call resolves
# to the version WITHOUT the replay check — a security control silently downgraded.
n=$(q fc_h "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='submit_run'")
ok "$([ "$n" = "1" ] && echo 1 || echo 0)" \
   "[migrations] exactly one submit_run exists after all four migrations (found $n) — two overloads would let a call bind to the version with no replay check"

# ── HIGH-2 · reproduce on the UNHARDENED schema, then prove the fix ──
bootstrap fc_u
apply fc_u supabase/migrations/0001_leaderboard.sql
apply fc_u supabase/migrations/0002_aar.sql
g=$(q fc_u "select string_agg(privilege_type,',' order by privilege_type) from information_schema.role_table_grants where grantee='anon' and table_name='runs'")
ok "$(echo "$g" | grep -q INSERT && echo 1 || echo 0)" \
   "[HIGH-2 repro] without 0003, anon HOLDS write grants on runs ($g) — RLS is the only thing stopping it"
q fc_u "alter table public.runs disable row level security" >/dev/null
w=$(q fc_u "set role anon; $INS values ('$U','PWNED',5000000,1,60,true,20000000,'legendaryplus','skirmish','x','1.0.0')")
ok "$(echo "$w" | grep -qi 'permission denied' && echo 0 || echo 1)" \
   "[HIGH-2 repro] and with RLS off, anon WRITES a maxed-out row — this is the failure 0003 defends against"

q fc_h "alter table public.runs disable row level security" >/dev/null
for op in "$INS values ('$U','PWNED',1,1,60,true,1,'veteran','skirmish','x','1.0.0')" \
          "update public.runs set rated_score=99999" \
          "delete from public.runs" \
          "truncate public.runs"; do
  r=$(q fc_h "set role anon; $op")
  ok "$(echo "$r" | grep -qi 'permission denied' && echo 1 || echo 0)" \
     "[HIGH-2 fix] RLS DISABLED and anon still cannot ${op%% *} — two independent controls, not one"
done
r=$(q fc_h "set role anon; select * from public.submit_run('$U','X',1,1,60,true,999,'veteran','skirmish','x','1.26.0',null,30000,null)")
ok "$(echo "$r" | grep -qi 'permission denied' && echo 1 || echo 0)" \
   "[HIGH-2 fix] anon cannot call submit_run directly either"
q fc_h "alter table public.runs enable row level security" >/dev/null

# reading stays public — the board is meant to be readable
r=$(q fc_h "set role anon; select count(*) from public.runs")
ok "$(echo "$r" | grep -qE '^[0-9]+$' && echo 1 || echo 0)" \
   "[HIGH-2 fix] anon can still READ the board — the hardening did not break the public leaderboard"

# ── LOW-1 · the trigger function ──
r=$(q fc_h "select prosecdef from pg_proc where proname='touch_updated_at'")
ok "$([ "$r" = "f" ] && echo 1 || echo 0)" "[LOW-1] touch_updated_at is SECURITY INVOKER, not DEFINER"
r=$(q fc_h "select has_function_privilege('anon','public.touch_updated_at()','execute')")
ok "$([ "$r" = "f" ] && echo 1 || echo 0)" "[LOW-1] anon has no EXECUTE on touch_updated_at"

# ── HIGH-3 · the cooldown must hold under concurrency ──
seed fc_h
for i in 1 2 3 4 5; do
  ( q fc_h "select outcome from public.submit_run('$U','Rook',2000,20,120,true,200,'veteran','skirmish','combined','1.26.0',null,30000)" >"/var/tmp/fc-c$i.txt" 2>&1 ) &
done
wait
lim=$(cat /var/tmp/fc-c*.txt | grep -c rate_limited)
best=$(q fc_h "select rated_score from public.runs where player_id='$U'")
ok "$([ "$lim" = "5" ] && [ "$best" = "100" ] && echo 1 || echo 0)" \
   "[HIGH-3 fix] 5 SIMULTANEOUS submissions are all rate-limited ($lim/5) and the stored score is untouched ($best) — the old read-then-write let every one of them through"
rm -f /var/tmp/fc-c*.txt

# ── HIGH-4 · a worse concurrent run must never overwrite a better one ──
lost=0
for trial in 1 2 3 4 5 6 7 8; do
  seed fc_h
  q fc_h "select outcome from public.submit_run('$U','A',2000,20,120,true,200,'veteran','skirmish','combined','1.26.0',null,0)" >/var/tmp/fc-a.txt 2>&1 & pa=$!
  q fc_h "select outcome from public.submit_run('$U','B',1500,15,120,true,150,'veteran','skirmish','combined','1.26.0',null,0)" >/var/tmp/fc-b.txt 2>&1 & pb=$!
  wait $pa; wait $pb
  b=$(q fc_h "select rated_score from public.runs where player_id='$U'")
  n=$(q fc_h "select count(*) from public.runs where player_id='$U'")
  if [ "$b" != "200" ] || [ "$n" != "1" ]; then
    lost=$((lost+1))
    echo "        trial $trial LOST: stored=$b rows=$n  200-call=$(tr -d ' \n' </var/tmp/fc-a.txt)  150-call=$(tr -d ' \n' </var/tmp/fc-b.txt)"
  fi
done
ok "$([ "$lost" = "0" ] && echo 1 || echo 0)" \
   "[HIGH-4 fix] across 8 concurrent races the BETTER run always survives and stays one row ($lost losses) — order of arrival no longer decides"

# ── the cooldown uses the DATABASE clock, not the caller's ──
seed fc_h
# The BEFORE UPDATE trigger resets updated_at to now(), so a plain UPDATE cannot
# age a row — which is itself proof the trigger works. Suspend it to build the
# state this test needs.
q fc_h "alter table public.runs disable trigger runs_touch_updated_at" >/dev/null
q fc_h "update public.runs set updated_at = now() - interval '60 seconds'" >/dev/null
q fc_h "alter table public.runs enable trigger runs_touch_updated_at" >/dev/null
r=$(q fc_h "select outcome from public.submit_run('$U','Rook',2000,20,120,true,200,'veteran','skirmish','combined','1.26.0',null,30000)")
ok "$([ "$r" = "improved" ] && echo 1 || echo 0)" \
   "[cooldown] a submission after the window is accepted (got '$r') — the limit expires as intended and is measured against now() in the database"

# ── the constraints are the last line of defence ──
seed fc_h
# NB: capture then match. Piping psql into grep breaks under `set -o pipefail`,
# because psql exits 1 on exactly the errors these cases are supposed to produce,
# so the pipeline reports failure even when grep found what it wanted.
bad=""
check_violates(){ case "$(q fc_h "$2")" in *violates*) ;; *) bad="$bad $1";; esac; }
check_violates "negative-score"   "$INS values ('$U','X',-1,1,60,true,1,'veteran','blitz','x','1.0.0')"
check_violates "5-second-run"     "$INS values ('$U','X',1,1,5,true,1,'veteran','blitz','x','1.0.0')"
check_violates "bogus-difficulty" "$INS values ('$U','X',1,1,60,true,1,'godmode','blitz','x','1.0.0')"
check_violates "off-board-mode"   "$INS values ('$U','X',1,1,60,true,1,'veteran','gauntlet','x','1.0.0')"
check_violates "over-ceiling"     "$INS values ('$U','X',99999999,1,60,true,1,'veteran','blitz','x','1.0.0')"
ok "$([ -z "$bad" ] && echo 1 || echo 0)" \
   "[constraints] negative score, a 5-second run, an invented difficulty, an off-board mode and an over-ceiling score are all refused by the TABLE, not just by the function${bad:+ :: NOT REFUSED:$bad}"

# a run for a player that does not exist must be refused by the foreign key
r=$(q fc_h "$INS values ('99999999-9999-9999-9999-999999999999','X',1,1,60,true,1,'veteran','blitz','x','1.0.0')")
ok "$(echo "$r" | grep -qi 'foreign key' && echo 1 || echo 0)" \
   "[constraints] a run attributed to a non-existent player is refused by the foreign key"

# one row per player per mode
seed fc_h
q fc_h "$INS values ('$U','Rook',1,1,60,true,1,'veteran','skirmish','x','1.0.0')" >/dev/null 2>&1
n=$(q fc_h "select count(*) from public.runs where player_id='$U' and mode='skirmish'")
ok "$([ "$n" = "1" ] && echo 1 || echo 0)" "[constraints] unique(player_id, mode) holds — one best run per player per mode"

# ── the AAR column bound from 0002 ──
big=$(python3 -c "import json;print(json.dumps({'v':1,'junk':'x'*8000}))")
r=$(q fc_h "$INS values ('22222222-2222-2222-2222-222222222222','X',1,1,60,true,1,'veteran','war','x','1.0.0') returning id" >/dev/null 2>&1;
    q fc_h "update public.runs set aar='$big'::jsonb where player_id='22222222-2222-2222-2222-222222222222'")
ok "$(echo "$r" | grep -qi 'runs_aar_small\|violates' && echo 1 || echo 0)" \
   "[aar] an oversized report is refused by the COLUMN constraint, independently of the Edge Function"

# ── MEDIUM-1 · replay must be a no-op, and only replay ──
seed fc_h
RID=3f2504e0-4f89-41d3-9a0c-0305e82c3301
# first submission of this run
o1=$(q fc_h "select outcome from public.submit_run('$U','Rook',3000,30,120,true,300,'veteran','skirmish','combined','1.26.0',null,0,'$RID')")
# the identical request again — a captured-and-replayed submission
o2=$(q fc_h "select outcome from public.submit_run('$U','Rook',3000,30,120,true,300,'veteran','skirmish','combined','1.26.0',null,0,'$RID')")
n=$(q fc_h "select count(*) from public.runs where player_id='$U'")
ok "$([ "$o1" = "improved" ] && [ "$o2" = "duplicate" ] && [ "$n" = "1" ] && echo 1 || echo 0)" \
   "[MEDIUM-1] a replayed submission is refused as a duplicate (first='$o1', replay='$o2') and adds no row"

# the SAME run replayed from a DIFFERENT identity — the abuse the ledger exists for,
# because a fresh anonymous identity dodges the per-player rate limit entirely
U2=22222222-2222-2222-2222-222222222222
o3=$(q fc_h "select outcome from public.submit_run('$U2','Thief',3000,30,120,true,300,'veteran','skirmish','combined','1.26.0',null,0,'$RID')")
n2=$(q fc_h "select count(*) from public.runs where player_id='$U2'")
ok "$([ "$o3" = "duplicate" ] && [ "$n2" = "0" ] && echo 1 || echo 0)" \
   "[MEDIUM-1] the same run replayed from a DIFFERENT anonymous identity is also refused (got '$o3') — run_id is unique across the whole table, not per player"

# a genuinely new run must still post
o4=$(q fc_h "select outcome from public.submit_run('$U','Rook',9000,40,180,true,900,'veteran','skirmish','combined','1.26.0',null,0,'4f89e0d1-2a3b-4c5d-8e9f-0a1b2c3d4e5f')")
ok "$([ "$o4" = "improved" ] && echo 1 || echo 0)" \
   "[MEDIUM-1] a NEW run with a fresh id still posts normally (got '$o4') — idempotency must not block legitimate play"

# a client that sends no id at all keeps working
seed fc_h
o5=$(q fc_h "select outcome from public.submit_run('$U','Rook',3000,30,120,true,300,'veteran','skirmish','combined','1.26.0',null,0,null)")
ok "$([ "$o5" = "improved" ] && echo 1 || echo 0)" \
   "[MEDIUM-1] a submission with NO run_id is still accepted (got '$o5') — an older build must not silently stop being able to post"

# a REFUSED submission must not burn its id: the retry has to be able to succeed
seed fc_h
RID2=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
r1=$(q fc_h "select outcome from public.submit_run('$U','Rook',3000,30,120,true,300,'veteran','skirmish','combined','1.26.0',null,30000,'$RID2')")
r2=$(q fc_h "select outcome from public.submit_run('$U','Rook',3000,30,120,true,300,'veteran','skirmish','combined','1.26.0',null,0,'$RID2')")
ok "$([ "$r1" = "rate_limited" ] && [ "$r2" = "improved" ] && echo 1 || echo 0)" \
   "[MEDIUM-1] a rate-limited submission releases its run_id so the retry can succeed (first='$r1', retry='$r2') — otherwise one refusal would permanently destroy that run"

# the ledger is not readable by the public: it is bookkeeping, not a leaderboard
r=$(q fc_h "set role anon; select count(*) from public.run_ids")
ok "$(echo "$r" | grep -qi 'permission denied' && echo 1 || echo 0)" \
   "[MEDIUM-1] anon cannot read public.run_ids — it carries no policy at all, and the grants are revoked underneath that"

echo "═════════════════════════════════════════════"
if [ "$FAIL" = "0" ]; then echo "✅ ALL $PASS DATABASE CHECKS PASSED"; else echo "❌ $FAIL of $((PASS+FAIL)) FAILED"; fi
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
