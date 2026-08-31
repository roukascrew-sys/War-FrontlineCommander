# Regression suite

`regression.js` boots `wargame.html` in real Chromium and checks the things that
have actually broken before: a browser-compat parse failure that silently killed
the loading screen, full-mode gameplay sims, and unit deploy sounds.

## Run it

```sh
# from the repo root
python3 -m http.server 8080 &
npm i -D playwright        # first time only
npx playwright install chromium   # first time only, if not already cached
node tests/regression.js
```

Override the target URL with `BASE_URL=http://host:port/wargame.html` if you're
not serving on `localhost:8080`.

Exits `0` if everything passes, `1` otherwise — safe to wire into CI. It takes several
minutes: most sections drive real battles to a real result rather than stubbing them.

## What section 33 is for

Section 33 covers **Creator Mode**, and its two halves have to be read together:

* a full creator battle changes **zero** save keys and issues **zero** leaderboard
  submissions;
* an ordinary skirmish **in the same session** still banks a win, a local board place, a
  career row, a streak and one submit.

The first check alone is vacuous — it would pass just as happily if progression were
broken for everybody. If you ever change the gating in `endGame()`, both halves must still
hold, or the sandbox has either become a scoring exploit or eaten the real game.
