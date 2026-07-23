/* BOOT GUARD — deliberately written in plain ES5 and kept tiny, and loaded as the very
   first script in <head>, before styles.css or game.js. Its only job is to guarantee a
   playtester is never stuck looking at the loading screen.

   Why this exists as a SEPARATE file instead of just the safety code already inside
   game.js: that in-file safety net (window 'error'/'unhandledrejection' handlers, a hard
   timeout) only helps once game.js has actually started running. It can't help if the
   browser fails to fetch game.js at all, or refuses to parse it (a real possibility on
   WebKit/Safari — this bug was reported stuck-on-load on an iPad, which this test
   environment has no way to reproduce directly). This file runs and registers its
   listeners BEFORE the browser ever reaches the game.js <script> tag at the bottom of the
   page, so it catches all of: game.js failing to load (network/CSP/404), game.js failing
   to PARSE (a syntax error aborts the whole file before anything in it — including its own
   safety net — ever runs), and any error/rejection anywhere on the page after that. */
(function () {
  "use strict";
  var fallbackShown = false;

  function hideLoader() {
    var el = document.getElementById("loader");
    if (!el) return;
    el.className = el.className ? el.className + " gone" : "gone";
    // set inline too, in case styles.css itself failed to load for some reason
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
  }

  function anyScreenVisible() {
    var screens = document.getElementsByClassName("screen");
    for (var i = 0; i < screens.length; i++) {
      if (String(screens[i].className).indexOf("hidden") === -1) return true;
    }
    return false;
  }

  function showFallback() {
    if (fallbackShown) return;
    fallbackShown = true;
    var box = document.createElement("div");
    box.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:99999;background:#05070c;color:#e8eef7;" +
        "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:24px;"
    );
    var title = document.createElement("div");
    title.setAttribute("style", "font-size:20px;font-weight:800;letter-spacing:1px;color:#ffce5a;");
    title.textContent = "⚔ FRONTLINE COMMANDER";
    var msg = document.createElement("div");
    msg.setAttribute("style", "font-size:14px;color:#8fa3bf;max-width:340px;line-height:1.5;");
    msg.textContent =
      "Trouble loading on this browser. This usually clears up with a reload — sorry about that.";
    var btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.setAttribute(
      "style",
      "padding:10px 28px;border-radius:8px;border:1px solid #ffce5a;background:#ffce5a;color:#0a0e14;" +
        "font-size:14px;font-weight:700;cursor:pointer;"
    );
    btn.onclick = function () {
      location.reload();
    };
    box.appendChild(title);
    box.appendChild(msg);
    box.appendChild(btn);
    document.body.appendChild(box);
  }

  function watchdog() {
    hideLoader();
    // give game.js (if it's still alive) a brief moment to reach showTitle() on its own
    // before deciding the page is genuinely blank and offering the reload fallback
    setTimeout(function () {
      if (!anyScreenVisible()) showFallback();
    }, 700);
  }

  // capture phase — required to observe a <script src> that fails to load at all
  // (network error / blocked), since that particular error event does not bubble
  window.addEventListener("error", watchdog, true);
  window.addEventListener("unhandledrejection", watchdog);
  // last resort: no matter what happened above, never sit on the loading screen past ~8s
  setTimeout(watchdog, 8000);
})();
