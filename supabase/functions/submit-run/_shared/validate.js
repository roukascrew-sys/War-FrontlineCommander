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

/* The oldest build whose scores are comparable with today's. Raise this only when a
   change makes older scores genuinely incomparable — raising it retires everyone still
   on an older build, which is a product decision, not a cleanup. */
const MIN_GAME_VERSION = '1.24.0';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* Compare dotted versions numerically. '1.9.0' vs '1.10.0' is the reason this is not a
   string comparison: lexically '1.9.0' sorts AFTER '1.10.0', which would retire a newer
   build than the floor. */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* MEDIUM-3. A ceiling on the request body, applied before parsing. The AAR column is
   independently bounded at 4 KB in SQL, which is what stops storage abuse; this is about
   not spending CPU parsing a megabyte of JSON that was never going to be accepted. */
const MAX_BODY_BYTES = 16 * 1024;

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

/* ── AFTER-ACTION REPORT WHITELISTS ──────────────────────────────────────────
   The AAR is the first thing one player submits that ANOTHER player's browser renders,
   so it is whitelisted on both sides. The client renders names from its own tables and
   never prints anything from the payload; the server additionally refuses to STORE an id
   it does not recognise, so a junk id cannot sit in the table waiting for a future
   renderer to be less careful than the current one.

   These mirror UNITS / STRIKES / STANCES / GROUP_DOCTRINES in wargame.html.
   tests/regression.js parses both files and fails if they drift apart. */
const AAR_UNITS = ['rifle', 'atgm', 'tank', 'ifv', 'arty', 'aa', 'heli', 'drone', 'sniper',
  'medic', 'engineer', 'mlrs', 'cbat', 'jammer', 'interceptor', 'gunship', 'flame',
  'swarm', 'wraith', 'nullifier', 'effigy', 'voidwarden'];
const AAR_POWERS = ['gunrun', 'barrage', 'precision', 'smoke', 'rods', 'rollback'];
const AAR_STANCES = ['assault', 'defend', 'skirmish'];
const AAR_ARMS = ['arty', 'armor', 'drone'];
const AAR_ORDERS = ['marching', 'battery', 'bombard', 'assault', 'support', 'breaker',
  'straight', 'hvt', 'bomber'];
const AAR_LIMITS = { UNITS: 6, POWERS: 4, MAX_COUNT: 9999, MAX_CP: 9999999, MAX_DMG: 99999999 };

/** Rebuild the AAR from scratch rather than filtering the submitted one. Anything not
 *  explicitly copied does not survive — so an extra key, a nested object or a payload
 *  three megabytes long cannot reach the column. Returns null (a valid, storable value)
 *  rather than failing the submission: a bad AAR should cost the player their report,
 *  never their score. */
function cleanAar(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const pairs = (arr, allow, cap) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set(), out = [];
    for (const p of arr) {
      if (out.length >= cap) break;
      if (!Array.isArray(p) || p.length !== 2) continue;
      const [id, nRaw] = p;
      if (typeof id !== 'string' || !allow.includes(id) || seen.has(id)) continue;
      const n = int(nRaw, 1, AAR_LIMITS.MAX_COUNT);
      if (n === null) continue;
      seen.add(id); out.push([id, n]);
    }
    return out;
  };
  const units = pairs(v.units, AAR_UNITS, AAR_LIMITS.UNITS);
  if (!units.length) return null;              // no verifiable force = nothing worth showing
  const orders = {};
  if (v.orders && typeof v.orders === 'object' && !Array.isArray(v.orders)) {
    for (const arm of AAR_ARMS) {
      const o = v.orders[arm];
      if (typeof o === 'string' && AAR_ORDERS.includes(o)) orders[arm] = o;
    }
  }
  return {
    v: 1,
    units,
    powers: pairs(v.powers, AAR_POWERS, AAR_LIMITS.POWERS),
    stance: (typeof v.stance === 'string' && AAR_STANCES.includes(v.stance)) ? v.stance : null,
    orders: Object.keys(orders).length ? orders : null,
    cp: int(v.cp, 0, AAR_LIMITS.MAX_CP) ?? 0,
    deploys: int(v.deploys, 0, AAR_LIMITS.MAX_COUNT) ?? 0,
    dmg: int(v.dmg, 0, AAR_LIMITS.MAX_DMG) ?? 0,
    hq: int(v.hq, 0, AAR_LIMITS.MAX_COUNT) ?? 0,
  };
}

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
    // Tabs and newlines ARE whitespace, so turn them into a space rather than deleting
    // them — stripping first made a pasted two-line name collapse into "GeneralDust".
    .replace(/[\t\n\v\f\r]/g, ' ')
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
  /* MEDIUM-4. A well-formed version used to be enough, so `0.0.1` or `9999.0.0` were
     both accepted. Nothing scores by version today, which is exactly why this is cheap
     to add now and awkward to add later.

     A FLOOR only, deliberately — no upper bound. Capping at "the current version" would
     mean that shipping a new build without redeploying this function rejects every
     legitimate submission from it. That failure is silent, total, and arrives at the
     worst moment. A floor cannot do that.

     IF VERSION EVER AFFECTS SCORING, a floor stops being sufficient: at that point this
     needs an explicit whitelist of versions whose scores are comparable. */
  if (cmpVersion(gameVersion, MIN_GAME_VERSION) < 0) {
    return { ok: false, status: 400, error: 'unsupported version' };
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

  /* MEDIUM-1. The idempotency key. Optional: a client on an older build sends none and
     must still be able to post. When present it must be a real uuid, because it becomes
     a primary key in public.run_ids and a malformed one would be refused by the database
     with an error the player cannot act on. */
  let runId = null;
  if (body.run_id !== undefined && body.run_id !== null) {
    if (typeof body.run_id !== 'string' || !UUID_RE.test(body.run_id)) {
      return { ok: false, status: 400, error: 'bad run id' };
    }
    runId = body.run_id.toLowerCase();
  }

  return {
    ok: true,
    row: {
      run_id: runId,
      player_id: playerId,
      display_name: cleanName(body.display_name),
      score, kills, duration_s: duration, won: body.won === true,
      rated_score: rated,
      difficulty, mode, doctrine, game_version: gameVersion,
      aar: cleanAar(body.aar),
    },
  };
}

export {
  DIFF_WEIGHT, MODES, LIMITS, MIN_GAME_VERSION, MAX_BODY_BYTES, UUID_RE,
  int, cmpVersion, cleanName, cleanAar, validateRun,
  AAR_UNITS, AAR_POWERS, AAR_STANCES, AAR_ARMS, AAR_ORDERS, AAR_LIMITS,
};
