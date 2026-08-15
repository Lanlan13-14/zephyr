#!/usr/bin/env sh
# Cross-compile the same pinned FreeRDP 3.30.0 + cliprdr patch for Android.
# Output layout matches protocol-rdp/NATIVE_BUILD.md:
#   $PREFIX/<abi>/{.zephyr-freerdp-tag,include/,lib/}
set -eu

TAG="3.30.0"
COMMIT="6b107f0aadbabc47941c5a5b893b88c01792af6d"
PATCH_REV="cliprdr-reassembly-limit-v1"
STAMP_VALUE="$TAG+$PATCH_REV"
OPENSSL_VER="3.3.2"
CJSON_VER="1.7.18"
API="${ZEPHYR_ANDROID_API:-24}"
ABI="${1:-arm64-v8a}"

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
CRATE="$(CDPATH= cd -- "$HERE/.." && pwd)"
PATCH_FILE="$CRATE/patches/freerdp-3.30.0-cliprdr-reassembly-limit.patch"
PREFIX="${ZEPHYR_ANDROID_FREERDP_ROOT:-$CRATE/.freerdp-android}"
ABI_PREFIX="$PREFIX/$ABI"
JOBS="${ZEPHYR_FREERDP_JOBS:-$(nproc 2>/dev/null || echo 4)}"

find_ndk() {
  if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then echo "$ANDROID_NDK_HOME"; return; fi
  if [ -n "${ANDROID_NDK_ROOT:-}" ] && [ -d "$ANDROID_NDK_ROOT" ]; then echo "$ANDROID_NDK_ROOT"; return; fi
  if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
    ls -d "$ANDROID_HOME/ndk"/* 2>/dev/null | sort -V | tail -n 1
    return
  fi
  echo ""
}

NDK="$(find_ndk)"
[ -n "$NDK" ] || { echo "ERROR: Android NDK not found (set ANDROID_NDK_HOME)" >&2; exit 2; }

case "$ABI" in
  arm64-v8a) OPENSSL_TARGET=android-arm64; TRIPLE=aarch64-linux-android ;;
  armeabi-v7a) OPENSSL_TARGET=android-arm; TRIPLE=armv7a-linux-androideabi ;;
  x86_64) OPENSSL_TARGET=android-x86_64; TRIPLE=x86_64-linux-android ;;
  x86) OPENSSL_TARGET=android-x86; TRIPLE=i686-linux-android ;;
  *) echo "ERROR: unsupported ABI $ABI" >&2; exit 2 ;;
esac

HOST_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
[ -d "$TOOLCHAIN" ] || { echo "ERROR: missing NDK toolchain $TOOLCHAIN" >&2; exit 2; }

STAMP="$ABI_PREFIX/.zephyr-freerdp-tag"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_VALUE" ] &&
   [ -f "$ABI_PREFIX/lib/libfreerdp3.a" ] &&
   [ -f "$ABI_PREFIX/lib/libfreerdp-client3.a" ] &&
   [ -f "$ABI_PREFIX/lib/libwinpr3.a" ] &&
   [ -f "$ABI_PREFIX/lib/libssl.a" ] &&
   [ -f "$ABI_PREFIX/lib/libcrypto.a" ] &&
   [ -f "$ABI_PREFIX/lib/libcjson.a" ]; then
  printf 'Android FreeRDP %s already built for %s\n' "$STAMP_VALUE" "$ABI"
  exit 0
fi

WORKDIR="$PREFIX/src"
mkdir -p "$WORKDIR" "$ABI_PREFIX"
export ANDROID_NDK_ROOT="$NDK"
export ANDROID_NDK_HOME="$NDK"
export PATH="$TOOLCHAIN/bin:$PATH"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | awk '{ print tolower($1) }'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | awk '{ print tolower($1) }'
  else openssl dgst -sha256 < "$1" | awk '{ print tolower($NF) }'
  fi
}

fetch_tar() {
  url="$1"
  dest="$2"
  if [ ! -f "$dest" ]; then
    printf 'Downloading %s\n' "$url"
    curl -fsSL --retry 3 --max-time 300 "$url" -o "$dest"
  fi
}

# --- OpenSSL static ---
SSL_SRC="$WORKDIR/openssl-$OPENSSL_VER"
SSL_TGZ="$WORKDIR/openssl-$OPENSSL_VER.tar.gz"
if [ ! -f "$ABI_PREFIX/lib/libssl.a" ]; then
  fetch_tar "https://www.openssl.org/source/openssl-$OPENSSL_VER.tar.gz" "$SSL_TGZ"
  rm -rf "$SSL_SRC"
  tar -xzf "$SSL_TGZ" -C "$WORKDIR"
  (
    cd "$SSL_SRC"
    ./Configure "$OPENSSL_TARGET" \
      -D__ANDROID_API__="$API" \
      no-shared no-tests no-apps no-docs no-asm \
      --prefix="$ABI_PREFIX" --openssldir="$ABI_PREFIX/ssl"
    make -j"$JOBS"
    make install_sw
  )
fi

# --- cJSON static ---
if [ ! -f "$ABI_PREFIX/lib/libcjson.a" ]; then
  CJSON_SRC="$WORKDIR/cJSON-$CJSON_VER"
  CJSON_TGZ="$WORKDIR/cJSON-$CJSON_VER.tar.gz"
  fetch_tar "https://github.com/DaveGamble/cJSON/archive/refs/tags/v$CJSON_VER.tar.gz" "$CJSON_TGZ"
  rm -rf "$CJSON_SRC"
  tar -xzf "$CJSON_TGZ" -C "$WORKDIR"
  cmake -S "$CJSON_SRC" -B "$CJSON_SRC/build" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$ABI" \
    -DANDROID_PLATFORM="android-$API" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$ABI_PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_CJSON_TEST=OFF \
    -DENABLE_CJSON_UTILS=OFF
  cmake --build "$CJSON_SRC/build" --parallel "$JOBS"
  cmake --install "$CJSON_SRC/build"
fi

# --- FreeRDP source + same audited patch as desktop ---
SRC="$WORKDIR/FreeRDP-$TAG"
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git -c core.autocrlf=false clone --depth 1 --branch "$TAG" \
    https://github.com/FreeRDP/FreeRDP.git "$SRC"
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || {
  echo "ERROR: FreeRDP $TAG is not pinned commit $COMMIT" >&2
  exit 2
}

PATCH_INPUT="$WORKDIR/freerdp-cliprdr.lf.patch"
tr -d '\015' < "$PATCH_FILE" > "$PATCH_INPUT"
if ! grep -q '^#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1$' \
     "$SRC/include/freerdp/client/channels.h"; then
  git -C "$SRC" apply --check --unidiff-zero --whitespace=error-all "$PATCH_INPUT"
  git -C "$SRC" apply --unidiff-zero --whitespace=error-all "$PATCH_INPUT"
fi
grep -q '^#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1$' \
  "$SRC/include/freerdp/client/channels.h" || {
  echo "ERROR: cliprdr patch was not applied" >&2
  exit 2
}

BUILD="$WORKDIR/freerdp-build-$ABI"
rm -rf "$BUILD"
cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" \
  -DANDROID_PLATFORM="android-$API" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$ABI_PREFIX" \
  -DCMAKE_PREFIX_PATH="$ABI_PREFIX" \
  -DCMAKE_FIND_ROOT_PATH="$ABI_PREFIX;$NDK" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTING=OFF \
  -DWITH_SAMPLE=OFF \
  -DWITH_SERVER=OFF \
  -DWITH_PROXY=OFF \
  -DWITH_SHADOW=OFF \
  -DWITH_PLATFORM_SERVER=OFF \
  -DWITH_CLIENT=ON \
  -DWITH_CLIENT_SDL=OFF \
  -DWITH_CLIENT_CHANNELS=ON \
  -DWITH_CLIENT_COMMON=ON \
  -DWITH_X11=OFF \
  -DWITH_WAYLAND=OFF \
  -DWITH_FFMPEG=OFF \
  -DWITH_SWSCALE=OFF \
  -DWITH_WEBVIEW=OFF \
  -DWITH_WINPR_TOOLS=OFF \
  -DWITH_MANPAGES=OFF \
  -DWITH_CUPS=OFF \
  -DWITH_PCSC=OFF \
  -DWITH_KRB5=OFF \
  -DWITH_OPENSSL=ON \
  -DWITH_ZLIB=ON \
  -DOPENSSL_USE_STATIC_LIBS=ON \
  -DOPENSSL_ROOT_DIR="$ABI_PREFIX" \
  -DWITH_ALSA=OFF \
  -DWITH_PULSE=OFF \
  -DWITH_OSS=OFF \
  -DWITH_SNDIO=OFF \
  -DWITH_MACAUDIO=OFF \
  -DWITH_WINMM=OFF \
  -DWITH_OPENSL=OFF \
  -DCHANNEL_URBDRC=OFF \
  -DCHANNEL_URBDRC_CLIENT=OFF \
  -DWITH_UNICODE_BUILTIN=ON \
  -DWITH_SYSTEMD=OFF \
  -DWITH_TIMEZONE_ICU=OFF \
  -DWITH_OPUS=OFF \
  -DWITH_FUSE=OFF \
  -DWITH_CAIRO=OFF \
  -DWITH_AAD=OFF \
  -DWITH_SMARTCARD_EMULATE=OFF \
  -DWITH_PKCS11=OFF \
  -DCHANNEL_RDPDR=ON -DCHANNEL_RDPDR_CLIENT=ON \
  -DCHANNEL_DRIVE=ON -DCHANNEL_DRIVE_CLIENT=ON \
  -DCHANNEL_RDPSND=ON -DCHANNEL_RDPSND_CLIENT=ON \
  -DCHANNEL_AUDIN=ON -DCHANNEL_AUDIN_CLIENT=ON \
  -DCHANNEL_CLIPRDR=ON -DCHANNEL_CLIPRDR_CLIENT=ON \
  -DCHANNEL_DISP=ON -DCHANNEL_DISP_CLIENT=ON \
  -DCHANNEL_RDPGFX=ON -DCHANNEL_RDPGFX_CLIENT=ON \
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF

cmake --build "$BUILD" --parallel "$JOBS"
cmake --install "$BUILD"

# Channel common archives are required by protocol-rdp/CMakeLists.txt.
for archive in remdesk-common rdpsnd-common; do
  found="$(find "$BUILD" -name "lib${archive}.a" -print | head -n 1)"
  [ -n "$found" ] || { echo "ERROR: missing $archive" >&2; exit 2; }
  install -m 0644 "$found" "$ABI_PREFIX/lib/lib${archive}.a"
done

printf '%s' "$STAMP_VALUE" > "$STAMP"
printf 'Android FreeRDP %s installed to %s\n' "$STAMP_VALUE" "$ABI_PREFIX"
