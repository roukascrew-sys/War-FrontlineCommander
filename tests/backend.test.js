#!/usr/bin/env node
/*
 * FRONTLINE COMMANDER — backend validation tests.
 *
 * Exercises the SAME module the Edge Function imports, so these are tests of the
 * deployed rules rather than of a re-implementation of them.
 *
 * The thing under test is the answer to one question: how much does a lie buy?
 * The game is a downloadable HTML file, so a player can send whatever they like.
 * These rules cannot make a claim true — they decide what a false claim is worth.
 *
 *   node tests/backend.test.js
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DIFF_WEIGHT, LIMITS, int, cleanName, validateRun } from
  '../supabase/functions/_shared/validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let PASS = 0, FAIL = 0;
const out = [];
function ok(cond, msg) {
  if (cond) { PASS++; out.push(' PASS  ' + msg); }
  else { FAIL++; out.push(' FAIL  ' + msg); }
}

const UID = '11111111-2222-3333-4444-555555555555';
const good = (over = {}) => ({
  display_name: 'Rook', score: 9000, kills: 40, duration_s: 180, won: true,
  difficulty: 'legendary', mode: 'skirmish', doctrine: 'blitzkrieg',
  game_version: '1.24.0', ...over,
});

/* ── 1. THE RULE THE WHOLE BACKEND EXISTS FOR ───────────────────────────── */
{
  const r = validateRun(good({ rated_score: 999999999, rated: 999999999 }), UID);
  ok(r.ok && r.row.rated_score === Math.round(9000 * 1.8),
    `[sort key] rated_score is DERIVED server-side (${r.row && r.row.rated_score}), and a client-supplied one is ignored entirely`);
  ok(r.ok && !('rated' in r.row),
    '[sort key] no client-supplied field survives into the row');
}

/* ── 2. TYPE COERCION — the path from a hostile body to a SQL column ────── */
{
  ok(int('9000', 0, 100000) === null, '[types] a numeric STRING is refused — "1e99" must never become a column value');
  ok(int(NaN, 0, 100) === null, '[types] NaN is refused');
  ok(int(Infinity, 0, 100) === null, '[types] Infinity is refused');
  ok(int({}, 0, 100) === null && int([], 0, 100) === null, '[types] objects and arrays are refused');
  ok(int(null, 0, 100) === null && int(undefined, 0, 100) === null, '[types] null and undefined are refused');
  ok(int(50.6, 0, 100) === 51, '[types] a real number is rounded, not truncated');
  ok(int(-1, 0, 100) === null && int(101, 0, 100) === null, '[types] out-of-range is refused at both ends');

  for (const bad of ['9000', NaN, Infinity, {}, [], null, undefined, -5, 1e12]) {
    const r = validateRun(good({ score: bad }), UID);
    if (r.ok) { ok(false, `[types] score ${String(bad)} was ACCEPTED`); break; }
  }
  ok(validateRun(good({ score: '9000' }), UID).ok === false, '[types] a submission with a string score is rejected outright');
}

/* ── 3. WHITELISTS ─────────────────────────────────────────────────────── */
{
  ok(validateRun(good({ difficulty: 'impossible' }), UID).error === 'unknown difficulty',
    '[whitelist] an unknown difficulty is refused — it would otherwise have no weight');
  ok(validateRun(good({ mode: 'gauntlet' }), UID).error === 'unknown mode',
    '[whitelist] modes outside the board are refused server-side, not just filtered client-side');
  ok(validateRun(good({ doctrine: '<script>' }), UID).error === 'bad doctrine',
    '[whitelist] doctrine is [a-z] only, so nothing renderable can reach the board through it');
  ok(validateRun(good({ game_version: 'v1; DROP TABLE runs' }), UID).error === 'bad version',
    '[whitelist] game_version must look like a version');
  ok(validateRun(good({ difficulty: 'legendaryplus' }), UID).ok,
    '[whitelist] legendaryplus IS accepted — the hardest tier must be postable');
}

/* ── 4. PLAUSIBILITY — "is this possible", not "is this true" ───────────── */
{
  ok(validateRun(good({ score: 5000000, duration_s: 20 }), UID).error === 'implausible score rate',
    '[plausibility] 5,000,000 points in 20 seconds is refused');
  ok(validateRun(good({ kills: 5000, duration_s: 30 }), UID).error === 'implausible kill rate',
    '[plausibility] 5,000 kills in 30 seconds is refused');
  ok(validateRun(good({ duration_s: 3 }), UID).error === 'bad numbers',
    '[plausibility] a 3-second run is refused');
  ok(validateRun(good({ duration_s: 99999 }), UID).error === 'bad numbers',
    '[plausibility] a 27-hour run is refused');

  /* The gate must not punish real excellence. A very good measured run: high score,
     high kills, in a realistic time. If this ever starts failing, the limits have
     been tuned into refereeing good play rather than rejecting the impossible. */
  const excellent = validateRun(good({ score: 120000, kills: 260, duration_s: 300 }), UID);
  ok(excellent.ok, '[plausibility] a genuinely excellent run still passes — the gate rejects the impossible, it does not referee good play');
}

/* ── 5. DISPLAY NAME — the only free text a player controls ─────────────── */
{
  ok(cleanName('<img src=x onerror=alert(1)>').length <= 20,
    '[name] hostile markup is length-capped (and escaped again at render time)');
  ok(!/‮/.test(cleanName('abc‮dnammoc')),
    '[name] bidi overrides are stripped — they let a name render as something else entirely');
  ok(!/​/.test(cleanName('a​​​b')),
    '[name] zero-width characters are stripped, so two names cannot look identical');
  ok(cleanName('  Iron   Marshal  ') === 'Iron Marshal',
    '[name] whitespace is collapsed and trimmed');
  ok(cleanName('') === 'Commander' && cleanName(null) === 'Commander' && cleanName({}) === 'Commander',
    '[name] an empty or non-string name FALLS BACK rather than rejecting the run — nobody loses a run over their name');
  ok(cleanName('x'.repeat(500)).length === 20, '[name] length is capped at 20');
}

/* ── 6. IDENTITY ───────────────────────────────────────────────────────── */
{
  ok(validateRun(good(), null).status === 401,
    '[identity] no player id means no submission');
  const r = validateRun(good({ player_id: 'someone-else', user_id: 'someone-else' }), UID);
  ok(r.ok && r.row.player_id === UID,
    '[identity] player_id comes from the VERIFIED token, so a body claiming another id cannot spoof it');
}

/* ── 7. THE TWO FILES MUST AGREE ───────────────────────────────────────── */
{
  const html = readFileSync(join(ROOT, 'wargame.html'), 'utf8');
  const m = html.match(/const DIFF_WEIGHT=\{([^}]*)\}/);
  ok(!!m, '[parity] DIFF_WEIGHT is findable in wargame.html');
  if (m) {
    const gameWeights = {};
    for (const part of m[1].split(',')) {
      const [k, v] = part.split(':').map(x => x.trim());
      if (k) gameWeights[k] = parseFloat(v);
    }
    const keys = new Set([...Object.keys(gameWeights), ...Object.keys(DIFF_WEIGHT)]);
    const mismatch = [...keys].filter(k => gameWeights[k] !== DIFF_WEIGHT[k]);
    ok(mismatch.length === 0,
      `[parity] the game and the server agree on every difficulty weight${mismatch.length ? ' :: DISAGREE ON ' + mismatch.join(', ') : ''}`);
    ok(DIFF_WEIGHT.legendaryplus > DIFF_WEIGHT.legendary,
      `[parity] Legendary+ outweighs Legendary (${DIFF_WEIGHT.legendary} → ${DIFF_WEIGHT.legendaryplus}) — it was missing entirely and fell back to 1.0, making the hardest tier score LOWEST`);
  }
}

/* ── 8. THE SHIPPED GAME MUST CARRY NO SECRET ──────────────────────────── */
{
  const html = readFileSync(join(ROOT, 'wargame.html'), 'utf8');
  /* The build now legitimately embeds a JWT — the anon key is DESIGNED to be public and is
     safe only because RLS restricts it. So "is there a JWT?" stopped being the question.
     Decode every one and require role="anon": a service_role key sits in the very same slot,
     is indistinguishable from an anon key by eye or by grep, and hands every player who
     views source full read/write access to the database. */
  const jwts = [...html.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)];
  const roles = jwts.map(m => {
    try { return JSON.parse(Buffer.from(m[1], 'base64').toString()).role; } catch (e) { return '<undecodable>'; }
  });
  const badRoles = roles.filter(r => r !== 'anon');
  ok(badRoles.length === 0,
    `[secrets] every JWT embedded in the game file decodes to an ANON key (found ${roles.length}: ${roles.join(', ') || 'none'})${badRoles.length ? ' :: NON-ANON KEY PRESENT — ROTATE IT NOW, the zip may already be downloaded' : ''}`);

  const lbUrl = (html.match(/const LB_URL='([^']*)'/) || [])[1] || '';
  const lbKey = (html.match(/const LB_ANON_KEY='([^']*)'/) || [])[1] || '';
  /* Set together or not at all. Half-configured is the state that fails only at runtime,
     in a player's browser, rather than here. */
  ok(!!lbUrl === !!lbKey,
    `[secrets] the two backend constants are set together or not at all (url=${lbUrl ? 'set' : 'empty'}, key=${lbKey ? 'set' : 'empty'})`);
  if (lbUrl && lbKey) {
    let ref = null;
    try { ref = JSON.parse(Buffer.from(lbKey.split('.')[1], 'base64').toString()).ref; } catch (e) {}
    ok(/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(lbUrl) && !!ref && lbUrl.includes(ref),
      `[secrets] the project URL is an https Supabase URL whose ref matches the key's (${ref || 'undecodable'}) — a URL and key from two different projects would fail only in a player's browser`);
  } else {
    ok(true, '[secrets] the build ships unconfigured, so the leaderboard makes no network call at all');
  }
  const sqlPath = join(ROOT, 'supabase/migrations/0001_leaderboard.sql');
  const rawSql = readFileSync(sqlPath, 'utf8');
  /* Strip -- comments before asserting. The file DISCUSSES the insert policy it
     deliberately does not have ("if you ever find yourself adding create policy ...
     for insert, stop"), and an earlier version of this check was matching that
     sentence rather than any statement. */
  const sql = rawSql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  ok(/enable row level security/i.test(sql),
    '[rls] RLS is enabled on the runs table');
  const policies = [...sql.matchAll(/create policy[\s\S]*?for\s+(select|insert|update|delete)/gi)]
    .map(m => m[1].toLowerCase());
  ok(policies.includes('select') && !policies.some(p => p !== 'select'),
    `[rls] the ONLY policy is SELECT (found: ${policies.join(', ') || 'none'}) — under RLS the absence of an insert policy is a denial, and that is what stops the anon key writing`);
}

console.log('\n══════════ BACKEND VALIDATION TESTS ══════════');
out.forEach(o => console.log(o));
console.log('══════════════════════════════════════════════');
console.log(FAIL === 0 ? `✅ ALL ${PASS} CHECKS PASSED` : `❌ ${FAIL} of ${PASS + FAIL} CHECKS FAILED`);
process.exit(FAIL === 0 ? 0 : 1);
