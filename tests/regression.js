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

  console.log('\n══════════ FRONTLINE COMMANDER — REGRESSION SUITE ══════════');
  out.forEach(o => console.log(o));
  console.log('═══════════════════════════════════════════════════════════');
  console.log(FAIL === 0 ? `✅ ALL ${out.length} CHECKS PASSED` : `❌ ${FAIL} of ${out.length} CHECKS FAILED`);
  await browser.close();
  process.exit(FAIL === 0 ? 0 : 1);
})();
