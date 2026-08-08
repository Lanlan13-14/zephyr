#!/usr/bin/env sh
# Build a pinned, static FreeRDP 3 for the Zephyr One RDP helper.
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
#   ZEPHYR_FREERDP_TAG         git tag to build (default: pinned below)
#   ZEPHYR_FREERDP_PREFIX      install prefix (default: <crate>/.freerdp-dist)
#   ZEPHYR_FREERDP_JOBS        parallel jobs (default: nproc)
#   ZEPHYR_FREERDP_CMAKE_ARGS  extra cmake args, appended last so they win
#
# ZEPHYR_FREERDP_CMAKE_ARGS exists because OpenSSL is not a system library on
# Windows or macOS (Apple removed it), so those targets must point FreeRDP at a
# vcpkg toolchain file. Linux passes nothing and uses the distro's libssl, whose
# CVEs are then fixed by system updates rather than by us re-releasing.
set -eu

# Pinned deliberately. 3.30.0 is the version Ubuntu 24.04 ships, which is the
# version our live RDP e2e already passes 19/19 against in CI, so the vendored
# build starts from a configuration that has been exercised end to end.
TAG="${ZEPHYR_FREERDP_TAG:-3.30.0}"

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
CRATE="$(CDPATH= cd -- "$HERE/.." && pwd)"
PREFIX="${ZEPHYR_FREERDP_PREFIX:-$CRATE/.freerdp-dist}"
JOBS="${ZEPHYR_FREERDP_JOBS:-$(nproc 2>/dev/null || echo 4)}"

SRC="$PREFIX/src"
BUILD="$PREFIX/build"
INSTALL="$PREFIX/install"

# Already built and complete? Skip. The stamp records the tag so bumping
# ZEPHYR_FREERDP_TAG forces a rebuild instead of silently reusing the old tree.
STAMP="$INSTALL/.zephyr-freerdp-tag"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$TAG" ]; then
  printf 'FreeRDP %s already built at %s\n' "$TAG" "$INSTALL"
  exit 0
fi

mkdir -p "$PREFIX"

if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  printf 'Cloning FreeRDP %s\n' "$TAG"
  git clone --depth 1 --branch "$TAG" \
    https://github.com/FreeRDP/FreeRDP.git "$SRC"
else
  printf 'Reusing source tree at %s\n' "$SRC"
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
          AUDIO_ARGS="-DWITH_ALSA=OFF -DWITH_MACAUDIO=OFF -DWITH_WINMM=ON" ;;
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
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -G Ninja \
  $AUDIO_ARGS \
  -DCHANNEL_URBDRC=OFF \
  -DCHANNEL_URBDRC_CLIENT=OFF \
  -DWITH_UNICODE_BUILTIN=ON \
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
  ${ZEPHYR_FREERDP_CMAKE_ARGS:-}
  # Unquoted on purpose: the caller passes several -D flags in one variable and
  # they must word-split into separate cmake arguments. Guarded with :- because
  # this script runs under `set -u`.

cmake --build "$BUILD" --parallel "$JOBS"
cmake --install "$BUILD"

printf '%s' "$TAG" > "$STAMP"
printf 'FreeRDP %s installed to %s\n' "$TAG" "$INSTALL"
