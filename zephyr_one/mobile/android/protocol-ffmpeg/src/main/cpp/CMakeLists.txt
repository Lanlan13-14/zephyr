cmake_minimum_required(VERSION 3.22.1)
project(zephyr_ffmpeg_android LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT DEFINED ZEPHYR_FFMPEG_ANDROID_ROOT)
    message(FATAL_ERROR "Set zephyr.ffmpeg.androidRoot or ZEPHYR_ANDROID_FFMPEG_ROOT")
endif()

set(FFMPEG_PREFIX "${ZEPHYR_FFMPEG_ANDROID_ROOT}/${ANDROID_ABI}")
set(FFMPEG_STAMP "${FFMPEG_PREFIX}/.zephyr-ffmpeg-tag")
set(FFMPEG_BIN "${FFMPEG_PREFIX}/bin/ffmpeg")

if(NOT EXISTS "${FFMPEG_STAMP}")
    message(FATAL_ERROR "Missing pinned FFmpeg stamp for ${ANDROID_ABI}: ${FFMPEG_STAMP}")
endif()
file(READ "${FFMPEG_STAMP}" FFMPEG_STAMP_VALUE)
string(STRIP "${FFMPEG_STAMP_VALUE}" FFMPEG_STAMP_VALUE)
if(NOT FFMPEG_STAMP_VALUE STREQUAL "6.1.2+libjxl-0.10.4")
    message(FATAL_ERROR "FFmpeg ${ANDROID_ABI} stamp must be 6.1.2+libjxl-0.10.4, got ${FFMPEG_STAMP_VALUE}")
endif()
if(NOT EXISTS "${FFMPEG_BIN}")
    message(FATAL_ERROR "Missing FFmpeg binary: ${FFMPEG_BIN}")
endif()

add_library(zephyr_ffmpeg_android SHARED zephyr_ffmpeg.c)
target_compile_options(zephyr_ffmpeg_android PRIVATE -Wall -Wextra -Werror)
target_link_libraries(zephyr_ffmpeg_android PRIVATE log)

# The CLI is packaged as jniLibs/arm64-v8a/libffmpegexec.so by the Gradle
# module (see protocol-ffmpeg/build.gradle.kts). CMake only builds the JNI
# wrapper; it still requires the stamp and binary so a stale prefix cannot
# silently ship.
