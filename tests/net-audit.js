/* Same resolution dance as tests/regression.js — a bare require('playwright') fails on a
   machine where it is installed globally rather than beside the repo, and this script is
   the one that gets run rarely enough for that to be a surprise every time. */
function resolvePlaywright() {
  const path = require('path');
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.HOME || '', 'node_modules/playwright')];
  for (const c of candidates) { try { return require(c); } catch (e) {} }
  console.error('Playwright is not installed. Run: npm i -D playwright');
  process.exit(1);
}
const { chromium } = resolvePlaywright();
const EXE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find(p => { try { return require('fs').existsSync(p); } catch (e) { return false; } });
(async () => {
  const b = await chromium.launch(EXE ? { executablePath: EXE, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const p = await b.newPage({viewport:{width:1280,height:800}});
  const hosts = new Map();
  const record = u => { try{ const h=new URL(u).host; hosts.set(h,(hosts.get(h)||0)+1); }catch{} };
  p.on('request', r => record(r.url()));
  await p.goto('http://localhost:8080/wargame.html');
  await p.waitForFunction(()=>window.__FC_ALIVE,null,{timeout:20000});
  // exercise a broad slice of the game: menus, a full battle, every screen
  await p.evaluate(async ()=>{
    SAVE.lvl=60; SAVE.debugUnlockAll=true; SAVE.seenTut=true; SAVE.enlisted=true; persist();
    showTitle(); openLeaderboard(); openRivals(); openGauntlet(); openIndoc();
    openManual('basics'); openSettings(); openRecord&&openRecord(); openPatchNotes();
    showTitle();
    LAUNCH=null; sel.mode='skirmish'; start(); G.prep=0; G.frozen=false;
    for(let i=0;i<600 && !G.over;i++) step(0.05);
    G.hq.R=0; checkWin();
    await new Promise(r=>setTimeout(r,400));
  });
  await p.waitForTimeout(800);
  console.log('HOSTS CONTACTED IN A FULL SESSION:');
  for (const [h,n] of [...hosts].sort()) console.log(`  ${h}  (${n} requests)`);
  await b.close();
})();
