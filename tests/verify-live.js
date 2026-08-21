#!/usr/bin/env node
/*
 * FRONTLINE COMMANDER — LIVE backend verification.
 *
 * Everything else in tests/ runs offline. This one talks to your real Supabase
 * project and proves the deployment actually behaves the way the design claims.
 * It is the check that cannot be faked by reading the source.
 *
 *   SUPABASE_URL=https://YOURREF.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   node tests/verify-live.js
 *
 * Or, if the two constants are already pasted into wargame.html, just:
 *
 *   node tests/verify-live.js
 *
 * It reads them straight out of the game file, which is the more useful test:
 * it verifies the values you are actually SHIPPING, not the ones you meant to.
 *
 * WHAT IT WRITES: one row, in a mode you pick with --mode (default `blitz`), from a
 * throwaway anonymous identity created for this run. It deletes nothing, because the
 * anon key deliberately cannot delete — see the note at the end of the output.
 * Use --mode blitz on a live board so you never displace a real skirmish entry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MODE = argOf('--mode', 'blitz');

/* Prefer the shipped values. A verification run against different credentials than the
   ones in the build is a verification of nothing. */
function fromGameFile() {
  try {
    const html = readFileSync(join(ROOT, 'wargame.html'), 'utf8');
    const u = html.match(/const LB_URL='([^']*)'/);
    const k = html.match(/const LB_ANON_KEY='([^']*)'/);
    return { url: u && u[1], key: k && k[1] };
  } catch { return {}; }
}
const shipped = fromGameFile();
const URL_ = process.env.SUPABASE_URL || shipped.url || '';
const KEY = process.env.SUPABASE_ANON_KEY || shipped.key || '';
const SOURCE = process.env.SUPABASE_URL ? 'environment' : 'wargame.html (the shipped values)';

let PASS = 0, FAIL = 0, WARN = 0;
const line = [];
const ok = (c, m, detail) => { c ? (PASS++, line.push(` PASS  ${m}`)) : (FAIL++, line.push(` FAIL  ${m}${detail ? '\n         ↳ ' + detail : ''}`)); return c; };
const warn = (m) => { WARN++; line.push(` WARN  ${m}`); };

if (!URL_ || !KEY) {
  console.error(`
╔══════════════════════════════════════════════════════════════════════╗
║  NOTHING TO VERIFY YET                                               ║
╚══════════════════════════════════════════════════════════════════════╝

wargame.html still has LB_URL='' and LB_ANON_KEY='', and no SUPABASE_URL /
SUPABASE_ANON_KEY were supplied in the environment. That is the correct SHIPPING
state — the game is inert without them — but there is nothing live to test.

Either paste the two values into wargame.html and re-run, or:

  SUPABASE_URL=https://YOURREF.supabase.co \\
  SUPABASE_ANON_KEY=eyJ... \\
  node tests/verify-live.js
`);
  process.exit(2);
}

const H = { apikey: KEY, 'Content-Type': 'application/json' };
const short = (s, n = 160) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

async function req(path, opts = {}) {
  const r = await fetch(URL_ + path, opts);
  let body = null;
  const text = await r.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

(async () => {
  console.log(`\n🔍 Verifying ${URL_}`);
  console.log(`   credentials from: ${SOURCE}`);
  console.log(`   test writes go to mode: ${MODE}\n`);

  // ── 0. THE KEY ITSELF ───────────────────────────────────────────────────
  let claims = null;
  try { claims = JSON.parse(Buffer.from(KEY.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch {}
  if (claims && claims.role) {
    ok(claims.role === 'anon',
      `the key in use is the ANON key (role="${claims.role}")`,
      claims.role === 'service_role'
        ? 'THIS IS THE SERVICE ROLE KEY. It bypasses every policy. Rotate it NOW — if it is in wargame.html it has already shipped.'
        : 'expected role "anon"');
  } else {
    warn('could not decode the key payload — cannot confirm it is the anon key. Check it by eye.');
  }

  // ── 1. ANONYMOUS AUTH ───────────────────────────────────────────────────
  const signup = await req('/auth/v1/signup', { method: 'POST', headers: H, body: JSON.stringify({ data: {} }) });
  const token = signup.body && signup.body.access_token;
  const uid = signup.body && signup.body.user && signup.body.user.id;
  if (!ok(!!token, 'anonymous sign-in works (no email, no password)',
      `HTTP ${signup.status} — ${short(JSON.stringify(signup.body))}\n           If this says "Signups not allowed", enable Authentication → Providers → Anonymous.`)) {
    return report();
  }
  const AUTH = { ...H, Authorization: 'Bearer ' + token };

  // ── 2. THE BOARD IS READABLE ────────────────────────────────────────────
  const read = await req(`/rest/v1/runs?select=display_name,rated_score,mode&limit=5`, { headers: H });
  ok(read.ok && Array.isArray(read.body),
    `the board is publicly readable (${Array.isArray(read.body) ? read.body.length : '?'} rows returned)`,
    `HTTP ${read.status} — ${short(JSON.stringify(read.body))}\n           If this is 404 the migration has not been applied: run \`supabase db push\`.`);

  // ── 3. THE CHECK THAT MATTERS MOST: DIRECT WRITES MUST BE DENIED ────────
  const forgedRow = {
    player_id: uid, display_name: 'VERIFY-DIRECT-INSERT', score: 1, kills: 1,
    duration_s: 60, won: true, rated_score: 999999, difficulty: 'legendary',
    mode: MODE, doctrine: 'blitzkrieg', game_version: '9.9.9',
  };
  const direct = await req('/rest/v1/runs', { method: 'POST', headers: AUTH, body: JSON.stringify(forgedRow) });
  ok(!direct.ok,
    `a DIRECT insert with the anon key is DENIED (HTTP ${direct.status}) — this is the single most important check in this file`,
    'THE ANON KEY CAN WRITE TO THE BOARD. Anyone who views source can post any score they like. Check that RLS is enabled on public.runs and that no INSERT policy exists.');

  const directUpd = await req(`/rest/v1/runs?mode=eq.${encodeURIComponent(MODE)}`, {
    method: 'PATCH', headers: AUTH, body: JSON.stringify({ rated_score: 999999 }) });
  const updRows = Array.isArray(directUpd.body) ? directUpd.body.length : 0;
  ok(!directUpd.ok || updRows === 0,
    `a direct UPDATE with the anon key changes nothing (HTTP ${directUpd.status})`,
    'The anon key can rewrite existing rows.');

  const directDel = await req(`/rest/v1/runs?mode=eq.${encodeURIComponent(MODE)}`, { method: 'DELETE', headers: AUTH });
  const delRows = Array.isArray(directDel.body) ? directDel.body.length : 0;
  ok(!directDel.ok || delRows === 0,
    `a direct DELETE with the anon key removes nothing (HTTP ${directDel.status})`,
    'The anon key can delete other players. Anyone can wipe your board.');

  // ── 4. THE FUNCTION REFUSES GARBAGE ─────────────────────────────────────
  const post = (b, hdrs = AUTH) => req('/functions/v1/submit-run', { method: 'POST', headers: hdrs, body: JSON.stringify(b) });
  const goodRun = { display_name: 'VERIFY BOT', score: 9000, kills: 40, duration_s: 180,
    won: true, difficulty: 'legendary', mode: MODE, doctrine: 'blitzkrieg', game_version: '1.24.0' };

  const noAuth = await post(goodRun, H);
  ok(noAuth.status === 401 || noAuth.status === 403,
    `the function refuses an unauthenticated call (HTTP ${noAuth.status})`,
    `expected 401/403, got ${noAuth.status} — ${short(JSON.stringify(noAuth.body))}`);

  const impossible = await post({ ...goodRun, score: 5000000, duration_s: 20 });
  ok(!impossible.ok,
    `the plausibility gate refuses 5,000,000 points in 20 seconds (HTTP ${impossible.status})`,
    `it was ACCEPTED — ${short(JSON.stringify(impossible.body))}`);

  const stringScore = await post({ ...goodRun, score: '99999' });
  ok(!stringScore.ok,
    `a string score is refused (HTTP ${stringScore.status})`,
    `it was ACCEPTED — coercion is not running server-side`);

  const badMode = await post({ ...goodRun, mode: 'gauntlet' });
  ok(!badMode.ok, `an off-board mode is refused server-side (HTTP ${badMode.status})`);

  // ── 5. A REAL RUN IS ACCEPTED, AND THE SORT KEY IS THE SERVER'S ─────────
  const forged = await post({ ...goodRun, rated_score: 999999999, rated: 999999999 });
  const acceptedRated = forged.body && forged.body.rated;
  ok(forged.ok, `a legitimate run is accepted (HTTP ${forged.status})`,
    short(JSON.stringify(forged.body)) + '\n           If this is 404 the function is not deployed: `supabase functions deploy submit-run`.');
  ok(acceptedRated === Math.round(9000 * 1.8),
    `rated_score is the SERVER's number (${acceptedRated}), not the 999,999,999 the client claimed`,
    `got ${acceptedRated}, expected ${Math.round(9000 * 1.8)} — a client-supplied sort key is being honoured`);

  // ── 6. RATE LIMIT ───────────────────────────────────────────────────────
  const again = await post({ ...goodRun, score: 9100 });
  ok(again.status === 429,
    `a second submission straight away is rate-limited (HTTP ${again.status})`,
    `expected 429, got ${again.status} — a scripted client can hammer the function`);

  // ── 7. THE ROW LANDED, AND LOOKS RIGHT ─────────────────────────────────
  const back = await req(`/rest/v1/runs?select=display_name,rated_score,score,game_version&player_id=eq.${uid}`, { headers: H });
  const row = Array.isArray(back.body) && back.body[0];
  ok(!!row, 'the run is readable back from the board');
  if (row) {
    ok(row.rated_score === Math.round(9000 * 1.8),
      `the stored rated_score is the server's (${row.rated_score})`,
      'the forged value was persisted');
    ok(row.display_name === 'VERIFY BOT', `the display name round-tripped (${short(row.display_name, 30)})`);
  }

  // ── 8. CORS — the browser has to be able to call this at all ────────────
  const pre = await fetch(URL_ + '/functions/v1/submit-run', {
    method: 'OPTIONS',
    headers: { Origin: 'https://html-classic.itch.zone', 'Access-Control-Request-Method': 'POST',
               'Access-Control-Request-Headers': 'authorization,content-type,apikey' } });
  ok(pre.status < 400 && !!pre.headers.get('access-control-allow-origin'),
    `CORS preflight passes from an itch.io origin (HTTP ${pre.status}, allow-origin: ${pre.headers.get('access-control-allow-origin') || 'none'})`,
    'the browser will block every submission with an opaque network error');

  report(uid);
})().catch(e => {
  console.error('\n💥 verification crashed:', e.message);
  console.error('   Is the project URL right, and is the project awake? A paused free-tier project refuses connections.');
  process.exit(1);
});

function report(uid) {
  console.log('══════════ LIVE BACKEND VERIFICATION ══════════');
  line.forEach(l => console.log(l));
  console.log('═══════════════════════════════════════════════');
  if (uid) {
    console.log(`\nThis run created one anonymous identity and one row in "${MODE}".`);
    console.log('Remove it from the SQL editor when you are done:');
    console.log(`  delete from public.runs where player_id = '${uid}';`);
    console.log("  (The anon key cannot delete it — which is exactly what check 3 proved.)");
  }
  console.log(FAIL === 0
    ? `\n✅ ${PASS} CHECKS PASSED${WARN ? ` · ${WARN} warning(s)` : ''}`
    : `\n❌ ${FAIL} of ${PASS + FAIL} CHECKS FAILED${WARN ? ` · ${WARN} warning(s)` : ''}`);
  process.exit(FAIL === 0 ? 0 : 1);
}
