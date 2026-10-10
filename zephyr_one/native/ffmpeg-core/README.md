# Android FFmpeg still-image decoder

Zephyr One Mobile decodes preview stills with a pinned FFmpeg 6.1.2 CLI
(`libffmpegexec.so`) plus a tiny JNI wrapper (`libzephyr_ffmpeg_android.so`).
Audio and video stay on LibVLC.

The web client still uses wasm-vips / ffmpeg.wasm. This tree is Android only.

## Build

Requires Android NDK r27, CMake, Ninja, nasm, pkg-config, autoconf, automake.

```sh
export ANDROID_NDK_HOME=…/ndk/27.2.12479018
export ZEPHYR_ANDROID_FFMPEG_ROOT=$PWD/.ffmpeg-android
sh scripts/build-ffmpeg-android.sh arm64-v8a
```

Stamp written to `$ZEPHYR_ANDROID_FFMPEG_ROOT/arm64-v8a/.zephyr-ffmpeg-tag`
must equal `6.1.2+libjxl-0.10.4`. CI refuses any other stamp.

Gradle picks the prefix up from `ZEPHYR_ANDROID_FFMPEG_ROOT` (see
`.github/workflows/zephyr-one-mobile.yml`) and packages:

- `lib/arm64-v8a/libzephyr_ffmpeg_android.so`
- `lib/arm64-v8a/libffmpegexec.so`  (the CLI, renamed so the APK packager keeps it)

## What it is allowed to decode

ImageDecoder (API 28+) first, for `jpg/jpeg/png/webp/gif/avif/bmp/heic/heif/ico/cur`.
FFmpeg otherwise, with the same 4096-edge / 32 MiB pixel ceiling as
`public/preview/preview-wasm.js`. TIFF/SVG stay rejected on the hosted main
end; a direct SFTP open on the phone still tries FFmpeg and reports a decode
error if the bitstream is outside the enabled demuxers.
