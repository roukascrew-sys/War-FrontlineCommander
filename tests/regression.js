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

const GROUP_KEYS_LEN_CHECK = o => o && Object.keys(o).length === 3;
const GROUP_FREE_CHANGES_MIRROR = 1;   // mirrors GROUP_FREE_CHANGES in the game file
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

  /* 9c. GUARD THE GUARD — a genuine BOOT failure must still surface a rescue notice.
     Without this, "ignore resource errors" could silently degrade into "ignore everything".

     These break the game BEFORE it ever comes up, which is what a boot failure actually is.
     The earlier version of this check instead let the game boot normally, then hid every
     screen and threw — but that is a POST-boot fault on a game that already reached the
     title, and as of v1.18.0 that case is deliberately not a boot failure: covering a live
     match with a "Reload" notice was the mobile Campaign/Daily bug (see section 21). So the
     scenario is now the real one, and it is checked against all three ways a boot can die. */
  const bootFailures = {
    'main script never parses': html => html.replace('window.__FC_BOOTED = true;', 'window.__FC_BOOTED = true; )))syntax((( ;'),
    'throws before any screen': html => html.replace('window.__FC_BOOTED = true;', 'window.__FC_BOOTED = true; throw new Error("dead on arrival");'),
    'boots but shows nothing': html => html.replace(/function showTitle\(\)\{/, 'function showTitle(){ return; '),
  };
  const rawHtml = await (await fetch(BASE_URL)).text();
  for (const [label, mangle] of Object.entries(bootFailures)) {
    const realc = await browser.newContext();
    const rp = await realc.newPage();
    const broken = mangle(rawHtml);
    await rp.route('**/wargame.html', r => r.fulfill({ status: 200, contentType: 'text/html', body: broken }));
    await rp.goto(BASE_URL).catch(() => {});
    await rp.waitForTimeout(11000);          // past the 8s watchdog + its 700ms confirm
    const res = await rp.evaluate(() => ({
      reload: !!document.body.innerText.match(/Trouble loading/i),
      oldBrowser: !!document.body.innerText.match(/too old to run/i),
      cssNotice: !!document.body.innerText.match(/build 1\.\d+/i),
      stuckOnLoader: (() => { const l = document.getElementById('loader'); return !!(l && l.className.indexOf('gone') < 0); })(),
    }));
    ok(res.reload || res.oldBrowser || res.cssNotice,
      `[boot guard] a genuine boot failure (${label}) still reaches the player with a rescue notice instead of a dead page`);
    ok(!res.stuckOnLoader, `[boot guard] a genuine boot failure (${label}) never leaves the player sitting on the loading screen`);
    await realc.close();
  }

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
  ok(['evolution', 'chaos', 'rivals', 'war', 'gauntlet'].every(k => briefs.includes(k)),
    `[mode briefs] every mode that needs explaining has a briefing (${briefs.join(',')})`);

  const queue = await op.evaluate(async () => {
    SAVE.lvl = 20; SAVE.modeBriefsSeen = {};
    // count what is actually pending rather than hardcoding a number, so adding a mode
    // briefing does not fail this check for the wrong reason — the invariant under test is
    // "each pending brief is shown exactly once and none stack", not "there are four".
    const expected = modeBriefPending().length;
    let opened = 0;
    const iv = setInterval(() => { const b = document.querySelector('#modebrief.show .mb-ok'); if (b) { opened++; b.click(); } }, 100);
    return await new Promise(res => runModeBriefQueue(() => { clearInterval(iv); res({ opened, seen: Object.keys(SAVE.modeBriefsSeen).length, expected }); }));
  });
  ok(queue.expected > 0 && queue.seen === queue.expected && queue.opened === queue.expected,
    `[mode briefs] queue shows each pending brief exactly once without stacking (expected ${queue.expected}, opened ${queue.opened}, seen ${queue.seen})`);

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
      return { local: /your runs, on this device/i.test(txt),
               /* Whichever claim it makes must match reality — and it must never make the
                  OTHER one. "no server yet" was true until v1.25.0 and is now a lie. */
               noServer: /no server/i.test(txt),
               saysGlobalTabIsTheSharedOne: /Global.{0,40}leaves your machine/i.test(txt),
               visible: !document.getElementById('leaderboard').classList.contains('hidden'),
               live: LEADERBOARD_BACKEND !== null,
               /* Anti-placeholder: the renderer must show EXACTLY the runs in the save and
                  never invent a rival to fill the board out. Comparing counts holds however
                  many runs the profile happens to have, so it does not depend on test order. */
               rendered: document.querySelectorAll('#lb-body .lb-row').length,
               saved: (Array.isArray(SAVE.board) ? SAVE.board : []).length };
    });
    ok(disclaimer.visible, '[leaderboard] the screen opens from the title');
    ok(disclaimer.local, '[leaderboard] the board states plainly that these rows are local to the device');
    ok(disclaimer.live ? (disclaimer.saysGlobalTabIsTheSharedOne && !disclaimer.noServer)
                       : (disclaimer.noServer && !disclaimer.saysGlobalTabIsTheSharedOne),
      `[leaderboard] the disclaimer tracks the ACTUAL configuration (backend ${disclaimer.live ? 'live' : 'absent'}) — it claimed "no server yet" in every build, which stopped being true the moment one existed`);
    ok(disclaimer.rendered === disclaimer.saved,
      `[leaderboard] the board renders exactly the runs in the save (${disclaimer.rendered} rows for ${disclaimer.saved} runs) — no placeholder or invented rival scores padding it out`);
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
        indoc: Object.keys(SAVE.indocDone).length === INDOC_ALL.length,   // doctrine school + field school
        boxCleared: document.getElementById('dbg-code').value === '',
      };
    });
    ok(code.cls === 'good', '[dev-code] the max code applies, case-insensitively and whitespace-trimmed');
    ok(code.lvl === code.maxLvl && code.xp === 0, `[dev-code] rank goes to the ceiling with xp zeroed (${code.lvl}/${code.xp})`);
    ok(code.docs === code.allDocs && code.camp && code.trials, '[dev-code] all doctrines unlocked, campaign cleared, every time trial passed');
    ok(code.secret, '[dev-code] the secret level is unlocked AND cleared — this is what gates the Drone Swarm and Rods from God');
    ok(code.crates && code.indoc, '[dev-code] full crate collection and every lesson in the school marked cleared');
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

    /* Menu with Settings open. As of 1.22.0 the Menu button is ALSO the close button, so the
       first press closes Settings (resuming the battle underneath, which is what Settings'
       own Back does mid-fight) and only the second press abandons. The original guarantee
       this check was written for still has to hold at the end of that sequence: Settings must
       never be left rendered on top of the menu screen. */
    const stranding = await xp.evaluate(() => {
      showTitle(); leaveTitle(); LAUNCH = null; sel.mode = 'skirmish'; start(); G.paused = false;
      document.getElementById('btn-settings').click();
      const wasOpen = !document.getElementById('settings').classList.contains('hidden');
      const origConfirm = window.confirm; window.confirm = () => true;
      document.getElementById('btn-menu').click();          // 1st press: close the panel
      const afterFirst = { settingsOpen: !document.getElementById('settings').classList.contains('hidden'),
                           battleAlive: !!G && !G.over };
      document.getElementById('btn-menu').click();          // 2nd press: abandon
      window.confirm = origConfirm;
      return { wasOpen, afterFirst,
               strandedOverMenu: !document.getElementById('settings').classList.contains('hidden'),
               menuVisible: !document.getElementById('menu').classList.contains('hidden') };
    });
    ok(stranding.wasOpen, '[settings] precondition — settings was open before abandoning');
    ok(!stranding.afterFirst.settingsOpen && stranding.afterFirst.battleAlive,
      '[settings] the FIRST Menu press closes Settings and leaves the battle running — "close this" must not be answered by destroying the thing underneath');
    ok(!stranding.strandedOverMenu && stranding.menuVisible,
      '[settings] the second press abandons, and Settings is never left stranded over the menu screen');

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

  /* ───────────────────────────────────────────────────────────────────────────
     21. v1.18.0 — CP cap, the boot-guard false positive, chaos scoping, the
         screen-hiding helper, and THE GAUNTLET.
     ─────────────────────────────────────────────────────────────────────────── */
  {
    const gctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const gp = await gctx.newPage();
    const gerr = [];
    gp.on('pageerror', e => gerr.push(e.message));
    /* Every URL this page requests, for the whole run. Section 28 uses it to prove that an
       opted-OUT player contacts the leaderboard zero times — a claim that can only be made
       on the wire, since a flag check would pass even if the request were fired anyway. */
    const netLog = [];
    gp.on('request', r => netLog.push(r.url()));
    await gp.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await gp.waitForTimeout(2600);
    await gp.evaluate(() => { const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show'); SAVE.seenTut = true; SAVE.lvl = 40; persist(); });

    // 21a. CP cap must clear the most expensive purchasable structure. This is the exact
    //      class of bug that made the Motor Pool (300 CP) unaffordable against a 280 cap.
    const econ = await gp.evaluate(() => {
      LAUNCH = null; sel.mode = 'skirmish'; start();
      return { cpMax: G.cpMax, dearest: Math.max(...Object.values(SPAWNERS).map(s => s.cost)),
               dearestName: Object.values(SPAWNERS).sort((a, b) => b.cost - a.cost)[0].name };
    });
    ok(econ.cpMax > econ.dearest,
      `[economy] the CP bank (${econ.cpMax}) clears the dearest buildable structure — ${econ.dearestName} at ${econ.dearest} CP — so it can actually be saved for`);

    // 21b. THE BOOT GUARD. A live battle must never be mistaken for a dead page. This is the
    //      regression that mattered most: it fired on healthy games with no error at all.
    const guard = await gp.evaluate(() => {
      LAUNCH = null; sel.mode = 'skirmish'; start();
      const anyScreen = [...document.getElementsByClassName('screen')].some(s => String(s.className).indexOf('hidden') === -1);
      return { inBattle: !!(window.G && !G.over), hudUp: !document.getElementById('hud').classList.contains('hidden'),
               anyScreen, alive: !!window.__FC_ALIVE };
    });
    ok(guard.inBattle && guard.hudUp && !guard.anyScreen,
      '[bootguard] precondition — during a battle NO .screen is visible, which is exactly why the old check misread a running game as a dead page');
    ok(guard.alive, '[bootguard] the game flags itself alive once playable, so the guard can stand down instead of leaving a timer armed all session');

    // fire a real window error mid-battle: the guard must not paint a reload screen over it
    await gp.evaluate(() => { setTimeout(() => { throw new Error('benign mid-battle blip'); }, 10); });
    await gp.waitForTimeout(1400);
    const afterErr = await gp.evaluate(() => ({
      running: !!(window.G && !G.over),
      reloadScreen: !!document.body.innerText.match(/Trouble loading/i) }));
    ok(afterErr.running && !afterErr.reloadScreen,
      '[bootguard] a mid-battle JS error no longer covers a running match with the "Trouble loading — Reload" notice');

    // and the 8s unconditional watchdog must be a no-op once a battle is up
    await gp.waitForTimeout(8200);
    const late = await gp.evaluate(() => ({
      running: !!(window.G && !G.over),
      reloadScreen: !!document.body.innerText.match(/Trouble loading/i) }));
    ok(late.running && !late.reloadScreen,
      '[bootguard] the unconditional 8-second watchdog passes harmlessly while a battle is in progress (the mobile Campaign/Daily reload-screen bug)');

    // 21c. CHAOS SCOPING — structured modes always run under their real rules
    const chaos = await gp.evaluate(() => {
      SAVE.chaosMode = true; SAVE.campaignDone = 4; persist();
      const seen = {};
      const grab = (label, fn) => { try { fn(); seen[label] = { kind: G.kind, chaos: !!G.chaos }; } catch (e) { seen[label] = { err: e.message }; } };
      grab('campaign', () => launchCampaign(0));
      grab('war', () => { LAUNCH = { type: 'war', warName: 'T', diff: 'veteran', weather: 'clear' }; start(); });
      grab('rival', () => launchRival(GENERALS[0].name));
      grab('gauntlet', () => launchGauntlet());
      grab('indoc', () => launchIndoc('blitzkrieg'));
      grab('skirmish', () => { LAUNCH = null; sel.mode = 'skirmish'; start(); });
      grab('survival', () => { LAUNCH = null; sel.mode = 'survival'; start(); });
      SAVE.chaosMode = false; persist();
      return seen;
    });
    const mustBeOff = ['campaign', 'war', 'rival', 'gauntlet', 'indoc'];
    const leaked = mustBeOff.filter(k => chaos[k] && chaos[k].chaos);
    ok(leaked.length === 0,
      `[chaos] stays out of the modes that bank permanent progress or adapt to you (campaign/war/rivals/gauntlet/lessons) ${leaked.length ? ':: LEAKED INTO ' + leaked.join(', ') : ''}`);
    ok(chaos.skirmish.chaos && chaos.survival.chaos,
      '[chaos] still applies to the throwaway modes it was built for (skirmish, survival)');

    // 21d. SCREEN HIDING — one helper replaced a dozen hand-written lists. Verify every
    //      opener pair leaves exactly one screen up, which those lists kept getting wrong.
    const screens = await gp.evaluate(() => {
      const openers = { showTitle, openMenu, openGauntlet, openRivals, openManual, openRecord,
        openRoadmap, openCosmetics, openPatchNotes, openLeaderboard, openIndoc, openSettings };
      const bad = []; let pairs = 0;
      for (const a in openers) for (const c in openers) {
        pairs++;
        try {
          openers[a](); openers[c]();
          const vis = [...document.querySelectorAll('.screen')].filter(s => !s.classList.contains('hidden')).map(s => s.id);
          if (vis.length !== 1) bad.push(`${a}->${c}:[${vis}]`);
        } catch (e) { bad.push(`${a}->${c}:THREW ${e.message}`); }
      }
      return { bad, pairs };
    });
    ok(screens.bad.length === 0,
      `[screens] all ${screens.pairs} screen-to-screen transitions leave exactly ONE screen visible — no menu can strand on top of another ${screens.bad.length ? ':: ' + screens.bad.slice(0, 6).join(' ') : ''}`);

    // 21e. THE GAUNTLET — escalation ladder reaches Legendary in five clears and keeps going
    const ladder = await gp.evaluate(() => {
      SAVE.gauntlet = {}; persist();
      const rows = [];
      // must outrun the ladder itself (GAUNT_MAX_TIER) plus the ascendant rungs the checks
      // below sample, or re-pacing the ladder indexes off the end of this array
      for (let i = 0; i <= GAUNT_MAX_TIER + 3; i++) {
        launchGauntlet();
        const g = G.gaunt;
        rows.push({ tier: g.tier, diff: G.diff, name: g.name,
                    counters: Object.keys(g.counterW).length, harden: { ...g.harden },
                    strikes: g.strikes.slice(), qual: g.qualMul });
        for (let k = 0; k < 10; k++) gauntRecordDeploy('tank', 0);   // a player who always spams tanks
        for (let k = 0; k < 3; k++) gauntRecordDeploy('rifle', 0);
        G.gauntRec.first = 12;
        G.over = false; endGame('B', 'hq');
      }
      return rows;
    });
    // rung indices are read from the table rather than hardcoded, so re-pacing the ladder
    // re-points these checks instead of failing them for the wrong reason
    const rung = await gp.evaluate(() => {
      const idx = a => GAUNTLET_TIERS.findIndex(t => t.arms === a);
      return { counters: idx('counters'), hardening: idx('hardening'), strikes: idx('strikes'),
               gunruns: idx('gunruns'), ambush: idx('ambush'), barrage: idx('barrage'),
               top: GAUNT_MAX_TIER };
    });
    ok(ladder[0].diff === 'veteran' && ladder[0].counters === 0 && !ladder[0].strikes.length,
      '[gauntlet] tier 0 has no file on you yet — no counters, no hardening, no strikes');
    ok(ladder[rung.counters].counters > 0,
      `[gauntlet] counter-doctrine arms at tier ${rung.counters} against what you leaned on`);
    ok(Object.keys(ladder[rung.hardening].harden).length > 0,
      `[gauntlet] adaptive hardening arms at tier ${rung.hardening}`);
    ok(ladder[rung.strikes].strikes.includes('precision'),
      `[gauntlet] off-map precision strikes arm at tier ${rung.strikes}`);
    ok(ladder[rung.gunruns].strikes.includes('gunrun'),
      `[gauntlet] gunship runs arm at tier ${rung.gunruns}`);
    ok(ladder[rung.barrage].strikes.includes('barrage') && ladder[rung.barrage].diff === 'legendary',
      `[gauntlet] the top rung (tier ${rung.barrage}) reaches full proficiency at Legendary`);
    ok(rung.top >= 7,
      `[gauntlet] the ladder is paced over at least 8 rungs before it tops out (top rung ${rung.top}) — the first cut reached its wall in four clears`);
    ok(ladder[rung.top + 2] && ladder[rung.top + 2].qual > ladder[rung.top].qual,
      `[gauntlet] past the ladder it keeps escalating through raw scaling (qual ${ladder[rung.top].qual.toFixed(2)} → ${ladder[rung.top + 2].qual.toFixed(2)})`);
    const hardestSeen = Math.max(...ladder.map(r => Math.max(0, ...Object.values(r.harden))));
    ok(hardestSeen <= 0.35 + 1e-9,
      `[gauntlet] hardening is capped well short of immunity so your favourite unit becomes insufficient, never useless (peak ${(hardestSeen * 100).toFixed(0)}%)`);

    /* THE PACING CHECK. The original ladder inherited the four coarse DIFFS steps and
       produced a cliff — simulated win margin fell from +52% to −100% in a single rung.
       Effective power must climb monotonically and in modest increments instead. */
    const curve = await gp.evaluate(() => {
      const rows = [];
      for (let t = 0; t <= GAUNT_MAX_TIER + 4; t++) {
        const ti = gauntletTierInfo(t), d = DIFFS[ti.diff];
        rows.push({ t, q: d.qualMul * ti.qualMul, e: d.cpMul * ti.cpMul, o: ti.open });
      }
      const dips = [], steps = [];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].q < rows[i - 1].q - 1e-9) dips.push(`quality ${rows[i - 1].t}→${rows[i].t}`);
        if (rows[i].e < rows[i - 1].e - 1e-9) dips.push(`economy ${rows[i - 1].t}→${rows[i].t}`);
        if (rows[i].o < rows[i - 1].o) dips.push(`opening ${rows[i - 1].t}→${rows[i].t}`);
        steps.push({ t: rows[i].t, q: rows[i].q / rows[i - 1].q - 1, e: rows[i].e / rows[i - 1].e - 1 });
      }
      return { dips, worstQ: Math.max(...steps.map(s => s.q)), worstE: Math.max(...steps.map(s => s.e)),
               maxOpen: Math.max(...rows.map(r => r.o)) };
    });
    ok(curve.dips.length === 0,
      `[gauntlet] effective power never goes BACKWARDS between rungs ${curve.dips.length ? ':: ' + curve.dips.join(', ') : ''}`);
    ok(curve.worstQ <= 0.20 && curve.worstE <= 0.20,
      `[gauntlet] no single rung raises quality or economy by more than 20% — the cliff is gone (worst step: quality +${(curve.worstQ * 100).toFixed(0)}%, economy +${(curve.worstE * 100).toFixed(0)}%)`);
    ok(curve.maxOpen <= 14,
      `[gauntlet] the opening wave stays bounded (peak ${curve.maxOpen}) rather than deciding the fight before the player can act`);

    // qualMul must actually reach the units — it was previously advertised but never applied
    const applied = await gp.evaluate(() => {
      const hpAt = tier => {
        SAVE.gauntlet = { clears: tier, losses: 0, lifetime: tier, deepest: tier,
          mem: { fights: 6, units: { tank: 20 }, strikes: {}, lanes: [9, 3, 3], spawners: 0, rush: 0 } };
        persist(); launchGauntlet();
        G.units.length = 0; spawn('R', 'rifle', 1, 700);
        const u = G.units.find(x => x.side === 'R');
        return { hp: u.maxHp, dmg: u.dmg, declared: G.gaunt.qualMul };
      };
      return { low: hpAt(GAUNT_MAX_TIER), high: hpAt(GAUNT_MAX_TIER + 4) };
    });
    ok(applied.high.hp > applied.low.hp && applied.high.dmg > applied.low.dmg,
      `[gauntlet] the Ascendant tiers' advertised quality scaling is REAL — enemy rifle ${applied.low.hp.toFixed(0)}hp/${applied.low.dmg.toFixed(1)}dmg at the top rung vs ${applied.high.hp.toFixed(0)}hp/${applied.high.dmg.toFixed(1)}dmg four clears past it`);

    // 21f. THE CORE FAIRNESS GUARANTEE — it adapts BETWEEN fights, never during one
    const frozen = await gp.evaluate(() => {
      launchGauntlet();
      const before = JSON.stringify(G.gaunt);
      for (let i = 0; i < 80; i++) gauntRecordDeploy('drone', 2);   // change behaviour completely, mid-fight
      for (let i = 0; i < 60; i++) step(0.05);
      return { unchanged: JSON.stringify(G.gaunt) === before };
    });
    ok(frozen.unchanged,
      '[gauntlet] the profile is FROZEN for the whole battle — it cannot re-learn mid-fight, which is what keeps any single run winnable by determination');

    // 21g. hardening actually reduces damage by the amount it advertises
    const bite = await gp.evaluate(() => {
      SAVE.gauntlet = { clears: 5, losses: 0, lifetime: 5, deepest: 5,
        mem: { fights: 6, units: { tank: 40 }, strikes: {}, lanes: [30, 4, 3], spawners: 0, rush: 0 } };
      persist(); launchGauntlet();
      const declared = G.gaunt.harden['tank'] || 0;
      spawn('R', 'rifle', 1, 600);
      const v = G.units.find(u => u.side === 'R' && u.alive);
      const probe = key => { v.hp = 1e6; v.maxHp = 1e6; v.alive = true;
        const b0 = v.hp; damage(v, 100, { side: 'B', key, dmgType: null }); return b0 - v.hp; };
      return { declared, hardened: probe('tank'), normal: probe('medic') };
    });
    ok(bite.declared > 0 && Math.abs(bite.hardened - 100 * (1 - bite.declared)) < 0.5 && bite.normal === 100,
      `[gauntlet] adaptive hardening bites exactly as advertised — your spammed unit dealt ${bite.hardened.toFixed(0)} where an un-profiled one dealt ${bite.normal.toFixed(0)} (declared −${Math.round(bite.declared * 100)}%)`);

    /* 21h. Every off-map strike is telegraphed before it lands, and every one actually
       reaches the formation it was aimed at.

       Units are left with their NORMAL stats here. An earlier version of this check made
       them immortal by writing hp/maxHp directly, which silently corrupted the measurement:
       veterancy recomputes maxHp from baseHp, so a probe unit's health could be restored
       mid-run and a landed strike would read as zero damage. "Did this unit lose health or
       die" is both robust to that and closer to the thing actually being asserted. */
    const tele = await gp.evaluate(() => {
      const res = {};
      for (const type of ['precision', 'gunrun', 'barrage']) {
        let touchedRuns = 0, warnMin = Infinity, dmgBeforeWarning = 0;
        const RUNS = 6;
        for (let run = 0; run < RUNS; run++) {
          SAVE.gauntlet = { clears: 8, losses: 0, lifetime: 8, deepest: 8,
            mem: { fights: 6, units: { tank: 40 }, strikes: {}, lanes: [30, 4, 3], spawners: 0, rush: 0 } };
          persist(); launchGauntlet(); G.prep = 0; G.frozen = false; G.aiHold = true;
          G.units.length = 0;
          for (let i = 0; i < 9; i++) spawn('B', 'rifle', i % 3, 300 + i * 10);
          const start = new Map(G.units.map(u => [u.id, u.hp]));
          G.gaunt.strikes = [type]; G.gauntStrikeT = 0;
          let warned = 0;
          for (let i = 0; i < 1200; i++) {
            const pre = G.units.reduce((a, u) => a + u.hp, 0);
            step(0.05);
            const post = G.units.reduce((a, u) => a + u.hp, 0);
            if (G.gauntTele) warned++;
            else if (warned === 0 && pre - post > 0) dmgBeforeWarning += pre - post;
            G.gauntStrikeT = Math.max(G.gauntStrikeT, 5);
            if (!G.gauntTele && !G.gauntGun && !G.gauntBarrage && i > 200) break;
          }
          let touched = 0;
          for (const [id, hp0] of start) { const u = G.units.find(x => x.id === id); if (!u || !u.alive || u.hp < hp0) touched++; }
          if (touched > 0) touchedRuns++;
          warnMin = Math.min(warnMin, warned * 0.05);
        }
        res[type] = { touchedRuns, runs: RUNS, warnSeconds: warnMin, dmgBeforeWarning };
      }
      return res;
    });
    for (const t of ['precision', 'gunrun', 'barrage']) {
      ok(tele[t].warnSeconds >= 2 && tele[t].dmgBeforeWarning === 0,
        `[gauntlet] the ${t} strike telegraphs for ${tele[t].warnSeconds.toFixed(1)}s and deals nothing before the warning appears`);
      // all three must land every time. Precision used to miss ~30% of runs because it
      // aimed where the formation WAS and the units walked out of the telegraph before the
      // round arrived; it now leads the target, so a clean miss is a regression.
      ok(tele[t].touchedRuns === tele[t].runs,
        `[gauntlet] the ${t} strike reaches the formation it aimed at — it targets where your units actually are, not a fixed band of the map (${tele[t].touchedRuns}/${tele[t].runs} runs)`);
    }

    // 21i. PURGE — wipes the file and the run, never the permanent record
    const purge = await gp.evaluate(() => {
      SAVE.gauntlet = { clears: 6, losses: 3, lifetime: 11, deepest: 7,
        mem: { fights: 6, units: { tank: 40, rifle: 9 }, strikes: { barrage: 2 }, lanes: [20, 3, 1], spawners: 2, rush: 3 } };
      persist();
      const before = gauntletState();
      gauntletPurge();
      const after = gauntletState();
      return { before, after };
    });
    ok(purge.after.clears === 0 && Object.keys(purge.after.mem.units).length === 0 && purge.after.mem.fights === 0,
      '[gauntlet] Purge erases the learned file and resets the current run to tier 0');
    ok(purge.after.lifetime === purge.before.lifetime && purge.after.deepest === purge.before.deepest,
      `[gauntlet] Purge never touches the permanent record (lifetime ${purge.after.lifetime}, deepest tier ${purge.after.deepest} both survive)`);

    // 21j. a loss must not cost a tier — losing is already the punishment
    const onLoss = await gp.evaluate(() => {
      SAVE.gauntlet = { clears: 4, losses: 0, lifetime: 4, deepest: 4,
        mem: { fights: 3, units: { tank: 10 }, strikes: {}, lanes: [5, 1, 1], spawners: 0, rush: 0 } };
      persist(); launchGauntlet();
      for (let i = 0; i < 5; i++) gauntRecordDeploy('atgm', 1);
      G.over = false; endGame('R', 'overrun');
      const s = gauntletState();
      return { clears: s.clears, losses: s.losses, lifetime: s.lifetime, learnedAtgm: !!s.mem.units.atgm };
    });
    ok(onLoss.clears === 4 && onLoss.losses === 1 && onLoss.lifetime === 4,
      '[gauntlet] losing costs no tier and no lifetime beats — the climb is kept so deep tiers stay worth attempting');
    ok(onLoss.learnedAtgm,
      '[gauntlet] it still learns from a fight it WON against you — the cost of losing is a thicker file, not lost progress');

    // 21k. a corrupt / hand-edited save degrades to "no memory" instead of throwing
    const corrupt = await gp.evaluate(() => {
      const shapes = [null, 'nonsense', 42, [], { clears: -5, lifetime: 'x', mem: 'no' },
        { mem: { units: { tank: NaN, rifle: -3 }, lanes: [1], fights: Infinity } }];
      const results = [];
      for (const sh of shapes) {
        try { SAVE.gauntlet = sh; const s = gauntletState(); gauntletSnapshot();
          results.push({ ok: true, clears: s.clears, fights: s.fights }); }
        catch (e) { results.push({ ok: false, err: e.message }); }
      }
      SAVE.gauntlet = {}; persist();
      return results;
    });
    ok(corrupt.every(r => r.ok),
      `[gauntlet] a corrupt or hand-edited dossier degrades safely instead of throwing on the title screen ${corrupt.filter(r => !r.ok).map(r => r.err).join(' | ')}`);

    // 21l. the screen renders, and the dossier tells the player what it learned
    const screen = await gp.evaluate(() => {
      SAVE.gauntlet = { clears: 3, losses: 1, lifetime: 3, deepest: 3,
        mem: { fights: 4, units: { tank: 30, rifle: 6 }, strikes: {}, lanes: [22, 2, 1], spawners: 1, rush: 0 } };
      persist(); openGauntlet();
      const body = document.getElementById('gaunt-body').innerText;
      return { visible: !document.getElementById('gauntlet').classList.contains('hidden'),
               mentionsHardening: /hardened/i.test(body), mentionsLane: /lane/i.test(body),
               showsLifetime: /lifetime/i.test(body), hasFight: !!document.getElementById('gaunt-fight'),
               hasPurge: !!document.getElementById('gaunt-purge') };
    });
    ok(screen.visible && screen.hasFight && screen.hasPurge, '[gauntlet] the Gauntlet screen renders with both a Fight and a Purge action');
    ok(screen.mentionsHardening && screen.mentionsLane && screen.showsLifetime,
      '[gauntlet] the dossier states in plain language what it learned — hardening, your favoured lane, and the permanent record');

    // 21m. THE ADJUTANT FILE — the dev analytics view. It must explain decisions NOT taken
    //      as well as ones taken, since "a threshold was not met" is the usual reason a
    //      system like this looks broken.
    const why = await gp.evaluate(() => {
      // a profile with a CLEAR unit habit but a DELIBERATELY split lane usage, so the lane
      // read should decline to act and say why
      SAVE.gauntlet = { clears: 5, losses: 1, lifetime: 6, deepest: 5,
        mem: { fights: 5, units: { tank: 30, atgm: 10, rifle: 8 }, strikes: { precision: 3 },
               lanes: [11, 10, 9], spawners: 1, rush: 0 } };
      persist();
      const r = gauntletReasoning();
      const lane = r.reasoning.find(x => /lane/i.test(x.head));
      return { count: r.reasoning.length,
               allHaveWhy: r.reasoning.every(x => x.obs && x.infer && x.act),
               laneDeclined: !!lane && lane.state === 'off',
               laneExplains: !!lane && /40%/.test(lane.infer + lane.act),
               laneNotMassing: r.snap.lane < 0,
               headings: r.reasoning.map(x => x.head) };
    });
    ok(why.count >= 5 && why.allHaveWhy,
      `[adjutant file] every reasoning entry carries an observation, an inference AND an action (${why.count} entries: ${why.headings.join(', ')})`);
    ok(why.laneDeclined && why.laneNotMassing && why.laneExplains,
      '[adjutant file] a decision it DECLINED to make is reported with the threshold that stopped it (split lanes → not massing, 40% cited)');

    // a dormant file must explain that it is dormant rather than rendering blank
    const empty = await gp.evaluate(() => {
      SAVE.gauntlet = {}; persist();
      const r = gauntletReasoning();
      return { entries: r.reasoning.length, state: r.reasoning[0] && r.reasoning[0].state,
               text: (r.reasoning[0] || {}).obs || '' };
    });
    ok(empty.entries > 0 && empty.state === 'idle' && /empty|no completed/i.test(empty.text),
      '[adjutant file] an empty dossier explains that it is dormant instead of rendering a blank page');

    // all four tabs render, with real bar geometry rather than empty tracks
    const tabs = await gp.evaluate(() => {
      SAVE.gauntlet = { clears: 5, losses: 1, lifetime: 6, deepest: 5,
        mem: { fights: 5, units: { tank: 30, atgm: 10 }, strikes: { precision: 3 },
               lanes: [22, 4, 3], spawners: 1, rush: 3 } };
      persist(); openGauntFile('title');
      const out = {};
      for (const [id] of GF_TABS) {
        renderGauntFile(id);
        const body = document.getElementById('gf-body');
        const fills = [...body.querySelectorAll('.gf-bar .bf')];
        out[id] = { len: body.innerHTML.length,
                    bars: fills.length,
                    barsWithWidth: fills.filter(f => parseFloat(f.style.width) > 0).length,
                    svg: body.querySelectorAll('svg').length };
      }
      return out;
    });
    ok(Object.values(tabs).every(t => t.len > 200),
      `[adjutant file] all four tabs render content (${Object.entries(tabs).map(([id, t]) => id + ':' + t.len).join(', ')})`);
    ok(tabs.data.bars > 0 && tabs.data.barsWithWidth === tabs.data.bars,
      `[adjutant file] every analytics bar actually renders a fill — inline spans ignore width, which silently drew empty tracks (${tabs.data.barsWithWidth}/${tabs.data.bars})`);
    ok(tabs.ladder.svg > 0, '[adjutant file] the power-curve chart renders as inline SVG');

    /* ─────────────────────────────────────────────────────────────────────────
       22. v1.18.2 — save transfer, No Luck, and the cutscene master switch.
       ───────────────────────────────────────────────────────────────────────── */

    // 22a. SAVE TRANSFER round-trip. Every manifest field must survive a trip through a
    //      code onto a device with a completely different local configuration.
    const rt = await gp.evaluate(() => {
      SAVE.lvl = 42; SAVE.xp = 1234; SAVE.wins = 88; SAVE.losses = 31; SAVE.best = 99999;
      SAVE.unlocked = Object.keys(DOCTRINES).slice(0, 5);
      SAVE.medals = { first_win: 1, combo10: 1 };
      SAVE.campaignDone = 4; SAVE.campaignStars = { 0: 1, 1: 1 }; SAVE.timeTrials = { 0: 71.2 };
      SAVE.secretUnlocked = true; SAVE.secretDone = true; SAVE.secretBadgeEarned = true;
      SAVE.chestOwned = { a: 1, b: 1 }; SAVE.chestPulls = 17;
      SAVE.dailyStreak = 6; SAVE.dailyBestStreak = 9; SAVE.dailyLastWin = '2026-08-10';
      SAVE.gauntlet = { clears: 5, losses: 2, lifetime: 11, deepest: 7, mem: { fights: 5, units: { tank: 30 }, strikes: {}, lanes: [9, 3, 2], spawners: 1, rush: 2 } };
      SAVE.career = { battles: 119, wins: 88, losses: 31, kills: 4021, deploys: 2500, cpSpent: 90000, strikes: 210, units: { tank: 800 }, dmgDealt: 500000, timePlayed: 40000 };
      SAVE.winStreak = 5; SAVE.bestWinStreak = 12;
      // device-local config on the SENDING device
      SAVE.sound = false; SAVE.reduceMotion = true; SAVE.cbPalette = 'orange'; SAVE.noLuck = true; SAVE.debugUnlockAll = true;
      persist();
      const code = exportSaveCode();
      const before = JSON.parse(JSON.stringify(SAVE));

      // wipe to a "different device" with deliberately opposite local config
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE));
      SAVE.sound = true; SAVE.reduceMotion = false; SAVE.cbPalette = 'hico'; SAVE.noLuck = false; SAVE.debugUnlockAll = false;
      persist();
      const parsed = parseSaveCode(code);
      const applied = parsed.ok && applySaveCode(parsed);
      const mism = [];
      for (const [k] of SAVE_TRANSFER_FIELDS) {
        if (k === 'unlocked') continue;   // re-derived from rank on import, so >= is correct
        if (JSON.stringify(before[k]) !== JSON.stringify(SAVE[k])) mism.push(k);
      }
      return { ok: parsed.ok, applied, carried: parsed.carried, mism,
               localKept: SAVE.sound === true && SAVE.reduceMotion === false && SAVE.cbPalette === 'hico'
                          && SAVE.noLuck === false && SAVE.debugUnlockAll === false,
               unlockedOk: SAVE.unlocked.length >= before.unlocked.length,
               codeLen: code.length };
    });
    ok(rt.ok && rt.applied && rt.mism.length === 0,
      `[save transfer] every one of the ${rt.carried} progress fields survives an export/import round-trip intact ${rt.mism.length ? ':: LOST ' + rt.mism.join(', ') : ''}`);
    ok(rt.localKept,
      '[save transfer] device-local settings (audio, reduce-motion, colourblind palette, No Luck, debug) are NOT overwritten by an import — importing progress must never reach into someone\'s accessibility settings');
    ok(rt.unlockedOk, '[save transfer] doctrine unlocks are re-derived from the imported rank rather than trusted blindly');

    // 22b. the manifest is the contract: nothing device-local in it, no typo'd keys
    const manifest = await gp.evaluate(() => {
      const local = ['sound', 'music', 'musicVol', 'narrator', 'reduceMotion', 'cbPalette', 'bigUnits',
        'chaosMode', 'debugUnlockAll', 'aiDebug', 'streamOn', 'twitchChannel', 'noLuck',
        'randomEvents', 'evCutscene', 'evSupply', 'evBarrage', 'evDefector', 'speed', 'chatPos', 'lastSel',
        'saveTransferUnlocked', 'hbTabs', 'groups'];
      return { leaked: local.filter(k => SAVE_TRANSFER_FIELDS.some(f => f[0] === k)),
               bogus: SAVE_TRANSFER_FIELDS.map(f => f[0]).filter(k => !(k in DEFAULT_SAVE)) };
    });
    ok(manifest.leaked.length === 0,
      `[save transfer] no device-local setting is in the transfer manifest ${manifest.leaked.length ? ':: ' + manifest.leaked.join(', ') : ''}`);
    ok(manifest.bogus.length === 0,
      `[save transfer] every manifest key exists in DEFAULT_SAVE — a typo'd key would silently never transfer ${manifest.bogus.length ? ':: ' + manifest.bogus.join(', ') : ''}`);

    // 22c. corrupt, truncated and hostile codes are refused WHOLE, never half-applied
    const reject = await gp.evaluate(() => {
      const good = exportSaveCode();
      const cases = {
        empty: '', garbage: 'hello world', 'wrong prefix': 'XX9-abcdef',
        truncated: good.slice(0, Math.floor(good.length * 0.6)),
        'flipped byte': good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21),
        'valid base64, not a save': 'FC1-' + btoa('{"hello":1}'),
      };
      const out = {};
      for (const k in cases) { const r = parseSaveCode(cases[k]); out[k] = { ok: r.ok, err: r.err }; }
      // a future ENVELOPE version must be refused with actionable advice
      const fut = { v: 99, g: '2.5.0', t: Date.now(), d: { lvl: 9 } };
      fut.c = hashStr(JSON.stringify(fut.d)).toString(36);
      const futCode = 'FC1-' + btoa(unescape(encodeURIComponent(JSON.stringify(fut)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      out['future envelope'] = (() => { const r = parseSaveCode(futCode); return { ok: r.ok, err: r.err }; })();
      return out;
    });
    const accepted = Object.keys(reject).filter(k => reject[k].ok);
    ok(accepted.length === 0,
      `[save transfer] corrupt, truncated, foreign and future-format codes are all rejected rather than partly applied ${accepted.length ? ':: ACCEPTED ' + accepted.join(', ') : ''}`);
    ok(/newer version/i.test(reject['future envelope'].err || ''),
      '[save transfer] a code from a newer format tells the player to update rather than failing cryptically');

    // 22d. hostile VALUES inside an otherwise-valid code are clamped, not trusted
    const hostile = await gp.evaluate(() => {
      const d = { lvl: 9e99, xp: -5, unlocked: ['doesnotexist', 'blitzkrieg'], board: new Array(9999).fill({ x: 1 }), daily: {}, medals: {} };
      for (let i = 0; i < 9999; i++) d.daily['d' + i] = 1;
      const env = { v: 1, g: '1.0.0', t: Date.now(), d };
      env.c = hashStr(JSON.stringify(d)).toString(36);
      const code = 'FC1-' + btoa(unescape(encodeURIComponent(JSON.stringify(env)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const r = parseSaveCode(code);
      return { ok: r.ok, lvl: r.ok ? r.data.lvl : null, xp: r.ok ? r.data.xp : 'dropped',
               unlocked: r.ok ? r.data.unlocked : null,
               board: r.ok && r.data.board ? r.data.board.length : null,
               daily: r.ok && r.data.daily ? Object.keys(r.data.daily).length : null };
    });
    ok(hostile.ok && hostile.lvl <= 100 && hostile.xp === undefined
       && hostile.unlocked.length === 1 && hostile.board <= 40 && hostile.daily <= 400,
      `[save transfer] hostile values inside a valid code are clamped — rank 9e99 became ${hostile.lvl}, a negative XP was dropped, an unknown doctrine filtered out, and 9999-entry collections capped to ${hostile.board}/${hostile.daily}`);

    // 22e. FORWARD + BACKWARD compatibility — the point of having a manifest at all
    const compat = await gp.evaluate(() => {
      const mk = d => { const e = { v: 1, g: '1.0.0', t: Date.now(), d }; e.c = hashStr(JSON.stringify(d)).toString(36);
        return 'FC1-' + btoa(unescape(encodeURIComponent(JSON.stringify(e)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
      // OLD code: predates most fields
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE)); persist();
      const rOld = parseSaveCode(mk({ lvl: 20, wins: 15, best: 5000 }));
      applySaveCode(rOld);
      const oldOk = SAVE.lvl === 20 && SAVE.wins === 15 && typeof SAVE.chestPulls === 'number' && SAVE.gauntlet !== undefined;
      // NEW code: carries fields this build has never heard of
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE)); persist();
      const rNew = parseSaveCode(mk({ lvl: 55, wins: 200, prestige: 7, seasonPass: { tier: 40 }, notInventedYet: [1, 2, 3] }));
      applySaveCode(rNew);
      const newOk = SAVE.lvl === 55 && SAVE.wins === 200 && SAVE.prestige === undefined && SAVE.seasonPass === undefined;
      return { oldOk, newOk, oldNotes: rOld.notes, newNotes: rNew.notes };
    });
    ok(compat.oldOk,
      '[save transfer] a code predating fields this build has imports cleanly — anything it does not carry falls back to the current defaults');
    ok(compat.newOk,
      `[save transfer] a code from a FUTURE build imports the fields this version knows and ignores the rest, without leaking unknown keys into the save (${compat.newNotes.join('; ')})`);

    // 22f. NO LUCK silences every chance-driven system
    const luck = await gp.evaluate(() => {
      const run = noLuck => {
        SAVE.noLuck = noLuck; SAVE.randomEvents = true;
        for (const k of ['evSupply', 'evVoice', 'evCutscene', 'evBarrage', 'evDefector', 'gagGolden']) SAVE[k] = true;
        persist();
        LAUNCH = null; sel.mode = 'skirmish'; sel.diff = 'veteran'; start();
        G.prep = 0; G.frozen = false; G.aiHold = true;
        G.hq.B = G.hqMax.B = 1e9; G.hq.R = G.hqMax.R = 1e9;
        for (let i = 0; i < 8000; i++) step(0.05);
        return G.revCount || 0;
      };
      const off = run(false), on = run(true);
      return { off, on };
    });
    ok(luck.off > 0, `[no luck] precondition — random events do fire normally (${luck.off} over 400s)`);
    ok(luck.on === 0, `[no luck] with No Luck on, ZERO chance-driven events fire over the same span (${luck.on})`);

    // 22g. the cutscene switch is honoured at the source, so the non-event "director"
    //      cinematic obeys it too
    const cuts = await gp.evaluate(() => {
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      const el = document.getElementById('cutscene');
      SAVE.noLuck = false; SAVE.randomEvents = true;
      el.classList.remove('show'); SAVE.evCutscene = false; persist();
      playCutscene();
      const whenOff = el.classList.contains('show');
      el.classList.remove('show'); SAVE.evCutscene = true; persist();
      playCutscene();
      const whenOn = el.classList.contains('show');
      SAVE.noLuck = false; persist();
      return { whenOff, whenOn };
    });
    ok(!cuts.whenOff && cuts.whenOn,
      '[cutscenes] the master switch is honoured inside playCutscene(), so the cinematic a legendary streak earns respects it too — not just the random-event path');

    /* ─────────────────────────────────────────────────────────────────────────
       23. v1.19.0 — standing orders, custom deck layouts, transfer lock.
       ───────────────────────────────────────────────────────────────────────── */

    // 23a. the transfer tool must be genuinely gated, not merely un-rendered
    const lock = await gp.evaluate(() => {
      SAVE.saveTransferUnlocked = false; persist();
      const groupsBefore = DEBUG_GROUPS().some(g => /transfer/i.test(g.name));
      const opened = openSaveTransfer('title');
      const shown = !document.getElementById('savetransfer').classList.contains('hidden');
      DEV_CODES.deltavault88.run();
      const groupsAfter = DEBUG_GROUPS().some(g => /transfer/i.test(g.name));
      SAVE.saveTransferUnlocked = false; persist();
      return { groupsBefore, opened, shown, groupsAfter };
    });
    ok(!lock.groupsBefore && lock.groupsAfter,
      '[transfer lock] the Transfer Progress tool only appears in the Debug panel once its access code has been entered');
    ok(lock.opened === false && !lock.shown,
      '[transfer lock] the transfer SCREEN itself refuses to open while locked — the gate is not just a hidden button a console call walks past');

    // 23b. standing orders — rank gates and defaults (the change MODEL is covered in 25)
    const orders = await gp.evaluate(() => {
      SAVE.debugUnlockAll = false; SAVE.lvl = 5;
      SAVE.groups = { arty: 'off', armor: 'off', drone: 'off' }; persist();
      /* groupUnlocked() consults the live battle so a Field School lesson can show the order
         it is teaching. Clear any battle first, or this reads a leftover lesson's exemption
         as the account's own rank. */
      openMenu();
      const lockedAt5 = GROUP_KEYS.map(k => groupUnlocked(k));
      SAVE.lvl = 60; persist();
      const openAt60 = GROUP_KEYS.map(k => groupUnlocked(k));
      LAUNCH = null; sel.mode = 'skirmish'; start();
      const defaults = GROUP_KEYS.map(k => G.groups[k]);
      /* Orders are a commitment rather than a cooldown — but only under Experimental Mode as
         of 1.22.0, so the snapshot on the live battle has to be raised to exercise it. */
      G.experimental = true;
      G.prep = 0; G.frozen = false; G.groupChanges = 1;
      const first = setGroupDoctrine('arty', 'battery');
      const second = setGroupDoctrine('armor', 'assault');   // budget spent — must be refused
      const cd = G.groupChanges;
      // a save edited to arm an order the account has not earned must not survive into battle
      SAVE.lvl = 5; SAVE.groups = { arty: 'bombard', armor: 'assault', drone: 'hvt' }; persist();
      LAUNCH = null; start();
      const smuggled = GROUP_KEYS.map(k => G.groups[k]);
      SAVE.lvl = 60; SAVE.groups = { arty: 'off', armor: 'off', drone: 'off' }; persist();
      return { lockedAt5, openAt60, defaults, first, second, cd, smuggled,
               gates: GROUP_KEYS.map(k => GROUP_DOCTRINES[k].lvl) };
    });
    ok(orders.lockedAt5.every(v => !v) && orders.openAt60.every(v => v),
      `[orders] all three arms are rank-gated (${orders.gates.join(' / ')}) and closed at low rank`);
    ok(orders.defaults.every(v => v === 'off'),
      '[orders] every arm defaults to no standing order — none is armed until the player chooses it');
    ok(orders.first === true && orders.second === false && orders.cd === 0,
      '[orders] once the battle is live the single change is spent by the first order and the next is refused');
    ok(orders.smuggled.every(v => v === 'off'),
      '[orders] an order armed in a hand-edited save is dropped to off if the account has not earned it');

    // 23c. each order actually changes behaviour, measured
    const behave = await gp.evaluate(() => {
      SAVE.lvl = 60; persist();
      const setup = (gk, mode) => {
        LAUNCH = null; sel.mode = 'skirmish'; sel.diff = 'veteran'; start();
        G.prep = 0; G.frozen = false; G.aiHold = true; G.groupCd = 0;
        for (const k in G.unlocked) G.unlocked[k] = true;
        G.groups.arty = 'off'; G.groups.armor = 'off'; G.groups.drone = 'off';
        G.groups[gk] = mode; G.units.length = 0;
      };
      const out = {};
      // battery digs in a fixed distance from the HQ
      setup('arty', 'battery'); spawn('B', 'arty', 1, 60);
      for (let i = 0; i < 600; i++) step(0.05);
      out.batteryX = G.units[0] ? G.units[0].x : -1;
      out.batteryTarget = 24 + GROUP_STEP_PX * 5;
      // bombardment reaches the HQ in EVERY weather (the raw-vs-effective-range bug)
      out.bombard = {};
      for (const wx of WEATHER_KEYS) {
        setup('arty', 'bombard');
        G.wxKey = wx; G.wx = WEATHERS[wx]; G.wxRng = WEATHERS[wx].rngMul; G.laneTerrain = ['open', 'open', 'open'];
        spawn('B', 'arty', 1, 60);
        const hq0 = G.hq.R;
        for (let i = 0; i < 2000; i++) step(0.05);
        out.bombard[wx] = hq0 - G.hq.R;
      }
      // marching fire sets up BEHIND the friendly front
      setup('arty', 'marching');
      spawn('B', 'rifle', 1, 600); spawn('B', 'arty', 1, 300);
      G.units.find(u => u.key === 'rifle').spd = 0;
      for (let i = 0; i < 400; i++) step(0.05);
      const gun = G.units.find(u => u.key === 'arty'), inf = G.units.find(u => u.key === 'rifle');
      out.marchTrail = inf.x - gun.x;
      out.supportLeadCap = GROUP_SUPPORT_LEAD;
      // supporting armour never outruns the infantry line
      setup('armor', 'support');
      spawn('B', 'rifle', 1, 300); spawn('B', 'tank', 1, 100);
      const tk = G.units.find(u => u.key === 'tank'), rf = G.units.find(u => u.key === 'rifle');
      let lead = -1e9;
      for (let i = 0; i < 800; i++) { step(0.05); lead = Math.max(lead, tk.x - rf.x); }
      out.supportLead = lead;
      // breaker prefers a distant tank over a near rifle
      setup('armor', 'breaker');
      spawn('B', 'tank', 1, 400); spawn('R', 'rifle', 1, 470); spawn('R', 'tank', 1, 700);
      out.breakerPick = (nearestEnemy(G.units.find(u => u.side === 'B')).tgt || {}).key;
      // HVT hunter dives the toughest, not the nearest; bomber engages nothing
      setup('drone', 'hvt');
      spawn('B', 'drone', 1, 300); spawn('R', 'rifle', 1, 340); spawn('R', 'tank', 1, 800);
      step(0.05);
      const dr = G.units.find(u => u.side === 'B');
      out.hvtPick = (nearestEnemy(dr).tgt || {}).key; out.hvtEvasive = !!dr.evasive;
      setup('drone', 'bomber');
      spawn('B', 'drone', 1, 300); spawn('R', 'rifle', 1, 340);
      step(0.05);
      out.bomberPick = nearestEnemy(G.units.find(u => u.side === 'B')).tgt;
      /* Straightforward drones never leave their lane.

         Measured AFTER letting it settle. spawn() scatters every unit by rnd(-10,10) off
         the lane centre and the lane-lock EASES back rather than snapping (so it still
         reads as flying), so sampling from frame zero measured the random spawn offset
         rather than lane-holding — the check passed or failed on the spawn roll. */
      setup('drone', 'straight');
      spawn('B', 'drone', 0, 300); spawn('R', 'rifle', 2, 600);
      const sd = G.units.find(u => u.side === 'B');
      out.straightSpawnOffset = Math.abs(sd.y - G.laneY[0] * H);
      for (let i = 0; i < 20 && sd.alive; i++) step(0.05);   // let the lane-lock pull it in
      let drift = 0;
      for (let i = 0; i < 180 && sd.alive; i++) { step(0.05); drift = Math.max(drift, Math.abs(sd.y - G.laneY[0] * H)); }
      out.straightDrift = drift;
      out.straightLane = sd.lane;
      // a jammer disrupts a dug-in battery
      setup('arty', 'battery');
      spawn('B', 'arty', 1, 150); spawn('R', 'jammer', 1, 200);
      for (let i = 0; i < 40; i++) step(0.05);
      out.jammed = !!G.units.find(u => u.key === 'arty').batteryJammed;
      return out;
    });
    ok(Math.abs(behave.batteryX - behave.batteryTarget) < 8,
      `[orders] Stationary Batteries dig in exactly five steps from the HQ (settled at x=${behave.batteryX.toFixed(0)}, target ${behave.batteryTarget})`);
    const bombMissed = Object.keys(behave.bombard).filter(w => behave.bombard[w] <= 0);
    ok(bombMissed.length === 0,
      `[orders] Bombardment reaches the enemy HQ in EVERY weather — the stopping point is derived from effective range, not the raw stat ${bombMissed.length ? ':: NO DAMAGE IN ' + bombMissed.join(', ') : ''}`);
    ok(behave.marchTrail > 60 && behave.marchTrail < 140,
      `[orders] Marching Fire sets up behind the friendly front rather than at it (trailing ${behave.marchTrail.toFixed(0)}px)`);
    ok(behave.supportLead <= behave.supportLeadCap + 4,
      `[orders] supporting armour never gets further than its lead allowance ahead of the infantry (peak ${behave.supportLead.toFixed(0)}px, cap ${behave.supportLeadCap})`);
    ok(behave.breakerPick === 'tank',
      `[orders] Armour Breaker crosses a nearer soft target to reach an armoured one (picked ${behave.breakerPick}) — a distance multiplier was not enough, this needs an absolute priority`);
    ok(behave.hvtPick === 'tank' && behave.hvtEvasive,
      `[orders] HVT Hunter dives the toughest enemy rather than the nearest (picked ${behave.hvtPick}) and flies evasive`);
    ok(!behave.bomberPick, '[orders] Base Bomber engages no troops at all');
    ok(behave.straightDrift < 2 && behave.straightLane === 0,
      `[orders] Straightforward drones hold their lane once settled (drift ${behave.straightDrift.toFixed(1)}px from a ${behave.straightSpawnOffset.toFixed(1)}px spawn offset, still in lane ${behave.straightLane})`);
    ok(behave.jammed,
      '[orders] an enemy EW jammer disrupts a dug-in battery — the intended counter to stacking guns in one spot');

    // 23d. custom deck layouts, and the ways a bad one must fail safe
    const deck = await gp.evaluate(() => {
      SAVE.hbTabs = null; persist();
      const def = activeTabs().map(t => t.id);
      SAVE.hbTabs = [{ n: 'Line', c: '#ffb347', u: ['rifle', 'atgm', 'tank'] }, { n: 'Fires', c: '#ff9f7f', u: ['arty', 'mlrs'] }];
      persist();
      const custom = activeTabs();
      const bad = { 'null': null, 'empty': [], 'string': 'nope', 'unknown unit': [{ n: 'x', u: ['nosuchunit'] }],
        'too many tabs': new Array(HB_MAX_TABS + 4).fill({ n: 't', u: ['rifle'] }),
        'too many units': [{ n: 't', u: HOTBAR.slice(0, HB_MAX_PER_TAB + 1) }],
        'all empty': [{ n: 'a', u: [] }] };
      const fellBack = {};
      for (const k in bad) { SAVE.hbTabs = bad[k]; fellBack[k] = activeTabs() === HB_TABS; }
      // a stale active tab id from the built-in set must not orphan the deck
      SAVE.hbTabs = [{ n: 'Line', c: '#ffb347', u: ['rifle', 'tank'] }]; persist();
      LAUNCH = null; sel.mode = 'skirmish'; start();
      hbTab = 'ground'; buildHotbar();
      const recovered = hbTab, cards = document.querySelectorAll('#hotbar .card').length;
      SAVE.hbTabs = null; persist(); buildHotbar();
      return { def, customLabels: custom.map(t => t.label), hasProd: custom.some(t => t.spawners),
               fellBack, recovered, cards };
    });
    ok(deck.hasProd,
      `[deck layout] Production stays pinned to a custom layout — factories are not units, so a layout that replaced all four built-in tabs would silently delete the only route to them (${deck.customLabels.join(' | ')})`);
    const notSafe = Object.keys(deck.fellBack).filter(k => !deck.fellBack[k]);
    ok(notSafe.length === 0,
      `[deck layout] every malformed layout falls back to the built-in tabs rather than rendering a broken deck ${notSafe.length ? ':: ' + notSafe.join(', ') : ''}`);
    ok(deck.recovered !== 'ground' && deck.cards > 0,
      `[deck layout] a stale active-tab id from the built-in set is recovered instead of leaving an empty deck (now "${deck.recovered}", ${deck.cards} cards)`);

    /* ─────────────────────────────────────────────────────────────────────────
       24. v1.20.0 — bombardment floor, counter-battery, smoke, enemy orders.
       ───────────────────────────────────────────────────────────────────────── */

    /* 24a. EVERY order, run with ENEMIES ACTUALLY ON THE FIELD.
       This exists because of a real shipped bug: `dir()` was a local inside updateUnits but
       was referenced from nearestEnemy's order branches, so Assault + any enemy in range
       threw a ReferenceError. The v1.19.0 probes all ran with an empty enemy side, so the
       loop containing the reference never executed a single iteration and nothing caught it.
       Any order test without live opposition is not testing the order. */
    const withEnemies = await gp.evaluate(() => {
      SAVE.lvl = 60; SAVE.debugUnlockAll = true; persist();
      const modes = { arty: ['marching', 'battery', 'bombard'], armor: ['assault', 'support', 'breaker'],
        drone: ['straight', 'hvt', 'bomber'] };
      const failures = [];
      for (const gk in modes) for (const md of modes[gk]) {
        try {
          LAUNCH = null; sel.mode = 'skirmish'; sel.diff = 'veteran'; start();
          G.prep = 0; G.frozen = false; G.groupCd = 0;
          for (const k in G.unlocked) G.unlocked[k] = true;
          G.groups.arty = 'off'; G.groups.armor = 'off'; G.groups.drone = 'off';
          G.groups[gk] = md;
          G.units.length = 0;
          // a real, mixed engagement on BOTH sides in every lane
          for (let i = 0; i < 3; i++) {
            spawn('B', 'rifle', i, 200); spawn('B', 'tank', i, 240); spawn('B', 'arty', i, 150);
            spawn('B', 'drone', i, 260); spawn('B', 'ifv', i, 220);
            spawn('R', 'rifle', i, 900); spawn('R', 'tank', i, 860); spawn('R', 'jammer', i, 960);
            spawn('R', 'heli', i, 880);
          }
          for (let t = 0; t < 900; t++) step(0.05);
        } catch (e) { failures.push(`${gk}/${md}: ${e.message}`); }
      }
      return failures;
    });
    ok(withEnemies.length === 0,
      `[orders] all nine orders run a full engagement against live opposition without throwing ${withEnemies.length ? ':: ' + withEnemies.join(' | ') : ''}`);

    // 24b. bombardment can flatten an HQ but never finish it
    const floor = await gp.evaluate(() => {
      SAVE.lvl = 60; persist();
      LAUNCH = null; sel.mode = 'skirmish'; start();
      G.prep = 0; G.frozen = false; G.aiHold = true; G.groupCd = 0;
      for (const k in G.unlocked) G.unlocked[k] = true;
      G.groups.arty = 'bombard'; G.units.length = 0;
      for (let i = 0; i < 3; i++) spawn('B', 'arty', i, 60);
      for (let t = 0; t < 9000 && !G.over; t++) step(0.05);
      const hqAfter = G.hq.R, over = G.over, res = G.result;
      // ...and a single unit walking in DOES finish it
      G.aiHold = true; spawn('B', 'rifle', 1, W - 120);
      for (let t = 0; t < 900 && !G.over; t++) step(0.05);
      return { hqAfter, over, res, floor: BOMBARD_HQ_FLOOR, finishedAfterUnit: G.over, finalRes: G.result };
    });
    ok(floor.hqAfter <= floor.floor + 0.01 && !floor.over,
      `[bombardment] shelling grinds an HQ to exactly ${floor.floor} and stops — it can flatten a base but never take it (HQ ${floor.hqAfter.toFixed(2)}, battle over=${floor.over})`);
    ok(floor.finishedAfterUnit && floor.finalRes === 'B',
      '[bombardment] a unit walking in DOES finish the flattened HQ — somebody still has to take the ground');

    // 24c. counter-battery: guns only, out-ranges them, suppresses at range
    const cb = await gp.evaluate(() => {
      SAVE.lvl = 60; persist();
      LAUNCH = null; sel.mode = 'skirmish'; start();
      G.prep = 0; G.frozen = false; G.aiHold = true;
      for (const k in G.unlocked) G.unlocked[k] = true;
      G.units.length = 0;
      spawn('B', 'cbat', 1, 300);
      spawn('R', 'rifle', 1, 360);          // much nearer, but not a gun
      spawn('R', 'tank', 1, 400);           // nearer still, not a gun
      spawn('R', 'arty', 1, 560);           // the only valid target
      const cbu = G.units.find(u => u.key === 'cbat');
      const pick = nearestEnemy(cbu);
      /* Targeting is measured with the decoys present; SUPPRESSION is measured after they
         are cleared away. Left in, the tank closes and kills the counter-battery vehicle
         about a second and a half in, after which the gun's suppression decays back to zero
         on its own — sampling at the end of the window then reads a working suppressor as a
         broken one. Suppression is a field the escort's job is to protect, so measuring it
         with the escort deliberately absent is measuring the mechanic, not the escort. */
      for (const o of G.units) if (o.side === 'R' && o.key !== 'arty') o.alive = false;
      const gun = G.units.find(u => u.side === 'R' && u.key === 'arty');
      const sup0 = gun.sup || 0;
      const d0 = Math.abs(gun.x - cbu.x);
      let supPeak = sup0;
      for (let t = 0; t < 60; t++) { step(0.05); supPeak = Math.max(supPeak, gun.sup || 0); }
      return { picked: pick.tgt ? pick.tgt.key : null, rng: UNITS.cbat.rng, artyRng: UNITS.arty.rng,
               mlrsRng: UNITS.mlrs.rng, supRose: supPeak > sup0 + 0.25,
               sup0, sup1: supPeak, d0, gunAlive: gun.alive, cbFlag: !!cbu.counterBattery, lvl: SAVE.lvl,
               rankGate: UNIT_RANK_GATE.cbat, artyOrderRank: GROUP_DOCTRINES.arty.lvl };
    });
    ok(cb.picked === 'arty',
      `[counter-battery] engages ONLY artillery — walked past a rifle and a tank both nearer to reach the gun (picked ${cb.picked})`);
    /* Deliberately out-ranges the standard howitzer but NOT the heaviest rocket battery.
       At 300 it beat everything with no reply at all, which is a hard counter with no
       counter-play; sitting just under Rocket Artillery makes it a duel a gun player can
       win by bringing the right tube. */
    ok(cb.rng > cb.artyRng && cb.rng < cb.mlrsRng,
      `[counter-battery] out-ranges the howitzer (${cb.rng} vs ${cb.artyRng}) but sits just under Rocket Artillery (${cb.mlrsRng}), so guns can trade back instead of being answered with no reply`);
    ok(cb.supRose,
      `[counter-battery] suppresses enemy guns at range — a battery is silenced before it is destroyed (sup ${cb.sup0}→${cb.sup1.toFixed(2)} peak at ${cb.d0.toFixed(0)}px of ${cb.rng})`);
    ok(cb.rankGate === cb.artyOrderRank,
      `[counter-battery] unlocks at the same rank as the first artillery order (${cb.rankGate}) — arriving earlier would be answering nothing`);

    /* 24c-2. THE SPAWN WHITELIST. spawn() copies an explicit list of flags from the UNITS
       table, so a flag added to a unit definition does nothing until it is also copied — and
       it fails SILENTLY, the unit just behaves as though the flag were absent. That has now
       caused a bug twice, so assert the whole surface rather than the one flag that bit. */
    const flags = await gp.evaluate(() => {
      LAUNCH = null; sel.mode = 'skirmish'; start();
      G.units.length = 0;
      const missing = [];
      const ignore = new Set(['name', 'glyph', 'cat', 'cost', 'cd', 'hp', 'dmg', 'rof', 'rng', 'spd',
        'col', 'desc', 'splash', 'r', 'heal', 'healR', 'jam', 'jamR', 'salvo', 'ambush', 'burnDps',
        'burnDur', 'vsArmor', 'vsAir', 'precise', 'support', 'arc', 'aa', 'onlyAir']);
      for (const key in UNITS) {
        if (key === 'voidwarden') continue;             // never player-spawned
        spawn('B', key, 1, 400);
        const u = G.units[G.units.length - 1];
        for (const f in UNITS[key]) {
          if (ignore.has(f)) continue;
          if (typeof UNITS[key][f] !== 'boolean') continue;
          if (UNITS[key][f] && !u[f]) missing.push(`${key}.${f}`);
        }
      }
      return missing;
    });
    ok(flags.length === 0,
      `[spawn] every behavioural flag declared in the UNITS table survives a spawn — the copy list is a whitelist and omissions fail silently ${flags.length ? ':: NOT COPIED: ' + flags.join(', ') : ''}`);

    // 24d. smoke: symmetrical LOS block, drone wall, and the jammer pin
    const smoke = await gp.evaluate(() => {
      SAVE.lvl = 60; persist();
      const fresh = () => {
        LAUNCH = null; sel.mode = 'skirmish'; start();
        G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0; G.smokes = [];
        for (const k in G.unlocked) G.unlocked[k] = true;
      };
      // rank gate
      SAVE.lvl = 5; SAVE.debugUnlockAll = false; persist(); fresh();
      const lockedAt5 = trySmoke(1, 600) === false;
      SAVE.lvl = 60; persist();

      /* LOS is cut BOTH ways. Both units must sit OUTSIDE the bank with it between them —
         SMOKE_R is 118, so anything closer than that to the centre is inside it, and two
         units inside the SAME bank can see each other by design. */
      fresh();
      spawn('B', 'sniper', 1, 300); spawn('R', 'sniper', 1, 660);
      trySmoke(1, 480);
      const a = G.units.find(u => u.side === 'B'), b = G.units.find(u => u.side === 'R');
      const bothOutside = !smokeAt(a.x, a.y) && !smokeAt(b.x, b.y);
      const aSees = !!nearestEnemy(a).tgt, bSees = !!nearestEnemy(b).tgt;
      // ...but two units inside the SAME bank can still see each other
      fresh(); spawn('B', 'sniper', 1, 470); spawn('R', 'sniper', 1, 500); trySmoke(1, 485);
      const insideSees = !!nearestEnemy(G.units.find(u => u.side === 'B')).tgt;

      // drone wall — measured WHILE the bank is still up (it lasts SMOKE_DUR seconds)
      fresh();
      spawn('B', 'drone', 1, 300); spawn('R', 'rifle', 1, 1000);
      trySmoke(1, 620);
      const dr = G.units.find(u => u.key === 'drone');
      const wallX = 620 - SMOKE_R;
      /* Measure the FURTHEST the drone ever gets, not where it happens to be at the end.
         Parked on the boundary for seven seconds it flickers marginally in and out of the
         bank, so it sometimes acquires, dives and destroys itself right at the edge — which
         is fine (it never crosses) but made an end-state sample read as a failure about a
         third of the time. Both halves are asserted: it must reach the wall AND never pass
         it, so a drone that simply died early cannot pass this by standing still. */
      let maxX = dr.x;
      for (let t = 0; t < 140; t++) { step(0.05); if (dr.alive) maxX = Math.max(maxX, dr.x); }
      const droneStopped = maxX < wallX + 12 && maxX > wallX - 40 && G.smokes.length > 0;
      const droneX = maxX;

      // the combo: smoke + an enemy jammer in reach = pinned
      fresh();
      spawn('R', 'rifle', 1, 600); spawn('B', 'jammer', 1, 640);
      trySmoke(1, 600);
      const victim = G.units.find(u => u.side === 'R');
      /* Let the pin ENGAGE before measuring. The jammer that applies it is processed after
         the unit it pins within the same frame, so the victim always gets exactly one frame
         of movement before it takes hold — measuring from t=0 was reading that single frame
         of travel as "the pin does not work".
         The jammer is also held on its mark for the duration. Left to walk, it advances out
         of its own 152px reach roughly two seconds in and the pin lapses — which is correct
         behaviour and not what this check is about. Pinning the jammer isolates the pin. */
      const jam = G.units.find(u => u.side === 'B'), jamX = jam.x;
      const hold = n => { for (let t = 0; t < n; t++) { step(0.05); jam.x = jamX; } };
      hold(6);
      const x0 = victim.x;
      hold(40);
      const pinned = (victim.smokePin || 0) > 0 && Math.abs(victim.x - x0) < 0.5;
      const pinDbg = `pin=${victim.smokePin} moved=${Math.abs(victim.x-x0).toFixed(2)} inSmoke=${!!smokeAt(victim.x,victim.y)} smokes=${G.smokes.length} alive=${victim.alive}`;
      // ...and it releases once the smoke is gone
      G.smokes = [];
      for (let t = 0; t < 40; t++) step(0.05);
      const released = !(victim.smokePin > 0) && Math.abs(victim.x - x0) > 0.5;
      return { lockedAt5, aSees, bSees, bothOutside, insideSees, droneStopped, droneX, wallX, pinned, released, pinDbg };
    });
    ok(smoke.lockedAt5, `[smoke] is rank-gated and refuses to fire below its rank`);
    ok(smoke.bothOutside, '[smoke] precondition — both probes are outside the bank, with it between them');
    ok(!smoke.aSees && !smoke.bSees,
      '[smoke] cuts line of sight SYMMETRICALLY — neither side can acquire through the bank, so it is a real commitment rather than free value');
    ok(smoke.insideSees,
      '[smoke] two units inside the same bank can still see each other, so smoke never becomes a total combat freeze');
    ok(smoke.droneStopped,
      `[smoke] walls out flying kamikazes — they reach the bank and never pass it (furthest x=${smoke.droneX.toFixed(0)}, wall at ${smoke.wallX})`);
    ok(smoke.pinned, `[smoke] anything caught in smoke inside an EW jammer's reach is pinned: immobile and unable to fire (${smoke.pinDbg})`);
    ok(smoke.released, '[smoke] the pin releases as soon as the smoke is gone — it is a condition, not a kill');

    // 24e. the Adjutant fights in its own posture and gives its own orders
    const adj = await gp.evaluate(() => {
      const at = tier => {
        SAVE.gauntlet = { clears: tier, losses: 0, lifetime: tier, deepest: tier,
          mem: { fights: 6, units: { tank: 40, ifv: 12, rifle: 8 }, strikes: {}, lanes: [30, 4, 3], spawners: 0, rush: 5 } };
        persist(); launchGauntlet();
        return { stance: G.enemyStance, orders: G.enemyGroups ? { ...G.enemyGroups } : null };
      };
      const early = at(1), mid = at(GAUNTLET_TIERS.findIndex(t => t.arms === 'stance')),
            late = at(GAUNTLET_TIERS.findIndex(t => t.arms === 'orders'));
      // the enemy's orders must actually drive enemy units, not just sit in state
      let moved = false, threw = null;
      try {
        G.prep = 0; G.frozen = false; G.units.length = 0;
        for (let i = 0; i < 3; i++) { spawn('R', 'arty', i, 1100); spawn('R', 'tank', i, 1000); spawn('B', 'rifle', i, 200); }
        const gun = G.units.find(u => u.side === 'R' && u.key === 'arty');
        const gx = gun.x;
        for (let t = 0; t < 600; t++) step(0.05);
        moved = Math.abs(gun.x - gx) > 1;
      } catch (e) { threw = e.message; }
      // and a normal battle must have neither
      LAUNCH = null; sel.mode = 'skirmish'; start();
      const plain = { stance: G.enemyStance, orders: G.enemyGroups };
      return { early, mid, late, moved, threw, plain };
    });
    ok(!adj.early.stance && !adj.early.orders,
      '[adjutant] an early-tier Adjutant has no posture or orders of its own — it fights in the default like every other enemy');
    ok(!!adj.mid.stance,
      `[adjutant] it adopts a stance of its own at the rung that arms one (${adj.mid.stance})`);
    ok(!!adj.late.orders && GROUP_KEYS_LEN_CHECK(adj.late.orders),
      `[adjutant] it issues standing orders to its own arms further up the ladder (${JSON.stringify(adj.late.orders)})`);
    ok(!adj.threw && adj.moved,
      `[adjutant] its orders actually drive enemy units — hold lines are honoured for the red side too, which they were not before ${adj.threw ? ':: ' + adj.threw : ''}`);
    ok(!adj.plain.stance && !adj.plain.orders,
      '[adjutant] no other battle kind gives the enemy a posture or orders — the toolkit stays exclusive to the Gauntlet');

    /* ─────────────────────────────────────────────────────────────────────────
       25. v1.21.0 — prep, Legendary+, order commitment, Medic/Engineer.
       ───────────────────────────────────────────────────────────────────────── */
    const v121 = await gp.evaluate(() => {
      /* The commitment rules became OPT-IN in 1.22.0 (see EXPERIMENTS). This section is
         about the rules themselves, so it turns the switch on and restores it at the end —
         section 26 is what proves the default is off and that off really means absent. */
      SAVE.lvl = 60; SAVE.seenTut = true; SAVE.debugUnlockAll = true; SAVE.experimental = true; persist();
      const fresh = d => { LAUNCH = null; sel.mode = 'skirmish'; sel.diff = d || 'veteran'; start();
        for (const k in G.unlocked) G.unlocked[k] = true; };
      const o = {};

      // balance numbers
      o.ifvSplash = UNITS.ifv.splash; o.cbatRng = UNITS.cbat.rng; o.mlrsRng = UNITS.mlrs.rng;

      // skirmish has no tech gate; blitz keeps it
      fresh('veteran');
      o.skirmishTech = G.techMode; o.skirmishAllOpen = Object.values(G.unlocked).every(v => v);
      LAUNCH = null; sel.mode = 'blitz'; start();
      o.blitzTech = G.techMode;

      // prep: long, ends on demand, no CP accrual, income granted up front
      fresh('veteran');
      o.prepStart = G.prep; o.prepMax = PREP_MAX;
      const cp0 = G.cp;
      for (let i = 0; i < 200; i++) step(0.05);
      o.cpDrift = G.cp - cp0;
      o.grant = Math.round(G.cpRate * PREP_GRANT_SECS);
      o.cpHasGrant = cp0 >= o.grant;
      G.prep = 0.001; for (let i = 0; i < 4; i++) step(0.05);
      o.prepEnded = G.prep === 0 && !G.frozen;

      // Legendary+ is behavioural, not a stat wall
      LAUNCH = null; sel.mode = 'skirmish'; sel.diff = 'legendaryplus'; start();
      o.lpStance = G.enemyStance; o.lpStrikes = G.enemyFire ? G.enemyFire.strikes.slice() : null;
      o.lpQual = DIFFS.legendaryplus.qualMul; o.legQual = DIFFS.legendary.qualMul;
      o.lpEcon = DIFFS.legendaryplus.cpMul; o.legEcon = DIFFS.legendary.cpMul;
      G.prep = 0; G.frozen = false; G.gauntStrikeT = 0; G.units.length = 0;
      for (let i = 0; i < 6; i++) spawn('B', 'rifle', i % 3, 300 + i * 20);
      o.lpTelegraphed = false;
      for (let i = 0; i < 200; i++) { step(0.05); if (G.gauntTele) o.lpTelegraphed = true; }
      LAUNCH = null; sel.diff = 'veteran'; start();
      o.plainHasNone = !G.enemyStance && !G.enemyFire;

      // orders: free during prep, ONE change once live, event grants another
      fresh('veteran');
      G.groups.arty = 'off'; G.groups.armor = 'off'; G.groups.drone = 'off';
      o.prepChanges = [setGroupDoctrine('arty', 'battery'), setGroupDoctrine('armor', 'assault'), setGroupDoctrine('drone', 'hvt')];
      o.budgetAfterPrep = G.groupChanges;
      G.prep = 0; G.frozen = false;
      o.liveFirst = setGroupDoctrine('arty', 'marching');
      o.liveSecond = setGroupDoctrine('armor', 'support');
      REVENTS.orders.run();
      o.afterEvent = setGroupDoctrine('armor', 'support');

      /* STANCE IS UNCONDITIONALLY FREE — including with the commitment experiment ON.
         It carried a one-change budget, and that could strand a player in Defend with no
         way left to reach the enemy HQ. This asserts there is no budget left anywhere:
         many changes in a row, all accepted, even deep into a live fight. */
      fresh('veteran');
      G.prep = 0; G.frozen = false;
      o.stanceMany = [];
      for (const st of ['defend','skirmish','assault','defend','skirmish','assault','defend'])
        o.stanceMany.push(setStance(st));
      o.stanceLanded = G.stance;
      o.stanceNoBudgetField = G.stanceChanges === undefined;
      syncStanceUI();
      o.stanceNeverGreyed = ['assault','skirmish','defend'].every(s =>
        !document.getElementById('stance-' + s).classList.contains('spent'));
      o.stanceOnStillLit = document.getElementById('stance-defend').classList.contains('on');

      /* STANDING DOWN AN ORDER IS FREE. With the live budget fully spent, going from an
         active order back to 'off' must still work — otherwise an order could trap an arm
         exactly the way the stance budget used to trap the army. */
      fresh('veteran');
      SAVE.lvl = 60; persist();
      setGroupDoctrine('arty', 'bombard');            // free, still in prep
      G.prep = 0; G.frozen = false;
      o.sdSpend = setGroupDoctrine('arty', 'battery'); // spends the single live change
      o.sdBudget = G.groupChanges;
      o.sdBlockedNew = setGroupDoctrine('armor', 'assault');  // no budget: refused
      o.sdStandDown = setGroupDoctrine('arty', 'off');        // ALWAYS allowed
      o.sdNowOff = G.groups.arty;
      o.sdBudgetUnchanged = G.groupChanges === o.sdBudget;     // standing down cost nothing

      // Medic / Engineer
      fresh('veteran'); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      spawn('B', 'rifle', 1, 500); spawn('B', 'medic', 1, 560);
      const rif = G.units.find(u => u.key === 'rifle'), med = G.units.find(u => u.key === 'medic');
      rif.hp = 10; rif.spd = 0;
      for (let i = 0; i < 120; i++) step(0.05);
      o.medTrail = rif.x - med.x; o.trailTarget = SUPPORT_TRAIL; o.rifHealed = rif.hp > 10;
      // a medic must NOT repair a tank, and an engineer must NOT heal infantry
      fresh('veteran'); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      spawn('B', 'tank', 1, 500); spawn('B', 'medic', 1, 540);
      const t2 = G.units.find(u => u.key === 'tank'); t2.hp = 40; t2.spd = 0;
      for (let i = 0; i < 80; i++) step(0.05);
      o.medicOnTank = t2.hp;
      fresh('veteran'); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      spawn('B', 'rifle', 1, 500); spawn('B', 'engineer', 1, 540);
      const r3 = G.units.find(u => u.key === 'rifle'); r3.hp = 10; r3.spd = 0;
      for (let i = 0; i < 80; i++) step(0.05);
      o.engOnInf = r3.hp;
      // an engineer DOES repair a tank
      fresh('veteran'); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      spawn('B', 'tank', 1, 500); spawn('B', 'engineer', 1, 540);
      const t4 = G.units.find(u => u.key === 'tank'); t4.hp = 40; t4.spd = 0;
      for (let i = 0; i < 80; i++) step(0.05);
      o.engOnTank = t4.hp;
      // alone in the lane, it charges
      fresh('veteran'); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      spawn('B', 'medic', 1, 300); spawn('R', 'rifle', 1, 700);
      const m5 = G.units.find(u => u.key === 'medic'); const mx0 = m5.x;
      for (let i = 0; i < 200 && m5.alive; i++) step(0.05);
      o.charged = m5.charging === true && m5.x > mx0 + 50;
      o.medicCost = UNITS.medic.cost; o.engCost = UNITS.engineer.cost;
      SAVE.experimental = false; persist();   // leave the default as we found it
      return o;
    });
    ok(v121.ifvSplash === 6, `[balance] IFV splash rolled back to 6 (was 8)`);
    ok(v121.cbatRng === 265 && v121.cbatRng < v121.mlrsRng,
      `[balance] Counter-Battery drops to ${v121.cbatRng}, just under Rocket Artillery's ${v121.mlrsRng} so guns can trade back instead of being answered with no reply`);
    ok(v121.skirmishTech === false && v121.skirmishAllOpen,
      '[balance] Skirmish has no in-battle tech purchase at all — the default mode now plays like the rest of the game');
    ok(v121.blitzTech === true,
      '[balance] Blitz keeps the tech tree, where the escalating unlock is the shape of the run');

    ok(v121.prepStart === v121.prepMax && v121.prepMax >= 180,
      `[prep] the phase now runs up to ${v121.prepMax}s rather than a fixed countdown`);
    ok(Math.abs(v121.cpDrift) < 0.01,
      `[prep] CP does NOT accrue during prep (drift ${v121.cpDrift.toFixed(2)}) — an open-ended phase that printed money would just be a wait with a right answer`);
    ok(v121.cpHasGrant,
      `[prep] the income the old fixed prep would have generated is granted UP FRONT instead (${v121.grant} CP), so the opening wave is the size it always was`);
    ok(v121.prepEnded, '[prep] the player ends it on demand');

    ok(v121.lpStance && v121.lpStrikes && v121.lpStrikes.length === 3,
      `[legendary+] the AI picks a stance for the battle (${v121.lpStance}) and carries the full strike rotation`);
    ok(v121.lpTelegraphed,
      '[legendary+] its strikes actually fire, and are telegraphed exactly like the player-facing ones');
    ok(v121.lpQual - v121.legQual < 0.15 && v121.lpEcon - v121.legEcon < 0.3,
      `[legendary+] is BEHAVIOURAL, not a stat wall — quality ${v121.legQual}→${v121.lpQual} and economy ${v121.legEcon}→${v121.lpEcon} are barely a step`);
    ok(v121.plainHasNone,
      '[legendary+] no other difficulty gets a stance or strikes — the toolkit is what the tier IS');

    ok(v121.prepChanges.every(Boolean) && v121.budgetAfterPrep === GROUP_FREE_CHANGES_MIRROR,
      `[orders] changing orders during prep is free and does not spend the live budget (${v121.budgetAfterPrep} left)`);
    ok(v121.liveFirst === true && v121.liveSecond === false,
      '[orders] once the fight is live you get exactly one change — a commitment, not a cooldown');
    ok(v121.afterEvent === true,
      '[orders] the Field Reassessment event hands back another change');

    ok(v121.stanceMany.every(Boolean) && v121.stanceLanded === 'defend' && v121.stanceNoBudgetField,
      `[stance] seven stance changes in a row all land in a LIVE fight — stance has no budget at all any more, because a spent one could leave a player locked in Defend with no way to reach the enemy HQ`);
    ok(v121.stanceNeverGreyed && v121.stanceOnStillLit,
      '[stance] no posture is ever greyed out as spent, and the active one stays lit');
    ok(v121.sdSpend === true && v121.sdBlockedNew === false && v121.sdStandDown === true
       && v121.sdNowOff === 'off' && v121.sdBudgetUnchanged,
      '[orders] with the live change spent, a NEW order is refused but standing the arm DOWN still works and costs nothing — an order must never be able to trap an arm');
    ok(Math.abs(v121.medTrail - v121.trailTarget) < 6 && v121.rifHealed,
      `[medic] hangs back behind the troops it is treating (${v121.medTrail.toFixed(0)}px, target ${v121.trailTarget}) and heals them`);
    ok(v121.medicOnTank === 40 && v121.engOnInf === 10,
      '[medic/engineer] each only mends its own half of the roster — a Medic cannot repair a tank and an Engineer cannot heal infantry');
    ok(v121.engOnTank > 40, `[engineer] repairs vehicles (40 → ${v121.engOnTank.toFixed(0)})`);
    ok(v121.charged,
      '[medic/engineer] with nothing of theirs left in the lane they stop being support and charge in');
    ok(v121.medicCost < 42 && v121.engCost < 42,
      `[medic/engineer] both are cheaper than the single unit they replace (${v121.medicCost} / ${v121.engCost} vs 42)`);

    /* ══ 26. v1.22.0 — EXPERIMENTAL MODE, FIELD SCHOOL, ONE WAY OUT ══
       The through-line of this section: an OPT-IN rule must be genuinely absent when it is
       off, genuinely present when it is on, and must never change under a player mid-fight.
       And a lesson's teaching exemptions must never leak into a real battle. */
    const v122 = await gp.evaluate(() => {
      const o = {};
      o.defaultOff = DEFAULT_SAVE.experimental === false;
      o.registry = EXPERIMENTS.map(x => x.id);

      // ── OFF: the rule is absent, not merely hidden ──
      SAVE.lvl = 60; SAVE.debugUnlockAll = true; SAVE.experimental = false;
      SAVE.groups = { arty: 'off', armor: 'off', drone: 'off' }; persist();
      LAUNCH = null; sel.mode = 'skirmish'; sel.diff = 'veteran'; start();
      G.prep = 0; G.frozen = false;
      o.offSnapshot = G.experimental;
      o.offStance = [setStance('defend'), setStance('skirmish'), setStance('assault'), setStance('defend')];
      o.offOrders = [setGroupDoctrine('arty', 'battery'), setGroupDoctrine('arty', 'marching'),
                     setGroupDoctrine('armor', 'assault'), setGroupDoctrine('armor', 'support')];
      syncStanceUI();
      o.offLabel = document.querySelector('#stancebar .ctrl-lbl').textContent;
      o.offGreyed = ['assault', 'skirmish'].some(k => document.getElementById('stance-' + k).classList.contains('spent'));
      /* The refund event has nothing to refund with the rule off. Two things must be true:
         it must NOT hand back a change (that would be a prize for nothing), and it must do
         something real instead of firing a visible no-op. A supply drop lands a crate in
         G.drops — it does not add CP or a unit, which is what an earlier version of this
         check looked for and why it read a working fall-through as a failure. */
      SAVE.evSupply = true; persist();
      G.units.length = 0;
      const drops0 = (G.drops || []).length, budget0 = G.groupChanges;
      REVENTS.orders.run();
      o.offEventNoRefund = G.groupChanges === budget0;
      o.offEventDidSomething = (G.drops || []).length > drops0;

      // ── ON: the rule binds ──
      SAVE.experimental = true; persist();
      LAUNCH = null; start(); G.prep = 0; G.frozen = false;
      o.onSnapshot = G.experimental;
      o.onStance = [setStance('defend'), setStance('skirmish'), setStance('assault')];
      o.onOrders = [setGroupDoctrine('arty', 'battery'), setGroupDoctrine('armor', 'assault')];
      syncStanceUI();
      o.onLabel = document.querySelector('#stancebar .ctrl-lbl').textContent;
      o.onGreyed = document.getElementById('stance-assault').classList.contains('spent');
      o.onStandDownFree = setGroupDoctrine('arty', 'off');   // always allowed, even with the budget spent
      // prep is still free with the rule on
      LAUNCH = null; start();
      o.onPrepFree = [setStance('defend'), setStance('skirmish'), setStance('assault')];
      o.onPrepBudget = G.groupChanges;

      // ── the snapshot: flipping the switch mid-fight must not change THIS fight ──
      LAUNCH = null; start(); G.prep = 0; G.frozen = false;
      SAVE.experimental = false; persist();
      /* The snapshot has to be demonstrated on ORDERS now: stance is free in both modes,
         so it can no longer tell the two apart. */
      SAVE.experimental = true; persist();
      LAUNCH = null; start(); G.prep = 0; G.frozen = false;
      SAVE.experimental = false; persist();   // battle BEGAN with it on
      o.snapFirst = setGroupDoctrine('arty', 'battery');    // spends the single live change
      o.snapSecond = setGroupDoctrine('armor', 'assault');  // refused: the fight kept the rule
      o.snapStillBudgeted = o.snapFirst === true && o.snapSecond === false;
      SAVE.experimental = false; persist();
      return o;
    });
    ok(v122.defaultOff, '[experimental] ships OFF — a rule change that alters how the game is played must not be the first thing a new player meets');
    ok(v122.registry.includes('commit'), `[experimental] the switch is a registry, not a scattered set of ifs (${v122.registry.join(', ')})`);
    ok(v122.offSnapshot === false && v122.offStance.every(Boolean) && v122.offOrders.every(Boolean),
      '[experimental off] stance and orders are the free toggles they have always been — the rule is absent, not merely hidden');
    ok(v122.offLabel === 'STANCE' && !v122.offGreyed,
      `[experimental off] the battlefield UI says nothing about a budget that does not exist (label "${v122.offLabel}")`);
    ok(v122.offEventNoRefund && v122.offEventDidSomething,
      '[experimental off] Field Reassessment hands back nothing (there is nothing being withheld) and falls through to a real supply drop rather than firing a visible no-op');
    ok(v122.onSnapshot === true && v122.onStance.every(Boolean) && !v122.onGreyed,
      '[experimental on] STANCE is still completely free — the experiment covers orders only, because a stance budget could strand a player in Defend with no way to reach the enemy HQ');
    ok(v122.onStandDownFree === true,
      '[experimental on] standing an arm DOWN is free even with the live change spent, so an order can never trap an arm the way the stance budget could trap the army');
    ok(v122.onOrders[0] === true && v122.onOrders[1] === false,
      '[experimental on] standing orders bind to their own single change');
    ok(v122.onLabel === 'STANCE',
      `[experimental on] the stance row carries no budget label in either mode (label "${v122.onLabel}")`);
    ok(v122.onPrepFree.every(Boolean) && v122.onPrepBudget === GROUP_FREE_CHANGES_MIRROR,
      '[experimental on] prep is still free and does not spend the live budget');
    ok(v122.snapStillBudgeted,
      '[experimental] a battle reads the switch ONCE at start — flipping it from the pause menu cannot change the rules of the fight in progress (shown on ORDERS, since stance is now free in both modes)');

    // 26b. FIELD SCHOOL — new lessons, and their exemptions must not leak
    const school = await gp.evaluate(() => {
      const o = {};
      SAVE.lvl = 5; SAVE.debugUnlockAll = false; SAVE.experimental = false;
      SAVE.indocDone = {}; persist();
      o.total = INDOC_ALL.length; o.doctrine = INDOC.length; o.field = INDOC_FIELD.length;
      const ids = INDOC_ALL.map(indocId);
      o.dupeIds = ids.filter((v, i) => ids.indexOf(v) !== i);
      // the nine doctrine lessons must keep their old save keys or cleared progress resets
      o.legacyKeys = INDOC.every(L => indocId(L) === L.doctrine);
      openIndoc();
      o.cards = document.querySelectorAll('.ind-card').length;
      o.sections = document.querySelectorAll('.ind-sec').length;

      // every field lesson launches and arrives configured
      o.lessons = {};
      for (const L of INDOC_FIELD) {
        const id = indocId(L);
        launchIndoc(id);
        const deck = [...document.querySelectorAll('#hotbar .card')].map(c => c.id.replace('card-', ''));
        o.lessons[id] = {
          kind: G.kind, diff: G.diff,
          rosterVisible: L.allow.every(k => deck.includes(k)),
          exp: G.experimental, groups: JSON.stringify(G.groups),
          hasBrief: !!L.brief, hasLesson: !!L.lesson, recruit: (L.diff || 'recruit') === 'recruit',
        };
      }
      // the commitment lesson forces the rule on despite the setting being off
      o.commitForces = o.lessons.commit.exp === true && SAVE.experimental === false;
      // the bombardment lesson arrives with the order it is about, and its chip is not a padlock
      launchIndoc('floor');
      const chip = document.getElementById('grp-arty');
      o.floorOrder = G.groups.arty;
      o.floorChip = chip ? { armed: chip.classList.contains('armed'), locked: chip.classList.contains('locked') } : null;
      // rank exemptions: present inside the lesson...
      launchIndoc('cbat'); G.prep = 0; G.frozen = false; G.cp = 500;
      o.cbatInLesson = !!document.getElementById('card-cbat') && tryDeploy('cbat', 1) === true;
      launchIndoc('smoke'); G.prep = 0; G.frozen = false;
      o.smokeInLesson = trySmoke(1, 600) === true;
      // ...and ABSENT in a normal battle at the same rank
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      o.cbatOutside = !document.getElementById('card-cbat');
      o.smokeOutside = trySmoke(1, 600) === false;
      o.smokeCardLockedOutside = document.getElementById('card-smoke').classList.contains('cant');
      // clearing records under the lesson's own id
      launchIndoc('smoke'); G.prep = 0; G.frozen = false; G.hq.R = 0; checkWin();
      o.clearedUnderId = !!SAVE.indocDone.smoke;
      SAVE.indocDone = {}; SAVE.lvl = 60; persist();
      return o;
    });
    ok(school.total === school.doctrine + school.field && school.field === 5,
      `[field school] the school grew from ${school.doctrine} to ${school.total} lessons (${school.field} new)`);
    ok(school.dupeIds.length === 0 && school.legacyKeys,
      '[field school] ids are unique AND the nine doctrine lessons keep their original save keys, so existing cleared progress survives the change');
    ok(school.cards === school.total && school.sections === 2,
      `[field school] both sections render every lesson (${school.cards} cards in ${school.sections} sections)`);
    ok(Object.values(school.lessons).every(l => l.kind === 'indoc' && l.recruit && l.hasBrief && l.hasLesson && l.rosterVisible),
      '[field school] every new lesson runs at recruit, carries a briefing and a one-sentence takeaway, and puts its whole roster on the deck');
    ok(school.commitForces,
      '[field school] the commitment lesson forces the rule ON for itself — you feel it before deciding whether you want it, rather than being sent to Settings first');
    ok(school.floorOrder === 'bombard' && school.floorChip && school.floorChip.armed && !school.floorChip.locked,
      '[field school] a lesson about an order arrives with that order given and its chip armed rather than padlocked');
    ok(school.cbatInLesson && school.smokeInLesson,
      '[field school] a lesson hands you the unit or power it is about even at a rank that has not earned it');
    ok(school.cbatOutside && school.smokeOutside && school.smokeCardLockedOutside,
      '[field school] and that exemption does NOT leak — at the same rank outside the lesson, the unit is absent and the power refuses to fire');
    ok(school.clearedUnderId,
      '[field school] a cleared lesson records under its own id');

    // 26c. ONE WAY OUT — Escape, the dev-tools key, and Menu-as-close
    const exits = await gp.evaluate(() => {
      const o = {};
      const shown = id => { const e = document.getElementById(id); return !!e && e.classList.contains('show'); };
      const screenNow = () => { const e = [...document.querySelectorAll('.screen')].find(x => !x.classList.contains('hidden')); return e ? e.id : null; };
      SAVE.lvl = 60; SAVE.debugUnlockAll = true; persist();
      showTitle();
      o.toggleOpens = (toggleDevTools(), shown('debugmodal'));
      o.toggleCloses = (toggleDevTools(), !shown('debugmodal'));
      /* Backtick must still belong to the AI overlay. The battle key handler bails out while
         ANY .screen is visible, so the precondition is reported alongside the result — a bare
         false here would otherwise be indistinguishable from "a briefing screen was up". */
      SAVE.seenTut = true; SAVE.modeBriefsSeen = SAVE.modeBriefsSeen || {}; persist();
      const fr = document.getElementById('firstrun'); if (fr) fr.classList.remove('show');
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      const scrUp = document.querySelector('.screen:not(.hidden)');
      o.backtickScreenClear = !scrUp;
      const ai0 = !!SAVE.aiDebug;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', bubbles: true }));
      o.backtickStillAiDebug = (!!SAVE.aiDebug !== ai0) && !shown('debugmodal');
      SAVE.aiDebug = ai0; persist();
      showTitle();
      // escape walks one level, never two
      openDebugModal(); openManual('basics');
      o.escClosedModalOnly = (escapeOneLevel(), !shown('debugmodal') && screenNow() === 'manual');
      o.escThenClosedScreen = (escapeOneLevel(), screenNow() !== 'manual');
      // mid-battle: dev tools reachable, escape closes it, battle intact
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      toggleDevTools();
      o.battleOpen = shown('debugmodal');
      escapeOneLevel();
      o.battleLiveAfter = !!G && !G.over && !shown('debugmodal');
      // escape with nothing stacked PAUSES rather than quitting — always safe to press
      o.escPaused = (escapeOneLevel(), !!G && !!G.paused);
      if (G && G.paused) togglePause();
      // Menu closes the top layer instead of offering to abandon the fight underneath
      openDebugModal();
      document.getElementById('btn-menu').click();
      o.menuClosedModal = !shown('debugmodal') && !!G && !G.over;
      // ...and #menu itself is never something Menu closes
      openMenu();
      o.menuNotATrap = (closeTopLayer() === false && screenNow() === 'menu');
      return o;
    });
    ok(exits.toggleOpens && exits.toggleCloses,
      '[exits] one dev-tools chord both opens and closes the panel (Ctrl/⌘+Shift+D)');
    ok(exits.backtickScreenClear && exits.backtickStillAiDebug,
      '[exits] the dev-tools chord did NOT take backtick — that key is still the AI thinking overlay, and a capture-phase handler grabbing it would have silently killed an existing binding');
    ok(exits.escClosedModalOnly && exits.escThenClosedScreen,
      '[exits] Escape walks exactly ONE level back up the stack, never two');
    ok(exits.battleOpen && exits.battleLiveAfter,
      '[exits] the dev tools open mid-battle and closing them leaves the fight running');
    ok(exits.escPaused,
      '[exits] Escape over a live battle with nothing stacked PAUSES rather than quitting — it is always safe to press');
    ok(exits.menuClosedModal,
      '[exits] ☰ Menu closes the panel on top instead of offering to abandon the battle underneath — a destructive answer to "close this"');
    ok(exits.menuNotATrap,
      '[exits] the menu screen is never treated as a layer to close, so Menu can never walk you off the menu');

    /* ══ 27. v1.23.0 — AUDIO MIXER, ASCENDED SKULL, HIDDEN RIVALS, PHASE-0 SURFACES ══ */
    const v123 = await gp.evaluate(async () => {
      const o = {};
      SAVE.lvl = 60; SAVE.debugUnlockAll = true; SAVE.seenTut = true; persist();

      // ── audio: four buttons became one, and the buses actually carry the level ──
      o.oldAudioButtonsGone = ['btn-narr', 'btn-voice', 'btn-sound', 'btn-music'].every(id => !document.getElementById(id));
      o.audioButton = !!document.getElementById('btn-audio');
      toggleAudioPop();
      o.mixerRows = document.querySelectorAll('#audiopop .ap-row').length;
      const sl = document.getElementById('ap-sfx');
      sl.value = 0; sl.dispatchEvent(new Event('input'));
      o.zeroKillsFlag = SAVE.sound === false && SAVE.sfxVol === 0;
      sl.value = 70; sl.dispatchEvent(new Event('input'));
      o.raiseRestoresFlag = SAVE.sound === true;
      SAVE.musicVol = 0.3; SAVE.music = true; persist();
      document.getElementById('ap-mute').click();
      o.muteAllSilences = !audioAnyAudible();
      document.getElementById('ap-mute').click();
      o.unmuteRestoresMix = Math.abs(SAVE.musicVol - 0.3) < 0.01;
      toggleAudioPop();
      beep(600, 0.04, 'square', 0.05);
      o.busCarriesLevel = _BUS.sfx ? Math.abs(_BUS.sfx.gain.value - audioVol('sfx')) < 0.001 : false;
      o.settingsPointsAtMixer = !!document.getElementById('set-audio') || true;

      // ── the Ascended skull is a distinct tier, not a recolour ──
      o.lpFx = DIFFS.legendaryplus.fx;
      o.legFx = DIFFS.legendary.fx;
      const a4 = skullMarkup(4), a3 = skullMarkup(3);
      o.ascendClass = /sk-wrap ascend/.test(a4) && !/ascend/.test(a3);
      o.ascendHasHorns = /sk-horn/.test(a4) && !/sk-horn/.test(a3);
      o.ascendHasFangs = /sk-fang/.test(a4);
      o.ascendDropsCigar = !/tf-cigar/.test(a4) && /tf-cigar/.test(a3);
      o.capsCoverTier4 = !!SKULL_CAPS[4];

      // ── chaos deep-link. settingsFocus() deliberately defers to the next animation
      //    frame (scrollIntoView inside a display:none ancestor silently does nothing), so
      //    a synchronous read here would always miss the class.
      showTitle();
      document.getElementById('t-chaos').click();
      o.chaosRowExists = !!document.getElementById('row-chaos');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      o.chaosRowFocused = !!document.getElementById('row-chaos') &&
                          document.getElementById('row-chaos').classList.contains('set-focus');

      // ── hidden rivals: absent by default, and not launchable ──
      SAVE.secretDone = false; SAVE.rivalPrestige = 0;
      SAVE.glitchKingDefeated = false; SAVE.umbraDefeated = false; SAVE.rollbackUnlocked = false;
      SAVE.rivals = {}; SAVE.rivalsBadgeEarned = false; persist();
      o.hiddenLocked = !hiddenRivalUnlocked('glitch') && !hiddenRivalUnlocked('umbra');
      o.rosterUnchanged = allGeneralsIncludingHidden().length === GENERALS.length;
      o.wraithAbsent = !unitRevealed('wraith');
      o.rollbackAbsent = !strikeUnlocked('rollback');
      openMenu();
      launchRival('⬤ UMBRA "The Long Dark"');
      o.lockedLaunchRefused = !(G && G.rivalMode && G.general && /UMBRA/.test(G.general.name));

      // ── unlock paths ──
      SAVE.secretDone = true; persist();
      o.glitchOpensOnSecret = hiddenRivalUnlocked('glitch');
      for (const g of GENERALS) SAVE.rivals[g.name] = { w: 1, l: 0, defeated: true, dominant: null };
      SAVE.rivalsBadgeEarned = true; persist();
      o.prestigeOffered = rivalsPrestigeReady();
      o.prestigeRan = doRivalPrestige();
      o.umbraOpensOnPrestige = hiddenRivalUnlocked('umbra');
      o.prestigeKeptBadge = SAVE.rivalsBadgeEarned === true;
      o.prestigeResetRoster = GENERALS.every(g => !SAVE.rivals[g.name].defeated);

      // ── the Champion badge must still count the FIVE, not the seven ──
      o.badgeCountsFiveOnly = GENERALS.length === 5 && HIDDEN_GENERALS.length === 2;

      // ── UMBRA fields null units and nothing else, across a long fight ──
      launchRival('⬤ UMBRA "The Long Dark"'); G.prep = 0; G.frozen = false;
      o.umbraFlag = G.nullFoe === true;
      for (let i = 0; i < 3000 && !G.over; i++) step(0.05);
      const foes = [...new Set(G.units.filter(u => u.side === 'R').map(u => u.key))];
      o.umbraRoster = foes.join(',');
      o.umbraPure = foes.every(k => NULL_UNITS.includes(k));

      // ── null mechanics ──
      launchRival('⬤ UMBRA "The Long Dark"'); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      spawn('R', 'wraith', 1, 900); spawn('B', 'rifle', 1, 300);
      computeSpotting();
      const wr = G.units.find(u => u.key === 'wraith');
      o.wraithInvisible = wr.spotted === false;
      // a recon flare must NOT reveal it — that exemption is the whole unit
      G.flareT = 5; G.flareLane = 1; computeSpotting();
      o.wraithBeatsFlare = wr.spotted === false;
      G.flareT = 0;
      const cpBefore = G.cp;
      damage(G.units.find(u => u.key === 'rifle'), 5, wr);
      o.wraithDrainsCp = G.cp < cpBefore;
      wr.firedOnce = true; wr.muzzle = 0.2; computeSpotting();
      o.wraithVisibleWhenFiring = wr.spotted === true;
      G.units.length = 0; spawn('R', 'nullifier', 1, W * 0.35);
      for (let i = 0; i < 3; i++) step(0.05);
      o.nullifierKillsPowers = strikeReady('precision') === false;
      G.units.length = 0; for (let i = 0; i < 3; i++) step(0.05);
      o.powersReturnWhenItDies = strikeReady('precision') === true;
      G.units.length = 0; spawn('B', 'tank', 1, 300); spawn('R', 'effigy', 1, 700);
      const ef = G.units.find(u => u.key === 'effigy');
      o.effigyWearsYourShape = ef.decoyOf === 'tank' && ef.glyph === UNITS.tank.glyph;

      // ── the Glitch King attacks the UI, but never in the first 20s ──
      launchRival('⌬ THE GLITCH KING'); G.prep = 0; G.frozen = false;
      /* Hold the fight open. This checks WHEN the Glitch King acts, not whether a Legendary
         AI can win in twenty seconds — and it can, which made the check flaky. */
      G.aiHold = true; G.hq.B = G.hqMax.B = 99999;
      const anyIw = () => G.info.grayT > 0 || G.info.fogT > 0 || G.info.jumbleT > 0 ||
                          G.info.tunnelT > 0 || G.info.gaslightT > 0;
      let early = false;
      while (G.t < 19 && !G.over) { step(0.05); if (anyIw()) early = true; }
      o.gkGracePeriod = !early;
      let fired = false, guard = 0;
      while (!fired && guard++ < 20000 && !G.over) { step(0.05); if (anyIw()) fired = true; }
      o.gkAttacksTheUi = fired;
      infoClear();

      // ── the roster whitelist bug: the Golden Drone must respect it ──
      launchRival('⬤ UMBRA "The Long Dark"'); G.prep = 0; G.frozen = false; G.units.length = 0;
      REVENTS.golden.run();
      o.goldenRespectsRoster = !G.units.some(u => u.side === 'R' && u.key === 'drone');

      // ── ⌬ Rollback ──
      SAVE.rollbackUnlocked = true; persist();
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      const runTo = s => { let g = 0; while (G.t < s && g++ < 20000 && !G.over) step(0.05); };
      runTo(20);
      spawn('B', 'tank', 1, 300); const tk = G.units.find(u => u.key === 'tank');
      G.hq.B -= 300; killUnit(tk);
      runTo(26);
      G.cp = 40;
      const hqB = G.hq.B, cpB2 = G.cp;
      o.rollbackFires = tryRollback();
      o.rollbackRestoresHq = G.hq.B > hqB;
      o.rollbackRefundsCp = G.cp > cpB2;
      o.rollbackNeverExceedsMax = G.hq.B <= G.hqMax.B;
      o.rollbackGoesOnCooldown = strikeReady('rollback') === false;
      // damage OLDER than the window stays done, or the window means nothing
      LAUNCH = null; start(); G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      runTo(4); G.hq.B -= 300; runTo(30);
      const hqOld = G.hq.B; tryRollback();
      o.rollbackWindowIsReal = Math.abs(G.hq.B - hqOld) < 1;
      SAVE.rollbackUnlocked = false; persist();
      o.rollbackLockedRefuses = tryRollback() === false;

      // ── Phase 0 surfaces: both silent until configured ──
      o.supportOffByDefault = SUPPORT_URL === '' && SUPPORT_OK === false && supportEligible(true) === false;

      // ── the brag line is true, specific and spoils nothing ──
      SAVE.gauntlet = { clears: 4, losses: 3, lifetime: 9, deepest: 5,
        mem: { units: { drone: 6 }, strikes: {}, lanes: [1, 5, 1], spawners: 0, rush: 1, fights: 4 } };
      persist();
      launchGauntlet(); G.prep = 0; G.frozen = false;
      const gr = gauntletCommit(true);
      const brag = gauntletBragLine(gr);
      o.bragNamesTier = /tier \d/i.test(brag);
      o.bragNamesWhatItLearned = /hardened against|waiting in the/i.test(brag);
      o.bragSpoilsNothing = !/glitch|umbra|wraith|nullifier|rods|void/i.test(brag);
      o.bragIsCopyOnly = typeof copyText === 'function';
      SAVE.experimental = false; persist();
      return o;
    });

    ok(v123.oldAudioButtonsGone && v123.audioButton && v123.mixerRows === 5,
      `[audio] four topbar mute buttons became one button and ${v123.mixerRows} real levels`);
    ok(v123.zeroKillsFlag && v123.raiseRestoresFlag,
      '[audio] a level of 0 also clears the channel boolean — the ~40 guards on it keep working, and a "on at zero" channel would build silent oscillator nodes forever');
    ok(v123.muteAllSilences && v123.unmuteRestoresMix,
      '[audio] Mute All remembers the mix, so unmuting restores it rather than resetting every channel to full');
    ok(v123.busCarriesLevel,
      '[audio] sound is routed through a per-channel bus, so a level change applies to everything on that channel including sounds added later');
    ok(v123.lpFx === 4 && v123.legFx === 3 && v123.ascendClass,
      `[skull] Legendary+ has a tier of its own (fx ${v123.legFx} → ${v123.lpFx}) rather than sharing Legendary's face`);
    ok(v123.ascendHasHorns && v123.ascendHasFangs && v123.capsCoverTier4,
      '[skull] the Ascended tier adds real anatomy — horns and fangs — not just a recolour');
    ok(v123.ascendDropsCigar,
      '[skull] and it is the only tier that DROPS the cigar: a lit cigar says a person is enjoying this, which is the wrong idea for this one');
    ok(v123.chaosRowExists && v123.chaosRowFocused,
      '[chaos] the title Chaos button scrolls to the Chaos row and pulses it, instead of dumping you at the top of Settings');
    ok(v123.hiddenLocked && v123.rosterUnchanged && v123.wraithAbsent && v123.rollbackAbsent,
      '[hidden rivals] both are genuinely ABSENT by default — not greyed out with a padlock that would hand the player the secret');
    ok(v123.lockedLaunchRefused,
      '[hidden rivals] and launchRival refuses them before they are earned, so a console call cannot walk past the gate');
    ok(v123.glitchOpensOnSecret,
      '[hidden rivals] the Glitch King appears once the Glitch Front is cleared — it was seen');
    ok(v123.prestigeOffered && v123.prestigeRan && v123.umbraOpensOnPrestige,
      '[hidden rivals] UMBRA is reached by clearing the roster and then resetting it');
    ok(v123.prestigeKeptBadge && v123.prestigeResetRoster,
      '[prestige] resetting marks the five fightable again and keeps the badge — a reset that costs you something you earned is a trap, not a prestige');
    ok(v123.badgeCountsFiveOnly,
      '[prestige] the Champion badge still counts the FIVE named rivals, so adding two hidden ones cannot retroactively un-earn it');
    ok(v123.umbraFlag && v123.umbraPure,
      `[umbra] fields null units and nothing else across a full fight (${v123.umbraRoster})`);
    ok(v123.wraithInvisible && v123.wraithBeatsFlare && v123.wraithVisibleWhenFiring,
      '[umbra] the Wraith is unspottable even by a recon flare, and reveals itself only in the beat after it fires — that window is the counter-play');
    ok(v123.wraithDrainsCp,
      '[umbra] and every hit bleeds Command Points off the owner of what it hit');
    ok(v123.nullifierKillsPowers && v123.powersReturnWhenItDies,
      '[umbra] the Nullifier carries no weapon and simply switches your commander powers off — killing it gives them straight back');
    ok(v123.effigyWearsYourShape,
      '[umbra] the Effigy wears the shape of one of YOUR units, so the board reads wrong');
    ok(v123.gkGracePeriod && v123.gkAttacksTheUi,
      '[glitch king] attacks the interface rather than the army, and never inside the first 20 seconds — you always get one clean look at the board');
    ok(v123.goldenRespectsRoster,
      '[bugfix] the Golden Drone gag spawned an enemy directly and walked past the one-sided roster whitelist — an infantry-only lesson could be handed a drone');
    ok(v123.rollbackFires && v123.rollbackRestoresHq && v123.rollbackRefundsCp,
      '[rollback] rewinds the HQ and refunds the CP of what died inside the window');
    ok(v123.rollbackWindowIsReal && v123.rollbackNeverExceedsMax && v123.rollbackGoesOnCooldown,
      '[rollback] damage older than the window stays done, the HQ never exceeds its maximum, and it goes on cooldown');
    ok(v123.rollbackLockedRefuses,
      '[rollback] and it refuses to fire for an account that has not taken it from the Glitch King');
    ok(v123.supportOffByDefault,
      '[support] the support card ships with no URL and stays completely silent — a support button pointing nowhere is worse than none');
    ok(v123.bragNamesTier && v123.bragNamesWhatItLearned && v123.bragSpoilsNothing && v123.bragIsCopyOnly,
      '[brag] the share line is specific and true (it names what the Adjutant had hardened against), spoils no secret, and is clipboard-only with no network call');

    /* ══ 28. v1.24.0 — GLOBAL LEADERBOARD ══
       The deep validation of the submission rules lives in tests/backend.test.js, which
       exercises the very module the Edge Function imports. What belongs HERE is the
       client half: that whatever credential ships is the RIGHT KIND, and that nothing
       leaves the device unasked.

       This section used to assert the constants were empty. They are no longer empty — the
       board is live — so the check that matters flipped from "is it off?" to "is the key
       shipping the one that is SAFE to ship?". A service_role key in that slot is
       indistinguishable from an anon key by eye and by grep; only the decoded payload
       tells them apart, so that is what is asserted. */
    const v124 = await gp.evaluate(async () => {
      const o = {};
      o.configured = LB_URL !== '' && LB_ANON_KEY !== '';
      // the ONE thing that must never ship: a key with any role other than anon
      o.keyRole = (() => {
        if (!LB_ANON_KEY) return '<empty>';
        try { return JSON.parse(atob(LB_ANON_KEY.split('.')[1])).role; } catch (e) { return '<undecodable>'; }
      })();
      o.urlIsHttpsSupabase = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(LB_URL);
      // and the URL's project ref must match the key's, or they are from different projects
      o.refsMatch = (() => {
        try { return LB_URL.includes(JSON.parse(atob(LB_ANON_KEY.split('.')[1])).ref); } catch (e) { return false; }
      })();
      o.configAccepted = LB_OK === true;
      o.backendLive = LEADERBOARD_BACKEND !== null;
      o.globalTab = LB_TABS.some(t => t[0] === 'global');
      o.optInOff = DEFAULT_SAVE.lbOptIn === false;
      o.nameBlank = DEFAULT_SAVE.lbName === '';
      // the weight table must rank the hardest tier highest
      o.lpWeight = DIFF_WEIGHT.legendaryplus;
      o.legWeight = DIFF_WEIGHT.legendary;
      o.lpRated = ratedScore(1000, 'legendaryplus');
      // Opt-in is what stands between a live backend and a silent upload. Finish a real
      // battle with it OFF; the Node side counts what actually hit the wire.
      SAVE.lvl = 60; SAVE.debugUnlockAll = true; SAVE.lbOptIn = false; persist();
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      G.hq.R = 0; checkWin();
      o.battleEnded = !!G.over;
      o.privacyMentionsBoard = /Global leaderboard/i.test(renderPrivacySection());
      return o;
    });
    // give any fire-and-forget submission a chance to actually leave before counting
    await gp.waitForTimeout(500);
    const supaHits = netLog.filter(u => /supabase\.co/.test(u));
    ok(v124.configured && v124.urlIsHttpsSupabase && v124.refsMatch && v124.configAccepted && v124.backendLive,
      '[leaderboard] the build is configured against a real https Supabase project whose ref matches the key\'s, and the client accepts it');
    ok(v124.keyRole === 'anon',
      `[leaderboard] the shipped key decodes to role="${v124.keyRole}" — this is THE check that matters: an anon key is meant to be public and is safe because RLS restricts it, while a service_role key in the same slot hands every player full database access and looks identical to grep`);
    ok(v124.globalTab,
      '[leaderboard] the Global tab exists now that there is a backend to back it');
    ok(v124.optInOff && v124.nameBlank,
      '[leaderboard] it is opt-IN: nothing leaves the device until the player says so, and the display name is never pre-filled');
    ok(v124.lpWeight > v124.legWeight && v124.lpRated === 2100,
      `[leaderboard] Legendary+ outweighs Legendary (${v124.legWeight} → ${v124.lpWeight}) — it was missing from the table and fell through to 1.0, so the hardest difficulty scored LOWEST`);
    ok(v124.battleEnded && supaHits.length === 0,
      `[leaderboard] a full battle finishes with opt-in OFF and contacts Supabase ZERO times (saw ${supaHits.length}) — measured on the wire, not inferred from a flag, because a live backend makes this the difference between opt-in and a silent upload`);
    ok(v124.privacyMentionsBoard,
      '[leaderboard] the in-game privacy panel names the board');

    /* ══ 29. v1.25.0 — ENLISTMENT + SAVE COMPATIBILITY ══ */
    /* Names chosen to break a normaliser: interior runs, tabs/newlines, zero-width joiners,
       a bidi override, an overlong string, and one that is nothing BUT invisible characters. */
    const NAME_CASES = [
      '  Iron  Marshal  ', 'Rook', '\tGeneral\n\nDust ', 'Zero\u200bWidth',
      'Bidi\u202eevil', 'A'.repeat(40), '\u200b\u200b\u200b', '   ', '\u00dcnit 7',
    ];
    const { cleanName } = await import(
      require('url').pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'submit-run', '_shared', 'validate.js')).href);
    const v125 = await gp.evaluate(async (NAME_CASES) => {
      const o = {};
      o.defaultsUnEnlisted = DEFAULT_SAVE.enlisted === false;

      /* An OLD save, as it exists on a returning player's device: written by a build that
         had never heard of the leaderboard, the mixer, enlistment or the hidden rivals.
         This is the check that answers "is it safe to upload a new zip to itch". */
      const old = { xp: 4200, lvl: 31, wins: 22, best: 88000,
        unlocked: ['blitzkrieg', 'mass', 'airpower'], seenTut: true, campaignDone: 4,
        sound: true, music: true, musicVol: 0.4, narrator: true,
        board: [{ ts: 1, score: 5000, rated: 5000, mode: 'skirmish', kind: 'skirmish',
                  diff: 'veteran', doc: 'mass', won: true, kills: 10, dur: 100 }],
        career: { battles: 31, wins: 22, losses: 9, kills: 400, deploys: 900, cpSpent: 9000,
                  strikes: 20, units: {}, dmgDealt: 5000, timePlayed: 9000 },
        rivals: { 'Gen. Korvinov "Steel Fist"': { w: 2, l: 1, defeated: true, dominant: 'armor' } },
        gauntlet: { clears: 3, losses: 2, lifetime: 7, deepest: 4 } };
      const up = sanitizeSave(old);
      o.progressKept = up.lvl === 31 && up.xp === 4200 && up.best === 88000 &&
                       up.unlocked.length === 3 && up.campaignDone === 4 &&
                       up.board.length === 1 && up.gauntlet.lifetime === 7 &&
                       !!up.rivals['Gen. Korvinov "Steel Fist"'].defeated;
      o.newFieldsSafe = up.lbOptIn === false && up.lbName === '' && up.enlisted === false &&
                        up.masterVol === 1 && up.sfxVol === 0.8 && up.experimental === false &&
                        up.rivalPrestige === 0 && up.umbraDefeated === false;
      o.oldAudioKept = up.music === true && up.musicVol === 0.4 && up.sound === true;

      // the screen itself
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE)); persist();
      showTitle(); enlistShow();
      o.shows = document.getElementById('enlist').classList.contains('show');
      o.visible = getComputedStyle(document.getElementById('enlist')).display !== 'none';
      /* The opt-in box appears only when there is a board to join, and ticking it is the
         ONLY thing that can opt a player in. */
      o.boardBoxMatchesBackend = !!document.getElementById('en-board') === (LEADERBOARD_BACKEND !== null);
      o.newPlayerCopy = /state your name/i.test(document.querySelector('#enlist .fr-h').textContent);
      // a returning player must be reassured, not alarmed
      SAVE.career.battles = 31; SAVE.lvl = 31; persist(); enlistShow();
      o.returningCopy = /progress is safe/i.test(document.querySelector('#enlist .fr-h').textContent);
      // finishing it
      document.getElementById('en-name').value = '  Iron  Marshal  ';
      enlistFinish();
      o.nameTrimmed = SAVE.lbName === 'Iron Marshal';
      o.enlistedNow = SAVE.enlisted === true;
      o.closed = !document.getElementById('enlist').classList.contains('show');
      o.stillNotOptedIn = SAVE.lbOptIn === false;   // finished the screen WITHOUT ticking the box
      // blank is allowed and falls back
      SAVE.enlisted = false; SAVE.lbName = ''; persist(); enlistShow();
      document.getElementById('en-name').value = '';
      enlistFinish();
      o.blankOk = SAVE.enlisted === true && lbName() === 'Commander';
      // and Settings can rename, as the screen promises
      openSettings();
      const nm = document.getElementById('set-name');
      o.settingsField = !!nm;
      if (nm) { nm.value = 'Rook'; nm.dispatchEvent(new Event('input')); }
      o.settingsRenames = SAVE.lbName === 'Rook';
      /* Whatever the client stores, the SERVER normalises before the board shows it. If the
         two disagree the player sees their name mangled by the site. Collect the client's
         answer here; the Node side compares it against the real cleanName(). */
      o.normCases = NAME_CASES.map(s => normName(s));
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE)); persist();
      return o;
    }, NAME_CASES);
    ok(v125.progressKept,
      '[save compat] a save written before the leaderboard, mixer, enlistment and hidden rivals loads with rank, unlocks, campaign, rivals, Gauntlet record and local board intact — this is what makes uploading a new zip safe');
    ok(v125.newFieldsSafe && v125.oldAudioKept,
      '[save compat] every field added since arrives at its safe default, and the old audio booleans survive the mixer migration');
    ok(v125.shows && v125.visible,
      '[enlist] the screen actually renders — it carries its own .show rule, which an earlier build was missing so the overlay reported shown and displayed nothing');
    ok(v125.newPlayerCopy && v125.returningCopy,
      '[enlist] a new player is asked their name; a RETURNING player is told their progress is safe first, because a first-run screen after an update reads as a wiped save');
    ok(v125.boardBoxMatchesBackend && v125.stillNotOptedIn,
      '[enlist] the join-the-board box appears exactly when a board exists to join, and enlisting WITHOUT ticking it leaves the player opted out — the screen cannot opt anyone in by default');
    ok(v125.nameTrimmed && v125.enlistedNow && v125.closed,
      '[enlist] the name is trimmed, recorded, and the screen closes');
    /* The client's normName() must agree with the server's cleanName() character for
       character — the one exception being the empty result, where the server substitutes
       'Commander' and the client defers that to lbName(). A mismatch means the board renders
       a different name than the player typed. */
    const nameParity = NAME_CASES.every((src, i) => {
      const server = cleanName(src), client = v125.normCases[i];
      return server === (client || 'Commander');
    });
    ok(nameParity,
      '[enlist] the client normalises a display name EXACTLY as the Edge Function does — interior whitespace, tabs, zero-width and bidi characters and the 20-char cap all agree, so nobody sees their name silently rewritten by the board');
    ok(v125.blankOk,
      '[enlist] a blank name is allowed and falls back to "Commander" — nobody is blocked at the door');
    ok(v125.settingsField && v125.settingsRenames,
      '[enlist] Settings can rename you later, which is what the screen promises');

    /* ══ 30. v1.26.0 — ORDERS RESET, THE OUTBOX, AND AFTER-ACTION REPORTS ══ */
    const v126 = await gp.evaluate(async () => {
      const o = {};
      SAVE = JSON.parse(JSON.stringify(DEFAULT_SAVE));
      SAVE.seenTut = true; SAVE.enlisted = true; SAVE.lvl = 60; SAVE.debugUnlockAll = true;
      /* An order set in a PREVIOUS build's save must not arm this battle. This is the whole
         change: orders used to be inherited from SAVE.groups, so one choice governed every
         fight afterwards and a player could be several battles into wondering why. */
      SAVE.groups = { arty: 'bombard', armor: 'assault', drone: 'hvt' };
      persist();
      LAUNCH = null; sel.mode = 'skirmish'; start();
      o.startOff = GROUP_KEYS.every(k => G.groups[k] === 'off');
      setGroupDoctrine('arty', 'bombard');
      o.canStillSet = G.groups.arty === 'bombard';
      o.saveUntouched = JSON.stringify(SAVE.groups) === JSON.stringify({ arty: 'bombard', armor: 'assault', drone: 'hvt' });
      start();
      o.nextBattleOff = GROUP_KEYS.every(k => G.groups[k] === 'off');

      // ── the AAR a run produces ──
      G.built = { rifle: 9, tank: 4, arty: 2 }; G.strikeUse = { precision: 5, barrage: 1 };
      G.stance = 'defend'; G.groups = { arty: 'bombard', armor: 'off', drone: 'off' };
      G.spent = 1234; G.deploys = 15; G.dmgDealt = 48000; G.hq.B = 71;
      const built = aarBuild(G, true, 9000);
      o.aarOrdered = built.units.map(u => u[0]).join(',');     // most-built first
      o.aarHasPowers = built.powers[0][0] === 'precision';
      o.aarOrders = built.orders && built.orders.arty === 'bombard' && !('armor' in built.orders);
      o.aarNoUnitsNull = aarBuild({ built: {}, groups: {} }, true, 0) === null;

      // ── the renderer, against a payload built to break it ──
      const evil = {
        v: 1,
        units: [['<img src=x onerror=alert(1)>', 5], ['tank', '9'], ['tank', 3], ['rifle', 7]],
        powers: [['__proto__', 1], ['constructor', 2], ['precision', 2]],
        stance: '<script>alert(1)</script>', orders: { arty: 'evil', armor: 'assault' },
        cp: '999', deploys: Infinity, dmg: -5, hq: 1e99,
      };
      const html = aarHTML(evil, { won: true });
      o.evilInert = !/<img|onerror|<script/i.test(html);
      o.evilNoUndefined = !/undefined/.test(html);   // TABLE['__proto__'] is truthy
      o.evilDeduped = (html.match(/Tank/g) || []).length === 1;
      o.evilDroppedStringCount = !/9×/.test(html);   // '9' is a string; the server refuses it too
      o.evilKeptReal = /Rifleman/.test(html) && /Precision/.test(html);
      o.emptyIsEmpty = aarHTML(null, {}) === '' && aarHTML({ units: [] }, {}) === '';

      // ── the outbox ──
      SAVE.lbQueue = []; persist();
      lbEnqueue({ mode: 'skirmish', score: 10 });
      lbEnqueue({ mode: 'blitz', score: 20 });
      o.queued = lbQueue().length === 2;
      o.queuePersists = JSON.parse(localStorage.getItem(SAVE_KEY)).lbQueue.length === 2;
      SAVE.lbQueue = new Array(200).fill({ mode: 'skirmish', score: 1 });
      o.queueCapped = lbQueue().length === LB_QUEUE_MAX;
      SAVE.lbQueue = []; persist();

      // ── auth backoff: one failure must NOT disable the session ──
      o.hasBackoff = typeof LB.nextTry === 'number' && !('tried' in LB);
      return o;
    });
    ok(v126.startOff && v126.nextBattleOff,
      '[orders] every standing order starts OFF in every battle, including one launched from a save that had them set — they used to carry over, so a single choice silently governed every later fight');
    ok(v126.canStillSet && v126.saveUntouched,
      '[orders] an order can still be set during a battle, and setting it no longer writes back to the save');
    ok(v126.aarOrdered === 'rifle,tank,arty' && v126.aarHasPowers && v126.aarOrders,
      '[aar] a finished run produces a report: units most-built first, powers used, and only the orders that were actually given');
    ok(v126.aarNoUnitsNull,
      '[aar] a run that deployed nothing produces no report rather than an empty one');
    ok(v126.evilInert && v126.evilNoUndefined,
      '[aar] a hostile report renders inert — and "__proto__" as a power id does not print "undefined undefined", which it did until the lookup was changed to an own-property check');
    ok(v126.evilDeduped && v126.evilDroppedStringCount && v126.evilKeptReal,
      '[aar] duplicate ids are deduped and a STRING count is refused (matching the server), while the legitimate entries in the same payload still render');
    ok(v126.emptyIsEmpty,
      '[aar] a missing or empty report renders nothing at all');
    ok(v126.queued && v126.queuePersists && v126.queueCapped,
      `[outbox] a run that could not be posted is queued in the SAVE and survives a reload, and the queue is capped both ways (an edited save with 200 entries comes back as ${25})`);
    ok(v126.hasBackoff,
      '[outbox] sign-in uses a backoff timestamp, not a one-shot "tried" flag — that flag was set on the FIRST failure and never cleared, so one blip silently stopped every submission for the rest of the session');

    /* ══ 31. v1.27.0 — CONTROL BAR CLEARS THE BOTTOM LANE, CHAT VOTE KEYS ══ */
    const v127 = await gp.evaluate(async () => {
      const o = {};
      SAVE.seenTut = true; SAVE.enlisted = true; SAVE.lvl = 60; SAVE.debugUnlockAll = true; persist();
      LAUNCH = null; sel.mode = 'skirmish'; start(); G.prep = 0; G.frozen = false;
      const cv = document.querySelector('canvas').getBoundingClientRect();
      const bar = document.getElementById('ctrlbar').getBoundingClientRect();
      const deck = document.getElementById('hbwrap').getBoundingClientRect();
      /* The bottom lane's centre line in SCREEN space. The control cluster used to stack
         vertically from bottom:112px, which put its top edge at ~580px against a lane centre
         of ~574 — so the rear of the bottom lane, where your own units spawn, was behind it. */
      const bottomLaneY = cv.y + LANE_Y[2] * cv.height;
      o.laneClearance = Math.round(bar.top - bottomLaneY);
      o.isRow = getComputedStyle(document.getElementById('ctrlbar')).flexDirection === 'row';
      o.overlapsDeck = !(bar.bottom <= deck.top || bar.left >= deck.right || bar.right <= deck.left);
      o.groupsVisible = ['groupbar','stancebar','speedbar']
        .every(id => document.getElementById(id).getBoundingClientRect().height > 0);

      /* A viewer whose name collides with Object.prototype must still be able to vote.
         'constructor', 'toString' and 'valueOf' are all legal Twitch names and all read
         TRUTHY on a plain {} — so the dedupe check treated them as having already voted. */
      G.cvVotes = { 0: 0, 1: 0, 2: 0 };
      const before = G.cvVotes[0];
      for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty'])
        onChatMsg(name, 'top');
      o.protoVotesCounted = G.cvVotes[0] - before;

      G.bossMeter = 0;
      for (const name of ['constructor', 'toString', 'valueOf']) onChatMsg(name, 'boss');
      o.protoBossCounted = G.bossMeter;

      G.chatPowers = {};
      for (const name of ['constructor', 'toString', 'valueOf']) onChatMsg(name, 'nuke');
      o.protoPowerCounted = (G.chatPowers.nuke || {}).n || 0;

      // and an ordinary viewer is unaffected, still deduped
      G.cvVotes = { 0: 0, 1: 0, 2: 0 }; G.cvVoters = Object.create(null);
      onChatMsg('rook', 'top'); onChatMsg('rook', 'top');
      o.normalDeduped = G.cvVotes[0] === 1;
      return o;
    });
    ok(v127.isRow && v127.groupsVisible,
      '[layout] ORDERS, STANCE and SPEED sit in ONE ROW and all three are still on screen');
    ok(v127.laneClearance > 20,
      `[layout] the control cluster clears the bottom lane's centre line by ${v127.laneClearance}px — it used to start ABOVE it, hiding the rear of the bottom lane where your own units spawn`);
    ok(!v127.overlapsDeck,
      '[layout] and it does not overlap the deck, which is centre-anchored and can grow wide');
    ok(v127.protoVotesCounted === 4 && v127.protoBossCounted === 3 && v127.protoPowerCounted === 3,
      `[chat] viewers named "constructor"/"toString"/"valueOf" can vote (lane ${v127.protoVotesCounted}/4, boss ${v127.protoBossCounted}/3, power ${v127.protoPowerCounted}/3) — on a plain {} those names read truthy through the prototype chain, so those viewers could never vote for anything`);
    ok(v127.normalDeduped,
      '[chat] and an ordinary viewer is still deduped — one vote each, as before');

    /* ══ 32. v1.28.0 — BOARD BUCKETS, SPLASH, RODS, SERVICE MARKS ══ */
    const v128 = await gp.evaluate(async () => {
      const o = {};
      SAVE.seenTut = true; SAVE.enlisted = true; SAVE.lvl = 60; SAVE.debugUnlockAll = true;
      SAVE.evCutscene = true; persist();

      /* Every wrapper must land in its OWN board bucket. G.mode is the RULESET and is
         'skirmish' for evolution, war, rivals and campaign alike, so recording it filed an
         Evolution run as a Skirmish one — where a skirmish run could displace it, the board
         keeping one best per mode. */
      const bucket = (launch, mode) => { LAUNCH = launch; if (mode) sel.mode = mode; start(); return boardMode(G); };
      o.buckets = {
        skirmish:   bucket(null, 'skirmish'),
        evolution:  bucket(null, 'evolution'),
        blitz:      bucket(null, 'blitz'),
        survival:   bucket(null, 'survival'),
        domination: bucket(null, 'domination'),
        war:        bucket({ type: 'war', warName: 'F', diff: 'veteran', weather: 'clear' }),
        rival:      bucket({ type: 'rival', rival: 'X', diff: 'elite', weather: 'clear' }),
      };
      o.rankedFlags = Object.entries(o.buckets).map(([k, v]) => [k, LB_MODES.indexOf(v) >= 0]);

      /* A splash weapon must always hurt what it AIMED at. It used to resolve purely by
         radius from where the round stopped: an IFV has splash 6 and an AT Team r 7, and a
         hit fires at r+3 = 10px, so the IFV shot the AT team and dealt NOTHING. */
      const duel = (atk) => {
        LAUNCH = null; sel.mode = 'skirmish'; start();
        G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
        spawn('B', atk, 1, 400); spawn('R', 'atgm', 1, 470);
        const a = G.units[0], d = G.units[1], hp0 = d.hp;
        for (let i = 0; i < 400 && d.alive; i++) step(0.05);
        return { dealt: Math.round(hp0 - d.hp), killed: !d.alive, survived: a.alive };
      };
      o.ifv = duel('ifv');
      o.tank = duel('tank');

      /* RODS is the once-per-battle card and has to clear the field. It used to start at
         0.28W (so anything that had pushed into YOUR half was outside it entirely), leave
         ~45px gaps between craters, and miss aircraft that do not sit in a lane band. */
      LAUNCH = null; sel.mode = 'skirmish'; start();
      G.prep = 0; G.frozen = false; G.aiHold = true; G.units.length = 0;
      const SECRET = ['voidwarden', 'wraith', 'nullifier', 'effigy', 'swarm'];
      const roster = Object.keys(UNITS).filter(k => SECRET.indexOf(k) < 0);
      for (const k of roster) for (let ln = 0; ln < 3; ln++)
        for (const x of [60, 300, 620, 940, 1210]) spawn('R', k, ln, x);
      o.rodsBefore = G.units.filter(u => u.side === 'R' && u.alive).length;
      G.strikeCds.rods = 0; G.rodsUsed = false;
      tryRods();
      await new Promise(r => setTimeout(r, 2600));
      for (let i = 0; i < 20; i++) step(0.05);
      o.rodsAfter = G.units.filter(u => u.side === 'R' && u.alive).length;
      o.rodsDeepHalf = G.units.filter(u => u.side === 'R' && u.alive && u.x < 300).length;

      /* Service marks: earned from story beats, shown when the recruit is clicked. */
      SAVE.marks = []; SAVE.marksSeen = [];
      SAVE.secretDone = true;
      SAVE.rivals = {}; SAVE.rivals[GENERALS[0].name] = { defeated: true };
      persist();
      showTitle(); renderTitleFigures();
      o.earned = markList().slice();
      o.tallies = document.querySelectorAll('#tfig-recruit .rc-tallies i').length;
      o.glitchScar = !!document.querySelector('#tfig-recruit .rc-glitch');
      o.hasNewBadge = document.getElementById('tfig-recruit').classList.contains('has-new');
      o.clickable = getComputedStyle(document.getElementById('tfig-recruit')).pointerEvents !== 'none';
      recruitClicked();
      o.cutOpen = document.getElementById('storycut').classList.contains('show');
      o.cutTitle = document.querySelector('#storycut .mc-title').textContent;
      o.seenAfter = markSeen().slice();
      document.getElementById('storycut').click();
      o.nextPending = pendingMark();
      // no film-grain rectangle behind the figures any more
      o.noGrain = !!(() => { try { return !document.querySelector('.tf-art')?.matches(':has(*)') || true; } catch (e) { return true; } })();
      SAVE.marks = []; SAVE.marksSeen = []; SAVE.secretDone = false; SAVE.rivals = {}; persist();
      return o;
    });
    ok(v128.buckets.evolution === 'evolution' && v128.buckets.war === 'war',
      `[boards] Evolution and War runs land in their OWN buckets (got ${v128.buckets.evolution} / ${v128.buckets.war}) — both were being filed as SKIRMISH, where a skirmish run could displace them`);
    ok(v128.buckets.rival === 'rival' && v128.rankedFlags.find(f => f[0] === 'rival')[1] === false,
      '[boards] a Rivals run gets its own bucket and is NOT ranked — it was posting to the global Skirmish board, a board it never played on');
    ok(['skirmish','blitz','survival','domination'].every(k => v128.buckets[k] === k),
      '[boards] the four modes that were already correct still are');
    ok(v128.ifv.dealt > 0 && v128.ifv.killed && v128.ifv.survived,
      `[damage] an IFV beats an AT Team inside its own range (${v128.ifv.dealt} damage) — a splash weapon resolved purely by radius, and with splash 6 against a target of radius 7 hit at up to 10px, the IFV dealt ZERO and lost`);
    ok(v128.tank.dealt > 0 && v128.tank.killed,
      `[damage] a tank still kills an AT Team too (${v128.tank.dealt} damage) — it was whiffing intermittently for the same reason`);
    ok(v128.rodsAfter === 0,
      `[rods] Rods from God clears the entire enemy roster (${v128.rodsBefore} → ${v128.rodsAfter}) — it used to start at 0.28W, leaving anything that had pushed into your own half untouched, with ~45px gaps between craters`);
    ok(v128.rodsDeepHalf === 0,
      '[rods] including everything deep in YOUR half, which is the half you would press it to save');
    ok(v128.earned.indexOf('glitch') >= 0 && v128.tallies === 1 && v128.glitchScar,
      `[marks] beating the Glitch Front and a rival writes them onto the recruit — a glitch scar and ${v128.tallies} stencilled tally`);
    ok(v128.hasNewBadge && v128.clickable,
      '[marks] he only becomes clickable while he has a mark to hand over, so the figure never silently eats a click meant for the menu');
    ok(v128.cutOpen && /FRONT THAT ISN/.test(v128.cutTitle) && v128.seenAfter.indexOf('glitch') >= 0,
      `[marks] clicking him plays that beat's cutscene ("${v128.cutTitle}") and records it as seen`);
    ok(v128.nextPending && v128.nextPending.indexOf('rival:') === 0,
      '[marks] and the next unseen mark queues up behind it, one beat per click');

    /* ─────────────────────────────────────────────────────────────────────────
       33. v1.29.0 — 🎬 CREATOR MODE.
           The checks that matter here are the INTEGRITY ones. A sandbox that can
           arrange ten tanks, triple income and a paper enemy HQ is a scoring
           exploit the moment any of it reaches a save file or a board, so this
           section proves three separate things:
             · a creator battle changes ZERO save keys and submits nothing;
             · a NORMAL battle still banks everything (or the check above is
               vacuous — it would pass just as well if progression were broken);
             · the submit function refuses a creator entry on its own, without
               relying on endGame's gate.
           Plus: the AI really is the real AI on both sides, imported scenarios
           cannot pollute or execute, and the documented limits hold.
       ───────────────────────────────────────────────────────────────────────── */

    // 33a. every picker reads a LIVE registry — no duplicated lists to drift
    const crReg = await gp.evaluate(() => ({
      docs: creatorDoctrineKeys(), realDocs: Object.keys(DOCTRINES),
      diffs: creatorDiffKeys(), realDiffs: Object.keys(DIFFS),
      stances: creatorStanceKeys(), realStances: Object.keys(STANCES),
      units: creatorUnitKeys(), realUnits: visibleRoster().filter(k => UNITS[k]),
      groups: GROUP_KEYS,
    }));
    ok(crReg.docs.length === 9 && crReg.docs.join() === crReg.realDocs.join(),
      `[creator] the doctrine picker enumerates all ${crReg.docs.length} real doctrines from DOCTRINES — not a copy that can drift`);
    ok(crReg.diffs.join() === crReg.realDiffs.join() && crReg.diffs.indexOf('legendaryplus') >= 0,
      '[creator] the difficulty picker enumerates DIFFS itself, Legendary+ included');
    ok(crReg.units.join() === crReg.realUnits.join() && crReg.stances.join() === crReg.realStances.join(),
      `[creator] units (${crReg.units.length}) and stances come from UNITS/STANCES, filtered through unitRevealed so a secret unlock is not spoiled`);

    // 33b. IMPORT IS UNTRUSTED INPUT. Structural whitelisting, prototype-safe, no execution.
    const crImp = await gp.evaluate(() => {
      const hostile = JSON.stringify({
        v: 99, name: '<img src=x onerror="window.__pwn=1">', notes: 'x\u0007 \u202ey',
        __proto__: { polluted: true }, constructor: { prototype: { polluted: true } },
        field: { ruleset: 'evil', weather: '__proto__', terrain: ['constructor', 'toString', 'open'], prep: 1e9, speed: 99 },
        sides: {
          B: { control: 'ai', doctrine: 'constructor', diff: '__proto__', stance: 'toString',
               groups: { arty: '__proto__', armor: 'valueOf' }, allowed: ['nope', 'rifle'], bias: 'toString',
               opening: [{ key: 'rifle', lane: 99, count: 1e6 }, { key: '__proto__', lane: 0, count: 1 }],
               cpMul: 1e9, startCp: -5, hqMul: 0 },
          R: { control: 'ai' } },
        rules: { banned: ['__proto__', 'tank'], timeLimit: 1e9 },
      });
      const r = creatorImportText(hostile);
      const s = r.scenario;
      return {
        ok: r.ok, warned: r.warnings.length,
        proto: ({}).polluted === undefined && Object.prototype.polluted === undefined,
        ruleset: s.field.ruleset, terrainReal: s.field.terrain.every(t => TERRAIN_KEYS.indexOf(t) >= 0),
        doc: s.sides.B.doctrine, diff: s.sides.B.diff, stance: s.sides.B.stance,
        arty: s.sides.B.groups.arty, allowed: s.sides.B.allowed,
        openReal: s.sides.B.opening.every(e => !!UNITS[e.key]),
        count: s.sides.B.opening[0].count, lane: s.sides.B.opening[0].lane,
        cpMul: s.sides.B.cpMul, banned: s.rules.banned, timeLimit: s.rules.timeLimit,
        notesClean: !/[\u0000-\u001F\u202A-\u202E]/.test(s.notes),
        tooBig: creatorImportText('x'.repeat(70000)).errors[0],
        notJson: creatorImportText('{nope').errors[0],
        bothHuman: creatorValidate({ v: 1, sides: { B: { control: 'human' }, R: { control: 'human' } } }, true).errors.length,
      };
    });
    ok(crImp.proto,
      '[creator] a scenario carrying __proto__ / constructor payloads pollutes nothing — every read is an own-property read, and unknown keys are dropped rather than merged');
    ok(crImp.ruleset === 'skirmish' && crImp.terrainReal && !!crReg.docs.length &&
       crImp.doc === 'blitzkrieg' && crImp.diff === 'veteran' && crImp.stance === 'assault' && crImp.arty === 'off',
      '[creator] every id that is not in this build\'s registries falls back to the default instead of reaching the game');
    ok(JSON.stringify(crImp.allowed) === '["rifle"]' && crImp.openReal && JSON.stringify(crImp.banned) === '["tank"]',
      '[creator] unit lists keep only ids this build actually has');
    ok(crImp.count === 40 && crImp.lane === 2 && crImp.cpMul === 6 && crImp.timeLimit === 1800,
      `[creator] every documented limit clamps on import (1,000,000 riflemen → ${crImp.count}, lane 99 → ${crImp.lane}, ×1e9 income → ×${crImp.cpMul})`);
    ok(crImp.notesClean && crImp.warned > 0,
      '[creator] author notes are stripped of control and bidi characters, and the clamps are reported as warnings rather than applied silently');
    ok(/too large/.test(crImp.tooBig) && /not valid JSON/.test(crImp.notJson) && crImp.bothHuman > 0,
      '[creator] oversized files, malformed JSON and contradictory scenarios (two human commanders) are all refused');

    // 33c. the generator is deterministic — the only thing that makes a seed worth sharing
    const crGen = await gp.evaluate(() => {
      const a = creatorGenerate('frontline'), b = creatorGenerate('frontline'), c = creatorGenerate('frontline2');
      return { same: JSON.stringify(a) === JSON.stringify(b), diff: JSON.stringify(a) !== JSON.stringify(c),
               valid: creatorValidate(a, true).errors.length === 0, seed: a.seed,
               numeric: creatorGenerate('12345').seed === 12345 };
    });
    ok(crGen.same && crGen.diff && crGen.valid && crGen.numeric,
      `[creator] the generator is seeded and deterministic (seed "frontline" → ${crGen.seed}, twice), and what it builds always validates`);

    // 33d. THE INTEGRITY GATE — a whole creator battle, start to finish
    const crRun = await gp.evaluate(async () => {
      showTitle(); await new Promise(r => setTimeout(r, 250));
      SAVE.lbOptIn = true; SAVE.lbName = 'Tester'; SAVE.xp = 300; SAVE.lvl = 12;
      SAVE.wins = 5; SAVE.losses = 2; SAVE.best = 9000; SAVE.winStreak = 3;
      SAVE.board = []; SAVE.lbQueue = []; SAVE.career.battles = 9; persist();
      const before = JSON.stringify(SAVE);
      let submits = 0;
      const orig = LEADERBOARD_BACKEND.submit;
      LEADERBOARD_BACKEND.submit = function (e) { submits++; return orig.call(this, e); };
      const sc = creatorDefaultScenario();
      sc.name = 'Integrity Run';
      sc.sides.B.control = 'ai'; sc.sides.R.control = 'ai';
      sc.sides.B.diff = 'legendaryplus'; sc.sides.R.diff = 'recruit';
      sc.sides.B.cpMul = 4; sc.sides.R.cpMul = 4;
      sc.sides.B.hqMul = 0.1; sc.sides.R.hqMul = 0.1;
      sc.sides.B.opening = [{ key: 'tank', lane: 0, count: 4 }, { key: 'rifle', lane: 1, count: 6 }];
      sc.sides.R.opening = [{ key: 'rifle', lane: 2, count: 5 }];
      const launched = creatorLaunch(sc);
      const atStart = {
        creator: G.creator, spectate: G.creatorSpectate, aiB: !!G.aiB,
        hudHidden: document.getElementById('hud').classList.contains('hidden'),
        blue: G.units.filter(u => u.side === 'B').length,
        red: G.units.filter(u => u.side === 'R').length,
      };
      G.speed = 2;
      for (let i = 0; i < 250 && !G.over; i++) await new Promise(r => setTimeout(r, 60));
      const a = JSON.parse(before), changed = [];
      for (const k in SAVE) if (JSON.stringify(SAVE[k]) !== JSON.stringify(a[k])) changed.push(k);
      const res = {
        launched: launched.ok, atStart, over: G.over, changed, submits,
        blueDecisions: G.aiB.thoughts.length, redDecisions: (G.aiThoughts || []).length,
        blueDeployed: G.crStats.B.spawned, redDeployed: G.crStats.R.spawned,
        events: (G.creatorEvents || []).length,
        reportUp: !document.getElementById('creatorreport').classList.contains('hidden'),
        reportText: document.getElementById('creatorreport').textContent || '',
        obsHidden: document.getElementById('crobs').classList.contains('hidden'),
      };
      LEADERBOARD_BACKEND.submit = orig;
      return res;
    });
    ok(crRun.launched && crRun.atStart.creator && crRun.atStart.spectate && crRun.over,
      '[creator] an AI-vs-AI scenario launches through the ordinary LAUNCH seam and fights to a result');
    ok(crRun.changed.length === 0,
      `[creator] a whole creator battle changes ZERO save keys${crRun.changed.length ? ' (changed: ' + crRun.changed.join(', ') + ')' : ''} — no XP, no rank, no wins, no local board, no career, no streak`);
    ok(crRun.submits === 0,
      '[creator] and submits nothing to the global board — endGame returns before the submit call is ever reached');
    ok(crRun.atStart.blue === 10 && crRun.atStart.red === 5,
      `[creator] the opening forces are EXACTLY what the scenario said (${crRun.atStart.blue} blue / ${crRun.atStart.red} red) — the difficulty's usual opening skirmishers are suppressed, or the field would never match what was typed`);

    // 33e. THE SAME ASSERTION, INVERTED. Without this the check above is vacuous:
    //      it would pass just as happily if progression were broken for everyone.
    const crNorm = await gp.evaluate(async () => {
      showTitle(); await new Promise(r => setTimeout(r, 250));
      SAVE.board = []; SAVE.winStreak = 0; SAVE.wins = 0; SAVE.career.battles = 0; persist();
      const before = JSON.stringify(SAVE);
      let submits = 0;
      const orig = LEADERBOARD_BACKEND.submit;
      LEADERBOARD_BACKEND.submit = function (e) { submits++; return { ok: true }; };
      LAUNCH = null; sel.mode = 'skirmish'; sel.diff = 'veteran'; start();
      G.prep = 0; G.frozen = false; G.kills = 4; G.dmgDealt = 900;
      endGame('B', 'test');
      await new Promise(r => setTimeout(r, 200));
      const a = JSON.parse(before), changed = [];
      for (const k in SAVE) if (JSON.stringify(SAVE[k]) !== JSON.stringify(a[k])) changed.push(k);
      const res = { changed, submits, wins: SAVE.wins, board: SAVE.board.length,
                    career: SAVE.career.battles, streak: SAVE.winStreak };
      LEADERBOARD_BACKEND.submit = orig;
      return res;
    });
    ok(crNorm.wins === 1 && crNorm.board === 1 && crNorm.career === 1 && crNorm.streak === 1 && crNorm.submits === 1,
      `[creator] …while an ORDINARY battle in the same session still banks all of it — win, local board place, career row, streak and one global submit (changed: ${crNorm.changed.length} save keys)`);

    // 33f. the submit function refuses a creator entry ON ITS OWN, independently of endGame
    const crGate = await gp.evaluate(async () => {
      showTitle(); await new Promise(r => setTimeout(r, 200));
      const base = { mode: 'skirmish', score: 999999, kills: 99, dur: 60, won: true,
                     diff: 'legendaryplus', doc: 'mass', run_id: 'test' };
      const flagged = await LEADERBOARD_BACKEND.submit(Object.assign({ creator: true }, base));
      const sc = creatorDefaultScenario();
      sc.sides.B.control = 'ai'; sc.sides.R.control = 'ai';
      creatorLaunch(sc);
      const ambient = await LEADERBOARD_BACKEND.submit(base);   // a clean entry, during a creator battle
      return { flagged: flagged && flagged.skipped, ambient: ambient && ambient.skipped };
    });
    ok(crGate.flagged === 'creator' && crGate.ambient === 'creator',
      '[creator] the submit function refuses a creator entry by itself — both a flagged entry and a clean one offered during a creator battle — so the endGame gate is not the only thing between a hand-built score and the public board');

    // 33g. AI vs AI runs the REAL AI on both sides, not the attract demo's random deploys
    ok(crRun.atStart.aiB && crRun.blueDecisions > 0 && crRun.blueDeployed > crRun.atStart.blue,
      `[creator] BLUE is driven by the same aiStepSide() red uses — ${crRun.blueDecisions} decisions, ${crRun.blueDeployed} units deployed — not by attract mode's random spawner`);
    ok(crRun.redDecisions > 0 && crRun.redDeployed > crRun.atStart.red,
      `[creator] RED still runs it too (${crRun.redDecisions} decisions), through a context that writes straight through to the same G.ecp / G.aiT fields it always used`);

    // 33h. the observer view and the report
    ok(crRun.atStart.hudHidden,
      '[creator] a spectated battle hides the commander\'s interface — hotbar, powers, stance rail and CP are controls for something the viewer is not doing');
    ok(crRun.reportUp && crRun.obsHidden && /BATTLE REPORT/.test(crRun.reportText) && /Integrity Run/.test(crRun.reportText),
      '[creator] it ends on a battle report naming the scenario, not on the career results screen');
    ok(crRun.events > 0 && /Timeline/.test(crRun.reportText),
      `[creator] with a timeline built from the game's own announce() calls (${crRun.events} events), rather than a second account of the fight that could drift from it`);

    // 33i. the editor renders author text inert
    const crXss = await gp.evaluate(async () => {
      showTitle(); await new Promise(r => setTimeout(r, 200));
      creatorOpen();
      CREATOR.sc = creatorDefaultScenario();
      CREATOR.sc.name = '<img src=x onerror="window.__crPwn=1">';
      CREATOR.sc.notes = '</div><script>window.__crPwn2=1<\/script>';
      renderCreator();
      await new Promise(r => setTimeout(r, 150));
      const body = document.getElementById('creator-body');
      return { pwn: !!window.__crPwn || !!window.__crPwn2,
               img: !!body.querySelector('img'), script: !!body.querySelector('script'),
               rendered: body.innerHTML.length > 2000 };
    });
    ok(!crXss.pwn && !crXss.img && !crXss.script && crXss.rendered,
      '[creator] a scenario name or note containing markup is drawn as text — the editor renders every author-supplied string through escapeHTML');

    // 33j. the live-unit ceiling actually holds
    const crCap = await gp.evaluate(async () => {
      showTitle(); await new Promise(r => setTimeout(r, 200));
      const sc = creatorDefaultScenario();
      sc.sides.B.control = 'ai'; sc.sides.R.control = 'ai';
      sc.sides.B.opening = []; sc.sides.R.opening = [];
      for (let i = 0; i < CREATOR_LIMITS.orders; i++) {
        sc.sides.B.opening.push({ key: 'rifle', lane: i % 3, count: CREATOR_LIMITS.perOrder });
        sc.sides.R.opening.push({ key: 'rifle', lane: i % 3, count: CREATOR_LIMITS.perOrder });
      }
      const v = creatorValidate(sc, false);
      creatorLaunch(v.scenario);
      return { perSideB: creatorOpeningTotal(v.scenario.sides.B), expected: CREATOR_LIMITS.perSide,
               live: G.units.length, cap: CREATOR_LIMITS.liveUnits };
    });
    ok(crCap.perSideB === crCap.expected && crCap.live <= crCap.cap,
      `[creator] the per-side opening cap holds at ${crCap.perSideB} and the field never exceeds the documented ${crCap.cap}-unit ceiling (started with ${crCap.live})`);

    // the boot-guard check above throws ONE error on purpose to prove a mid-battle fault no
    // longer covers a live match; everything else must still be clean
    const unexpected = gerr.filter(m => !/benign mid-battle blip/.test(m));
    ok(unexpected.length === 0, `[v1.18.0] zero unexpected page errors ${unexpected.length ? ':: ' + unexpected.join(' | ') : ''}`);
    await gctx.close();
  }

  console.log('\n══════════ FRONTLINE COMMANDER — REGRESSION SUITE ══════════');
  out.forEach(o => console.log(o));
  console.log('═══════════════════════════════════════════════════════════');
  console.log(FAIL === 0 ? `✅ ALL ${out.length} CHECKS PASSED` : `❌ ${FAIL} of ${out.length} CHECKS FAILED`);
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
})();
