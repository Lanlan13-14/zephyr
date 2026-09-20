# Architecture

## Product

Zephyr One = **full Zephyr product** running locally inside Electron, on **desktop only**
(Windows / macOS / Linux).

```
┌─────────────────────────────────────────┐
│ Zephyr One (Electron)                   │
│  ┌─────────────┐   ┌──────────────────┐ │
│  │ Shell        │   │ Local Zephyr     │ │
│  │ OS unlock    │──▶│ core (Node)      │ │
│  │ (optional)   │   │ server.js+public │ │
│  └─────────────┘   └────────┬─────────┘ │
│                             │ loopback  │
│                     BrowserWindow loads │
└─────────────────────────────────────────┘
                │ optional sync only
                ▼
        Remote Zephyr main (Zephyr Link / mobile v1)
```

- Day-to-day SSH / RDP / VNC / notes / AI → **local core**
- Remote main → **account data sync only** (not the UI host)
- RDP → same WASM client as Web Zephyr
- Agent bastion mapping → same Web path
- File sync → Android One enrollment + mobile-v1 bootstrap/changes/push

## Credential surface

The browser-era credential wall is **removed** in the embedded build:

| Mechanism | Where |
|---|---|
| Local account adopted automatically | `exchangeEmbeddedBootstrap` in `server.js`, gated on `ZEPHYR_ONE_EMBEDDED=1` |
| Listener pinned to loopback | `EMBEDDED_LISTEN_HOST` |
| Security tab + logout removed from the DOM | `zephyr-one-embed-surface.js` |

## SQLite driver

The core runs with `ZEPHYR_ONE_USE_BUILTIN_SQLITE=1` on every desktop platform, so
`node:sqlite` is used instead of the `better-sqlite3` addon.

## OS unlock

Optional, default **off**. Only ever the OS authenticator, never an app-invented password.

| Platform | Real API |
|----------|----------|
| macOS | LocalAuthentication via osascript/JXA |
| Windows | UserConsentVerifier via PowerShell / Windows Runtime |
| Linux | unavailable — reports so rather than faking it |

## Signing

Package id is **`com.zephyr.one`**. Desktop artifacts are unsigned in CI.
