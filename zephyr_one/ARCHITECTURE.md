# Architecture

## Product

Zephyr One = **full Zephyr product** running locally inside Tauri, on **desktop only**
(Windows / macOS / Linux).

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

## Why desktop only

The core is a **spawned Node child process**. That single fact decides the platform set:

- **iOS** forbids `fork` / `exec` of any process, so there is no path at all.
- **Android** required `jniLibs/<abi>/libnode.so` plus an APK-asset pipeline streaming a
  bundled CommonJS entry into Node's stdin. It worked, but carrying it beside the desktop
  product was not worth the maintenance.

Mobile is being rebuilt as **native clients** (iOS SwiftUI, Android Kotlin) that sync through
`/api/one/*` rather than embedding a Node core.

## Credential surface

The browser-era credential wall is **removed** in the embedded build, not merely hidden:

| Mechanism | Where |
|---|---|
| Local account adopted automatically | `adoptEmbeddedLocalSession` in `server.js`, gated on `ZEPHYR_ONE_EMBEDDED=1` |
| Listener pinned to loopback | `EMBEDDED_LISTEN_HOST` in the same mode |
| Security tab + logout removed from the DOM | `zephyr-one-embed-surface.js` |
| `/` skips the login page | explicit redirect to `/app.html` ahead of the static handler |

The loopback pin is what makes automatic adoption sound. Without it, adoption would hand a
live session to anything on the LAN. Plain web deployments are untouched and still require login.

## SQLite driver

The core runs with `ZEPHYR_ONE_USE_BUILTIN_SQLITE=1` on every desktop platform, so
`node:sqlite` is used instead of the `better-sqlite3` addon. Two reasons, both structural:

1. `stage-desktop-runtime.mjs` ships the **build machine's** Node binary, so a native addon
   would have to match that ABI exactly.
2. The macOS job targets `aarch64` **and** `x86_64`, but `npm ci` on an arm64 runner produces
   an arm64-only addon.

`node:sqlite` has neither problem — it is inside the Node binary being shipped. `sqlite-driver.js`
aligns its named-parameter semantics with better-sqlite3 in **both** directions (extra keys
ignored, missing keys rejected); raw `node:sqlite` diverges on both.

## OS unlock

Optional, default **off**. Only ever the OS authenticator, never an app-invented password.

| Platform | Real API |
|----------|----------|
| macOS | `localauthentication-rs` |
| Windows | `windows::Security::Credentials::UI::UserConsentVerifier` |
| Linux | unavailable — reports so rather than faking it |

## Signing

Package id is **`com.zephyr.one`** and does **not** replace `com.zephyr.agent`.
Desktop artifacts are unsigned in CI; Windows/macOS signing needs real certificates supplied
out of band.
