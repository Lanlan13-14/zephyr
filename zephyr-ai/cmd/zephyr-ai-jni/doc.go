// Package main builds the true JNI shared library
// (libzephyr_ai_runtime_jni.so) via -buildmode=c-shared.
//
// This is the in-process path required by the Zephyr AI Master Unification
// Spec: Android must call the embedded runtime as a library through JNI
// instead of spawning a loopback HTTP child process. The CGO-less
// libzephyr_ai_runtime.so executable remains the fallback for devices
// where the JNI library cannot be loaded.
//
// Build (NDK required):
//   CGO_ENABLED=1 GOOS=android GOARCH=arm64 \
//   CC=$(ndk -C toolchain aarch64-linux-android-clang) \
//   go build -buildmode=c-shared -trimpath -ldflags='-s -w' \
//   -o libzephyr_ai_runtime_jni.so ./cmd/zephyr-ai-jni
package main

// main is required by -buildmode=c-shared; it never runs. Defined here
// (not behind the cgo tag) so the package also builds with CGO_ENABLED=0,
// which produces the CGO-less executable fallback variant.
func main() {}