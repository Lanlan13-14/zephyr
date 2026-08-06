# Architecture

## Product

Zephyr One = **full Zephyr product** running locally inside Tauri.

```
┌─────────────────────────────────────────┐
│ Zephyr One (Tauri)                      │
│  ┌─────────────┐   ┌──────────────────┐ │
│  │ Shell        │   │ Local Zephyr     │ │
│  │ OS unlock    │──▶│ core (Node)      │ │
│  │ (optional)   │   │ server.js+public │ │
│  └─────────────┘   └────────┬─────────┘ │
│                             │ loopback  │
│                     WebView loads UI    │
└─────────────────────────────────────────┘
                │ optional sync only
                ▼
        Remote Zephyr main (/api/one/*)
```

- Day-to-day SSH / RDP / VNC / notes / AI / tokens → **local core**
- Remote main → **account data sync only** (not the UI host)

## Signing

Android release uses the same keystore practice as Zephyr Agent  
(`platform_assets/android/signing/zephyr-one-release.jks`, alias `zephyr-agent`)  
so CI-built APKs share a stable certificate for updates.  
Package id remains **`com.zephyr.one`** — does **not** replace `com.zephyr.agent`.

## Android Node (open-box)

Build downloads node-android-build into:

`app/src/main/jniLibs/<abi>/libnode.so`

Android installs/extracts native libs; runtime `exec`s `nativeLibraryDir/libnode.so`.  
No first-run download or app-side tar extract of Node.

## OS unlock

| Platform | Real API |
|----------|----------|
| Android / iOS | tauri-plugin-biometric |
| macOS | localauthentication-rs |
| Windows | windows::Security::Credentials::UI::UserConsentVerifier |
| Linux | unavailable |
