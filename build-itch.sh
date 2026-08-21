#!/usr/bin/env bash
#
# build-itch.sh — produce the itch.io upload for FRONTLINE COMMANDER.
#
# WHY THIS EXISTS
#   itch.io serves EVERY file in the uploaded zip at a public URL. There is no
#   "private" folder and no server-side access control. So zipping the repo
#   directory would publish, among other things:
#       marketing_outlook_v1.html  — pricing strategy and revenue projections
#       game_report.html           — internal market analysis
#       marketing_campaign.html    — campaign planning
#       war.html                   — the 1.7 MB internal research simulator
#       CODE_GUIDE.md / PHASES.md  — internal engineering notes
#       .agents/                   — internal review personas
#   None of that should be downloadable by the public. This script builds an
#   ALLOWLIST — only files named here ship — so adding a new internal document
#   to the repo can never silently publish it.
#
# USAGE
#   ./build-itch.sh                       # build dist/ and dist/frontline-commander-itch.zip
#   SITE_URL=https://example.com ./build-itch.sh   # also emit a real sitemap.xml
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
ZIP="$DIST/frontline-commander-itch.zip"

# ── The allowlist. Anything not in here does not ship. ──────────────────────
#   src:dest  — the game becomes index.html because itch.io boots the zip's
#   index.html and nothing else.
FILES=(
  "wargame.html:index.html"
  "privacy.html:privacy.html"
  "terms.html:terms.html"
)

echo "▸ Cleaning $DIST"
rm -rf "$DIST"
mkdir -p "$DIST"

echo "▸ Copying allowlisted files"
for entry in "${FILES[@]}"; do
  src="${entry%%:*}"; dest="${entry##*:}"
  if [[ ! -f "$ROOT/$src" ]]; then
    echo "  ✖ MISSING: $src" >&2; exit 1
  fi
  cp "$ROOT/$src" "$DIST/$dest"
  echo "  ✓ $src → $dest"
done

# ── Optional sitemap, only when a real URL is supplied ──────────────────────
if [[ -n "${SITE_URL:-}" ]]; then
  base="${SITE_URL%/}"
  cat > "$DIST/sitemap.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>$base/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>$base/privacy.html</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
  <url><loc>$base/terms.html</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
</urlset>
XML
  printf 'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' "$base" > "$DIST/robots.txt"
  echo "  ✓ sitemap.xml + robots.txt for $base"
else
  echo "  · SITE_URL not set — skipping sitemap.xml (correct for an itch.io-only release;"
  echo "    itch.io provides its own page and does not read a sitemap from the game zip)"
fi

# ── Guard: refuse to ship anything that looks like a credential ─────────────
echo "▸ Scanning build output for credentials"
if grep -rEIl "sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|AIza[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}" "$DIST" 2>/dev/null; then
  echo "  ✖ ABORT: credential-shaped string found in build output" >&2; exit 1
fi
echo "  ✓ no credential-shaped strings"

# ── Guard: a Supabase JWT may ship ONLY if it is the anon key ────────────────
# The build now legitimately carries a JWT — the anon key is designed to be public and is
# safe because RLS restricts it. A service_role key in the same slot is catastrophic and
# looks IDENTICAL to grep, because the role lives inside the base64 payload. So decode it.
echo "▸ Checking every JWT in the build is an anon key"
if ! node -e '
const fs=require("fs"),path=require("path");
const dist=process.argv[1]; let bad=0,seen=0;
for(const f of fs.readdirSync(dist)){
  const p=path.join(dist,f); if(!fs.statSync(p).isFile())continue;
  const txt=fs.readFileSync(p,"utf8");
  for(const m of txt.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)){
    seen++;
    let role="<undecodable>";
    try{ role=JSON.parse(Buffer.from(m[1],"base64").toString()).role; }catch(e){}
    if(role!=="anon"){ bad++; console.error(`  ✖ ${f}: JWT with role="${role}"`); }
  }
}
if(bad){
  console.error("  ✖ ABORT: a non-anon key is in the build. ROTATE IT NOW — the zip may already be downloaded.");
  process.exit(1);
}
console.log(`  ✓ ${seen} JWT(s), all role="anon"`);
' "$DIST"; then exit 1; fi

# ── Guard: the placeholder legal fields must be filled before a real launch ──
# Matches ANY square-bracket ALL-CAPS placeholder rather than a fixed list of names — the
# previous version hardcoded "[INSERT CONTACT EMAIL|JURISDICTION]" and silently stopped
# warning the moment those placeholders were renamed to [YOUR STATE]. A guard that fails
# open when the thing it guards changes shape is worse than no guard.
if grep -qE "\[[A-Z][A-Z ,.…—-]{3,}\]" "$DIST/privacy.html" "$DIST/terms.html" 2>/dev/null; then
  echo "  ⚠ WARNING: privacy.html / terms.html still contain unfilled placeholders:"
  grep -ohE "\[[A-Z][A-Z ,.…—-]{3,}\]" "$DIST/privacy.html" "$DIST/terms.html" | sort -u | sed 's/^/      /'
  echo "    Fine for a playtest build; fill them in before charging money or launching publicly."
fi

echo "▸ Zipping"
( cd "$DIST" && zip -qr "$(basename "$ZIP")" . -x "$(basename "$ZIP")" )

echo
echo "✅ Build complete"
echo "   Upload:  $ZIP"
echo "   Size:    $(du -h "$ZIP" | cut -f1)"
echo "   Contents:"
unzip -l "$ZIP" | sed 's/^/     /'
echo
echo "   On itch.io: set the upload to \"This file will be played in the browser\"."
echo "   Suggested viewport 1280x720, and TICK \"Mobile friendly\" + \"Fullscreen button\"."
