#!/usr/bin/env sh
# Cross-compile a pinned FFmpeg 6.1.2 (LGPL + libjxl) for Android arm64.
# Output:
#   $PREFIX/<abi>/{.zephyr-ffmpeg-tag,include/,lib/,bin/ffmpeg}
#
# FFmpeg is the on-device image decoder (and JPEG still encoder) so the
# mobile client no longer ships wasm-vips. Audio and video stay on LibVLC,
# which already embeds libavcodec. No GPL encoder (libx264) is linked.
set -eu

FFMPEG_TAG="n6.1.2"
JXL_TAG="v0.10.4"
BROTLI_TAG="v1.1.0"
HIGHWAY_TAG="1.2.0"
STAMP_VALUE="6.1.2+libjxl-0.10.4"
API="${ZEPHYR_ANDROID_API:-24}"
ABI="${1:-arm64-v8a}"

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
CRATE="$(CDPATH= cd -- "$HERE/.." && pwd)"
PREFIX="${ZEPHYR_ANDROID_FFMPEG_ROOT:-$CRATE/.ffmpeg-android}"
ABI_PREFIX="$PREFIX/$ABI"
STAMP="$ABI_PREFIX/.zephyr-ffmpeg-tag"
JOBS="${ZEPHYR_FFMPEG_JOBS:-$(nproc 2>/dev/null || echo 4)}"
WORKDIR="${ZEPHYR_FFMPEG_WORKDIR:-$CRATE/.ffmpeg-src}"

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
[ -n "$NDK" ] && [ -d "$NDK" ] || { echo "ERROR: Android NDK not found (set ANDROID_NDK_HOME)" >&2; exit 2; }

HOST_TAG="$(uname -s | tr '[:upper:]' '[:lower:]')-x86_64"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
[ -x "$TOOLCHAIN/bin/aarch64-linux-android${API}-clang" ] || {
  echo "ERROR: missing NDK clang at $TOOLCHAIN/bin/aarch64-linux-android${API}-clang" >&2
  exit 2
}

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_VALUE" ]; then
  test -x "$ABI_PREFIX/bin/ffmpeg"
  test -f "$ABI_PREFIX/lib/libavcodec.a"
  printf 'Android FFmpeg %s already installed at %s\n' "$STAMP_VALUE" "$ABI_PREFIX"
  exit 0
fi

export PATH="$TOOLCHAIN/bin:$PATH"
export AR="$TOOLCHAIN/bin/llvm-ar"
export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
export STRIP="$TOOLCHAIN/bin/llvm-strip"
export NM="$TOOLCHAIN/bin/llvm-nm"
export CC="$TOOLCHAIN/bin/aarch64-linux-android${API}-clang"
export CXX="$TOOLCHAIN/bin/aarch64-linux-android${API}-clang++"
export AS="$CC"
export LD="$CC"
export SYSROOT="$TOOLCHAIN/sysroot"
export PKG_CONFIG_PATH="$ABI_PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$ABI_PREFIX/lib/pkgconfig"
export CFLAGS="-fPIC -O2"
export CXXFLAGS="-fPIC -O2"
export LDFLAGS="-pie"
mkdir -p "$WORKDIR" "$ABI_PREFIX/lib/pkgconfig" "$ABI_PREFIX/include" "$ABI_PREFIX/bin"

fetch() {
  url="$1"
  dest="$2"
  if [ -f "$dest" ]; then return; fi
  tmp="$dest.partial"
  curl -fsSL --retry 5 --retry-delay 2 "$url" -o "$tmp"
  mv "$tmp" "$dest"
}

# --- brotli (libjxl dep) ---
BROTLI_TGZ="$WORKDIR/brotli-$BROTLI_TAG.tar.gz"
fetch "https://github.com/google/brotli/archive/refs/tags/$BROTLI_TAG.tar.gz" "$BROTLI_TGZ"
rm -rf "$WORKDIR/brotli-src"
mkdir -p "$WORKDIR/brotli-src"
tar -xzf "$BROTLI_TGZ" -C "$WORKDIR/brotli-src" --strip-components=1
cmake -S "$WORKDIR/brotli-src" -B "$WORKDIR/brotli-build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" \
  -DANDROID_PLATFORM="android-$API" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$ABI_PREFIX" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DBROTLI_BUNDLED_MODE=OFF \
  -DBROTLI_BUILD_TOOLS=OFF
cmake --build "$WORKDIR/brotli-build" --parallel "$JOBS"
cmake --install "$WORKDIR/brotli-build"

# --- highway (libjxl dep) ---
HIGHWAY_TGZ="$WORKDIR/highway-$HIGHWAY_TAG.tar.gz"
fetch "https://github.com/google/highway/archive/refs/tags/$HIGHWAY_TAG.tar.gz" "$HIGHWAY_TGZ"
rm -rf "$WORKDIR/highway-src"
mkdir -p "$WORKDIR/highway-src"
tar -xzf "$HIGHWAY_TGZ" -C "$WORKDIR/highway-src" --strip-components=1
cmake -S "$WORKDIR/highway-src" -B "$WORKDIR/highway-build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" \
  -DANDROID_PLATFORM="android-$API" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$ABI_PREFIX" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DHWY_ENABLE_TESTS=OFF \
  -DHWY_ENABLE_EXAMPLES=OFF \
  -DHWY_ENABLE_CONTRIB=OFF \
  -DBUILD_TESTING=OFF
cmake --build "$WORKDIR/highway-build" --parallel "$JOBS"
cmake --install "$WORKDIR/highway-build"

# --- libjxl ---
JXL_TGZ="$WORKDIR/libjxl-$JXL_TAG.tar.gz"
fetch "https://github.com/libjxl/libjxl/archive/refs/tags/$JXL_TAG.tar.gz" "$JXL_TGZ"
rm -rf "$WORKDIR/jxl-src"
mkdir -p "$WORKDIR/jxl-src"
tar -xzf "$JXL_TGZ" -C "$WORKDIR/jxl-src" --strip-components=1
# The release tarball has no git submodules; fetch skcms at the exact commit
# libjxl v0.10.4 deps.sh pins (deps.sh THIRD_PARTY_SKCMS).
SKCMS_COMMIT="42030a771244ba67f86b1c1c76a6493f873c5f91"
SKCMS_TGZ="$WORKDIR/skcms-$SKCMS_COMMIT.tar.gz"
fetch "https://skia.googlesource.com/skcms/+archive/$SKCMS_COMMIT.tar.gz" "$SKCMS_TGZ"
mkdir -p "$WORKDIR/jxl-src/third_party/skcms"
tar -xzf "$SKCMS_TGZ" -C "$WORKDIR/jxl-src/third_party/skcms"
test -f "$WORKDIR/jxl-src/third_party/skcms/skcms.h"
cmake -S "$WORKDIR/jxl-src" -B "$WORKDIR/jxl-build" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" \
  -DANDROID_PLATFORM="android-$API" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$ABI_PREFIX" \
  -DCMAKE_PREFIX_PATH="$ABI_PREFIX" \
  -DCMAKE_FIND_ROOT_PATH="$ABI_PREFIX;$NDK" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DJPEGXL_ENABLE_TOOLS=OFF \
  -DJPEGXL_ENABLE_DOXYGEN=OFF \
  -DJPEGXL_ENABLE_MANPAGES=OFF \
  -DJPEGXL_ENABLE_BENCHMARK=OFF \
  -DJPEGXL_ENABLE_EXAMPLES=OFF \
  -DJPEGXL_ENABLE_JNI=OFF \
  -DJPEGXL_ENABLE_SJPEG=OFF \
  -DJPEGXL_ENABLE_OPENEXR=OFF \
  -DJPEGXL_ENABLE_SKCMS=ON \
  -DJPEGXL_ENABLE_VIEWERS=OFF \
  -DJPEGXL_ENABLE_DEVTOOLS=OFF \
  -DJPEGXL_ENABLE_TESTS=OFF \
  -DBUILD_TESTING=OFF \
  -DJPEGXL_BUNDLE_LIBPNG=OFF \
  -DJPEGXL_FORCE_SYSTEM_BROTLI=ON \
  -DJPEGXL_FORCE_SYSTEM_LCMS2=OFF \
  -DJPEGXL_FORCE_SYSTEM_HWY=ON \
  -DJPEGXL_STATIC=ON
cmake --build "$WORKDIR/jxl-build" --parallel "$JOBS"
cmake --install "$WORKDIR/jxl-build"

# --- FFmpeg ---
FFMPEG_TGZ="$WORKDIR/ffmpeg-$FFMPEG_TAG.tar.gz"
fetch "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/$FFMPEG_TAG.tar.gz" "$FFMPEG_TGZ"
rm -rf "$WORKDIR/ffmpeg-src"
mkdir -p "$WORKDIR/ffmpeg-src"
tar -xzf "$FFMPEG_TGZ" -C "$WORKDIR/ffmpeg-src" --strip-components=1

# Order is load-bearing: --disable-everything first, then the image + still
# encoder surface Kotlin execs (`-i in -vf scale=w:h -frames:v 1 -q:v 3 out.jpg`).
# JPEG is the guaranteed output. libjxl covers JXL; HEIC/AVIF fall to Android
# ImageDecoder (API 28+) before FFmpeg is invoked.
(
  cd "$WORKDIR/ffmpeg-src"
  ./configure \
    --prefix="$ABI_PREFIX" \
    --arch=aarch64 \
    --cpu=armv8-a \
    --target-os=android \
    --enable-cross-compile \
    --cc="$CC" \
    --cxx="$CXX" \
    --ar="$AR" \
    --ranlib="$RANLIB" \
    --strip="$STRIP" \
    --nm="$NM" \
    --sysroot="$SYSROOT" \
    --extra-cflags="-I$ABI_PREFIX/include -fPIC -O2" \
    --extra-ldflags="-L$ABI_PREFIX/lib -pie" \
    --extra-libs="-lc++ -lm -lz" \
    --pkg-config=pkg-config \
    --pkg-config-flags="--static" \
    --disable-gpl \
    --enable-version3 \
    --enable-static \
    --disable-shared \
    --disable-doc \
    --disable-htmlpages \
    --disable-manpages \
    --disable-podpages \
    --disable-txtpages \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-network \
    --disable-debug \
    --disable-autodetect \
    --disable-avdevice \
    --disable-postproc \
    --disable-everything \
    --enable-avcodec \
    --enable-avformat \
    --enable-avutil \
    --enable-avfilter \
    --enable-swscale \
    --enable-swresample \
    --enable-ffmpeg \
    --enable-protocol=file \
    --enable-protocol=pipe \
    --enable-filter=scale \
    --enable-filter=format \
    --enable-demuxer=image2 \
    --enable-demuxer=image_jpeg_pipe \
    --enable-demuxer=image_png_pipe \
    --enable-demuxer=image_bmp_pipe \
    --enable-demuxer=image_webp_pipe \
    --enable-demuxer=image_tiff_pipe \
    --enable-demuxer=image_gif_pipe \
    --enable-demuxer=image_j2k_pipe \
    --enable-demuxer=image_pam_pipe \
    --enable-demuxer=image_pbm_pipe \
    --enable-demuxer=image_pcx_pipe \
    --enable-demuxer=image_pgm_pipe \
    --enable-demuxer=image_ppm_pipe \
    --enable-demuxer=image_psd_pipe \
    --enable-demuxer=image_qdraw_pipe \
    --enable-demuxer=image_sgi_pipe \
    --enable-demuxer=image_sunrast_pipe \
    --enable-demuxer=image_targa_pipe \
    --enable-demuxer=image_exr_pipe \
    --enable-demuxer=image_hdr_pipe \
    --enable-demuxer=image_dds_pipe \
    --enable-demuxer=mjpeg \
    --enable-demuxer=ico \
    --enable-muxer=image2 \
    --enable-muxer=mjpeg \
    --enable-encoder=mjpeg \
    --enable-encoder=png \
    --enable-decoder=mjpeg \
    --enable-decoder=png \
    --enable-decoder=bmp \
    --enable-decoder=gif \
    --enable-decoder=webp \
    --enable-decoder=tiff \
    --enable-decoder=jpeg2000 \
    --enable-decoder=jpegls \
    --enable-decoder=psd \
    --enable-decoder=pcx \
    --enable-decoder=sgi \
    --enable-decoder=sunrast \
    --enable-decoder=targa \
    --enable-decoder=exr \
    --enable-decoder=hdr \
    --enable-decoder=dds \
    --enable-decoder=qdraw \
    --enable-decoder=pictor \
    --enable-decoder=pnm \
    --enable-decoder=pgm \
    --enable-decoder=ppm \
    --enable-decoder=pbm \
    --enable-decoder=pam \
    --enable-decoder=fits \
    --enable-decoder=libjxl \
    --enable-libjxl \
    --enable-zlib \
    --enable-parser=mjpeg \
    --enable-parser=png \
    --enable-parser=bmp \
    --enable-parser=gif \
    --enable-parser=webp \
    --enable-parser=tiff \
    --enable-parser=jpeg2000 \
    --enable-bsf=mjpeg2jpeg
  make -j"$JOBS"
  make install
)

test -x "$ABI_PREFIX/bin/ffmpeg"
test -f "$ABI_PREFIX/lib/libavcodec.a"
"$ABI_PREFIX/bin/ffmpeg" -hide_banner -decoders 2>/dev/null | grep -q ' mjpeg ' || {
  echo "ERROR: ffmpeg binary missing mjpeg decoder" >&2
  exit 2
}
"$ABI_PREFIX/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q ' mjpeg ' || {
  echo "ERROR: ffmpeg binary missing mjpeg encoder" >&2
  exit 2
}
"$ABI_PREFIX/bin/ffmpeg" -hide_banner -filters 2>/dev/null | grep -q ' scale ' || {
  echo "ERROR: ffmpeg binary missing scale filter" >&2
  exit 2
}
printf '%s' "$STAMP_VALUE" > "$STAMP"
printf 'Android FFmpeg %s installed to %s\n' "$STAMP_VALUE" "$ABI_PREFIX"
