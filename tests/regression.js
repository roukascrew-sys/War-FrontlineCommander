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

  console.log('\n══════════ FRONTLINE COMMANDER — REGRESSION SUITE ══════════');
  out.forEach(o => console.log(o));
  console.log('═══════════════════════════════════════════════════════════');
  console.log(FAIL === 0 ? `✅ ALL ${out.length} CHECKS PASSED` : `❌ ${FAIL} of ${out.length} CHECKS FAILED`);
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
})();
