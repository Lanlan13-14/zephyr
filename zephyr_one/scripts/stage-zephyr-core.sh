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

# Production deps
if command -v npm >/dev/null 2>&1; then
  (cd "$OUT" && npm install --omit=dev --no-audit --no-fund) || {
    echo "warn: npm install failed in zephyr-core" >&2
  }
fi

# Embed CSS for One product surface (hide multi-user / security / backup)
cat > "$OUT/public/zephyr-one-embed.css" <<'CSS'
/* Zephyr One local product surface */
#adminSettingsTab,
#settings-admin,
.settings-tab[data-settings="admin"],
.settings-tab[data-settings="security"],
#settings-security,
.settings-tab[data-settings="data"],
#settings-data {
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
