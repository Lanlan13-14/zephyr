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

# Frozen mobile v1 contracts.
#
# server.js mounts /api/mobile/v1 and reads registries/entity-registry.json to
# build its entity adapters; the registry hash is what stops a client built
# against a different entity classification from writing a field this server
# treats differently. Without these files the mount throws ENOENT and the catch
# around it swallows the failure, so every packaged Zephyr One shipped with the
# entire mobile API silently absent.
#
# Copied to `mobile-contracts/` rather than recreating `zephyr_one/mobile/...`
# inside the core: the staged tree is a flat runtime, and resolveMobileContract()
# in server.js looks here precisely so the staged layout does not have to
# reproduce the repository's directory shape.
#
# The whole directory is copied, not just the registry: openapi-mobile-v1.json is
# the frozen surface the Kotlin client is generated from, and the schemas and
# test vectors are what let a device verify its own envelopes. ~270 KB of JSON.
if [ -d "$REPO/zephyr_one/mobile/contracts" ]; then
  mkdir -p "$OUT/mobile-contracts"
  cp -a "$REPO/zephyr_one/mobile/contracts/." "$OUT/mobile-contracts/"
  test -f "$OUT/mobile-contracts/registries/entity-registry.json" || {
    echo "ERROR: mobile entity registry missing from staged core" >&2
    exit 1
  }
else
  echo "ERROR: $REPO/zephyr_one/mobile/contracts not found; mobile v1 would not mount" >&2
  exit 1
fi

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
# `security` was hidden here until One had a security surface of its own. It is
# no longer: zephyr-one-embed-surface.js now *replaces* that panel's body with
# One's single switch (viewing a stored password or private key requires a system
# unlock first), so hiding it would hide the one security setting One can
# actually enforce. The browser-era cards inside it -- change password, TOTP,
# passkeys, login mail, IP allow-list, CAPTCHA -- are removed structurally by
# that transform rather than by CSS, because app.js reaches into #passwordForm
# and friends and a CSS-hidden node still matches those selectors.
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
cp "$ROOT/zephyr-one-embed.css" "$OUT/public/zephyr-one-embed.css"

cat > "$OUT/ZEPHYR_ONE_CORE.json" <<EOF
{
  "role": "zephyr-one-local-core",
  "syncOnlyRemote": true,
  "stagedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── One-only: retire the browser RDP client in favour of native FreeRDP ──
#
# Zephyr One talks RDP through native FreeRDP. The staging transform replaces
# app.js's browser iframe URL with an inert native-session marker, copies the
# One-only control surface, and drops every browser-only RDP runtime asset.
# The repository's own public/ is untouched, so the standalone server keeps
# serving WASM RDP to browser users byte-for-byte.
#
# This runs after dependency/vendor copies so the verifier sees the final tree.
# motion-wasm and every unrelated asset stay untouched.
node "$ROOT/scripts/stage-native-rdp.mjs" "$OUT"

echo "Staged core OK: $OUT"
test -f "$OUT/server.js"
test -d "$OUT/public"
test -f "$OUT/public/app.html"
test -f "$OUT/public/app.js"
test -f "$OUT/mobile-contracts/registries/entity-registry.json"
ls "$OUT" | wc -l
