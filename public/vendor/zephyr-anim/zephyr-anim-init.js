/**
 * zephyr-anim-init.js
 * Entry point: loads engine + wires UI after DOM is ready.
 * Include as <script type="module"> at end of <body> in app.html.
 */

import { ZephyrAnimUI } from './zephyr-anim-ui.js';
import { animEngine } from './zephyr-anim.js';

async function boot() {
  try {
    await ZephyrAnimUI.init();
    document.documentElement.dataset.zephyrAnimReady = '1';
    // Expose on window so app.js internal functions can call the engine
    window.ZephyrAnim   = ZephyrAnimUI;
    window.__zaEngine   = animEngine;   // raw engine for app.js patches
    // Dispatch event so app.js can hook into after-init actions
    document.dispatchEvent(new CustomEvent('zephyr-anim-ready', { detail: ZephyrAnimUI }));
  } catch (err) {
    // Non-fatal: CSS fallback animations remain intact
    console.warn('[zephyr-anim]', 'engine failed to load, using CSS fallback', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
