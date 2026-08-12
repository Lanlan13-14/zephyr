#!/usr/bin/env sh
# Build a pinned, static FreeRDP 3 for Zephyr One's in-process native RDP core.
#
# Why vendor it instead of using the system package:
#   - vcpkg's freerdp port produces a broken static set. Measured on both Linux
#     and Windows CI: libfreerdp3.a and libwinpr3.a were byte-identical
#     (size=1745350 members=257 syms=440 each) and gdi_free,
#     freerdp_client_load_addins and PubSub_Subscribe were defined in NO
#     archive. That is what produced 20 undefined symbols for four rounds.
#   - Distro packages differ per distro (Ubuntu libfreerdp-client3-3, Fedora
#     freerdp-libs, ...), so a deb/rpm dependency is a guess per target.
#   - A pinned build deletes the FreeRDP 2/3 compatibility surface we otherwise
#     have to carry: the version macros in the shim, the pkg-config candidate
#     chain, and the POSIX-lib platform filter all exist only because the
#     linked version was unknown at build time.
#
# BUILD_SHARED_LIBS=OFF is an upstream-supported configuration: FreeRDP ships
# ci/cmake-preloads/config-qa-static.cmake which sets exactly that, so this is
# a path upstream tests, not one we invented.
#
# Environment:
#   ZEPHYR_FREERDP_PREFIX      install prefix (default: <crate>/.freerdp-dist)
#   ZEPHYR_FREERDP_JOBS        parallel jobs (default: nproc)
#   ZEPHYR_FREERDP_CMAKE_ARGS  extra cmake args; the final no-LTO invariant wins
#
# ZEPHYR_FREERDP_CMAKE_ARGS exists because OpenSSL is not a system library on
# Windows or macOS (Apple removed it), so those targets must point FreeRDP at a
# vcpkg toolchain file. Linux passes nothing and uses the distro's libssl, whose
# CVEs are then fixed by system updates rather than by us re-releasing.
set -eu

# Pinned deliberately. 3.30.0 is the version Ubuntu 24.04 ships, which is the
# version our live RDP e2e already passes 19/19 against in CI, so the vendored
# build starts from a configuration that has been exercised end to end.
TAG="3.30.0"
COMMIT="6b107f0aadbabc47941c5a5b893b88c01792af6d"
PATCH_REV="cliprdr-reassembly-limit-v1"
PATCH_FILE=""
ADDIN_UPSTREAM_LF_SHA256="92efc5c0f3b2c16ee304ef290c5bc3ee528806fe939060dd1a09da8540f36ae4"
CHANNELS_UPSTREAM_LF_SHA256="6c78a8896421495230bea71ec57afd1f9942e539782e7e84c7e3bcb1e0cd1e95"
# Git for Windows may have checked an already-existing source tree out with
# CRLF before this script began enforcing LF for new clones. These are the same
# audited files with only line endings converted, so both the upstream and
# patched states have an exact hash pair for each line-ending convention.
ADDIN_UPSTREAM_CRLF_SHA256="8e7043fac321dbfc1f918abb922076f7824d4d668927876b4a2cdad97dd88469"
CHANNELS_UPSTREAM_CRLF_SHA256="d718329cff2136a89951554ff53e991a52a92d63ae1f7548e857c4eb13b61e0f"
ADDIN_PATCHED_LF_SHA256="55f9aeb7714e4c52200a42fa346361068abcd0a3d3eeb17ac7a77e4e268438f8"
CHANNELS_PATCHED_LF_SHA256="74d177e563ed86e6efc25952b792fbe8df424a4c2209e082bf4b7921dc0dfcb0"
ADDIN_PATCHED_CRLF_SHA256="d3e5ec1cb9b267540b52f921df146104b13144dc486e10996b239dbe70191ae0"
CHANNELS_PATCHED_CRLF_SHA256="972e7de531580d53a164912e6544c0a34d3eca8f9a4e5aaad17cef98e0b33b34"

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
CRATE="$(CDPATH= cd -- "$HERE/.." && pwd)"
PATCH_FILE="$CRATE/patches/freerdp-3.30.0-cliprdr-reassembly-limit.patch"
PREFIX="${ZEPHYR_FREERDP_PREFIX:-$CRATE/.freerdp-dist}"
JOBS="${ZEPHYR_FREERDP_JOBS:-$(nproc 2>/dev/null || echo 4)}"

SRC="$PREFIX/src"
BUILD="$PREFIX/build"
INSTALL="$PREFIX/install"

# Already built and complete? Skip only when the patch revision, no-LTO and
# no-systemd build contracts, and installed public marker agree. A tag-only
# stamp could silently reuse an old allocation-vulnerable or LTO-enabled build
# of this release.
STAMP="$INSTALL/.zephyr-freerdp-tag"
STAMP_VALUE="$TAG+$PATCH_REV"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_VALUE" ] &&
   grep -q '^CMAKE_INTERPROCEDURAL_OPTIMIZATION:BOOL=OFF$' \
     "$BUILD/CMakeCache.txt" 2>/dev/null &&
   grep -q '^WITH_SYSTEMD:BOOL=OFF$' "$BUILD/CMakeCache.txt" 2>/dev/null &&
   grep -q '^#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1$' \
     "$INSTALL/include/freerdp3/freerdp/client/channels.h"; then
  printf 'FreeRDP %s already built at %s\n' "$TAG" "$INSTALL"
  exit 0
fi

mkdir -p "$PREFIX"

if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  printf 'Cloning FreeRDP %s\n' "$TAG"
  git -c core.autocrlf=false clone --depth 1 --branch "$TAG" \
    https://github.com/FreeRDP/FreeRDP.git "$SRC"
else
  printf 'Reusing source tree at %s\n' "$SRC"
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{ print tolower($1) }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$1" | awk '{ print tolower($1) }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 < "$1" | awk '{ print tolower($NF) }'
  else
    echo "ERROR: SHA-256 tool required to verify pinned FreeRDP sources" >&2
    exit 2
  fi
}

matches_hash_pair() {
  [ "$addin_hash" = "$1" ] && [ "$channels_hash" = "$2" ]
}

[ -f "$PATCH_FILE" ] || { echo "ERROR: missing FreeRDP security patch: $PATCH_FILE" >&2; exit 2; }
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || {
  echo "ERROR: FreeRDP $TAG source is not pinned commit $COMMIT" >&2
  exit 2
}

ADDIN="$SRC/channels/client/addin.c"
CHANNELS="$SRC/include/freerdp/client/channels.h"
addin_hash="$(hash_file "$ADDIN")"
channels_hash="$(hash_file "$CHANNELS")"
if matches_hash_pair "$ADDIN_UPSTREAM_LF_SHA256" "$CHANNELS_UPSTREAM_LF_SHA256" ||
   matches_hash_pair "$ADDIN_UPSTREAM_CRLF_SHA256" "$CHANNELS_UPSTREAM_CRLF_SHA256"; then
  # --check makes an upstream context/offset change a hard build failure. The
  # patch is never applied with fuzz or silently skipped.
  git -C "$SRC" apply --check --unidiff-zero --whitespace=error-all "$PATCH_FILE"
  git -C "$SRC" apply --unidiff-zero --whitespace=error-all "$PATCH_FILE"
elif ! matches_hash_pair "$ADDIN_PATCHED_LF_SHA256" "$CHANNELS_PATCHED_LF_SHA256" &&
     ! matches_hash_pair "$ADDIN_PATCHED_CRLF_SHA256" "$CHANNELS_PATCHED_CRLF_SHA256"; then
  echo "ERROR: pinned FreeRDP files differ from both audited upstream and patched hashes" >&2
  echo "addin.c=$addin_hash channels.h=$channels_hash" >&2
  exit 2
fi

addin_hash="$(hash_file "$ADDIN")"
channels_hash="$(hash_file "$CHANNELS")"
if { matches_hash_pair "$ADDIN_PATCHED_LF_SHA256" "$CHANNELS_PATCHED_LF_SHA256" ||
     matches_hash_pair "$ADDIN_PATCHED_CRLF_SHA256" "$CHANNELS_PATCHED_CRLF_SHA256"; } &&
   grep -q '^#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1$' "$CHANNELS"; then
  :
else
  echo "ERROR: FreeRDP cliprdr pre-allocation limit was not applied exactly" >&2
  exit 2
fi

rm -rf "$BUILD"
mkdir -p "$BUILD"

# Audio backend, gated per platform.
#
# This is not cosmetic. FreeRDP plays remote audio through its OWN backend on
# the client machine -- the shim sets AudioPlayback/AudioCapture and never
# forwards PCM to the host, verified by inspection: no rdpsnd/audin client
# context is bound and no PCM event is emitted. So the backend below IS the
# audio path; picking the wrong one for a platform silently removes sound.
#
# Selecting per platform also avoids repeating the -lrt class of failure, where
# a Linux-only library reached the macOS link line and aborted the build.
case "$(uname -s)" in
  Linux)  AUDIO_ARGS="-DWITH_ALSA=ON -DWITH_MACAUDIO=OFF -DWITH_WINMM=OFF" ;;
  Darwin) AUDIO_ARGS="-DWITH_ALSA=OFF -DWITH_MACAUDIO=ON -DWITH_WINMM=OFF" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
          # vcpkg's x64-windows-static-md dependencies and Rust's MSVC target
          # both use the DLL CRT. FreeRDP defaults static builds to /MT, which
          # makes libssl/cJSON imports unresolved when the final archive links.
          AUDIO_ARGS="-DWITH_ALSA=OFF -DWITH_MACAUDIO=OFF -DWITH_WINMM=ON -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL" ;;
  *) echo "ERROR: unsupported host for audio backend: $(uname -s)" >&2; exit 2 ;;
esac
# PulseAudio/OSS/sndio stay off everywhere: each would add another runtime .so
# to a helper whose whole purpose here is to not depend on system libraries.
AUDIO_ARGS="$AUDIO_ARGS -DWITH_PULSE=OFF -DWITH_OSS=OFF -DWITH_SNDIO=OFF"

# Only what the helper actually speaks. Every ON below maps to a feature the
# shim uses; everything else is off to keep the build small and to avoid
# dragging in X11/Wayland/SDL, which a headless helper must never need.
#
#   rdpdr + drive  -> folder mapping (the RDPDR channel the e2e asserts)
#   rdpsnd         -> audio playback
#   audin          -> microphone redirection
#   cliprdr        -> clipboard
#   disp           -> dynamic resolution
#   rdpgfx         -> the gfx pipeline
#
# The OFF switches below each remove a measured runtime .so from the helper's
# ldd output. Before them the "static" helper still pulled 10 shared libraries:
#   urbdrc  -> libusb-1.0.so.0    (USB redirection; shim has zero references)
#   ICU     -> libicuuc/libicudata (WinPR Unicode; the shim hand-rolls
#              UTF-8<->UTF-16 precisely because WinPR 3 removed ConvertToUnicode)
#   opus    -> libopus.so.0       (optional audio codec; other codecs remain)
#   fuse    -> libfuse3           (clipboard FILE streaming; shim is text-only,
#              verified: no CB_FORMAT_TEXTURIZED file-group-descriptor use)
#
# WinPR's systemd integration is only a WLog journald appender. It is unrelated
# to the RDP features above, but FreeRDP enables it by default when headers are
# present, which makes static pkg-config consumers link libsystemd. Keep the
# shipped static closure independent of that optional logging backend.
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -G Ninja \
  $AUDIO_ARGS \
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
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTING=OFF \
  -DWITH_SAMPLE=OFF \
  -DWITH_SERVER=OFF \
  -DWITH_PROXY=OFF \
  -DWITH_SHADOW=OFF \
  -DWITH_PLATFORM_SERVER=OFF \
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
  -DCHANNEL_RDPDR=ON -DCHANNEL_RDPDR_CLIENT=ON \
  -DCHANNEL_DRIVE=ON -DCHANNEL_DRIVE_CLIENT=ON \
  -DCHANNEL_RDPSND=ON -DCHANNEL_RDPSND_CLIENT=ON \
  -DCHANNEL_AUDIN=ON -DCHANNEL_AUDIN_CLIENT=ON \
  -DCHANNEL_CLIPRDR=ON -DCHANNEL_CLIPRDR_CLIENT=ON \
  -DCHANNEL_DISP=ON -DCHANNEL_DISP_CLIENT=ON \
  -DCHANNEL_RDPGFX=ON -DCHANNEL_RDPGFX_CLIENT=ON \
  ${ZEPHYR_FREERDP_CMAKE_ARGS:-} \
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF
  # Unquoted on purpose: the caller passes several -D flags in one variable and
  # they must word-split into separate cmake arguments. Guarded with :- because
  # this script runs under `set -u`.

cmake --build "$BUILD" --parallel "$JOBS"
cmake --install "$BUILD"

case "$(uname -s)" in
  Darwin)
    # FreeRDP 3.30 hard-codes Linux's librt in winpr3.pc even though macOS
    # provides the required APIs in libSystem and has no separate librt.
    # Remove only that standalone token; keep every other static dependency.
    for pc in "$INSTALL"/lib/pkgconfig/*.pc; do
      sed -E 's/(^|[[:space:]])-lrt([[:space:]]|$)/\1\2/g' "$pc" > "$pc.tmp"
      mv "$pc.tmp" "$pc"
    done
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    # FreeRDP 3.30's static client pkg-config module references these private
    # channel archives but its install target omits them on MSVC.
    for archive in \
      "$BUILD/channels/remdesk/common/remdesk-common.lib" \
      "$BUILD/channels/rdpsnd/common/rdpsnd-common.lib"; do
      [ -f "$archive" ] || {
        echo "ERROR: Windows static FreeRDP closure is missing $archive" >&2
        exit 2
      }
      install -m 0644 "$archive" "$INSTALL/lib/$(basename "$archive")"
    done

    # The generated Windows .pc files inherit Unix-only private libraries.
    # Keep every real dependency, but never feed dl/rt/pthread/m to link.exe.
    for pc in "$INSTALL"/lib/pkgconfig/*.pc; do
      sed -E -i 's/-l(dl|rt|pthread|m)([[:space:]]|$)/ /g' "$pc"
    done
    ;;
esac

printf '%s' "$STAMP_VALUE" > "$STAMP"
printf 'FreeRDP %s installed to %s\n' "$TAG" "$INSTALL"
