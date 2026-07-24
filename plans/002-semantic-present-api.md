# 002 — Add semantic present / dismiss / sheet / popover APIs

- **Status**: DONE (API + feel demos + contract tests only; production CSS/app.js **not** wired)
- **Commit**: ef3592d (authored against)
- **Severity**: HIGH
- **Category**: Interruptibility / API surface / Missed opportunities
- **Estimated scope**: 2–4 files under `public/vendor/zephyr-motion/` + feel page demos + tests; **no** bulk CSS migration yet

## Problem

`Motion` today is atomic channels only:

```js
/* public/vendor/zephyr-motion/motion.js — public surface (abbrev.) */
Motion.to / set / stop / value / release
Motion.morph / morphTo
Motion.track / drag / press / stagger
```

Production CSS already encodes **dozens** of enter/exit recipes the engine cannot name:

| CSS (examples) | Need |
|---|---|
| `fadeIn`, `aiIosFadeLift`, `aiIosPopIn` | opacity + small scale enter |
| `dockerDrawerIn`, `aiIosSlideSheet` | edge sheet + (usually) scrim |
| `floatingPanelOpenFromButton` / `CloseToButton` | origin-aware from trigger rect |
| `transferPopoverIn`, `panelMenuPopIn` | popover scale from origin |
| `connectionCardIn` + notes list | staggered list enter |

Without semantic helpers, call sites either:

1. Keep uninterruptible `@keyframes` (restart from zero on spam), or  
2. Hand-roll `Motion.to({ opacity, scale, y })` with inconsistent presets → feels **worse than current CSS**.

Keyframes cannot retarget mid-flight (AUDIT §4). Emil rule: UI that can be triggered rapidly must use transitions/springs.

## Target

Extend `public/vendor/zephyr-motion/motion.js` (and re-export from `index.js`) with **semantic, interrupt-safe** helpers. All values fixed below — do not invent new curves.

### Presets (already in `presets.js` — reuse, do not duplicate)

| Name | response | damping | Use |
|---|---|---|---|
| `snappy` | 0.28 | 1.0 | popovers, small enter, press-adjacent |
| `ui` | 0.40 | 1.0 | default reposition |
| `gentle` | 0.55 | 1.0 | large surfaces |
| `sheet` | 0.30 | 0.80 | drawers / sheets only (bounce allowed) |
| `morph` | 0.45 | 0.92 | shared-element only |

### New API (exact signatures)

```js
/**
 * Generic enter: from rest pose → identity.
 * Default from: { opacity: 0, scale: 0.96 }  // NEVER scale 0
 * preset default: 'snappy'
 * reduced-motion: jump to end via engine
 */
Motion.present(el, {
  from = { opacity: 0, scale: 0.96 },
  to = { opacity: 1, scale: 1, x: 0, y: 0 },
  preset = 'snappy',
  delay = 0,
} = {})

/**
 * Generic exit to a pose, then optional display:none / callback.
 * Prefer same path as present (spatial consistency).
 */
Motion.dismiss(el, {
  to = { opacity: 0, scale: 0.96 },
  preset = 'snappy',
  delay = 0,
  thenHide = false, // if true: el.hidden = true or el.style.display = 'none' AFTER settle
} = {})

/**
 * Origin-aware popover: scale from trigger rect center (or transform-origin point).
 * Sets transform-origin to trigger, then present from scale 0.96 + opacity 0.
 * Modals MUST NOT use this — they stay center origin.
 */
Motion.popover(el, triggerElOrRect, {
  preset = 'snappy',
  fromScale = 0.96,
} = {})

/**
 * Edge sheet: y from 100% of self height (or px), optional scrimEl opacity 0→1.
 * Sheet body preset: 'sheet' { response: 0.30, damping: 0.80 }
 * Scrim: critically damped 'ui' or 'snappy', opacity only — no bounce.
 */
Motion.sheet(el, {
  edge = 'bottom', // 'bottom' | 'top' | 'left' | 'right'
  scrim = null,    // HTMLElement | null
  preset = 'sheet',
  open = true,     // false → dismiss toward edge
} = {})

/**
 * Ordered multi-step spring chain (island melt, multi-phase UI).
 * Each step: { el, props, preset?, delay? } | { wait: seconds }
 * Always interruptible per channel; cancelling = Motion.stop on listed els.
 */
Motion.sequence(steps = [])

/**
 * Bind N CSS custom properties on one element to spring slots
 * (dock: --dock-scale, --dock-lift, …). Units map required for non-unitless.
 * Does not compose transform itself — CSS rules consume the vars.
 */
Motion.cssVars(el, {
  // propNameWithoutUnitInKey: targetNumber
}, {
  units = {},      // e.g. { '--dock-lift': 'px', '--dock-rotate': 'deg' }
  preset = 'dock',
  immediate = false, // true → Motion.set semantics
} = {})
```

### Exact default enter/exit values (Emil / AUDIT)

```text
Enter: opacity 0 → 1, scale 0.96 → 1   (allowed range scale start 0.95–0.97)
Exit:  reverse the same path
Sheet bottom open:  y = +height → 0   (use el.offsetHeight or getBoundingClientRect().height)
Sheet bottom close: y = 0 → +height
Scrim: opacity 0 → 0.24..0.4 (match existing -- use 0.24 for connection parity) with preset snappy/ui, damping 1.0
NEVER scale(0)
Popover transform-origin: pixel origin at trigger center relative to el, or style.transformOrigin = `${tx}px ${ty}px`
```

### Implementation notes for the executor

1. Implement helpers **on top of** existing `to` / `set` / `stop` / `value` / `release` — no new wasm ABI.
2. `present`: if not in flight, `set(el, from)` then `to(el, to, { preset, delay })`. If in flight, only `to` (retarget).
3. `dismiss`: `to` then on settle optionally hide; return the Promise from `to`.
4. `popover`: compute origin:
   ```js
   const tr = trigger.getBoundingClientRect?.() ?? trigger;
   const er = el.getBoundingClientRect();
   const ox = (tr.left + tr.width/2) - er.left;
   const oy = (tr.top + tr.height/2) - er.top;
   el.style.transformOrigin = `${ox}px ${oy}px`;
   return Motion.present(el, { from: { opacity: 0, scale: fromScale }, preset });
   ```
5. `sheet`: map edge → channel:
   - bottom: `y` from `+h` to `0`
   - top: `y` from `-h` to `0`
   - right: `x` from `+w` to `0`
   - left: `x` from `-w` to `0`
   Scrim separate `to(scrim, { opacity: open ? target : 0 }, { preset: 'snappy' })`.
6. `sequence`: async function; for each step await previous Promise; support `{ wait: 0.05 }`.
7. `cssVars`: for each key starting with `--`, use existing channel path in `writerFor` (already supports `--*`). Call `to` or `set` with `units`.
8. Export everything on `Motion` object; ensure `index.js` does not need changes beyond existing `export { Motion }`.

### Feel page additions (`tests/motion-feel.html`)

Add sections (copy pattern of existing demos):

- **Present/dismiss** button spam mid-flight  
- **Popover from chip** (origin-aware)  
- **Bottom sheet + scrim** drag-optional later; open/close spam  
- **Sequence** three list items with waits  

Extend self-test checks:

```js
check('present rejects scale 0 defaults', /* default from.scale >= 0.95 */);
check('sheet bottom uses y channel', /* after open value y≈0 */);
```

## Repo conventions to follow

- File: `public/vendor/zephyr-motion/motion.js` only for API (keep runtime.js physics-agnostic).
- Presets only from `resolvePreset` / `PRESETS` in `presets.js`.
- Comments in motion.js header already mandate: interruptible springs, compositor props, reduced-motion short-circuit — keep helpers inside those rules.
- Exemplar usage style: `tests/motion-feel.html` (`Motion.press`, `Motion.morph`, `Motion.stagger`).

## Steps

1. Read full `motion.js` and `presets.js` at commit `ef3592d` to ensure slot/writer still match.
2. Append the six methods to `export const Motion = { ... }` **before** the tracker helpers, reusing `slotFor` / `to` / `set`.
3. Wire `cssVars` through existing `--` branch in `writerFor` (already present).
4. Update `motion-wasm/README.md` API list (one table row per helper).
5. Extend `tests/motion-feel.html` demos + self-tests.
6. Add `tests/motion-semantic-api-contract.test.mjs` that **string-matches** source for function names and default `scale: 0.96` (and asserts no `scale: 0` default):
   ```js
   assert.match(motionJs, /present\s*\(/);
   assert.match(motionJs, /dismiss\s*\(/);
   assert.match(motionJs, /popover\s*\(/);
   assert.match(motionJs, /sheet\s*\(/);
   assert.match(motionJs, /sequence\s*\(/);
   assert.match(motionJs, /cssVars\s*\(/);
   assert.match(motionJs, /scale:\s*0\.96|scale\s*=\s*0\.96|fromScale\s*=\s*0\.96/);
   assert.doesNotMatch(motionJs, /from\s*=\s*\{\s*opacity:\s*0,\s*scale:\s*0\s*\}/);
   ```
7. Run motion unit tests + new contract test.

## Boundaries

- Do **NOT** migrate production CSS keyframes to these APIs yet (plans 003–005 call them).
- Do **NOT** change wasm / spring math / PRESET numeric values.
- Do **NOT** add Framer/Motion One/GSAP.
- Do **NOT** animate `width`/`height`/`top`/`left` in these helpers (sheet uses transform `x`/`y` only).
- Do **NOT** use `damping < 1` except `preset: 'sheet'` / `'bouncy'` / `'morph'` / `'island'` as already defined.
- If `writerFor` cannot set a needed prop, STOP — do not invent layout animation.

## Verification

- **Mechanical**:
  ```bash
  node --test tests/motion-spring-js.test.mjs tests/motion-runtime.test.mjs tests/motion-abi.test.mjs
  node --test tests/motion-semantic-api-contract.test.mjs
  node --check public/vendor/zephyr-motion/motion.js
  ```
- **Feel check** (`tests/motion-feel.html`, Animations panel 10% speed):
  1. Spam present/dismiss — motion reverses from live scale/opacity, no jump to 0.
  2. Popover opens from the chip, not the viewport center (`transform-origin` not `50% 50%`).
  3. Sheet: body slides from bottom; scrim fades with **no** overshoot; sheet may soft-settle with sheet preset.
  4. Sequence steps do not block pointer on previous elements after they settle.
  5. `prefers-reduced-motion: reduce` — present jumps to full opacity/scale without travel.
- **Done when**: all six APIs exist, contract + motion tests green, feel page demos interruptible, defaults never use `scale(0)`.
