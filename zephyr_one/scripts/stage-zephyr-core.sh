#!/usr/bin/env sh
# Stage full Zephyr core for Zephyr One local embed.
# Remote main remains sync-only; this is the day-to-day product runtime.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
REPO="$(CDPATH= cd -- "$ROOT/.." && pwd)"
OUT="${1:-$ROOT/zephyr-core}"

echo "Staging Zephyr core from $REPO -> $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# All root-level JS/MJS modules used by server and tools
for f in "$REPO"/*.js "$REPO"/*.mjs; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  case "$base" in
    test-*.js|*.test.js) continue ;;
  esac
  cp "$f" "$OUT/$base"
done

# package manifests
cp "$REPO/package.json" "$OUT/package.json"
[ -f "$REPO/package-lock.json" ] && cp "$REPO/package-lock.json" "$OUT/package-lock.json"

# Runtime directories
for d in public server preview; do
  if [ -d "$REPO/$d" ]; then
    cp -a "$REPO/$d" "$OUT/$d"
  fi
done

# Optional worker / wasm sources if present (public may already contain built wasm)
for d in zephyr-worker rdp-wasm motion-wasm; do
  if [ -d "$REPO/$d" ]; then
    # do not bloat with full source trees unless needed; public vendor holds runtime assets
    :
  fi
done

# Production dependencies follow the root lockfile. Install scripts stay enabled
# so any native addon is built for the host, but the runtime still selects
# node:sqlite (ZEPHYR_ONE_USE_BUILTIN_SQLITE=1 in runtime/mod.rs) because the
# bundled Node is the CI runner's own binary and the macOS bundle is universal
# while npm can only build a single-arch addon.
if command -v npm >/dev/null 2>&1; then
  (cd "$OUT" && npm ci --omit=dev --no-audit --no-fund) || {
    echo "ERROR: npm ci failed in desktop zephyr-core" >&2
    exit 1
  }
fi

# The Android runtime reads static files directly from the installed APK. Copy
# package-owned browser assets into public/ so every UI request is addressable
# through one APK asset namespace without unpacking node_modules at first run.
if [ -d "$OUT/node_modules/viewerjs/dist" ]; then
  mkdir -p "$OUT/public/vendor/viewerjs"
  cp -a "$OUT/node_modules/viewerjs/dist/." "$OUT/public/vendor/viewerjs/"
fi
if [ -d "$OUT/node_modules/@novnc/novnc" ]; then
  mkdir -p "$OUT/public/vendor/novnc"
  cp -a "$OUT/node_modules/@novnc/novnc/." "$OUT/public/vendor/novnc/"
fi

# Embed CSS for One product surface.
#
# The security tab BUTTON is removed structurally by
# zephyr-one-embed-surface.js, not hidden here: `#settings-security` is
# app.html's default-active panel and app.js falls back to
# `[data-settings="security"]` in three places, so a CSS-hidden button still
# matches those selectors and Settings lands on an invisible panel. CSS only
# hides panels whose tab button is already gone or admin-gated.
#
# Hidden here, and why each is browser-only:
#   admin  — multi-user management; One is a single local account
#   mail   — SMTP for login/reset mail; One has no remote recipients
#   beian  — ICP filing notice, a public-website obligation
#
# `data` (backup / restore) is deliberately NOT hidden. It acts on the local
# core's own zephyr.db, so it is a first-class One capability, and the product
# contract names it twice: once in the required mobile capability list and again
# as "服务器设置和备份恢复保留；不能因为它们由主端执行就擅自从One移除".
# Verified against a real embedded core: the adopted session is the first user,
# whom storage.js promotes to super admin, so requireSuperAdmin passes; export
# returns 200 with a zip.enc attachment, and import still demands the account
# password (wrong password -> 403), which is what contract §8 requires of a
# sensitive operation.
cat > "$OUT/public/zephyr-one-embed.css" <<'CSS'
/* Zephyr One local product surface */
#adminSettingsTab,
#settings-admin,
.settings-tab[data-settings="admin"],
.settings-tab[data-settings="mail"],
#settings-mail,
.settings-tab[data-settings="beian"],
#settings-beian,
#settings-security {
  display: none !important;
}
CSS

cat > "$OUT/ZEPHYR_ONE_CORE.json" <<EOF
{
  "role": "zephyr-one-local-core",
  "syncOnlyRemote": true,
  "stagedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── One-only: retire the Go/WASM RDP client in favour of native FreeRDP ──
#
# Installs One's native RDP surface, repoints app.js's remote-desktop iframe at
# it, and deletes the whole WASM pipeline (rdp-*.js + vendor/rdp-wasm/main.wasm)
# from the staged copy. The repository's own public/ is untouched, so the browser
# product keeps its WASM client byte-for-byte.
#
# This runs *after* the vendor copies above so the deletion sees the final tree,
# and it fails the build if anything still references a removed file — a missing
# rdp-worker.js would otherwise 404 at runtime and leave the RDP tab dead.
echo "Applying One native RDP transform"
node "$ROOT/scripts/stage-native-rdp.mjs" "$OUT" "$ROOT/embed"

echo "Staged core OK: $OUT"
test -f "$OUT/server.js"
test -d "$OUT/public"
test -f "$OUT/public/app.html"
test -f "$OUT/public/app.js"
ls "$OUT" | wc -l
