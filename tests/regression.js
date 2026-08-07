#!/usr/bin/env node
/*
 * FRONTLINE COMMANDER — headless regression suite.
 *
 * Boots wargame.html in a real Chromium instance and checks the things that have
 * actually broken in the past: an iOS-only parse failure that silently killed the
 * loader failsafe, a login screen that never dismissed, a chat panel that drifted
 * on reload, browser-syntax regressions (regex lookbehind / optional chaining are
 * newer than this file's minimum-supported browser), and full-mode gameplay sims
 * with zero console errors.
 *
 * USAGE
 *   1. Serve the repo root:      python3 -m http.server 8080
 *   2. Install Playwright once:  npm i -D playwright   (or: npx playwright install chromium)
 *   3. Run:                      node tests/regression.js
 *      (override the URL with PORT=xxxx or BASE_URL=http://host:port/wargame.html)
 *
 * Exits 0 if every check passes, 1 otherwise — safe to wire into CI.
 */
const path = require('path');

function resolvePlaywright() {
  try { return require('playwright'); } catch (e) {}
  // fall back to a couple of common locations if a local install isn't on the path
  const candidates = [
    '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright'),
  ];
  for (const c of candidates) { try { return require(c); } catch (e) {} }
  console.error('Playwright is not installed. Run: npm i -D playwright  (or npx playwright install chromium)');
  process.exit(1);
}
const { chromium } = resolvePlaywright();

function resolveExecutablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  const fs = require('fs');
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return undefined; // let Playwright use its own managed browser
}

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}/wargame.html`;

(async () => {
  const launchOpts = { args: ['--no-sandbox'] };
  const exe = resolveExecutablePath();
  if (exe) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);

  const out = [];
  let FAIL = 0;
  const ok = (cond, msg) => { out.push((cond ? ' PASS  ' : ' FAIL  ') + msg); if (!cond) FAIL++; };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME|goatcounter/i.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
  const grab = () => { const e = errs.slice(); errs.length = 0; return e.length ? `${e.length} [${e.join(' || ')}]` : '0'; };

  // ══ 1. FRESH BOOT ══
  await page.goto(BASE_URL);
  await page.waitForFunction(() => document.getElementById('loader') && document.getElementById('loader').classList.contains('gone'), { timeout: 15000 });
  await page.waitForTimeout(600);
  const boot = await page.evaluate(() => ({
    titleVisible: !document.getElementById('title').classList.contains('hidden'),
    booted: window.__FC_BOOTED === true,
    ver: typeof GAME_VERSION !== 'undefined' ? GAME_VERSION : null,
  }));
  ok(boot.titleVisible, 'fresh boot lands on the TITLE screen');
  ok(boot.booted, '__FC_BOOTED flag set (main script parsed — catches any new browser-parse failure)');
  ok(grab() === '0', `no console/page errors on boot [v${boot.ver}]`);

  // ══ 2. BROWSER-COMPAT GUARDRAIL — keep the file parseable on older engines ══
  // These features are all newer than this project's minimum-supported browser (iOS Safari's
  // WebKit lagged regex lookbehind until 16.4; a SyntaxError here is a PARSE-time failure that
  // kills the whole <script> block, not a runtime one — see PATCH_NOTES v1.14.0).
  const srcScan = await page.evaluate(async () => {
    const t = await (await fetch(location.href)).text();
    return {
      lookbehind: (t.match(/\(\?<[=!]/g) || []).length,
      optChain: (t.match(/\?\.\w/g) || []).length,
      logicalAssign: (t.match(/(\|\|=|&&=|\?\?=)/g) || []).length,
    };
  });
  ok(srcScan.lookbehind === 0, 'no regex lookbehind in the file (Safari < 16.4 compat)');
  ok(srcScan.optChain === 0, 'no optional chaining in the file');
  ok(srcScan.logicalAssign === 0, 'no logical-assignment operators in the file');

  // ══ 3. FAILSAFE SURVIVES A PARSE ERROR IN THE MAIN SCRIPT ══
  const bad = await browser.newContext();
  const bp = await bad.newPage();
  await bp.route('**/wargame.html', async route => {
    let body = await (await route.fetch()).text();
    body = body.replace('window.__FC_BOOTED = true;', "window.__FC_BOOTED = true; const _bad = {" + "" /* deliberately unterminated */);
    await route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  await bp.goto(BASE_URL);
  await bp.waitForTimeout(11000);
  const failsafe = await bp.evaluate(() => {
    const l = document.getElementById('loader');
    return {
      loaderHidden: !l || l.classList.contains('gone') || getComputedStyle(l).display === 'none' || +getComputedStyle(l).opacity === 0,
      noticeShown: !!document.getElementById('fc-oldbrowser'),
    };
  });
  ok(failsafe.loaderHidden, '[injected parse error] loader still clears, not stuck spinning');
  ok(failsafe.noticeShown, '[injected parse error] honest "browser too old" notice shown');
  await bad.close();

  // ══ 3a. BOOT FAILURE WHERE SCRIPTS RUN BUT TIMERS NEVER FIRE ══
  // This is the iOS email/Files attachment preview case, reported from real video footage:
  // the page draws and CSS animates, but setTimeout/setInterval callbacks never arrive, so
  // every timer-based safety net dies silently and the player gets a black screen. The only
  // thing that can still reach them is the pure-CSS #bootfail notice — verify it appears.
  const frozen = await browser.newContext();
  const fp = await frozen.newPage();
  await fp.addInitScript(() => {
    // neuter timers before any page script runs, exactly like the preview sandbox does
    window.setTimeout = function () { return 0; };
    window.setInterval = function () { return 0; };
    window.requestAnimationFrame = function () { return 0; };
  });
  await fp.goto(BASE_URL);
  await fp.waitForTimeout(15000); // past the 13s CSS reveal
  const dead = await fp.evaluate(() => {
    const el = document.getElementById('bootfail');
    const cs = el && getComputedStyle(el);
    return {
      present: !!el,
      visible: !!(cs && cs.display !== 'none' && +cs.opacity > 0.5),
      mentionsFix: !!(el && /Open in Safari|share icon/i.test(el.textContent)),
      build: (document.getElementById('bootfail-ver') || {}).textContent,
    };
  });
  ok(dead.visible, '[timers dead] pure-CSS boot-failure notice becomes visible');
  ok(dead.mentionsFix, '[timers dead] notice tells the player how to open it in a real browser');
  await frozen.close();

  // the notice's build number is hardcoded in HTML (it must survive a dead script), so it can
  // drift from GAME_VERSION — assert they match rather than trusting anyone to remember
  const verMatch = await page.evaluate(() => {
    const el = document.getElementById('bootfail-ver');
    return { stamped: el && el.textContent.trim(), real: typeof GAME_VERSION !== 'undefined' ? GAME_VERSION : null };
  });
  ok(verMatch.stamped === verMatch.real,
    `boot-failure notice build stamp matches GAME_VERSION (stamped ${verMatch.stamped} / real ${verMatch.real})`);

  // ══ 3b. HEALTHY BOOT MUST NEVER SHOW THE FAILURE NOTICE ══
  const healthy = await page.evaluate(() => {
    const el = document.getElementById('bootfail');
    const cs = el && getComputedStyle(el);
    return { hidden: !!(cs && (cs.display === 'none' || +cs.opacity < 0.01)),
             booted: document.documentElement.className.indexOf('fc-booted') >= 0 };
  });
  ok(healthy.booted, 'healthy boot sets html.fc-booted (timer-liveness probe fired)');
  ok(healthy.hidden, 'healthy boot keeps the boot-failure notice hidden');

  // ══ 3b. CHAT PANEL STAYS ON-SCREEN ACROSS A CROSS-SESSION VIEWPORT SHRINK ══
  // Regression for: chatBoxFrame() used to read box.offsetParent, which is null while #stream
  // is display:none (i.e. at boot, before any battle has started) and silently fell back to raw
  // viewport size instead of #stage's real (topbar-shorter) size — so a position saved on a tall
  // window could render partly off-screen on a shorter one, with no way to drag it back.
  const shrink = await browser.newContext({ viewport: { width: 1000, height: 520 } });
  const sp = await shrink.newPage();
  await sp.addInitScript(() => {
    localStorage.setItem('FRONTLINE_SAVE_v1', JSON.stringify({
      xp: 0, lvl: 5, seenTut: true, streamOn: true,
      chatPos: { x: 20, y: 600 }, // valid on a taller (900px) viewport from a prior session
    }));
  });
  await sp.goto(BASE_URL);
  await sp.waitForFunction(() => document.getElementById('loader') && document.getElementById('loader').classList.contains('gone'), { timeout: 15000 });
  await sp.waitForTimeout(500);
  await sp.evaluate(() => {
    const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show');
    showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start();
    if (G) { G.tutorial = false; G.prep = 0; G.frozen = false; }
    refreshTopbar();
  });
  await sp.waitForTimeout(400);
  const chatFit = await sp.evaluate(() => {
    const box = document.getElementById('chatbox'), stage = document.getElementById('stage');
    const br = box.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    return br.top >= sr.top - 1 && br.bottom <= sr.bottom + 1;
  });
  ok(chatFit, 'chat panel stays inside #stage after a cross-session viewport shrink');
  await shrink.close();

  // ══ 4. FULL GAMEPLAY REGRESSION ACROSS MODES ══
  const modes = ['skirmish', 'blitz', 'survival', 'domination', 'evolution'];
  for (const m of modes) {
    errs.length = 0;
    const res = await page.evaluate((mode) => {
      try { G = null; window.G = null; } catch (e) {}
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = mode; start();
      if (!G) return { err: 'no game' };
      G.tutorial = false; G.prep = 0; G.frozen = false; G.cp = 9999;
      for (const k in UNITS) G.unlocked[k] = true;
      const keys = Object.keys(UNITS).filter(k => k !== 'voidwarden');
      let t = 0; const dt = 1 / 30;
      for (let i = 0; i < 240; i++) {
        if (i % 12 === 0) tryDeploy(keys[((i / 12) | 0) % keys.length], i % 3);
        try { step(dt); } catch (e) { return { err: e.message, t: Math.round(t) }; }
        t += dt; if (G.over) break;
      }
      return { t: Math.round(t), units: G.units.length, cpNaN: isNaN(G.cp), laneY: G.laneY.map(x => +x.toFixed(2)).join(',') };
    }, m);
    ok(!res.err && !res.cpNaN && res.laneY === '0.3,0.5,0.7', `mode ${m.padEnd(11)} ran clean — ${JSON.stringify(res)}`);
    ok(grab() === '0', `mode ${m.padEnd(11)} zero console errors`);
  }

  // ══ 5. DEPLOY SOUNDS ══
  const soundFails = await page.evaluate(() => {
    const bad = [];
    for (const k of Object.keys(UNITS)) { try { SND.deployFor(k); } catch (e) { bad.push(k); } }
    return bad;
  });
  ok(soundFails.length === 0, `all unit deploy sounds fire without throwing (bad: ${JSON.stringify(soundFails)})`);

  // ══ 6. iOS-SHAPED SMOKE TEST ══
  const ios = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  });
  const ip = await ios.newPage();
  const ierrs = []; ip.on('pageerror', e => ierrs.push(e.message));
  await ip.goto(BASE_URL);
  await ip.waitForFunction(() => document.getElementById('loader') && document.getElementById('loader').classList.contains('gone'), { timeout: 15000 });
  await ip.waitForTimeout(700);
  const iosRes = await ip.evaluate(() => ({
    booted: window.__FC_BOOTED === true,
    title: !document.getElementById('title').classList.contains('hidden'),
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  ok(iosRes.booted, '[iPhone viewport] main script parsed and booted');
  ok(iosRes.title, '[iPhone viewport] reaches the title screen');
  ok(!iosRes.hScroll, '[iPhone viewport] no horizontal page scroll');
  ok(ierrs.length === 0, `[iPhone viewport] zero page errors ${ierrs.length ? ':: ' + ierrs.join(' | ') : ''}`);
  await ios.close();

  // ══ 7. STORAGE BLOCKED (itch.io iframe / private browsing / 3rd-party storage off) ══
  // itch.io serves HTML5 games in a cross-origin iframe, where Safari partitions or blocks
  // localStorage outright and private-browsing quota is 0 — setItem() THROWS. The game must
  // stay playable AND tell the player their progress is not being kept, rather than letting
  // them grind a session and lose it silently.
  const nostore = await browser.newContext();
  const np = await nostore.newPage();
  await np.addInitScript(() => {
    const boom = () => { throw new DOMException('QuotaExceededError'); };
    Object.defineProperty(window, 'localStorage', {
      get() { return { getItem: boom, setItem: boom, removeItem: boom }; },
    });
  });
  const nerrs = []; np.on('pageerror', e => nerrs.push(e.message));
  await np.goto(BASE_URL);
  await np.waitForTimeout(9000);
  const nres = await np.evaluate(() => {
    const w = [...document.querySelectorAll('div')].find(
      d => /can.t be saved in this window/i.test(d.textContent || '') && d.style.position === 'fixed');
    return {
      flag: typeof STORAGE_OK !== 'undefined' ? STORAGE_OK : null,
      warned: !!w,
      tellsFix: !!(w && /own tab|fullscreen/i.test(w.textContent)),
      title: !document.getElementById('title').classList.contains('hidden'),
    };
  });
  ok(nres.flag === false, '[storage blocked] STORAGE_OK probe correctly reports unusable storage');
  ok(nres.title, '[storage blocked] game still boots and reaches the title screen');
  ok(nres.warned, '[storage blocked] player is warned that progress will not be kept');
  ok(nres.tellsFix, '[storage blocked] warning says how to fix it (own tab / fullscreen)');
  ok(nerrs.length === 0, `[storage blocked] zero page errors ${nerrs.length ? ':: ' + nerrs.join(' | ') : ''}`);
  await nostore.close();

  // Healthy storage: no false alarm, and the probe must not litter localStorage.
  const clean = await page.evaluate(() => ({
    flag: STORAGE_OK,
    warned: [...document.querySelectorAll('div')].some(d => /can.t be saved in this window/i.test(d.textContent || '')),
    probeLeft: localStorage.getItem('__fc_probe__'),
  }));
  ok(clean.flag === true, '[storage ok] probe reports storage usable');
  ok(!clean.warned, '[storage ok] no false "progress not saved" warning');
  ok(clean.probeLeft === null, '[storage ok] storage probe cleans up after itself');

  // ══ 8. CORRUPT SAVE MUST NOT BREAK THE GAME ══
  // A partial write (quota exceeded mid-save, tab killed), a downgrade to an older build, or
  // any future change to the save shape produces a save whose fields are the wrong type. The
  // old guard accepted anything with an `xp` key and merged it wholesale, which poisoned SAVE
  // and left the campaign menu throwing with no recovery path for the player.
  const BAD_SAVES = {
    'all-wrong-types': { xp: 'nope', lvl: -999, wins: null, unlocked: 'str', career: 'str', timeTrials: null },
    'NaN/Infinity': { xp: NaN, lvl: Infinity, best: NaN, musicVol: 999 },
    'nulled-objects': { xp: 5, lvl: 3, career: null, timeTrials: null, medals: null, unlocked: null },
    'empty-object': {},
    'array-not-object': [1, 2, 3],
  };
  for (const [label, payload] of Object.entries(BAD_SAVES)) {
    const cs = await browser.newContext();
    const cp = await cs.newPage();
    const cerrs = []; cp.on('pageerror', e => cerrs.push(e.message));
    // Ignore blocked outbound analytics: the beacon is an <img> to GoatCounter, and a sandboxed
    // or offline CI runner fails it with a network error that says nothing about the game.
    cp.on('console', m => {
      const t = m.text();
      if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|goatcounter/i.test(t)) {
        cerrs.push('console:' + t.split('\n')[0]);
      }
    });
    await cp.goto(BASE_URL);
    await cp.evaluate(pl => localStorage.setItem('FRONTLINE_SAVE_v1', JSON.stringify(pl)), payload);
    await cp.reload();
    await cp.waitForTimeout(8000);
    const cr = await cp.evaluate(() => {
      let menuOk = true;
      try { buildMenu(); } catch (e) { menuOk = false; }
      return {
        menuOk,
        title: !document.getElementById('title').classList.contains('hidden'),
        lvlSane: SAVE.lvl >= 1 && SAVE.lvl <= 100,
        xpSane: typeof SAVE.xp === 'number' && SAVE.xp >= 0,
        unlockedArr: Array.isArray(SAVE.unlocked),
        careerObj: !!SAVE.career && typeof SAVE.career === 'object',
      };
    });
    const good = cr.menuOk && cr.title && cr.lvlSane && cr.xpSane && cr.unlockedArr && cr.careerObj && cerrs.length === 0;
    ok(good, `[corrupt save: ${label}] recovers to a working game ${good ? '' : ':: ' + JSON.stringify(cr) + ' ' + cerrs.slice(0, 2).join('|')}`);
    await cs.close();
  }

  // ══ 9. BOOT GUARD MUST NOT FIRE ON A BLOCKED RESOURCE ══
  // The boot guard listens for 'error' in the CAPTURE phase, which is the only way to see a
  // subresource that failed to load — but that also means it sees every <img>/<link>/<script>
  // error in the page. The game is one self-contained file with no external scripts, so no
  // subresource failure can stop it booting, which makes every resource error a false positive.
  // This matters because the analytics beacon targets GoatCounter, which ad blockers and
  // Pi-hole routinely block. Treating that as a boot failure would hide the loader early and
  // show "Reload" over a perfectly working game for every adblocker user.
  const seesFallback = pg => pg.evaluate(() => {
    const fb = [...document.querySelectorAll('div')]
      .find(d => /Reload/.test(d.textContent || '') && d.querySelector('button'));
    return { fallback: !!fb, titleUp: !document.getElementById('title').classList.contains('hidden') };
  });

  // 9a. adblocker blocks the beacon AND it is attached to the DOM (the refactor that would bite)
  const adb = await browser.newContext();
  await adb.route('**goatcounter.com**', r => r.abort());
  const ap = await adb.newPage();
  await ap.addInitScript(() => {
    const Orig = window.Image;
    window.Image = function () {
      const i = new Orig();
      setTimeout(() => { try { document.body.appendChild(i); } catch (e) {} }, 0);
      return i;
    };
  });
  await ap.goto(BASE_URL);
  await ap.waitForTimeout(4000);
  const adRes = await seesFallback(ap);
  ok(!adRes.fallback, '[adblocker] blocked analytics beacon does NOT trigger a false "Reload" screen');
  ok(adRes.titleUp, '[adblocker] game still reaches the title screen');
  await adb.close();

  // 9b. any blocked <img> mid-boot is likewise not a boot failure
  const imgc = await browser.newContext();
  const ip2 = await imgc.newPage();
  await ip2.goto(BASE_URL);
  await ip2.evaluate(() => { const i = new Image(); i.src = 'http://127.0.0.1:9/nope.png'; document.body.appendChild(i); });
  await ip2.waitForTimeout(4000);
  const imgRes = await seesFallback(ip2);
  ok(!imgRes.fallback, '[blocked image] a failed <img> does NOT trigger a false "Reload" screen');
  await imgc.close();

  // 9c. GUARD THE GUARD — a genuine script failure must still surface the fallback.
  // Without this, "ignore resource errors" could silently degrade into "ignore everything".
  const realc = await browser.newContext();
  const rp = await realc.newPage();
  await rp.addInitScript(() => {
    window.addEventListener('load', () => setTimeout(() => {
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      const s = document.createElement('script'); s.textContent = 'null.x.y';
      document.body.appendChild(s);
    }, 2500));
  });
  await rp.goto(BASE_URL);
  await rp.waitForTimeout(6000);
  const realRes = await seesFallback(rp);
  ok(realRes.fallback, '[real script error] genuine boot failure DOES still show the reload fallback');
  await realc.close();

  // ══ 10. BACKGROUND TAB QUIESCING ══
  // People leave itch.io tabs open for hours. A hidden tab must not keep generating a
  // procedural orchestral score — but a REAL battle must NOT be auto-paused either, or a
  // streamer with the game behind their chat window returns to a frozen match.
  const vis = await browser.newContext();
  const vp = await vis.newPage();
  await vp.goto(BASE_URL);
  await vp.waitForTimeout(9000);
  await vp.mouse.click(400, 300);   // user gesture unlocks the audio context
  await vp.waitForTimeout(800);
  const setHidden = h => vp.evaluate(hid => {
    Object.defineProperty(document, 'hidden', { value: hid, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: hid ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  const ctxState = () => vp.evaluate(() => (typeof MUSIC !== 'undefined' && MUSIC.ctx) ? MUSIC.ctx.state : 'none');

  const visState = await ctxState();
  await setHidden(true); await vp.waitForTimeout(1200);
  const hidState = await ctxState();
  await setHidden(false); await vp.waitForTimeout(1200);
  const backState = await ctxState();
  ok(visState === 'running', `[background tab] audio is running while visible (${visState})`);
  ok(hidState === 'suspended', `[background tab] audio suspends when the tab is hidden (${hidState})`);
  ok(backState === 'running', `[background tab] audio resumes when the tab returns (${backState})`);

  // The important half: a live battle keeps simulating while hidden.
  await vp.evaluate(() => { sel.mode = 'skirmish'; LAUNCH = null; start(); });
  await vp.waitForTimeout(1500);
  const tBefore = await vp.evaluate(() => G.t);
  await setHidden(true);
  await vp.waitForTimeout(2500);
  const after = await vp.evaluate(() => ({ t: G.t, paused: G.paused }));
  ok(after.t > tBefore && !after.paused,
    `[background tab] a REAL battle keeps running while hidden (${tBefore.toFixed(1)}s -> ${after.t.toFixed(1)}s, paused=${after.paused})`);
  await vis.close();

  // ══ 11. ONBOARDING: TUTORIAL SPOTLIGHT ══
  // "Tap the Rifleman card" only helps if you can find it. Every step that names a control
  // must point at one that actually exists and is visible, or the instruction is worse than
  // no instruction.
  const tut = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tp = await tut.newPage();
  const terrs = []; tp.on('pageerror', e => terrs.push(e.message));
  await tp.goto(BASE_URL);
  await tp.waitForTimeout(9000);
  await tp.evaluate(() => { SAVE.seenTut = false; persist(); LAUNCH = { type: 'tutorial' }; start(); });
  await tp.waitForTimeout(1500);
  const spots = await tp.evaluate(() => TUT_STEPS.map((s, i) => {
    if (!s.spot) return null;
    const el = document.querySelector(s.spot);
    const r = el ? el.getBoundingClientRect() : null;
    return { i, sel: s.spot, ok: !!(el && el.offsetParent && r.width > 0 && r.height > 0) };
  }).filter(Boolean));
  ok(spots.length >= 5, `[tutorial] steps carry spotlight targets (${spots.length} of them)`);
  const badSpots = spots.filter(s => !s.ok);
  ok(badSpots.length === 0,
    `[tutorial] every spotlight target exists and is visible${badSpots.length ? ' :: MISSING ' + JSON.stringify(badSpots) : ''}`);

  // The ring must surround its target, and keep doing so after a viewport change — the
  // hotbar reflows on resize, and a stale ring pointing at empty space is actively harmful.
  const ringOn = async () => tp.evaluate(() => {
    TUT_STEPS.forEach(s => s._t = null); G.tutStep = 2; G.selCard = null;
    return new Promise(res => setTimeout(() => {
      const el = document.getElementById('tutspot'), t = document.querySelector('#card-rifle');
      const er = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
      res({
        on: el.classList.contains('on'),
        surrounds: er.left <= tr.left + 1 && er.top <= tr.top + 1 && er.right >= tr.right - 1 && er.bottom >= tr.bottom - 1,
      });
    }, 700));
  });
  const rDesk = await ringOn();
  ok(rDesk.on && rDesk.surrounds, '[tutorial] spotlight ring surrounds the Rifleman card');
  await tp.setViewportSize({ width: 390, height: 844 });
  const rPhone = await ringOn();
  ok(rPhone.on && rPhone.surrounds, '[tutorial] spotlight re-tracks the card after a resize to phone width');
  // and it must never outlive the tutorial
  await tp.evaluate(() => tutFinish());
  await tp.waitForTimeout(400);
  const ringGone = await tp.evaluate(() => document.getElementById('tutspot').classList.contains('on'));
  ok(!ringGone, '[tutorial] spotlight clears when the tutorial ends');
  ok(terrs.length === 0, `[tutorial] zero page errors ${terrs.length ? ':: ' + terrs.join(' | ') : ''}`);
  await tut.close();

  // ══ 12. MODE BRIEFINGS + AUDIENCE CAPTURE + COMEBACK ══
  const on = await browser.newContext();
  const op = await on.newPage();
  const oerrs = []; op.on('pageerror', e => oerrs.push(e.message));
  await op.goto(BASE_URL);
  await op.waitForTimeout(9000);

  const briefs = await op.evaluate(() => Object.keys(MODE_BRIEFS));
  ok(['evolution', 'chaos', 'rivals', 'war'].every(k => briefs.includes(k)),
    `[mode briefs] all four gated modes have a briefing (${briefs.join(',')})`);

  const queue = await op.evaluate(async () => {
    SAVE.lvl = 20; SAVE.modeBriefsSeen = {};
    let opened = 0;
    const iv = setInterval(() => { const b = document.querySelector('#modebrief.show .mb-ok'); if (b) { opened++; b.click(); } }, 100);
    return await new Promise(res => runModeBriefQueue(() => { clearInterval(iv); res({ opened, seen: Object.keys(SAVE.modeBriefsSeen).length }); }));
  });
  ok(queue.seen === 4 && queue.opened === 4,
    `[mode briefs] queue shows each exactly once without stacking (opened ${queue.opened}, seen ${queue.seen})`);

  // The capture card must stay silent while no community URL is configured — shipping a
  // prominent CTA that leads nowhere burns the one moment a player was willing to act.
  const rally = await op.evaluate(() => {
    SAVE.career.battles = 99; SAVE.rallyDone = false; SAVE.rallySeen = 0;
    return { url: COMMUNITY_URL, win: rallyEligible(true), loss: rallyEligible(false) };
  });
  ok(!rally.url ? (!rally.win && !rally.loss) : true,
    '[audience capture] stays silent while COMMUNITY_URL is unset (no dead call-to-action ships)');
  const rallyGated = await op.evaluate(() => {
    const saved = SAVE.career.battles;
    SAVE.career.battles = 1; const early = rallyEligible(true);
    SAVE.career.battles = saved; SAVE.rallyDone = true; const done = rallyEligible(true);
    SAVE.rallyDone = false;
    return { early, done };
  });
  ok(!rallyGated.early && !rallyGated.done,
    '[audience capture] never asks a first-time player, and never again once actioned');

  const comeback = await op.evaluate(() => {
    const day = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    SAVE.lastPlayedDay = null; const first = comebackCheck();
    SAVE.lastPlayedDay = day(1); SAVE.dailyStreak = 3; const b2b = comebackCheck();
    SAVE.lastPlayedDay = day(4); SAVE.dailyStreak = 0; const away = comebackCheck();
    return { first, b2b: !!b2b && /streak/i.test(b2b.s), away: !!away && /4 days/.test(away.s) };
  });
  ok(comeback.first === null, '[comeback] a brand-new player is not greeted with a welcome-back');
  ok(comeback.b2b, '[comeback] a next-day return names the live daily streak');
  ok(comeback.away, '[comeback] a lapsed return names how long they were gone');
  ok(oerrs.length === 0, `[onboarding] zero page errors ${oerrs.length ? ':: ' + oerrs.join(' | ') : ''}`);
  await on.close();

  // ══ 13. TOUCH-LAYOUT GEOMETRY ══
  // This whole block exists because a real defect shipped and 64 checks missed it: the
  // narrator is top-anchored (top:84px) but three (pointer:coarse) rules also set `bottom`
  // on it. An absolutely-positioned, auto-height element given BOTH top and bottom stretches
  // to span the gap — producing a ~600px-tall box down the middle of the battlefield on every
  // touch device. Every earlier test measured desktop only, where those rules never applied.
  // The lesson generalised: assert GEOMETRY on touch, not just "it booted".
  const TOUCH_CASES = [
    { label: 'touch 1037x882', w: 1037, h: 882, wideEnoughForColumns: true },
    { label: 'tablet landscape 1194x834', w: 1194, h: 834, wideEnoughForColumns: true },
    { label: 'phone portrait 390x844', w: 390, h: 844, wideEnoughForColumns: false },
  ];
  for (const tc of TOUCH_CASES) {
    const tctx = await browser.newContext({
      viewport: { width: tc.w, height: tc.h }, hasTouch: true, isMobile: true,
    });
    const tpg = await tctx.newPage();
    const tperr = []; tpg.on('pageerror', e => tperr.push(e.message));
    await tpg.goto(BASE_URL);
    await tpg.waitForTimeout(9000);
    await tpg.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; persist(); });

    // menu orientation: cards sharing a top edge means they are side by side
    await tpg.evaluate(() => openMenu());
    await tpg.waitForTimeout(500);
    const mcols = await tpg.evaluate(() => {
      const mc = document.querySelector('.menu-cols');
      const tops = [...mc.querySelectorAll('.mcard')].map(c => Math.round(c.getBoundingClientRect().top));
      return { horizontal: new Set(tops).size === 1, n: tops.length };
    });
    if (tc.wideEnoughForColumns) {
      ok(mcols.horizontal, `[touch ${tc.w}px] play screen keeps the horizontal column layout (${mcols.n} cards)`);
    } else {
      ok(!mcols.horizontal, `[touch ${tc.w}px] narrow screen correctly stacks the play screen`);
    }

    // narrator geometry
    await tpg.evaluate(() => { sel.mode = 'skirmish'; LAUNCH = null; start(); });
    await tpg.waitForTimeout(900);
    await tpg.evaluate(() => { try { narr('battleStart'); } catch (e) {} });
    await tpg.waitForTimeout(600);
    // NB: do NOT try to assert this via getComputedStyle().bottom === 'auto'. For an
    // absolutely-positioned element the computed style returns the USED value, so `bottom`
    // reports a resolved pixel number even when the stylesheet says auto — the check passes
    // and fails identically either way. Measure the RESULT instead: a box stretched between
    // top and bottom is several times taller than its own text.
    const nb = await tpg.evaluate(() => {
      const el = document.getElementById('narrator');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      // natural height of the content, independent of how the box is anchored
      const inner = [...el.children].reduce((m, c) => Math.max(m, c.getBoundingClientRect().bottom), r.top) - r.top;
      return { h: Math.round(r.height), w: Math.round(r.width), content: Math.round(inner + pad) };
    });
    ok(nb.h < 120, `[touch ${tc.w}px] narrator box is a subtitle, not a panel (${nb.h}px tall)`);
    ok(nb.h <= nb.content + 24,
      `[touch ${tc.w}px] narrator height tracks its text, i.e. not stretched between top and bottom (${nb.h}px box vs ~${nb.content}px content)`);
    ok(nb.w <= Math.min(400, tc.w), `[touch ${tc.w}px] narrator width is capped sanely (${nb.w}px)`);
    ok(tperr.length === 0, `[touch ${tc.w}px] zero page errors ${tperr.length ? ':: ' + tperr.join(' | ') : ''}`);
    await tctx.close();
  }

  // ══ 14. LAYOUT IS A FUNCTION OF SIZE, NOT OF POINTER TYPE ══
  // Second defect from the same root: the whole compact layout was gated on
  // (pointer:coarse). A touchscreen Windows laptop reports pointer:coarse, so a 1920px
  // machine was locked into the phone layout — icon-only top bar, 40px deploy cards, a
  // bottom deck packed for a 390px screen. Section 13 could not catch it, because
  // section 13 only ever ran WITH touch on; the bug was that touch changed anything at all.
  //
  // So this section runs every viewport TWICE — once with touch emulation, once without —
  // and asserts the two render identically. That invariant is the real contract: pointer
  // type may change tap-target sizes, never layout. Any future rule that moves a box
  // based on how the user points will fail here.
  const measureLayout = async (w, h, touch) => {
    const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
    const p = await c.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE_URL);
    await p.waitForTimeout(9000);
    await p.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; persist(); });
    await p.evaluate(() => openMenu());
    await p.waitForTimeout(400);
    const menuRow = await p.evaluate(() => {
      const mc = document.querySelector('.menu-cols');
      const tops = [...mc.querySelectorAll('.mcard')].map(x => Math.round(x.getBoundingClientRect().top));
      return new Set(tops).size === 1;
    });
    await p.evaluate(() => { sel.mode = 'skirmish'; LAUNCH = null; start(); });
    await p.waitForTimeout(900);
    const m = await p.evaluate(() => {
      const bar = document.getElementById('topbar');
      const btns = [...bar.querySelectorAll('.tb-btn,#playtest-link')];
      const stream = document.getElementById('btn-stream');
      const card = document.querySelector('#hotbar .card');
      const deck = document.getElementById('hbwrap');
      const qb = document.getElementById('quickbar');
      const nar = document.getElementById('narrator');
      const dr = deck ? deck.getBoundingClientRect() : null;
      return {
        // >60px means the button is showing its word, not just its emoji
        topbarWords: stream ? stream.getBoundingClientRect().width > 60 : null,
        offscreen: btns.filter(b => { const r = b.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).length,
        cardW: card ? Math.round(card.getBoundingClientRect().width) : null,
        deckTop: dr ? Math.round(dr.top) : null,
        deckLeft: dr ? Math.round(dr.left) : null,
        deckRight: dr ? Math.round(dr.right) : null,
        qbLeft: qb ? Math.round(qb.getBoundingClientRect().left) : null,
        // compare the CAP, not the rendered width: rendered size tracks whichever
        // narration line happens to be on screen and differs between runs.
        narMaxW: nar ? getComputedStyle(nar).maxWidth : null,
        laneY: Math.round(innerHeight * 0.70),
      };
    });
    await c.close();
    return { ...m, menuRow, errs };
  };

  const LAYOUT_CASES = [
    { w: 1920, h: 950, label: 'touchscreen laptop', words: true, row: true },
    { w: 1366, h: 768, label: 'laptop', words: true, row: true },
    { w: 1024, h: 768, label: 'iPad landscape', words: false, row: true },
    { w: 390, h: 844, label: 'phone portrait', words: false, row: false },
  ];
  for (const lc of LAYOUT_CASES) {
    const mouse = await measureLayout(lc.w, lc.h, false);
    const touch = await measureLayout(lc.w, lc.h, true);
    const keys = ['topbarWords', 'cardW', 'deckTop', 'deckLeft', 'deckRight', 'qbLeft', 'narMaxW', 'menuRow'];
    const drift = keys.filter(k => mouse[k] !== touch[k]);
    ok(drift.length === 0,
      `[layout ${lc.w}x${lc.h} ${lc.label}] touch and mouse render identically` +
      (drift.length ? ` :: differs on ${drift.map(k => `${k} ${mouse[k]}→${touch[k]}`).join(', ')}` : ''));
    ok(touch.topbarWords === lc.words,
      `[layout ${lc.w}x${lc.h}] top bar shows ${lc.words ? 'full labels' : 'icons'} as its width warrants`);
    ok(touch.menuRow === lc.row,
      `[layout ${lc.w}x${lc.h}] play screen is ${lc.row ? 'horizontal' : 'stacked'} as its width warrants`);
    ok(touch.offscreen === 0,
      `[layout ${lc.w}x${lc.h}] no top-bar button is pushed off the edge (${touch.offscreen} offscreen)`);
    ok(touch.deckTop !== null && touch.deckTop >= touch.laneY,
      `[layout ${lc.w}x${lc.h}] deploy deck clears the bottom lane (deck@${touch.deckTop} vs lane@${touch.laneY})`);
    ok(touch.qbLeft !== null && touch.qbLeft >= 0 && touch.deckLeft >= 0 && touch.deckRight <= lc.w + 1,
      `[layout ${lc.w}x${lc.h}] deck and specials sit inside the viewport, not clipped off an edge`);
    ok(touch.errs.length === 0 && mouse.errs.length === 0,
      `[layout ${lc.w}x${lc.h}] zero page errors ${touch.errs.length ? ':: ' + touch.errs.join(' | ') : ''}`);
  }

  // ══ 15. v1.16.0 — PRE-RELEASE HARDENING + ACCESSIBILITY + TITLE ══
  {
    const hctx = await browser.newContext({ viewport: { width: 1366, height: 620 } });
    const hp = await hctx.newPage();
    const herr = []; hp.on('pageerror', e => herr.push(e.message));
    await hp.goto(BASE_URL);
    await hp.waitForTimeout(9000);
    await hp.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; persist(); });

    // CSP is default-deny and grants exactly the known endpoints
    const csp = await hp.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
    ok(csp.includes("default-src 'none'"), '[csp] default-src is \'none\' — unlisted capabilities are denied, not defaulted open');
    ok(csp.includes('wss://irc-ws.chat.twitch.tv') && csp.includes('goatcounter.com'), '[csp] connect-src grants exactly the two known endpoints');
    ok(!csp.includes('frame-ancestors'), '[csp] no frame-ancestors — itch.io must be able to embed the game (and meta ignores it anyway)');

    // title screen: labelled clusters + the daily card with streak.
    // v1.17.0 added a fourth cluster ("Learn") for the Indoctrination school; the assertion
    // pins the full ordered list so an accidental reordering or a dropped group still fails.
    const title = await hp.evaluate(() => ({
      groups: [...document.querySelectorAll('.title-grp-lbl')].map(e => e.textContent),
      daily: !!document.getElementById('t-daily'),
      dailySub: document.getElementById('t-daily-sub').textContent,
      streakTxt: document.getElementById('t-daily-streak').textContent,
      chest: !!document.getElementById('t-chest'),
      indoc: !!document.getElementById('t-indoc'),
      leaderboard: !!document.getElementById('t-leaderboard'),
    }));
    // v1.17.2 folded the Info cluster into inline text links so the primary actions clear
    // the fold in the 1280x720 itch embed; the three remaining clusters are pinned in order.
    ok(title.groups.join('|') === 'More Modes|Learn|Your Progress', `[title] labelled clusters intact (${title.groups.join(', ')})`);
    ok(title.chest && title.indoc && title.leaderboard, '[title] the daily crate card, Indoctrination and Leaderboard entry points are all present');
    const infoLinks = await hp.evaluate(() => ['t-manual', 't-patchnotes', 't-settings']
      .every(id => { const e = document.getElementById(id); return e && e.offsetParent !== null; }));
    ok(infoLinks, '[title] Field Manual / Patch Notes / Settings survive the fold-out as reachable links');
    // PLAY must precede the difficulty picker in the DOM — a first-timer shouldn't have to
    // resolve "which difficulty?" before they're allowed to want to play.
    const order = await hp.evaluate(() => {
      const play = document.getElementById('t-play'), diff = document.getElementById('title-diff');
      return !!(play && diff && (play.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    ok(order, '[title] the PLAY button comes before the difficulty picker');
    ok(title.daily && title.dailySub.length > 3, `[title] daily challenge card present with today's twist ("${title.dailySub}")`);
    ok(/🔥|Start a streak/.test(title.streakTxt), `[title] streak state shown on the daily card ("${title.streakTxt}")`);

    // tall screens scroll to the very top (the flex-centering clip bug)
    const scrollTop = await hp.evaluate(() => {
      const scr = document.getElementById('title'); scr.scrollTop = 0;
      const first = [...scr.children].find(c => c.offsetHeight > 0 && !c.classList.contains('back-btn'));
      return { overflow: scr.scrollHeight > scr.clientHeight, top: Math.round(first.getBoundingClientRect().top) };
    });
    ok(scrollTop.overflow && scrollTop.top >= 0,
      `[scroll] an overflowing screen can be scrolled fully to its top (first element at y=${scrollTop.top})`);

    // colourblind palette: whitelisted, swaps canvas team colours + hp ramp
    const pal = await hp.evaluate(() => {
      const out = {};
      SAVE.cbPalette = 'orange'; applyCbPalette();
      out.orange = TEAM.R.main; out.hpCb = hpRampCol(0.9);
      SAVE.cbPalette = '"><img onerror=x>'; applyCbPalette();
      out.hostileAttr = document.body.getAttribute('data-cb'); out.hostileTeam = TEAM.R.main;
      SAVE.cbPalette = 'default'; applyCbPalette(); out.back = TEAM.R.main; out.hpDef = hpRampCol(0.9);
      return out;
    });
    ok(pal.orange === '#ff9d1f' && pal.back === '#ff5a4a', '[a11y] colourblind palette swaps every canvas team colour through TEAM');
    ok(pal.hpCb === '#59c3ff' && pal.hpDef === '#3fd07a', '[a11y] unit HP bars switch to a luminance ramp in colourblind modes');
    ok(pal.hostileAttr === 'default' && pal.hostileTeam === '#ff5a4a', '[a11y] a hostile hand-edited palette value is whitelisted back to default');

    // reduce-motion honoured for fresh saves
    const rm = await hp.evaluate(() => { localStorage.removeItem(SAVE_KEY); return true; });
    ok(rm, '[a11y] (setup) save cleared for fresh-boot reduced-motion check');
    const rmctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const rmp = await rmctx.newPage();
    await rmp.goto(BASE_URL); await rmp.waitForTimeout(9000);
    const rmv = await rmp.evaluate(() => SAVE.reduceMotion);
    ok(rmv === true, '[a11y] a fresh save on a prefers-reduced-motion device starts with Reduce Motion ON');
    await rmctx.close();

    // beacon rate limiter: 300 events cannot become 300 requests
    const flood = await hp.evaluate(() => {
      const before = _gcBucket.total;
      for (let i = 0; i < 300; i++) gcEvent('flood');
      return { sent: _gcBucket.total - before, cap: _gcBucket.total <= 200 };
    });
    ok(flood.sent <= 20 && flood.cap, `[rate-limit] 300 beacon calls collapse to ${flood.sent} sends, session cap holds`);

    // focus ring + canvas ARIA
    const a11y = await hp.evaluate(() => ({
      focusCss: [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes(':focus-visible')); } catch (e) { return false; } }),
      canvasLabel: document.getElementById('game').getAttribute('aria-label'),
    }));
    ok(a11y.focusCss, '[a11y] :focus-visible ring exists for keyboard users');
    ok(!!a11y.canvasLabel, '[a11y] battlefield canvas has an aria-label');

    // The overlay key-guard must not cost the battle its hotkeys. This is the regression
    // risk the guard itself introduces: block one key too many and SPACE stops pausing, or
    // the number keys stop selecting units, in the one screen where they matter most.
    await hp.evaluate(() => { showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start(); });
    await hp.waitForTimeout(1200);
    const keys = await hp.evaluate(async () => {
      const press = k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const openDuringBattle = (document.querySelector('.screen:not(.hidden)') || {}).id || null;
      press(' '); const paused = G.paused;
      press(' '); const resumed = !G.paused;
      press('1'); const card = G.selCard;
      return { openDuringBattle, paused, resumed, card };
    });
    ok(keys.openDuringBattle === null, '[keys] a live battle has no .screen overlay open, so the key-guard never engages there');
    ok(keys.paused && keys.resumed, '[keys] SPACE still pauses AND unpauses inside a battle');
    ok(!!keys.card, `[keys] number hotkeys still select units in a battle (picked "${keys.card}")`);

    ok(herr.length === 0, `[v1.16.0] zero page errors ${herr.length ? ':: ' + herr.join(' | ') : ''}`);
    await hctx.close();
  }

  // ══ 16. v1.16.1 — NARRATOR CUTOFF, DUPLICATE TUTORIAL TEXT, ICON CLARITY, FRIEND-OR-FOE ══
  {
    // 16a. narrator/tutorial: a fake speechSynthesis with a scripted per-clause delay proves the
    // step-advance now WAITS for speech to finish instead of narrStop()-ing it mid-sentence, and
    // that the tutorial box + narrator subtitle never show the same line at the same time.
    const nctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await nctx.addInitScript(() => {
      let cancelled = false;
      window.__spoken = [];
      const fake = {
        speaking: false,
        speak(u) {
          cancelled = false; this.speaking = true;
          window.__spoken.push({ text: u.text, cancelledMidway: false });
          const rec = window.__spoken[window.__spoken.length - 1];
          setTimeout(() => { this.speaking = false; if (cancelled) { rec.cancelledMidway = true; return; } try { u.onend && u.onend(); } catch (e) {} }, 250);
        },
        cancel() { cancelled = true; this.speaking = false; },
        getVoices() { return []; }, onvoiceschanged: null,
      };
      Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true, writable: true });
    });
    const np = await nctx.newPage();
    const nerr = []; np.on('pageerror', e => nerr.push(e.message));
    await np.goto(BASE_URL); await np.waitForTimeout(9000);
    await np.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = false; SAVE.narrator = true; persist(); });
    await np.evaluate(() => { LAUNCH = { type: 'tutorial' }; start(); tutStart(); });
    await np.waitForTimeout(300);
    const noDup = await np.evaluate(() => ({
      tutboxShown: document.getElementById('tutbox').classList.contains('show'),
      narratorShown: document.getElementById('narrator').classList.contains('show'),
    }));
    ok(noDup.tutboxShown && !noDup.narratorShown, '[narrator] tutorial shows the training box only, not a duplicate narrator subtitle for the same line');
    // adversarial fast player: satisfy every cond-based step's condition the instant it appears
    let sawDup = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await np.waitForTimeout(120);
      const st = await np.evaluate(() => {
        if (!G || G.tutDone) return { step: -1 };
        if (G.tutStep === 2) G.selCard = 'rifle';
        if (G.tutStep === 3) G.deploys = Math.max(G.deploys || 0, 1);
        if (G.tutStep === 4) G.units.push({ alive: true, side: 'B', key: 'tank' });
        if (G.tutStep === 5) G.kills = Math.max(G.kills || 0, 1);
        if (G.tutStep === 7) G.strikeUsedCount = Math.max(G.strikeUsedCount || 0, 1);
        return { step: G.tutStep, narratorShown: document.getElementById('narrator').classList.contains('show') };
      });
      if (st.narratorShown) sawDup = true;
      if (st.step === -1) break;
    }
    ok(!sawDup, '[narrator] narrator subtitle never appears mid-tutorial under an adversarial fast player');
    const spokenAll = await np.evaluate(() => window.__spoken.map(s => ({ t: s.text, c: s.cancelledMidway })));
    const cutLines = spokenAll.filter(s => s.c).map(s => '"' + String(s.t).slice(0, 55) + '…"');
    ok(spokenAll.length > 10 && cutLines.length === 0,
      `[narrator] zero of ${spokenAll.length} spoken lines were cut off mid-sentence, even when the player raced every step` +
      (cutLines.length ? ` :: CUT ${cutLines.length}: ${cutLines.join(' | ')}` : ''));
    ok(nerr.length === 0, `[narrator] zero page errors ${nerr.length ? ':: ' + nerr.join(' | ') : ''}`);
    await nctx.close();
  }

  {
    // 16b. hotbar icons: every UNITS glyph is a distinct, real pictograph — the old abstract-shape
    // set (▲⊕◼▣⊞⊗ etc) is asserted absent so a future edit can't silently reintroduce it.
    const ictx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ip = await ictx.newPage();
    const ierr = []; ip.on('pageerror', e => ierr.push(e.message));
    await ip.goto(BASE_URL); await ip.waitForTimeout(9000);
    const glyphs = await ip.evaluate(() => Object.values(UNITS).filter(u => u.cat !== undefined).map(u => u.glyph));
    const OLD_ABSTRACT = ['▲', '⊕', '◼', '▣', '⊞', '⊗', '⬡', '⬟', '✛', '▤', '◈', '➤', '⁂'];
    ok(!glyphs.some(g => OLD_ABSTRACT.includes(g)), '[icons] no unit uses the old abstract-shape glyph set');
    ok(new Set(glyphs).size === glyphs.length, `[icons] all ${glyphs.length} unit glyphs are unique — no two cards share an icon`);
    ok(ierr.length === 0, `[icons] zero page errors ${ierr.length ? ':: ' + ierr.join(' | ') : ''}`);
    await ictx.close();
  }

  {
    // 16c. friend-or-foe: pixel-sample the rendered canvas at the team marker (ground) and IFF
    // wedge (air) for a friendly and an enemy unit of the SAME type, and assert the colours
    // actually differ on screen — not just that the drawing code looks right.
    const fctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const fp = await fctx.newPage();
    const ferr = []; fp.on('pageerror', e => ferr.push(e.message));
    await fp.goto(BASE_URL); await fp.waitForTimeout(9000);
    const iff = await fp.evaluate(() => {
      const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; persist();
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start();
      G.prep = 0;
      spawn('B', 'rifle', 1, 300); spawn('R', 'rifle', 1, 1000);
      spawn('B', 'heli', 2, 300); spawn('R', 'heli', 2, 1000);
      for (const u of G.units) u.spotted = true;
      draw();
      const ctx = cv.getContext('2d'); const t = ctx.getTransform();
      const px1 = (wx, wy) => { const d = ctx.getImageData(Math.round(wx * t.a), Math.round(wy * t.d), 1, 1).data; return { r: d[0], g: d[1], b: d[2] }; };
      const units = G.units.filter(u => u.key === 'rifle' || u.key === 'heli');
      const bRifle = units.find(u => u.side === 'B' && u.key === 'rifle'), rRifle = units.find(u => u.side === 'R' && u.key === 'rifle');
      const bHeli = units.find(u => u.side === 'B' && u.key === 'heli'), rHeli = units.find(u => u.side === 'R' && u.key === 'heli');
      // disc edge, offset past the narrow infantry silhouette
      const discBest = (u, signs) => { let best = null; for (const s of signs) { const c = px1(u.x + s, u.y + u.r * 0.6); if (!best || Math.abs(c.r - c.b) > Math.abs(best.r - best.b)) best = c; } return best; };
      const wedge = (u) => px1(u.x, u.y - 16 - u.r - 9);
      return { bRifle: discBest(bRifle, [6, 7, 8]), rRifle: discBest(rRifle, [-6, -7, -8]), bHeli: wedge(bHeli), rHeli: wedge(rHeli) };
    });
    const blue = (px) => px.b > px.r, red = (px) => px.r > px.b;
    ok(blue(iff.bRifle), '[friend-or-foe] friendly ground unit marker reads blue-dominant');
    ok(red(iff.rRifle), '[friend-or-foe] enemy ground unit marker reads red-dominant');
    ok(blue(iff.bHeli), '[friend-or-foe] friendly aircraft IFF wedge reads blue-dominant');
    ok(red(iff.rHeli), '[friend-or-foe] enemy aircraft IFF wedge reads red-dominant');
    ok(ferr.length === 0, `[friend-or-foe] zero page errors ${ferr.length ? ':: ' + ferr.join(' | ') : ''}`);
    await fctx.close();
  }

  {
    // 16d. unit visual scale: render size grows (base bump, then Big Units) while the real
    // gameplay/collision radius never moves — the whole point of keeping them separate.
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const sp = await sctx.newPage();
    const serr = []; sp.on('pageerror', e => serr.push(e.message));
    await sp.goto(BASE_URL); await sp.waitForTimeout(9000);
    const scale = await sp.evaluate(() => {
      const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; persist();
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start();
      spawn('B', 'tank', 1, 500);
      const u = G.units.find(x => x.key === 'tank');
      const rBefore = u.r, vrDefault = unitVisualR(u);
      SAVE.bigUnits = true;
      const vrBig = unitVisualR(u);
      const rAfterBig = u.r;
      SAVE.bigUnits = false;
      return { rBefore, rAfterBig, vrDefault, vrBig, base: BASE_VUNIT_SCALE, bigMul: BIG_UNITS_SCALE };
    });
    ok(scale.rBefore === scale.rAfterBig, '[unit-scale] gameplay radius (u.r) is untouched by the Big Units setting');
    ok(scale.vrDefault > scale.rBefore, `[unit-scale] default render size is modestly larger than gameplay radius (${scale.vrDefault.toFixed(1)} vs ${scale.rBefore})`);
    ok(scale.vrDefault < scale.rBefore * 1.3, '[unit-scale] default bump stays subtle (under 1.3x), not drastic');
    ok(scale.vrBig > scale.vrDefault * 1.5, `[unit-scale] Big Units mode is dramatically larger than the default (${scale.vrBig.toFixed(1)} vs ${scale.vrDefault.toFixed(1)})`);
    ok(serr.length === 0, `[unit-scale] zero page errors ${serr.length ? ':: ' + serr.join(' | ') : ''}`);
    await sctx.close();
  }

  // ══ 17. v1.17.0 — DAILY CHEST · LEADERBOARD · INDOCTRINATION ══
  {
    // 17a. CHEST — pool integrity, weighted distribution, the pity floor, duplicate
    //      protection, and the completion payout. Rolled thousands of times in-page
    //      rather than through the UI: one chest a day means the UI can only ever
    //      exercise a single branch, and the interesting failures are all in the tail.
    const cctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const cp = await cctx.newPage();
    const cerr = []; cp.on('pageerror', e => cerr.push(e.message));
    await cp.goto(BASE_URL); await cp.waitForTimeout(9000);

    const pool = await cp.evaluate(() => {
      const ids = CHEST_COSMETICS.map(c => c.id);
      const badgeGlyphs = CHEST_COSMETICS.filter(c => c.type === 'badge').map(c => c.glyph);
      const rankGlyphs = HQ_BADGES.map(b => b.glyph).concat(SPECIAL_BADGES.map(b => b.glyph));
      return {
        n: CHEST_COSMETICS.length,
        dupIds: ids.length - new Set(ids).size,
        dupGlyphs: badgeGlyphs.length - new Set(badgeGlyphs).size,
        collide: badgeGlyphs.filter(g => rankGlyphs.includes(g)),
        badRarity: CHEST_COSMETICS.filter(c => !CHEST_RARITIES[c.rarity]).map(c => c.id),
        malformed: CHEST_COSMETICS.filter(c =>
          c.type === 'badge' ? (!c.name || !c.glyph) : c.type === 'title' ? !c.title : true).map(c => c.id),
        rarities: CHEST_RARITY_ORDER.filter(r => !CHEST_COSMETICS.some(c => c.rarity === r)),
      };
    });
    ok(pool.dupIds === 0, '[chest] every cosmetic id is unique');
    ok(pool.dupGlyphs === 0, '[chest] no two chest badges share a glyph');
    ok(pool.collide.length === 0, `[chest] chest badge glyphs never collide with rank/special badges ${pool.collide.length ? ':: ' + pool.collide.join(',') : ''}`);
    ok(pool.badRarity.length === 0, '[chest] every cosmetic names a real rarity tier');
    ok(pool.malformed.length === 0, `[chest] badges carry name+glyph and titles carry a title ${pool.malformed.length ? ':: ' + pool.malformed.join(',') : ''}`);
    ok(pool.rarities.length === 0, `[chest] every rarity tier has at least one cosmetic ${pool.rarities.length ? ':: empty ' + pool.rarities.join(',') : ''}`);

    const dist = await cp.evaluate(() => {
      const N = 20000, counts = {};
      let gap = 0, worstGap = 0;
      SAVE.chestSinceEpic = 0;
      for (let i = 0; i < N; i++) {
        const r = rollChestRarity();
        counts[r] = (counts[r] || 0) + 1;
        if (r === 'epic' || r === 'legendary') { if (gap > worstGap) worstGap = gap; gap = 0; SAVE.chestSinceEpic = 0; }
        else { gap++; SAVE.chestSinceEpic++; }
      }
      SAVE.chestSinceEpic = 0;
      return { N, counts, worstGap, pity: CHEST_PITY };
    });
    const pct = k => (dist.counts[k] || 0) / dist.N * 100;
    ok(pct('common') > pct('uncommon') && pct('uncommon') > pct('rare') && pct('rare') > pct('epic') && pct('epic') > pct('legendary'),
      `[chest] rarity frequency is strictly ordered common>uncommon>rare>epic>legendary (${['common','uncommon','rare','epic','legendary'].map(k => k[0] + ':' + pct(k).toFixed(1)).join(' ')})`);
    ok(pct('legendary') > 0 && pct('legendary') < 5, `[chest] legendary stays genuinely rare but reachable (${pct('legendary').toFixed(2)}%)`);
    ok(dist.worstGap <= dist.pity, `[chest] pity floor holds — never more than ${dist.pity} pulls without an epic+ (worst run: ${dist.worstGap})`);

    const drain = await cp.evaluate(() => {
      SAVE.chestOwned = {}; SAVE.chestSinceEpic = 0; SAVE.chestPulls = 0;
      const got = []; let surplus = 0, nulls = 0;
      for (let i = 0; i < CHEST_COSMETICS.length + 6; i++) {
        SAVE.chestLastDay = null;               // force a fresh day for each pull
        const r = claimChest();
        if (!r) { nulls++; continue; }
        if (r.item) got.push(r.item.id); else surplus++;
      }
      return { pulls: got.length, dupes: got.length - new Set(got).size, surplus, nulls,
               owned: Object.keys(SAVE.chestOwned).length, total: CHEST_COSMETICS.length };
    });
    ok(drain.dupes === 0, `[chest] duplicate protection — draining the whole pool never granted the same item twice (${drain.pulls} pulls, ${drain.dupes} dupes)`);
    ok(drain.owned === drain.total, `[chest] the pool is fully collectable (${drain.owned}/${drain.total})`);
    ok(drain.surplus === 6, `[chest] once collected, further crates pay XP surplus instead of failing (${drain.surplus} surplus payouts)`);

    const claimGate = await cp.evaluate(() => {
      SAVE.chestLastDay = null;
      const first = !!claimChest();
      const readyAfter = chestReady();
      const second = claimChest();
      return { first, readyAfter, secondBlocked: second === null, day: SAVE.chestLastDay === todayKey() };
    });
    ok(claimGate.first && claimGate.secondBlocked && !claimGate.readyAfter && claimGate.day,
      '[chest] strictly one crate per calendar day — a second claim the same day is refused');

    const equipChest = await cp.evaluate(() => {
      SAVE.chestOwned = {};
      const badge = CHEST_COSMETICS.find(c => c.type === 'badge');
      const title = CHEST_COSMETICS.find(c => c.type === 'title');
      equipBadge(badge.id); equipTitle(title.id);           // unowned — must be refused
      const refusedB = equippedBadge().glyph !== badge.glyph;
      const refusedT = equippedTitleEntry().title !== title.title;
      SAVE.chestOwned[badge.id] = true; SAVE.chestOwned[title.id] = true;
      equipBadge(badge.id); equipTitle(title.id);           // owned — must stick
      return { refusedB, refusedT, badgeOk: equippedBadge().glyph === badge.glyph,
               titleOk: equippedTitleEntry().title === title.title };
    });
    ok(equipChest.refusedB && equipChest.refusedT, '[chest] equipping an unowned crate cosmetic is refused');
    ok(equipChest.badgeOk && equipChest.titleOk, '[chest] an owned crate badge and title both equip and resolve');
    ok(cerr.length === 0, `[chest] zero page errors ${cerr.length ? ':: ' + cerr.join(' | ') : ''}`);
    await cctx.close();
  }

  {
    // 17b. LEADERBOARD — rated ordering, the board cap, streak break/continue, and the
    //      beaten-today rollover. Also asserts the local-only disclaimer is actually on
    //      screen: it is the one thing on that page that must never quietly disappear.
    const lctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const lp = await lctx.newPage();
    const lerr = []; lp.on('pageerror', e => lerr.push(e.message));
    await lp.goto(BASE_URL); await lp.waitForTimeout(9000);

    const rated = await lp.evaluate(() => {
      SAVE.board = [];
      const mk = (diff, sc) => ({ diff, mode: 'skirmish', kind: 'skirmish', doc: 'mass', kills: 10, t: 100, sc });
      // a Recruit blowout must NOT outrank a lower-raw Legendary win
      const a = mk('recruit', 1000), b = mk('legendary', 800);
      boardRecord(a, true, a.sc); boardRecord(b, true, b.sc);
      return { order: SAVE.board.map(e => e.diff), rated: SAVE.board.map(e => e.rated),
               weights: DIFF_WEIGHT, indocExcluded: typeof BOARD_MAX === 'number' };
    });
    ok(rated.order[0] === 'legendary',
      `[leaderboard] rated score ranks a Legendary win over a higher-raw Recruit run (${rated.order.join(' > ')})`);

    const cap = await lp.evaluate(() => {
      SAVE.board = [];
      const extra = 25, n = BOARD_MAX + extra;
      for (let i = 0; i < n; i++)
        boardRecord({ diff: 'veteran', mode: 'skirmish', kind: 'skirmish', doc: 'mass', kills: 1, t: 60 }, true, 100 + i);
      const desc = SAVE.board.every((e, i, a) => i === 0 || a[i - 1].rated >= e.rated);
      return { len: SAVE.board.length, max: BOARD_MAX, desc,
               top: SAVE.board[0].score, expectedTop: 100 + n - 1,
               // the worst surviving row must be better than everything that was dropped
               worst: SAVE.board[SAVE.board.length - 1].score, droppedBest: 100 + extra - 1 };
    });
    ok(cap.len === cap.max, `[leaderboard] board is capped at BOARD_MAX rows (${cap.len}/${cap.max})`);
    ok(cap.desc, '[leaderboard] rows stay sorted best-first after every insert');
    ok(cap.top === cap.expectedTop, `[leaderboard] the highest-scoring run survives the cap (kept ${cap.top}, expected ${cap.expectedTop})`);
    ok(cap.worst > cap.droppedBest, `[leaderboard] the cap drops the WORST runs, not the oldest (worst kept ${cap.worst} > best dropped ${cap.droppedBest})`);

    const streak = await lp.evaluate(() => {
      SAVE.winStreak = 0; SAVE.bestWinStreak = 0;
      streakRecord(true); streakRecord(true); streakRecord(true);
      const after3 = SAVE.winStreak, best3 = SAVE.bestWinStreak;
      streakRecord(false);
      const afterLoss = SAVE.winStreak, bestKept = SAVE.bestWinStreak;
      streakRecord(true);
      return { after3, best3, afterLoss, bestKept, restarted: SAVE.winStreak };
    });
    ok(streak.after3 === 3 && streak.best3 === 3, '[leaderboard] win streak counts consecutive wins and records a best');
    ok(streak.afterLoss === 0 && streak.bestKept === 3, '[leaderboard] a loss breaks the streak but never the recorded best');
    ok(streak.restarted === 1, '[leaderboard] the streak restarts cleanly after a break');

    const today = await lp.evaluate(() => {
      SAVE.beatToday = { day: '1999-01-01', items: [{ id: 'stale', label: 'stale', glyph: '?', score: 1 }] };
      // NB read the length IMMEDIATELY — beatTodayState() hands back a live reference to
      // SAVE.beatToday, so the adds below would otherwise mutate what we're asserting on.
      const rolled = beatTodayState();                    // stale day must be discarded
      const rolledEmpty = rolled.items.length === 0, rolledDay = rolled.day === todayKey();
      beatTodayAdd('daily', 'Daily Challenge', '🎯', 500);
      beatTodayAdd('daily', 'Daily Challenge', '🎯', 900);  // replay: dedupe, keep best
      beatTodayAdd('daily', 'Daily Challenge', '🎯', 300);  // worse replay: must not lower it
      const d = beatTodayState().items.find(i => i.id === 'daily');
      return { rolledEmpty, day: rolledDay,
               rows: beatTodayState().items.length, n: d.n, score: d.score };
    });
    ok(today.rolledEmpty && today.day, '[beaten-today] the list rolls over to an empty board on a new calendar day');
    ok(today.rows === 1 && today.n === 3, '[beaten-today] repeat clears of the same thing collapse into one row with a count');
    ok(today.score === 900, `[beaten-today] a deduped row keeps the BEST score, not the latest (${today.score})`);

    const disclaimer = await lp.evaluate(() => {
      showTitle(); openLeaderboard(); buildLbTabs('runs');
      const txt = document.getElementById('lb-body').textContent;
      return { local: /your runs, on this device/i.test(txt), noServer: /no server/i.test(txt),
               visible: !document.getElementById('leaderboard').classList.contains('hidden'),
               backendNull: LEADERBOARD_BACKEND === null };
    });
    ok(disclaimer.visible, '[leaderboard] the screen opens from the title');
    ok(disclaimer.local && disclaimer.noServer,
      '[leaderboard] the board states plainly that it is local and that there is no server — never silently implies a global ranking');
    ok(disclaimer.backendNull, '[leaderboard] LEADERBOARD_BACKEND ships as null — no placeholder/fake global rows');
    ok(lerr.length === 0, `[leaderboard] zero page errors ${lerr.length ? ':: ' + lerr.join(' | ') : ''}`);
    await lctx.close();
  }

  {
    // 17c. INDOCTRINATION — the promise of this mode is that the matchup is exactly what
    //      the briefing said. So: the forced doctrine applies (even unlocked-gated), the
    //      player's deck is exactly the whitelist, off-roster deploys are refused, and the
    //      ENEMY never fields anything outside its own whitelist across a full fight.
    const ictx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ip = await ictx.newPage();
    const ierr = []; ip.on('pageerror', e => ierr.push(e.message));
    await ip.goto(BASE_URL); await ip.waitForTimeout(9000);

    const shape = await ip.evaluate(() => {
      const bad = [];
      for (const L of INDOC) {
        if (!DOCTRINES[L.doctrine]) bad.push(L.doctrine + ': unknown doctrine');
        if (!L.allow || !L.allow.length) bad.push(L.doctrine + ': empty player roster');
        if (!L.enemyAllow || !L.enemyAllow.length) bad.push(L.doctrine + ': empty enemy roster');
        for (const k of (L.allow || [])) if (!UNITS[k]) bad.push(L.doctrine + ': bad unit ' + k);
        for (const k of (L.enemyAllow || [])) if (!UNITS[k]) bad.push(L.doctrine + ': bad enemy unit ' + k);
        if (L.diff && L.diff !== 'recruit') bad.push(L.doctrine + ': difficulty above recruit (' + L.diff + ')');
        if (!L.brief || !L.lesson) bad.push(L.doctrine + ': missing brief/lesson');
        if (!WEATHERS[L.weather]) bad.push(L.doctrine + ': bad weather ' + L.weather);
      }
      const covered = Object.keys(DOCTRINES).filter(d => !INDOC.some(l => l.doctrine === d));
      return { bad, covered, n: INDOC.length, docs: Object.keys(DOCTRINES).length };
    });
    ok(shape.bad.length === 0, `[indoc] every lesson is well-formed ${shape.bad.length ? ':: ' + shape.bad.join(' | ') : ''}`);
    ok(shape.covered.length === 0, `[indoc] every doctrine has a lesson ${shape.covered.length ? ':: missing ' + shape.covered.join(',') : ''}`);
    ok(shape.n === shape.docs, `[indoc] lesson count matches doctrine count (${shape.n}/${shape.docs})`);

    // play all nine to a result
    const runs = [];
    for (const key of shape ? await ip.evaluate(() => INDOC.map(l => l.doctrine)) : []) {
      runs.push(await ip.evaluate(async (dkey) => {
        const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show');
        SAVE.seenTut = true; SAVE.unlocked = ['blitzkrieg', 'mass'];   // most lessons are rank-locked doctrines
        showTitle(); leaveTitle(); launchIndoc(dkey);
        const lesson = INDOC.find(l => l.doctrine === dkey);
        const forced = G.doc === dkey;
        const deck = [...document.querySelectorAll('#hotbar .card:not(.spawner)')].map(c => c.id.replace('card-', ''));
        const spawners = document.querySelectorAll('#hotbar .card.spawner').length;
        const tabsHidden = document.getElementById('hbtabs').style.display === 'none';
        // an off-roster unit must be refused even with unlimited CP
        const outside = HOTBAR.find(k => lesson.allow.indexOf(k) < 0 && k !== 'swarm');
        G.prep = 0; G.frozen = false; G.cp = 99999;
        const n0 = G.units.length; if (outside) tryDeploy(outside, 1);
        const offRosterBlocked = G.units.length === n0;
        const deadline = Date.now() + 9000;
        while (!G.over && Date.now() < deadline) {
          G.cp = 400;
          for (const k of lesson.allow) for (let l = 0; l < 3; l++) tryDeploy(k, l);
          for (let i = 0; i < 60; i++) step(1 / 30);
          await new Promise(r => setTimeout(r, 0));
        }
        const enemyKeys = [...new Set(G.units.filter(u => u.side === 'R').map(u => u.key))];
        return { dkey, forced, deck, want: lesson.allow.slice(), spawners, tabsHidden, offRosterBlocked,
                 enemyIllegal: enemyKeys.filter(k => lesson.enemyAllow.indexOf(k) < 0),
                 over: G.over, won: G.result === 'B', cleared: !!(SAVE.indocDone && SAVE.indocDone[dkey]),
                 leakedToBoard: (SAVE.board || []).some(e => e.kind === 'indoc'),
                 onToday: (SAVE.beatToday.items || []).some(i => i.id === 'indoc-' + dkey) };
      }, key));
    }
    const same = (a, b) => a.length === b.length && a.slice().sort().join() === b.slice().sort().join();
    ok(runs.every(r => r.forced), `[indoc] the lesson's doctrine is forced regardless of rank unlocks (${runs.filter(r => !r.forced).map(r => r.dkey).join(',') || 'all ok'})`);
    ok(runs.every(r => same(r.deck, r.want)), `[indoc] the visible deck is exactly the lesson roster ${runs.filter(r => !same(r.deck, r.want)).map(r => r.dkey + ':' + r.deck.join('/')).join(' | ')}`);
    ok(runs.every(r => r.tabsHidden && r.spawners === 0), '[indoc] category tabs and production spawners are hidden — the cut-down deck is shown as one row');
    ok(runs.every(r => r.offRosterBlocked), `[indoc] deploying a unit outside the roster is refused even with unlimited CP (${runs.filter(r => !r.offRosterBlocked).map(r => r.dkey).join(',') || 'all blocked'})`);
    ok(runs.every(r => r.enemyIllegal.length === 0),
      `[indoc] the enemy never fields a unit outside its whitelist ${runs.filter(r => r.enemyIllegal.length).map(r => r.dkey + ':' + r.enemyIllegal.join('/')).join(' | ')}`);
    ok(runs.every(r => r.over && r.won), `[indoc] every lesson is winnable and resolves (${runs.filter(r => !r.won).map(r => r.dkey).join(',') || 'all won'})`);
    ok(runs.every(r => r.cleared), '[indoc] a win marks the lesson cleared in the save');
    ok(runs.every(r => !r.leakedToBoard), '[indoc] stacked lessons never post to the leaderboard');
    ok(runs.every(r => r.onToday), '[indoc] a cleared lesson does appear on the beaten-today list');

    // normal play must be completely unaffected by the whitelist machinery
    const normal = await ip.evaluate(() => {
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; sel.doctrine = 'blitzkrieg'; start();
      return { allowed: G.allowed, enemyAllowed: G.enemyAllowed,
               tabsShown: document.getElementById('hbtabs').style.display !== 'none',
               tabs: document.querySelectorAll('#hbtabs .hbtab').length, doc: G.doc };
    });
    ok(normal.allowed === null && normal.enemyAllowed === null, '[indoc] a normal skirmish carries no roster restriction');
    ok(normal.tabsShown && normal.tabs >= 3, `[indoc] the category tab bar is back for normal play (${normal.tabs} tabs)`);
    ok(ierr.length === 0, `[indoc] zero page errors ${ierr.length ? ':: ' + ierr.join(' | ') : ''}`);
    await ictx.close();
  }

  // ══ 18. v1.17.1 — SESSION-RESET SWITCHES · DEV CODES · LAUNCH DIVIDER ══
  {
    const vctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const vp = await vctx.newPage();
    const verr = []; vp.on('pageerror', e => verr.push(e.message));
    await vp.goto(BASE_URL); await vp.waitForTimeout(9000);
    await vp.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); });

    // 18a. SESSION RESET — the switches that can strand a player must never survive a reload,
    //      and nothing a player EARNED may be touched by that reset.
    await vp.evaluate(() => {
      SAVE.chaosMode = true; SAVE.debugUnlockAll = true; SAVE.aiDebug = true;
      SAVE.lvl = 42; SAVE.dailyStreak = 9; SAVE.bestWinStreak = 5;
      SAVE.chestOwned = { cb_boar: true }; SAVE.secretDone = true; SAVE.campaignDone = 4;
      persist();
    });
    await vp.reload(); await vp.waitForTimeout(9000);
    const sess = await vp.evaluate(() => ({
      chaos: SAVE.chaosMode, unlockAll: SAVE.debugUnlockAll, aiDebug: SAVE.aiDebug,
      stored: JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'),
      lvl: SAVE.lvl, streak: SAVE.dailyStreak, best: SAVE.bestWinStreak,
      crates: Object.keys(SAVE.chestOwned).length, secret: SAVE.secretDone, camp: SAVE.campaignDone,
      keys: SESSION_RESET_KEYS,
    }));
    ok(sess.chaos === false && sess.unlockAll === false && sess.aiDebug === false,
      `[session-reset] chaos mode and the dev switches all start OFF after a reload (chaos=${sess.chaos} unlockAll=${sess.unlockAll} ai=${sess.aiDebug})`);
    ok(sess.stored.chaosMode === false,
      '[session-reset] the reset is persisted, so a second reload cannot resurrect the old value');
    ok(sess.lvl === 42 && sess.streak === 9 && sess.best === 5 && sess.crates === 1 && sess.secret === true && sess.camp === 4,
      '[session-reset] earned progress (rank, streaks, crates, secret, campaign) is untouched by the reset');
    ok(Array.isArray(sess.keys) && sess.keys.length <= 4,
      `[session-reset] the reset list stays deliberately short (${sess.keys.length} keys: ${sess.keys.join(', ')})`);

    const chaosStill = await vp.evaluate(() => {
      SAVE.lvl = 99; SAVE.chaosMode = true; persist();
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start();
      return !!G.chaos;
    });
    ok(chaosStill, '[session-reset] chaos mode still works normally once enabled within a session');

    // 18b. DEV CODES — the max code has to actually reach the late-game content it promises
    //      (that is its entire purpose: trailer capture without hours of legitimate play).
    const code = await vp.evaluate(() => {
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE)); persist();
      showTitle(); openDebugModal();
      document.getElementById('dbg-code').value = '  OmegaLambda77  ';  // padded + mixed case
      applyDevCode();
      const msgEl = document.getElementById('dbg-code-msg');
      return {
        cls: msgEl.className, html: msgEl.innerHTML,
        lvl: SAVE.lvl, maxLvl: MAX_LVL, xp: SAVE.xp,
        docs: SAVE.unlocked.length, allDocs: Object.keys(DOCTRINES).length,
        camp: SAVE.campaignDone === CAMPAIGN.length - 1,
        trials: Object.keys(SAVE.timeTrials).length === CAMPAIGN.length,
        secret: SAVE.secretUnlocked && SAVE.secretDone && SAVE.secretBadgeEarned,
        crates: Object.keys(SAVE.chestOwned).length === CHEST_COSMETICS.length,
        indoc: Object.keys(SAVE.indocDone).length === INDOC.length,
        boxCleared: document.getElementById('dbg-code').value === '',
      };
    });
    ok(code.cls === 'good', '[dev-code] the max code applies, case-insensitively and whitespace-trimmed');
    ok(code.lvl === code.maxLvl && code.xp === 0, `[dev-code] rank goes to the ceiling with xp zeroed (${code.lvl}/${code.xp})`);
    ok(code.docs === code.allDocs && code.camp && code.trials, '[dev-code] all doctrines unlocked, campaign cleared, every time trial passed');
    ok(code.secret, '[dev-code] the secret level is unlocked AND cleared — this is what gates the Drone Swarm and Rods from God');
    ok(code.crates && code.indoc, '[dev-code] full crate collection and every doctrine lesson marked cleared');
    ok(code.boxCleared, '[dev-code] the input clears after a successful apply');

    const secretKit = await vp.evaluate(() => {
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start();
      let seen = false;
      for (const t of HB_TABS) { hbTab = t.id; buildHotbar();
        if ([...document.querySelectorAll('#hotbar .card')].some(c => c.id === 'card-swarm')) seen = true; }
      return { swarm: seen, rods: SAVE.secretDone };
    });
    ok(secretKit.swarm, '[dev-code] the Drone Swarm card is actually visible in the hotbar after the max code');
    ok(secretKit.rods, '[dev-code] the Rods from God strike is available after the max code');

    const badCode = await vp.evaluate(() => {
      const before = JSON.stringify(SAVE);
      const results = [];
      for (const t of ['', 'omegalambda', 'OMEGALAMBDA78', '<img src=x onerror=alert(1)>', ' ']) {
        document.getElementById('dbg-code').value = t; applyDevCode();
        results.push(document.getElementById('dbg-code-msg').className);
      }
      return { unchanged: JSON.stringify(SAVE) === before, allRejected: results.every(r => r === 'bad'),
               html: document.getElementById('dbg-code-msg').innerHTML };
    });
    ok(badCode.unchanged, '[dev-code] an invalid or blank code never mutates the save');
    ok(badCode.allRejected, '[dev-code] every invalid code reports a clear failure');
    ok(!/<img|onerror/i.test(badCode.html), '[dev-code] typed markup is never injected into the DOM (textContent, not innerHTML)');

    const wipe = await vp.evaluate(() => {
      document.getElementById('dbg-code').value = 'resetall'; applyDevCode();
      return { lvl: SAVE.lvl, crates: Object.keys(SAVE.chestOwned).length, secret: SAVE.secretDone };
    });
    ok(wipe.lvl === 1 && wipe.crates === 0 && !wipe.secret, '[dev-code] the wipe code returns the account to brand new');

    // 18c. COMMUNITY LINK — an unset or malformed destination must disable the card, never
    //      ship a dead/unsafe button to players.
    const comm = await vp.evaluate(() => ({
      // COMMUNITY_URL is now SET (the live Discord). What matters is that whatever is set
      // passes the validator — a shipped link that fails validation would silently disable
      // the whole audience-capture path with only a console warning to show for it.
      set: COMMUNITY_URL !== '', okTrue: COMMUNITY_OK === true,
      https: /^https:\/\//.test(COMMUNITY_URL),
      host: (() => { try { return new URL(COMMUNITY_URL).hostname; } catch (e) { return null; } })(),
      hostAllowed: (() => { try { const h = new URL(COMMUNITY_URL).hostname.toLowerCase();
        return COMMUNITY_HOSTS.some(a => h === a || h.endsWith('.' + a)); } catch (e) { return false; } })(),
      rallyLive: rallyEligible(true) === true || (SAVE.rallyDone === true),  // eligible unless already dismissed
      rejects: (() => {
        // exercise the validator's logic directly against hostile-looking values
        const test = (u) => { try { const p = new URL(u); return p.protocol === 'https:' &&
          COMMUNITY_HOSTS.some(h => p.hostname.toLowerCase() === h || p.hostname.toLowerCase().endsWith('.' + h)); }
          catch (e) { return false; } };
        return { js: test('javascript:alert(1)'), data: test('data:text/html,x'),
                 http: test('http://discord.gg/abc'), evil: test('https://discord.gg.evil.com/x'),
                 good: test('https://discord.gg/abc123') };
      })(),
    }));
    ok(comm.set && comm.okTrue && comm.https,
      `[community] the shipped COMMUNITY_URL is https and passes the validator (host: ${comm.host})`);
    ok(comm.hostAllowed, `[community] the destination host is on the allowlist (${comm.host})`);
    ok(!comm.rejects.js && !comm.rejects.data && !comm.rejects.http && !comm.rejects.evil,
      '[community] the validator rejects javascript:, data:, plain http, and look-alike hosts');
    ok(comm.rejects.good, '[community] a real https discord.gg invite passes the validator');

    // 18d. PATCH NOTES — the pre/post public-beta boundary must be visible and correctly placed
    const pn = await vp.evaluate(() => {
      showTitle(); openPatchNotes();
      const body = document.getElementById('pn-body');
      const kids = [...body.children];
      const launchIdx = kids.findIndex(c => c.tagName === 'H2' && /PUBLIC BETA LAUNCH/.test(c.textContent));
      const divIdx = kids.findIndex(c => c.className === 'pn-divider');
      const marked = PATCH_NOTES.filter(p => p.launch);
      return { txt: body.textContent, launchIdx, divIdx,
               markedCount: marked.length, markedVer: marked[0] && marked[0].v,
               firstHead: body.querySelector('h2').textContent, current: GAME_VERSION };
    });
    ok(pn.markedCount === 1, `[patch-notes] exactly one release carries the launch flag (${pn.markedCount})`);
    ok(/Since public beta/.test(pn.txt) && /Before public beta/.test(pn.txt),
      '[patch-notes] both era headings render around the boundary');
    ok(pn.launchIdx >= 0 && pn.divIdx > pn.launchIdx,
      '[patch-notes] the divider sits AFTER the launch build, so post-launch entries are the ones above it');
    ok(pn.firstHead.includes(pn.current), `[patch-notes] the newest entry is the running version (${pn.current})`);
    ok(verr.length === 0, `[v1.17.1] zero page errors ${verr.length ? ':: ' + verr.join(' | ') : ''}`);
    await vctx.close();
  }

  // ══ 19. v1.17.2 — THE TUTORIAL MUST NEVER HANG ══
  {
    /* Beta funnel data: 17 players started the tutorial, 4 finished it. The cause was that
       every interactive step waited forever for one exact action, with the Skip button as the
       only escape — so a player who didn't understand the ask, or was on a phone being told to
       "press 0", simply stopped. This section exists so that can never silently return. */
    const tctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const tp = await tctx.newPage();
    const terr = []; tp.on('pageerror', e => terr.push(e.message));
    await tp.goto(BASE_URL); await tp.waitForTimeout(9000);

    const shape = await tp.evaluate(() => {
      const gated = TUT_STEPS.map((s, i) => ({ i, cond: !!s.cond, nudge: !!s.nudge, auto: !!s.auto }))
        .filter(s => s.cond);
      return { gated, missingNudge: gated.filter(s => !s.nudge).map(s => s.i),
               missingAuto: gated.filter(s => !s.auto).map(s => s.i),
               nudgeT: TUT_NUDGE_T, autoT: TUT_AUTO_T,
               keyboardOnly: TUT_STEPS.filter(s => s.cond && /press \d/i.test(s.nudge || '')).length };
    });
    ok(shape.missingNudge.length === 0,
      `[tutorial] every condition-gated step has a plain-language nudge ${shape.missingNudge.length ? ':: missing on ' + shape.missingNudge.join(',') : ''}`);
    ok(shape.missingAuto.length === 0,
      `[tutorial] every condition-gated step can perform itself for a stuck player ${shape.missingAuto.length ? ':: missing on ' + shape.missingAuto.join(',') : ''}`);
    ok(shape.autoT > shape.nudgeT && shape.autoT <= 60,
      `[tutorial] the auto-help timer follows the nudge and stays under a minute (${shape.nudgeT}s → ${shape.autoT}s)`);
    ok(shape.keyboardOnly === 0,
      '[tutorial] no nudge tells the player to press a key — a phone has no keyboard and 28% of traffic is touch');

    // park on each gated step, do NOTHING, and require it to move on
    const hangs = [];
    for (const g of shape.gated) {
      const r = await tp.evaluate(async (target) => {
        const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show');
        showTitle(); leaveTitle(); launchTutorial();
        for (let guard = 0; guard < 6000 && G.tutStep < target; guard++) {
          const s = TUT_STEPS[G.tutStep];
          if (s && s.cond && s.auto) { try { s.auto(); } catch (e) {} }
          if (s) s._t = 999;
          if (typeof NARR === 'object') NARR.speaking = false;
          tutTick(1 / 30);
        }
        if (G.tutStep !== target) return { target, landed: G.tutStep, skipped: true };
        const before = G.tutStep;
        // 90 simulated seconds of complete inactivity — three times the auto-help timer
        for (let i = 0; i < 90 * 30; i++) { if (typeof NARR === 'object') NARR.speaking = false; tutTick(1 / 30); }
        return { target, landed: before, moved: G.tutStep !== before || G.tutDone };
      }, g.i);
      if (!r.skipped && !r.moved) hangs.push(r.target);
    }
    ok(hangs.length === 0,
      `[tutorial] no condition-gated step hangs on an inactive player ${hangs.length ? ':: steps ' + hangs.join(',') + ' HANG' : '(all ' + shape.gated.length + ' self-recover)'}`);

    // and a fully passive player must actually reach the end and be counted as finishing
    const passive = await tp.evaluate(async () => {
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE)); persist();
      showTitle(); leaveTitle(); launchTutorial();
      let guard = 0;
      while (!G.tutDone && guard++ < 10 * 60 * 30) {
        if (typeof NARR === 'object') NARR.speaking = false;
        tutTick(1 / 30);
        if (!G.frozen) step(1 / 30);
      }
      return { done: G.tutDone, seen: SAVE.seenTut,
               funnelDone: !!(SAVE.funnel && SAVE.funnel['tutorial-done']),
               helped: TUT_STEPS.filter(s => s._autoed).length };
    });
    ok(passive.done, '[tutorial] a player who touches NOTHING still reaches the end of the tutorial');
    ok(passive.funnelDone, '[tutorial] that completion is counted in the funnel, so the metric reflects reality');
    ok(passive.helped > 0, `[tutorial] the auto-help actually engaged for the passive run (${passive.helped} steps)`);
    ok(terr.length === 0, `[tutorial] zero page errors ${terr.length ? ':: ' + terr.join(' | ') : ''}`);
    await tctx.close();
  }

  // ══ 20. v1.17.3 — TOPBAR SETTINGS · ITCH CORNER CLEARANCE · KILLFEED ATTRIBUTION ══
  {
    const xctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const xp = await xctx.newPage();
    const xerr = []; xp.on('pageerror', e => xerr.push(e.message));
    await xp.goto(BASE_URL); await xp.waitForTimeout(9000);
    await xp.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; persist(); });

    // 20a. killfeed must never render literal "undefined" — the original bug was DOT/burn kills
    //      crediting a synthetic {side} object with no name/glyph
    const kf = await xp.evaluate(() => {
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      spawn('B', 'flame', 1, 500); spawn('R', 'rifle', 1, 560);
      const flame = G.units.find(u => u.side === 'B' && u.key === 'flame');
      const victim = G.units.find(u => u.side === 'R' && u.key === 'rifle');
      damage(victim, 1, { side: 'B', dmgType: null, glyph: flame.glyph, name: flame.name, burnDps: 40, burnDur: 3 });
      flame.alive = false; flame.hp = 0;   // the igniting unit is gone by the time the DOT finishes the kill
      document.getElementById('killfeed').innerHTML = '';
      for (let i = 0; i < 400 && victim.alive; i++) burnTick(victim, 1 / 30);
      const attributed = document.getElementById('killfeed').innerHTML;
      document.getElementById('killfeed').innerHTML = '';
      killfeed({ side: 'R' }, { col: '#fff', glyph: '🪖', name: 'Rifleman' });  // fully bare attacker
      const bare = document.getElementById('killfeed').innerHTML;
      return { victimDied: !victim.alive, attributed, bare };
    });
    ok(kf.victimDied, '[killfeed] burn DOT setup actually finishes the kill');
    ok(!/undefined/i.test(kf.attributed) && /Flame Trooper|🔥/.test(kf.attributed),
      `[killfeed] a burn kill is attributed to the igniting unit, captured at ignition — not "undefined" — even after that unit is gone :: ${kf.attributed.replace(/\s+/g, ' ').slice(0, 160)}`);
    ok(!/undefined/i.test(kf.bare), `[killfeed] a fully bare {side} attacker (no name/glyph at all) still never renders "undefined" :: ${kf.bare.replace(/\s+/g, ' ')}`);

    // 20b. Settings is reachable mid-battle, pauses the sim, and returns to the SAME battle
    const settings = await xp.evaluate(() => {
      const hasBtn = !!document.getElementById('btn-settings');
      const killsBefore = G.kills, tBefore = G.t;
      document.getElementById('btn-settings').click();
      const open = { visible: !document.getElementById('settings').classList.contains('hidden'), paused: G.paused, gameAlive: !!G && !G.over };
      const frozen = G.kills === killsBefore && G.t === tBefore;
      document.getElementById('set-back').click();
      const closed = { hidden: document.getElementById('settings').classList.contains('hidden'),
        hudBack: !document.getElementById('hud').classList.contains('hidden'), resumed: !G.paused, gameIntact: !!G && !G.over };
      return { hasBtn, open, frozen, closed };
    });
    ok(settings.hasBtn, '[settings] a Settings button exists in the topbar');
    ok(settings.open.visible && settings.open.paused && settings.open.gameAlive,
      '[settings] opening it mid-battle shows the screen and pauses the sim without abandoning the match');
    ok(settings.frozen, '[settings] battle state does not advance while the menu is open');
    ok(settings.closed.hidden && settings.closed.hudBack && settings.closed.resumed && settings.closed.gameIntact,
      '[settings] Back resumes the SAME battle rather than dropping to the title');

    // a pre-existing deliberate pause must survive a visit to Settings, not get silently cleared
    const pausePreserve = await xp.evaluate(() => {
      togglePause();
      const before = { paused: G.paused, screenUp: !document.getElementById('pauseScreen').classList.contains('hidden') };
      document.getElementById('btn-settings').click();
      document.getElementById('set-back').click();
      const after = { paused: G.paused, screenUp: !document.getElementById('pauseScreen').classList.contains('hidden') };
      togglePause();
      return { before, after };
    });
    ok(pausePreserve.before.paused && pausePreserve.before.screenUp, '[settings] pause precondition set up correctly');
    ok(pausePreserve.after.paused && pausePreserve.after.screenUp,
      '[settings] a deliberate pause survives a Settings visit instead of being force-resumed');

    // abandoning via Menu while Settings is open must not strand it on top of the menu screen
    const stranding = await xp.evaluate(() => {
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start(); G.paused = false;
      document.getElementById('btn-settings').click();
      const wasOpen = !document.getElementById('settings').classList.contains('hidden');
      const origConfirm = window.confirm; window.confirm = () => true;
      document.getElementById('btn-menu').click();
      window.confirm = origConfirm;
      return { wasOpen, strandedOverMenu: !document.getElementById('settings').classList.contains('hidden'),
               menuVisible: !document.getElementById('menu').classList.contains('hidden') };
    });
    ok(stranding.wasOpen, '[settings] precondition — settings was open before abandoning');
    ok(!stranding.strandedOverMenu && stranding.menuVisible,
      '[settings] abandoning via Menu while Settings is open does not strand it over the menu screen');

    // Settings opened from the TITLE (no live battle) must still behave exactly as before
    const fromTitle = await xp.evaluate(() => {
      showTitle();
      document.getElementById('btn-settings').click();
      const opened = !document.getElementById('settings').classList.contains('hidden');
      document.getElementById('set-back').click();
      return { opened, backToTitle: !document.getElementById('title').classList.contains('hidden') };
    });
    ok(fromTitle.opened && fromTitle.backToTitle, '[settings] opened from the title screen, Back still returns to the title as before');

    // 20c. itch.io embed corner clearance — verified across the actual in-battle button set
    //      (Pause visible), which is the tightest real layout, at a spread of common widths
    const widths = [1280, 1366, 1420, 1421, 1440, 1499, 1500, 1536, 1920, 2560];
    const layout = [];
    for (const w of widths) {
      await xp.setViewportSize({ width: w, height: 900 });
      await xp.waitForTimeout(60);
      layout.push({ w, ...(await xp.evaluate(() => {
        const tb = document.getElementById('topbar'), menu = document.getElementById('btn-menu');
        const btns = [...tb.querySelectorAll('.tb-btn,#playtest-link')].filter(b => getComputedStyle(b).display !== 'none' && !b.classList.contains('hidden'));
        const offscreen = btns.filter(x => { const r = x.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }).length;
        return { offscreen, menuClearance: window.innerWidth - menu.getBoundingClientRect().right };
      })) });
    }
    const anyOffscreen = layout.filter(l => l.offscreen > 0);
    ok(anyOffscreen.length === 0,
      `[topbar] no button is pushed offscreen at any tested width (adding Settings did not silently break a laptop-width layout) ${anyOffscreen.length ? ':: ' + anyOffscreen.map(l => l.w + 'px:' + l.offscreen).join(', ') : ''}`);
    const wideClear = layout.filter(l => l.w >= 1500);
    ok(wideClear.every(l => l.menuClearance >= 60),
      `[topbar] every width ≥1500px reserves real clearance from the true corner for itch.io's embed overlay ${wideClear.map(l => l.w + ':' + l.menuClearance.toFixed(0)).join(', ')}`);
    const laptopClear = layout.find(l => l.w === 1366);
    ok(laptopClear && laptopClear.menuClearance > 0 && laptopClear.menuClearance < 60,
      `[topbar] common laptop widths (1366px) stay unpadded rather than fighting the itch-clearance rule for room they don't have (clearance ${laptopClear && laptopClear.menuClearance.toFixed(0)}px)`);

    ok(xerr.length === 0, `[v1.17.3] zero page errors ${xerr.length ? ':: ' + xerr.join(' | ') : ''}`);
    await xctx.close();
  }

  console.log('\n══════════ FRONTLINE COMMANDER — REGRESSION SUITE ══════════');
  out.forEach(o => console.log(o));
  console.log('═══════════════════════════════════════════════════════════');
  console.log(FAIL === 0 ? `✅ ALL ${out.length} CHECKS PASSED` : `❌ ${FAIL} of ${out.length} CHECKS FAILED`);
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
})();
