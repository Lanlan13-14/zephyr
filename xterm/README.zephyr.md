# xterm.js in Zephyr SSH

## Layout

| Path | Role |
|------|------|
| `xterm/` | Full **xterm.js** source tree (MIT) for forking / 魔改. Not loaded by the browser as-is. |
| `node_modules/@xterm/headless` | Published headless build used to produce the browser bundle. |
| `public/vendor/wterm-fork/core/xterm-headless.js` | Browser ESM bundle of headless Terminal. |
| `public/vendor/wterm-fork/core/xterm-bridge.js` | `TerminalCore` adapter (`XtermBridge`). |
| `wterm/packages/@wterm/dom` | **DOM layer** (renderer, input, viewport facade) — kept from wterm, paints xterm cells. |
| `wterm/packages/@wterm/core` | `TerminalCore` interface + `XtermBridge` + optional legacy `WasmBridge`. |

## Architecture

```
PTY bytes → XtermBridge (@xterm/headless) → TerminalCore cells
                                              ↓
                                    wterm Renderer / InputHandler / viewport
                                              ↓
                                         DOM (.term-row …)
```

- **VT / buffer / reflow / modes**: xterm.js  
- **Paint / selection / mobile IME shell / Zephyr viewport API**: wterm DOM  

Default `WTerm` option: `engine: "xterm"`. Legacy Zig WASM: `engine: "wasm"` (requires `BUILD_WASM=1`).

## Rebuild

```bash
npm run build:terminal
# optional legacy wasm core:
npm run build:terminal:wasm
```

## 魔改 xterm

1. Edit sources under `xterm/src/` (especially `common/` and `headless/`).
2. Upstream rebuild flow needs the full xterm toolchain; for day-to-day Zephyr work you can either:
   - patch and re-publish a local `@xterm/headless` via xterm's `package-headless`, or
   - point `scripts/build-xterm-headless.mjs` at a custom entry once you produce one.
3. Re-run `npm run build:terminal` so `public/vendor/wterm-fork/core/xterm-headless.js` updates.

## License

xterm.js is **MIT** — see `xterm/LICENSE` and `public/vendor/wterm-fork/core/XTERM-LICENSE`.
Zephyr remains GPL-3.0; MIT code is redistributed under its own terms.
