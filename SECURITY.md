# Security model — FRONTLINE COMMANDER

Last verified: 2026-07-29, against v1.16.0.

This document exists because most security checklists are written for a very
different kind of application, and applying one indiscriminately produces either
busywork or false confidence. Below is what this project actually is, what that
rules out, and what genuinely remains.

**Every "verified" claim here was checked against the code, not assumed.** Where
something is marked N/A, the reason is stated so the judgement can be re-examined
when the architecture changes.

---

## What this application is

- A **single self-contained HTML file**. No build step, no bundler.
- **No server.** No backend, no API, no database.
- **No dependencies.** No `package.json`, no lockfile, no `node_modules`, and
  **zero external subresources** — verified by stripping HTML comments and
  searching for any `script`/`link`/`iframe` with an `http(s)` source. None exist.
- **No accounts.** No login, no sessions, no tokens, no passwords, no payments.
- All state is `localStorage` on the player's own device.

The only outbound traffic is: a cookieless analytics pixel, an opt-in anonymous
read-only Twitch chat socket, and a user-initiated link to a Google Form.

## Complete endpoint inventory

Every destination this application can contact, all hardcoded constants — there
is no code path that fetches a user-supplied URL (this is what makes SSRF-class
attacks structurally impossible today):

| Endpoint | Direction | Trigger | Guard |
|---|---|---|---|
| `https://zeusrgr.goatcounter.com/count` | image-pixel GET | page view / gameplay events | `gcConfigured()` regex pins the host to `*.goatcounter.com`; token-bucket rate limit (burst 20, 10/min refill, 200/session hard cap) |
| `wss://irc-ws.chat.twitch.tv:443` | WebSocket, anonymous read-only | user clicks Connect | channel name whitelisted to `^[a-zA-Z0-9_]{1,25}$` (blocks IRC CRLF injection); one attempt per 3 s; no auto-reconnect loop |
| Google Form (feedback) | user-initiated navigation | user clicks the link | `noopener,noreferrer`; nothing sent automatically |
| `privacy.html` / `terms.html` | same-origin links | user click | static documents in the same zip |

The CSP (`default-src 'none'`) denies **everything else** — a future edit that
adds a fifth destination without updating both the CSP and this table will fail
loudly in the browser console, not silently ship.

---

## Threat model

The realistic attackers are:

1. **A malicious Twitch chatter.** They control text that the game renders. This
   is the single genuine untrusted input channel and gets the most attention below.
2. **Someone who tampers with their own save.** Not a threat — see "Deliberately
   undefended".
3. **A supply-chain attacker.** No supply chain to attack.
4. **A network attacker.** Nothing sensitive is transmitted; there is nothing to
   intercept.

---

## OWASP / vibe-coding checklist, mapped honestly

| Risk | Status | Evidence |
|---|---|---|
| **Broken access control** | **N/A** | No server, no routes, no API, no roles, no multi-tenancy. There is no privileged operation to fail to check. |
| **IDOR** | **N/A** | No object IDs, no user-scoped resources, no server to ask. |
| **SQL / NoSQL injection** | **N/A** | No database and no query layer of any kind. |
| **Hardcoded secrets** | **Verified clean** | Full-tree and full-git-history sweep for key-shaped literals, auth headers and `.env` files: zero hits. The game holds no credentials by design, and actively scrubs legacy key material left by older builds on load. |
| **XSS** | **Verified defended** | Twitch nick and message text both pass `escapeHTML()`; the IRC parser constrains the nick to `\w+` before it reaches the DOM. The chat colour is whitelist-validated to a hex literal at the sink. Tested with attribute-breakout and tag-injection payloads: escaped, zero nodes created, no script executed. |
| **Code injection** | **Verified clean** | Zero `eval`, zero `new Function`, zero `document.write`, zero `insertAdjacentHTML`, zero `srcdoc`. |
| **Weak hashing** | **N/A** | Nothing is hashed. No passwords exist. |
| **Session management / token expiry** | **N/A** | No sessions and no tokens. The Twitch connection is anonymous with no credential at all. |
| **Tokens in localStorage** | **Verified clean** | `localStorage` holds exactly two keys: the save blob and a transient storage probe that is deleted immediately. No credentials. |
| **Brute force / rate limiting** | **N/A** | No authentication endpoint to brute force. |
| **CORS misconfiguration** | **N/A** | No server, therefore no CORS policy to get wrong. |
| **Supply chain / vulnerable deps** | **N/A by construction** | Zero dependencies. This is the single largest category of AI-generated-code risk and it is structurally absent. |
| **HTTPS enforcement** | **Host responsibility** | itch.io serves over HTTPS and does not offer a plaintext option. Revisit if self-hosting. |
| **CSP** | **In place, default-deny** | `default-src 'none'` with explicit grants back: `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`, `connect-src` limited to the Twitch socket and analytics host, `img-src 'self' data:` + analytics, everything else (`media/worker/frame/form-action/object/base-uri`) explicitly `'none'`. `'unsafe-inline'` is a deliberate, documented trade — all game logic is inline by architecture, and a hash policy would silently break on every edit. It still blocks an injected external script, which is the realistic bar here. |
| **DoS / abusive traffic** | **Split responsibility** | Absorbing a DDoS against a static file is the host CDN's job (itch.io/Cloudflare) — no client can defend the server it is served from. What the client IS responsible for: never *originating* abusive traffic. Verified: the analytics beacon is token-bucket limited, Twitch connects are cooled down, there is no auto-reconnect loop, the crash reporter caps at 5/session, and the narrator speech queue is capped. |
| **SSRF / URL-injection imports** | **N/A by construction** | The game has no feature that fetches, imports, or embeds a user-supplied URL. Every outbound destination is a hardcoded constant (see endpoint inventory), and `connect-src`/`img-src` in the CSP would block a smuggled one. |
| **`frame-ancestors`** | **Intentionally absent** | itch.io *requires* the game to be embeddable, and `frame-ancestors` is spec-ignored in a `<meta>` CSP regardless. |
| **`target="_blank"` reverse tabnabbing** | **Verified clean** | Every `target="_blank"` link carries `rel="noopener"`. |
| **PII handling / GDPR / CCPA** | **Documented** | No personal data is collected. See `privacy.html`. |
| **Audit trails** | **N/A** | No privileged actions to audit. |

---

## Deliberately undefended, and why

**Save editing and console cheating are trivially possible, and that is correct.**
`SAVE` is a plain global and the save file is plain JSON. Anyone can open dev
tools and set their rank to 100.

This is not a vulnerability because there is no leaderboard, no economy, no
multiplayer, and nothing purchasable. It is the player's own device and their own
save, and the only person affected is them. Obfuscating it would add real
complexity to defend nothing.

**This changes the day a leaderboard ships.** At that point scores become a
shared resource and client-reported values stop being trustworthy — that requires
server-side validation, not client-side obfuscation.

---

## Anti-bricking guarantees

More player-sessions are lost to a game that fails to start than to attackers.
These are enforced by regression tests:

- **Boot guard ignores resource errors.** The guard listens for `error` in the
  capture phase, which is the only way to see a failed subresource — but that
  also means it observes every `<img>`/`<link>` error on the page. Since the game
  is one self-contained file with no external scripts, *no* subresource failure
  can prevent it starting, so every resource error there is a false positive.
  This matters concretely: the analytics beacon targets GoatCounter, which ad
  blockers and Pi-hole routinely block. Resource errors are now filtered out, and
  a test asserts that a genuine script failure still surfaces the reload fallback
  (so "ignore resource errors" cannot silently degrade into "ignore everything").
- **Dead timers.** In iOS Quick Look, scripts run but timers never fire, which
  silently defeated every timer-based safety net. A pure-CSS fallback notice
  covers it.
- **Blocked storage.** In a cross-origin iframe (itch.io) or private browsing,
  `localStorage.setItem` throws. Storage is probed with a real round-trip and the
  player is told once, rather than losing a session's progress silently.
- **Corrupt save.** Every field is type-checked against its default on load;
  valid fields are salvaged, invalid ones replaced. A corrupt save can cost
  progress, never a working game.

---

## The development workflow is now part of the attack surface

This project is built largely with AI assistance, which introduces a risk class
that has nothing to do with the shipped code:

- **Prompt injection via pull requests / issues** (CVE-2025-53773 class). Text in
  a PR description, issue body, or CI log can be crafted to manipulate an AI
  coding agent into writing malicious code. **Treat any text originating outside
  this repository as untrusted input to the agent, not as instructions.**
- **Never paste a real credential into a file for an agent to "use".** Any key in
  a browser build is public the moment the page loads. A dead code path that
  *looks* like it wants a key is an invitation to do exactly this — one such path
  (an unauthenticated call to the Anthropic API in `war.html`) was removed for
  precisely this reason, despite carrying no credential and never being called.
- **Review AI-generated diffs for what they *remove*,** not only what they add.

---

## Release pipeline

`build-itch.sh` builds from an **allowlist**, not an exclude-list. This is a
security control, not a convenience: itch.io serves every file in the uploaded
zip at a public URL, and this repository contains pricing strategy, revenue
projections and internal engineering notes. An allowlist means adding a new
internal document to the repo can never publish it by accident.

The script also refuses to build if any credential-shaped string reaches the
output, and CI independently asserts the build contains nothing unexpected.

---

## Day-one backend checklist

Several requested protections have **nothing to attach to today** — there is no
server, no accounts, no tokens, no paid tier. They are recorded here as *binding
requirements for the first backend commit*, so the day one of the re-check
triggers below fires, this section becomes the work order. Each row says what to
build and the failure it prevents.

| # | Protection | Rule when a backend exists |
|---|---|---|
| 1 | **IDOR** | Every object access is authorized server-side against the session's user id — never trust an id that arrived in a URL, body, or header. A player must not be able to reach `/saves/1234` by changing `1233`. Use non-guessable ids (UUIDv4) *and* ownership checks; the ids alone are not the defense. |
| 2 | **Row-level security** | If the database is Postgres (e.g. Supabase), enable RLS on every table from the first migration, policy-scoped to `auth.uid()`. No table ships with RLS off — including "temporary" ones; those are the ones that leak. |
| 3 | **Server-side enforcement** | The client is a *renderer of decisions*, never the decider. Rank, unlocks, purchases, leaderboard scores: computed or validated on the server. Anything enforced only in browser JS is enforced for honest people only (today's save-editing stance, which is fine *until* state is shared). |
| 4 | **API rate limiting & cost caps** | Per-IP and per-account token buckets at the gateway on every endpoint; strict quotas + billing alerts on anything that costs money per call (LLM/TTS APIs especially). A public endpoint that fans out to a paid API without a cap is an open wallet. |
| 5 | **JWT handling** | Asymmetric signing (RS256/EdDSA), short expiry, server-side verification of signature *and* `iss`/`aud`/`exp` on every request; reject `alg:none`. Tokens live in httpOnly SameSite cookies, never `localStorage`. Never put entitlements in the token that the server doesn't re-check. |
| 6 | **Demo/paid separation** | A demo or free build contains **zero** API keys and makes zero calls to paid endpoints — paid capability lives behind a server that requires a verified, entitled session. Any key shipped in a browser build is public the moment the page loads (this is already this repo's standing rule). |
| 7 | **SSRF** | Any server-side "fetch this URL" feature validates against an allowlist, resolves DNS *then* checks the IP is not private/link-local (169.254.0.0/16, 10/8, 172.16/12, 192.168/16, ::1), disables redirects-into-private, and runs from a network segment with no metadata-service access. |

**DDoS at the edge:** keep the static build on a CDN-fronted host (itch.io
today); if self-hosting later, put Cloudflare or equivalent in front before the
first marketing push, not after the first outage.

---

## Re-check this document when any of these become false

- "There is no server."
- "There are no dependencies."
- "There are no accounts."
- "There is no leaderboard."
- "Nothing is purchasable."

Each one invalidates a whole block of N/A rulings above.
