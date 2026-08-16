//go:build ignore

// This file is documentation for the reproducible artifact command used by CI/release checks:
// CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build -trimpath -ldflags='-s -w'
//   -o zephyr_one/mobile/android/app/src/main/jniLibs/arm64-v8a/libzephyr_ai_runtime.so
//   ./zephyr-ai/cmd/zephyr-ai-android
package build
