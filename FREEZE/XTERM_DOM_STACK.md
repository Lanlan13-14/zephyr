# Xterm core + WTerm DOM stack

Date: 2026-07-21  
Status: default runtime path (`engine: "xterm"`)

## Goal

- Replace the **Zig WASM VT core** with **xterm.js headless** (buffer, parser, reflow, modes).
- Keep the **wterm DOM layer** as the sole browser paint/selection/IME shell (Zephyr mobile viewport API, `.term-row` renderer, external input mode).
- Vendor **full xterm.js source** at repo root `xterm/` so it can be forked freely (MIT).

## Runtime graph

```
browser terminal.js
  → register /vendor/wterm-fork/core/xterm-headless-register.js
  → WTerm (public/vendor/wterm-fork) engine:"xterm"
       → XtermBridge (TerminalCore)
            → @xterm/headless Terminal (bundled xterm-headless.js)
       → Renderer / InputHandler / viewport (wterm DOM)
```

## Source of truth

| Tree | Contents |
|------|----------|
| `xterm/` | Full upstream xterm.js clone for 魔改 |
| `wterm/packages/@wterm/core` | `TerminalCore`, `XtermBridge`, legacy `WasmBridge` |
| `wterm/packages/@wterm/dom` | DOM renderer, input, WTerm class, viewport facade |
| `public/vendor/wterm-fork/` | Browser-ready build output |

## Build

```bash
npm run build:terminal          # headless bundle + transpile core/dom
npm run build:terminal:wasm     # optional legacy Zig engine
npm run test:xterm-bridge       # Node contract tests (8)
```

Native `esbuild` binary may be broken under this aarch64 PRoot; scripts use `esbuild-wasm`.

## Host integration

- `public/terminal.js` `initWTerm` always registers xterm headless, then constructs `WTerm` with `engine: 'xterm'`.
- Cache bust: `20260721-xterm-dom1`.
- `term.bridge` remains the `TerminalCore` surface used by scroll/history/AI snapshot code.

## Not done in this cut

- OSC 52 / clipboard addon on xterm path (returns null; host may still use selection DOM).
- Kitty graphics / Sixel via xterm Image addon (getImages empty).
- Deep Kitty keyboard flag probe (returns 0 → classic key sequences).
- Removing dead Zig sources (kept for `engine:"wasm"`).
- Full browser e2e on test machine (requires deploy + hard refresh).

## Rollback

Construct WTerm with `engine: 'wasm'` and rebuild with `BUILD_WASM=1` (needs Zig).
