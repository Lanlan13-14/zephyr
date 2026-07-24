# 001 — Unify on a single zephyr-motion runtime

- **Status**: TODO
- **Commit**: ef3592d
- **Severity**: HIGH
- **Category**: Cohesion & tokens / API surface
- **Estimated scope**: 6–8 files (app boot, vendor shim, tests); no visual redesign

## Problem

The product ships **two** spring engines:

1. **Legacy** `public/vendor/zephyr-anim/` (`zephyr-anim.js` + `zephyr_anim.wasm` + `zephyr-anim-init.js`) — mass/stiffness/damping presets (`magnify` k:460…), only patches dock scale + island grip, bound from `app.html`.
2. **New foundation** `public/vendor/zephyr-motion/` (`motion.js` + `runtime.js` + `spring.js` + `zephyr_motion.wasm`) — Apple response/damping API (`Motion.to/set/morph/drag/press/stagger`), used only by `tests/motion-feel.html`.

```html
/* public/app.html:977 — current boot (legacy only) */
<script src="vendor/zephyr-anim/zephyr-anim-init.js?v=20260723-sync2" type="module"></script>
```

```js
/* public/vendor/zephyr-anim/zephyr-anim.js:18-24 — different physics language */
const PRESETS = {
  magnify : { k: 460, c: 32, m: 0.9 },
  island  : { k: 420, c: 15, m: 1.0 },
  snappy  : { k: 300, c: 28, m: 1.0 },
  bouncy  : { k: 380, c: 18, m: 1.0 },
};
```

```js
/* public/vendor/zephyr-motion/presets.js:13-22 — the intended language */
export const PRESETS = {
  snappy: { response: 0.28, damping: 1.0 },
  ui:     { response: 0.40, damping: 1.0 },
  gentle: { response: 0.55, damping: 1.0 },
  sheet:  { response: 0.30, damping: 0.80 },
  morph:  { response: 0.45, damping: 0.92 },
  dock:   { response: 0.22, damping: 0.95 },
  island: { response: 0.34, damping: 0.86 },
  bouncy: { response: 0.40, damping: 0.72 },
};
```

Business code (`public/app.js`) never imports `Motion`. Dock magnification still hard-sets CSS vars in `updateDockMagnification` (app.js:4229), while anim-init *also* monkey-patches the same function — racey dual ownership. Executors later cannot “just use Motion” while anim-init still owns slots 0–12 of a different wasm module.

## Target

1. **One runtime**: `window.Motion` from `public/vendor/zephyr-motion/index.js` is the only spring engine loaded in production.
2. **Boot path** in `public/app.html` loads `zephyr-motion/index.js` (module), not `zephyr-anim-init.js`.
3. **Compatibility shim** (temporary, ≤ one file): if anything still calls `window.__zaEngine`, map to Motion/engine or delete call sites.
4. **Legacy tree retired**: `public/vendor/zephyr-anim/**` either deleted in this plan or marked dead with a one-line re-export that throws in dev. Prefer delete after grep is clean.
5. **Dock + island grip** keep working (even if still via CSS vars) without the old engine — either:
   - leave native `updateDockMagnification` hard-set for this plan (feel equal to pre-anim-init), OR
   - thin reimplementation of the anim-init patches on Motion (preferred if small). **Plan 004 owns the full multi-channel dock spring**; this plan only must not regress to a broken dock.
6. Production still honors `prefers-reduced-motion` through Motion’s engine flag.

Exact boot target:

```html
<!-- public/app.html — end of body, replace zephyr-anim-init script -->
<script src="vendor/zephyr-motion/index.js?v=20260724-motion-unify1" type="module"></script>
```

Optional app-side await (only if openModal/dock need readiness; engine auto-inits in index.js):

```js
// near app.js module top or DOMContentLoaded
import { Motion } from './vendor/zephyr-motion/index.js';
await Motion.init({ capacity: 512 }); // larger pool for later morph work
window.Motion = Motion; // index.js already sets this; keep idempotent
```

## Repo conventions to follow

- Motion public API lives in `public/vendor/zephyr-motion/motion.js` and is exported from `index.js` (see file header comments: interactive motion = springs; transform/opacity/filter only).
- Apple presets: `public/vendor/zephyr-motion/presets.js` — **response + damping**, never k/c/m.
- Feel/self-test exemplar: `tests/motion-feel.html` already does `import { Motion, engine, PRESETS } from '../public/vendor/zephyr-motion/index.js'` and `await Motion.init({ capacity: 256 })`.
- Cache-bust query strings on script tags match the existing `?v=YYYYMMDD-tag` pattern in `app.html`.
- Contract tests under `tests/*motion*.test.mjs` and `tests/check-js-syntax.mjs` — do not break them.

## Steps

1. **Inventory live references** (must be zero before delete):
   ```bash
   rg -n "zephyr-anim|__zaEngine|zephyr_anim" public tests --glob '!**/vendor/zephyr-anim/**'
   ```
   Record every hit outside the vendor folder.

2. **Switch production boot** in `public/app.html`:
   - Remove the `vendor/zephyr-anim/zephyr-anim-init.js` script line.
   - Add `vendor/zephyr-motion/index.js` as `type="module"` with a new cache-bust tag.
   - Do **not** load both.

3. **Ensure `window.Motion` exists before dock pointer handlers run.** `index.js` already does:
   ```js
   window.Motion = Motion;
   engine.init(256).catch(...)
   ```
   If `app.js` is a classic non-module script that runs before the module, either:
   - keep app.js as-is (dock uses CSS vars; Motion only needed later), or
   - bump Motion init capacity to `512` from a tiny boot module:
     ```js
     // public/vendor/zephyr-motion/boot.js
     import { Motion } from './index.js';
     await Motion.init({ capacity: 512 });
     window.Motion = Motion;
     ```
     and load `boot.js` instead of `index.js`.

4. **Re-home or drop anim-init patches**:
   - Grep `updateDockMagnification` / `resetDockMagnification` / `terminal-grip` / `__zaEngine`.
   - After removing anim-init, the **app.js original** `updateDockMagnification` (hard setProperty) remains — this is acceptable for plan 001 (no feel regression vs pure CSS path).
   - Island grip CSS keyframes (`terminalIslandTapBounce`) remain as CSS until a later plan; do not leave a half-broken pointer listener that writes dead CSS vars without a spring.
   - Delete any residual `__zaEngine` debug hooks or re-point them:
     ```js
     window.__zephyrMotion = window.Motion;
     ```

5. **Delete or quarantine legacy vendor** (only after step 1 is clean):
   - Preferred: `git rm -r public/vendor/zephyr-anim`
   - If something external still imports it, replace `zephyr-anim.js` with:
     ```js
     console.error('[zephyr-anim] removed — use vendor/zephyr-motion (window.Motion)');
     export const engine = null;
     ```
   - Update any Dockerfile/static copy lists if they hardcode zephyr-anim (grep repo root).

6. **Document the single entry** in `public/vendor/zephyr-motion/` or `motion-wasm/README.md` (one paragraph): “Production boots Motion only; zephyr-anim is gone as of this commit.”

7. **Add a tiny contract test** `tests/motion-runtime-unify-contract.test.mjs`:
   ```js
   import { readFileSync } from 'node:fs';
   import assert from 'node:assert/strict';
   import { test } from 'node:test';
   const html = readFileSync('public/app.html','utf8');
   test('app boots zephyr-motion, not zephyr-anim', () => {
     assert.match(html, /vendor\/zephyr-motion\//);
     assert.doesNotMatch(html, /zephyr-anim-init/);
   });
   test('legacy anim package absent or stubbed', () => {
     // either directory gone, or init not referenced
     assert.doesNotMatch(html, /zephyr_anim\.wasm/);
   });
   ```

## Boundaries

- Do **NOT** rewrite connection FLIP (`openModal` / `closeModal`) — plan 003.
- Do **NOT** implement multi-channel dock springs — plan 004.
- Do **NOT** add present/sheet/popover semantic APIs — plan 002.
- Do **NOT** mass-migrate CSS keyframes.
- Do **NOT** add npm dependencies.
- Do **NOT** change spring math / wasm ABI.
- If `rg` shows unexpected production imports of zephyr-anim after deletion, STOP and report — do not invent dual-load bridges.

## Verification

- **Mechanical**:
  ```bash
  node --check public/vendor/zephyr-motion/motion.js
  node --check public/vendor/zephyr-motion/runtime.js
  node --test tests/motion-spring-js.test.mjs tests/motion-runtime.test.mjs tests/motion-abi.test.mjs
  node --test tests/motion-runtime-unify-contract.test.mjs
  rg -n "zephyr-anim-init|zephyr_anim\.wasm" public --glob '!**/vendor/zephyr-anim/**'
  # expected: no hits in app.html / app.js
  ```
- **Feel check**:
  1. Hard-reload app, open terminal workspace, move pointer across smartbar dock — items still magnify (CSS var path OK); no console error about missing wasm/engine.
  2. Console: `window.Motion` defined, `await Motion.ready` / `Motion.usingWasm` logs without throw.
  3. Open `tests/motion-feel.html` — self-test still `MOTION_PASS`.
  4. DevTools → Rendering → `prefers-reduced-motion: reduce` — Motion feel page reduced-motion check still jumps to target.
- **Done when**: production HTML loads only zephyr-motion; contract test green; dock still responds; no dual-engine console noise; motion unit tests green.
