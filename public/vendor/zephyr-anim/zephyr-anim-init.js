/**
 * zephyr-anim-init.js
 *
 * Boots the spring engine and patches ONLY two existing JS functions:
 *   1. updateDockMagnification  — smooth spring follow replaces hard setProperty
 *   2. island grip pointerdown  — spring squish on existing @property vars
 *
 * ZERO new CSS. ZERO new transform/will-change on any element.
 * Only touches CSS vars that style.css @property already declares.
 */

import { engine } from './zephyr-anim.js';

// ── Spring ID allocation (small fixed set) ───────────────────────────────
// IDs 0-9: dock item springs (one per visible dock item)
// IDs 10-12: terminal-grip (island) sx, sy, blur
const DOCK_BASE = 0;
const DOCK_MAX  = 10;
const ISL_SX   = 10;
const ISL_SY   = 11;
const ISL_BLUR = 12;
const CAPACITY  = 16;

async function boot() {
  try {
    await engine.init(CAPACITY);

    // Configure presets
    for (let i = 0; i < DOCK_MAX; i++) engine.configure(i, 'magnify');
    engine.configure(ISL_SX,   'island');
    engine.configure(ISL_SY,   'island');
    engine.configure(ISL_BLUR, 'snappy');

    // Set initial rest values
    for (let i = 0; i < DOCK_MAX; i++) engine.setValue(i, 1.0);
    engine.setValue(ISL_SX, 1.0);
    engine.setValue(ISL_SY, 1.0);
    engine.setValue(ISL_BLUR, 0.0);

    patchDockMagnification();
    patchIslandGrip();

    window.__zaEngine = engine;
  } catch (err) {
    // Non-fatal — original JS behaviour unchanged
    console.warn('[zephyr-anim]', 'engine failed, CSS fallback active', err);
  }
}

// ── Patch 1: updateDockMagnification ────────────────────────────────────
// Original: writes --dock-scale/lift/shift/blur/rotate instantly via setProperty
// New: same calculation, but springs to each target value.
// The CSS rule that consumes these vars is UNCHANGED:
//   .smartbar-session { transform: translate3d(var(--dock-shift),var(--dock-lift),0)
//                                  scale(var(--dock-scale)) rotateZ(var(--dock-rotate)); }
function patchDockMagnification() {
  if (typeof window.updateDockMagnification !== 'function') return;

  // Per-item spring state: Map<Element, { ids: {scale,lift,shift,rotate} }>
  const itemState = new Map();
  let nextSlot = DOCK_BASE; // allocate from pool as items appear

  function getOrAlloc(item) {
    if (itemState.has(item)) return itemState.get(item);
    if (nextSlot >= DOCK_BASE + DOCK_MAX) return null; // pool exhausted — fallback
    const ids = { scale: nextSlot };
    // Each item needs 4 springs (scale, lift, shift, rotate).
    // With DOCK_MAX=10 slots, support up to 2 items with 4 springs each,
    // or use a single shared slot per item for scale only and fallback rest.
    // For simplicity: allocate 1 slot per item for scale (most visible effect).
    // lift/shift/rotate use direct setProperty (less critical for smoothness).
    nextSlot++;
    engine.configure(ids.scale, 'magnify');
    engine.setValue(ids.scale, 1.0);
    itemState.set(item, ids);
    return ids;
  }

  window.updateDockMagnification = function(clientX, dock, clientY) {
    if (!dock) dock = document.querySelector('.smartbar-dock');
    if (!dock) return;
    const verticalDock = window.isCompactTerminalWorkspace?.() &&
                         document.body.classList.contains('terminal-custom-fullscreen-open');
    const influence = verticalDock ? 118 : 142;
    const pointerCoord = verticalDock ? (clientY ?? 0) : clientX;

    dock.querySelectorAll('.smartbar-session, .smartbar-add').forEach(item => {
      const rect   = item.getBoundingClientRect();
      const center = verticalDock
        ? rect.top  + rect.height / 2
        : rect.left + rect.width  / 2;
      const d      = Math.abs(pointerCoord - center);
      const t      = Math.max(0, 1 - d / influence);
      const eased  = 1 - Math.pow(1 - t, 3);
      const dir    = Math.sign(center - pointerCoord);

      const targetScale  = 1 + eased * 0.26;
      const targetLift   = (-eased * (verticalDock ? 6 : 15));
      const targetShift  = dir * eased * (verticalDock ? 9 : 8);
      const targetRotate = dir * eased * (verticalDock ? -1.1 : -0.7);
      const targetBlur   = (1 - eased) * 0.14;

      const state = getOrAlloc(item);
      if (state) {
        // Scale: spring-driven (most visible effect)
        engine.animateTo(state.scale, targetScale);
        engine.bind(state.scale, item, '--dock-scale');
        // lift/shift/rotate: write directly (they're already part of transform,
        // and CSS transition on transform handles smoothing here)
        item.style.setProperty('--dock-lift',   `${targetLift.toFixed(2)}px`);
        item.style.setProperty('--dock-shift',  `${targetShift.toFixed(2)}px`);
        item.style.setProperty('--dock-rotate', `${targetRotate.toFixed(2)}deg`);
        item.style.setProperty('--dock-blur',   `${targetBlur.toFixed(2)}px`);
      } else {
        // Fallback: original behaviour
        item.style.setProperty('--dock-scale',  targetScale.toFixed(3));
        item.style.setProperty('--dock-lift',   `${targetLift.toFixed(2)}px`);
        item.style.setProperty('--dock-shift',  `${targetShift.toFixed(2)}px`);
        item.style.setProperty('--dock-blur',   `${targetBlur.toFixed(2)}px`);
        item.style.setProperty('--dock-rotate', `${targetRotate.toFixed(2)}deg`);
      }
    });
  };

  // Patch reset to spring-return instead of removeProperty
  const origReset = window.resetDockMagnification;
  window.resetDockMagnification = function(dock) {
    if (!dock) dock = document.querySelector('.smartbar-dock');
    if (!dock) { origReset?.call(window, dock); return; }
    dock.querySelectorAll('.smartbar-session, .smartbar-add').forEach(item => {
      const state = itemState.get(item);
      if (state) {
        engine.configure(state.scale, 'snappy');
        engine.animateTo(state.scale, 1.0);
        // reset to 'dock' preset after settle
        setTimeout(() => engine.configure(state.scale, 'magnify'), 500);
      } else {
        item.style.removeProperty('--dock-scale');
      }
      // These reset immediately (not spring-driven, matches original feel)
      item.style.removeProperty('--dock-lift');
      item.style.removeProperty('--dock-shift');
      item.style.removeProperty('--dock-blur');
      item.style.removeProperty('--dock-rotate');
    });
  };
}

// ── Patch 2: island grip spring squish ───────────────────────────────────
// .terminal-grip already reads --island-fluid-scale-x/y/blur via @property.
// We add pointerdown/up listeners that spring those vars instead of the
// CSS @keyframes terminalIslandTapBounce — no CSS change needed.
function patchIslandGrip() {
  function attachGrip(el) {
    if (el.__zaGripHooked) return;
    el.__zaGripHooked = true;

    // One shared binding per grip element to the three existing @property vars
    // We reuse ISL_SX/SY/BLUR slots but rebind per element on press
    // (only one grip can be pressed at a time, so shared slots are fine)

    el.addEventListener('pointerdown', () => {
      // Squish: wider X, shorter Y — same gesture as Dynamic Island on iPhone
      engine.unbind(ISL_SX);
      engine.unbind(ISL_SY);
      engine.unbind(ISL_BLUR);
      engine.bind(ISL_SX,   el, '--island-fluid-scale-x');
      engine.bind(ISL_SY,   el, '--island-fluid-scale-y');
      engine.bind(ISL_BLUR, el, '--island-fluid-blur', 'px');
      engine.animateTo(ISL_SX,   1.12);
      engine.animateTo(ISL_SY,   0.84);
      engine.animateTo(ISL_BLUR, 1.8);
    }, { passive: true });

    const release = () => {
      engine.animateTo(ISL_SX,   1.0);
      engine.animateTo(ISL_SY,   1.0);
      engine.animateTo(ISL_BLUR, 0.0);
    };
    el.addEventListener('pointerup',     release, { passive: true });
    el.addEventListener('pointercancel', release, { passive: true });
  }

  // Attach to existing grips + watch for new ones
  document.querySelectorAll('.terminal-grip').forEach(attachGrip);
  new MutationObserver(() => {
    document.querySelectorAll('.terminal-grip:not([data-za-grip])').forEach(el => {
      el.dataset.zaGrip = '1';
      attachGrip(el);
    });
  }).observe(document.body, { childList: true, subtree: true });
}

// Boot after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
