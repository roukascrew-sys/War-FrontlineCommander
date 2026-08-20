/* ═══════════════════════════════════════════════════════════════════════════
   Submission validation — the rules that decide whether the leaderboard is worth
   reading.

   This is a plain dependency-free .js module, not .ts, for one reason: Deno runs
   it as-is inside the Edge Function AND Node can require it directly from
   tests/backend.test.js. The alternative was security-critical logic that could
   only be exercised by deploying it, which is how anti-cheat rules quietly rot.

   Nothing here touches the network, the database, or Deno APIs. Given a request
   body it returns either { ok:false, status, error } or { ok:true, row } with
   every field already coerced, whitelisted and re-derived.
   ═══════════════════════════════════════════════════════════════════════════ */

/* MUST match DIFF_WEIGHT in wargame.html. If these disagree the board sorts by one
   rule while the game promises another — tests/regression.js parses both files and
   asserts they are identical. */
const DIFF_WEIGHT = {
  recruit: 0.7, veteran: 1.0, elite: 1.35, legendary: 1.8, legendaryplus: 2.1,
};

const MODES = ['skirmish', 'evolution', 'blitz', 'survival', 'domination', 'war'];

/* Derived from real measured runs, then given generous headroom. The gate rejects
   the physically impossible, it does not referee good play — tuned too tight it
   throws out a genuinely excellent run and the player never learns why. */
const LIMITS = {
  MAX_SCORE: 5000000,
  MAX_KILLS: 100000,
  MIN_DURATION: 10,
  MAX_DURATION: 7200,
  MAX_SCORE_PER_SEC: 900,
  MAX_KILLS_PER_SEC: 12,
};

/** Strict integer coercion. Rejects NaN, Infinity, numeric strings, objects and
 *  out-of-range values alike — anything that is not a plain finite whole number in
 *  bounds returns null, and null refuses the whole submission. Accepting "1e99"
 *  because it looks numeric is exactly how a bad row reaches a column. */
function int(v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < lo || n > hi) return null;
  return n;
}

/** The only free text a player controls. Strip C0/C1 controls, zero-width
 *  characters and the bidi overrides used to make text render deceptively; collapse
 *  whitespace; cap length. Falls back rather than rejecting — nobody should lose a
 *  run because of their name. The game escapes it again at render time. */
function cleanName(v) {
  if (typeof v !== 'string') return 'Commander';
  const s = v
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return s.length ? s : 'Commander';
}

/**
 * Validate a submission and derive the row to write.
 * @param {any} body parsed JSON from the client — assume every field is hostile
 * @param {string} playerId the caller's id, taken from the VERIFIED JWT and never
 *                          from the request body, so it cannot be spoofed
 */
function validateRun(body, playerId) {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'bad body' };
  if (!playerId) return { ok: false, status: 401, error: 'unauthorized' };

  const difficulty = String(body.difficulty ?? '');
  const weight = DIFF_WEIGHT[difficulty];
  if (!weight) return { ok: false, status: 400, error: 'unknown difficulty' };

  const mode = String(body.mode ?? '');
  if (!MODES.includes(mode)) return { ok: false, status: 400, error: 'unknown mode' };

  const doctrine = String(body.doctrine ?? '');
  if (!/^[a-z]{1,24}$/.test(doctrine)) return { ok: false, status: 400, error: 'bad doctrine' };

  const gameVersion = String(body.game_version ?? '');
  if (!/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(gameVersion)) {
    return { ok: false, status: 400, error: 'bad version' };
  }

  const score = int(body.score, 0, LIMITS.MAX_SCORE);
  const kills = int(body.kills, 0, LIMITS.MAX_KILLS);
  const duration = int(body.duration_s, LIMITS.MIN_DURATION, LIMITS.MAX_DURATION);
  if (score === null || kills === null || duration === null) {
    return { ok: false, status: 400, error: 'bad numbers' };
  }

  // plausibility: not "is this true" (unknowable) but "is this possible"
  if (score > duration * LIMITS.MAX_SCORE_PER_SEC) {
    return { ok: false, status: 422, error: 'implausible score rate' };
  }
  if (kills > duration * LIMITS.MAX_KILLS_PER_SEC) {
    return { ok: false, status: 422, error: 'implausible kill rate' };
  }

  /* THE sort key, derived here and only here. `body.rated_score` is not read at
     all — not validated, not compared, ignored entirely. */
  const rated = Math.round(score * weight);

  return {
    ok: true,
    row: {
      player_id: playerId,
      display_name: cleanName(body.display_name),
      score, kills, duration_s: duration, won: body.won === true,
      rated_score: rated,
      difficulty, mode, doctrine, game_version: gameVersion,
    },
  };
}

export { DIFF_WEIGHT, MODES, LIMITS, int, cleanName, validateRun };
