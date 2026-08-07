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

# Production dependencies follow the root lockfile. Desktop platforms retain
# install scripts so their native addons match the target OS. Android never runs
# those host-native scripts: it uses node:sqlite and ssh2's pure-JS fallback.
if command -v npm >/dev/null 2>&1; then
  if [ "${ZEPHYR_ONE_ANDROID:-0}" = "1" ]; then
    (cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || {
      echo "ERROR: npm ci failed in Android zephyr-core" >&2
      exit 1
    }
    # better-sqlite3 is replaced by node:sqlite and sharp is lazy/fallback-only
    # on Android. Remove their host packages before packing to reduce APK size.
    rm -rf "$OUT/node_modules/better-sqlite3" "$OUT/node_modules/sharp" "$OUT/node_modules/@img"
    find "$OUT/node_modules" -type f -name '*.node' -delete
    echo "Android core: removed unsupported native dependency packages and .node addons"
  else
    (cd "$OUT" && npm ci --omit=dev --no-audit --no-fund) || {
      echo "ERROR: npm ci failed in desktop zephyr-core" >&2
      exit 1
    }
  fi
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
#   data   — server-side backup/restore of a shared deployment
#   mail   — SMTP for login/reset mail; One has no remote recipients
#   beian  — ICP filing notice, a public-website obligation
cat > "$OUT/public/zephyr-one-embed.css" <<'CSS'
/* Zephyr One local product surface */
#adminSettingsTab,
#settings-admin,
.settings-tab[data-settings="admin"],
.settings-tab[data-settings="data"],
#settings-data,
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

echo "Staged core OK: $OUT"
test -f "$OUT/server.js"
test -d "$OUT/public"
test -f "$OUT/public/app.html"
test -f "$OUT/public/app.js"
ls "$OUT" | wc -l
