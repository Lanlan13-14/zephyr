/**
 * zephyr-motion — entry point.
 *
 *   import { Motion, engine, PRESETS } from './vendor/zephyr-motion/index.js';
 *   // or after load: window.Motion
 */
import { engine, Engine } from './runtime.js';
import { Motion } from './motion.js';
import { PRESETS, MOTION_STANDARDS, STANDARD_FALLBACKS, resolvePreset } from './presets.js';

export { engine, Engine, Motion, PRESETS, MOTION_STANDARDS, STANDARD_FALLBACKS, resolvePreset };

if (typeof window !== 'undefined') {
  window.Motion = Motion;
  // Auto-boot; explicit Motion.init({capacity}) is idempotent.
  engine.init(256).catch(err =>
    console.warn('[zephyr-motion] engine init failed:', err?.message || err)
  );
}
