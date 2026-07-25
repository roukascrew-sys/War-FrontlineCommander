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

Exits `0` if everything passes, `1` otherwise — safe to wire into CI.
