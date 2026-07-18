/**
 * Shared harness for motion wasm ABI tests.
 *
 * Loads, in order of preference:
 *   1. ZEPHYR_MOTION_WASM env path (local stdgo verification build —
 *      needs ZEPHYR_WASM_EXEC pointing at Go's wasm_exec.js glue)
 *   2. public/vendor/zephyr-motion/zephyr_motion.wasm (committed TinyGo
 *      artifact — freestanding, empty imports)
 *
 * Returns null when no artifact exists (tests skip with instructions).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWasiShim, isWasiExit } from '../public/vendor/zephyr-motion/wasi-shim.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..');
export const DEFAULT_ARTIFACT = join(REPO_ROOT, 'public/vendor/zephyr-motion/zephyr_motion.wasm');
export const GOLDEN_PATH = join(REPO_ROOT, 'motion-wasm/motion/testdata/motion-golden.json');

export function loadGolden() {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
}

/** Advance the engine to absolute time `toT` in sub-clamp steps. */
export function tickTo(ex, fromT, toT) {
  let t = fromT;
  while (toT - t > 1e-12) {
    const dt = Math.min(0.032, toT - t);
    ex.engine_tick(dt);
    t += dt;
  }
  return t;
}

function bootExports(instance, kind) {
  const ex = instance.exports;
  ex.__wasm_call_ctors?.();
  if (typeof ex._initialize === 'function') {
    ex._initialize();
  } else if (typeof ex._start === 'function') {
    try { ex._start(); } catch (err) { if (!isWasiExit(err)) throw err; }
  }
  if (typeof ex.engine_init !== 'function') {
    throw new Error(`${kind}: module lacks engine_init`);
  }
  return { exports: ex, kind };
}

async function instantiateWithTiers(bytes, kind) {
  // Tier 1: freestanding.
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return bootExports(instance, kind);
  } catch { /* needs imports */ }
  // Tier 2: TinyGo — WASI via shared shim.
  const { imports, setMemory } = createWasiShim();
  const { instance } = await WebAssembly.instantiate(bytes, {
    wasi_snapshot_preview1: imports,
  });
  setMemory(instance.exports.memory ?? instance.exports.mem);
  return bootExports(instance, kind);
}

export async function loadMotionWasm() {
  const envWasm = process.env.ZEPHYR_MOTION_WASM;

  if (envWasm) {
    if (!existsSync(envWasm)) throw new Error(`ZEPHYR_MOTION_WASM not found: ${envWasm}`);
    const bytes = readFileSync(envWasm);
    try {
      return await instantiateWithTiers(bytes, 'env-build');
    } catch { /* stdgo build — needs glue */ }
    const gluePath = process.env.ZEPHYR_WASM_EXEC;
    if (!gluePath || !existsSync(gluePath)) {
      throw new Error('stdgo build needs ZEPHYR_WASM_EXEC=/path/to/wasm_exec.js');
    }
    new Function(readFileSync(gluePath, 'utf8'))(); // registers globalThis.Go
    // The Go runtime parks its scheduler on setTimeout; unref those timers
    // so the Node test process can exit when the suite is done.
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      const t = origSetTimeout(fn, ms, ...args);
      t.unref?.();
      return t;
    };
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    go.run(instance); // main blocks; exports are live
    globalThis.setTimeout = origSetTimeout;
    return { exports: instance.exports, kind: 'stdgo' };
  }

  if (!existsSync(DEFAULT_ARTIFACT)) return null;
  const bytes = readFileSync(DEFAULT_ARTIFACT);
  return instantiateWithTiers(bytes, 'artifact');
}

export const EXPECTED_EXPORTS = [
  'engine_init', 'engine_capacity', 'engine_configure', 'engine_set_epsilon',
  'engine_animate_to', 'engine_animate_to_delayed', 'engine_flick_to',
  'engine_set_value', 'engine_get_value', 'engine_get_velocity',
  'engine_is_active', 'engine_stop', 'engine_tick',
  'engine_buffer_ptr', 'engine_buffer_len',
  'tracker_push', 'tracker_velocity_x', 'tracker_velocity_y', 'tracker_clear',
  'project', 'rubberband', 'rubberband_clamp', 'cubic_bezier_sample',
];
