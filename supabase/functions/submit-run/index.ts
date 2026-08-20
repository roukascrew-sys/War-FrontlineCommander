/* ═══════════════════════════════════════════════════════════════════════════
   FRONTLINE COMMANDER — submit-run
   The only thing on earth allowed to write to public.runs.

   It holds the service role key, so it bypasses RLS. That is exactly why every
   value below is re-derived or re-checked rather than trusted:

     · rated_score is COMPUTED HERE. It is the number the board sorts by, and it
       is never read from the request. Accepting it from the client would make
       every other check in this file decorative.
     · Every field is coerced to a real integer/string before it touches SQL.
       `body.score` arriving as "1e99", null, or {} must not become NaN in a
       column, and must not reach the database at all.
     · Free-text fields are whitelisted, not sanitised. display_name is the one
       genuine exception — it is a person's chosen name — so it is length-capped
       and control-stripped here, and escaped again when the game renders it.

   What this buys: a cheater can still submit a PLAUSIBLE fake run. They cannot
   submit 10^12, cannot submit 400 kills in eight seconds, cannot spam the table,
   and cannot choose their own sort key. For a client-side game that is the
   realistic ceiling, and it is enough to keep a board worth reading.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createClient } from 'jsr:@supabase/supabase-js@2';

/* The validation rules live in _shared/validate.js and are imported, not restated.
   Deno runs that file as-is and Node imports it from tests/backend.test.js, so the
   rules that decide whether the board is worth reading are the SAME code in both
   places — anti-cheat logic that can only be exercised by deploying it is how these
   rules quietly rot. */
import { validateRun } from '../_shared/validate.js';

const SUBMIT_COOLDOWN_MS = 30_000;

/* The game is served from itch.io, from the raw file, and from mirrors. An allowlist
   of origins would break the mirrors — a deliberate part of distribution — and would
   buy nothing, because the caller sets the Origin header anyway. The real access
   control is the auth token. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'unauthorized' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    console.error('submit-run: missing environment configuration');
    return json({ error: 'server misconfigured' }, 500);
  }

  /* Resolve WHO is calling using their own token. The player never states their
     own id — it comes from the verified JWT, so it cannot be spoofed by editing
     a request body. */
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  /* One call does every whitelist, every coercion, every plausibility check, and
     derives rated_score. `body.rated_score` is never read — not validated, not
     compared, ignored entirely. Handing the client the number the board sorts by
     would make everything else here decorative. */
  const v = validateRun(body, user.id);
  if (!v.ok || !v.row) return json({ error: v.error || 'invalid' }, v.status || 400);
  const row = v.row;
  const mode = row.mode;
  const rated = row.rated_score;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  /* Rate limit on the player's most recent write in ANY mode. Cheap (one indexed
     lookup) and it bounds how fast a scripted client can hammer the function. */
  const { data: recent } = await admin
    .from('runs')
    .select('updated_at')
    .eq('player_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (recent?.length) {
    const age = Date.now() - new Date(recent[0].updated_at).getTime();
    if (age < SUBMIT_COOLDOWN_MS) {
      return json({ error: 'too fast', retry_in_ms: SUBMIT_COOLDOWN_MS - age }, 429);
    }
  }

  /* Keep the player's BEST run in this mode. Read-then-write is not atomic, but
     the unique constraint makes the failure mode a harmless duplicate-key error
     rather than a corrupted row, and a player racing themselves is not a threat
     worth a transaction for. */
  const { data: existing } = await admin
    .from('runs')
    .select('id, rated_score')
    .eq('player_id', user.id)
    .eq('mode', mode)
    .maybeSingle();

  if (existing && existing.rated_score >= rated) {
    return json({ ok: true, improved: false, rated, best: existing.rated_score });
  }

  const { error } = existing
    ? await admin.from('runs').update(row).eq('id', existing.id)
    : await admin.from('runs').insert(row);

  if (error) {
    console.error('submit-run insert failed', error.message);
    return json({ error: 'write failed' }, 400);
  }

  return json({ ok: true, improved: true, rated });
});
