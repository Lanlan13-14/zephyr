/**
 * runtime.js — engine bridge: backend selection (wasm → JS fallback),
 * slot bindings, the single rAF loop, settle callbacks, reduced motion.
 *
 * Backend contract (both backends implement it):
 *   configure(id, response, damping) / configureStandard(id, standard, fallback)
 *   animateTo(id, target)
 *   animateToDelayed(id, target, delay) / flickTo(id, target, velocity)
 *   setValue / getValue / getVelocity / isActive / stop / setEpsilon
 *   tick(dtSeconds) → activeCount
 *   frameBuffer() → Float64Array [value, velocity, active] × capacity
 *   trackerPush/TrackerVelocity/trackerClear, project, rubberband, bezier
 */

import { SpringEngine, VelocityTracker, project, rubberband, rubberbandClamp, cubicBezierSample, BUFFER_STRIDE } from './spring.js';
import { createWasiShim, isWasiExit } from './wasi-shim.js';

const WASM_URL = new URL('./zephyr_motion.wasm', import.meta.url).href;
const TRACKER_COUNT = 8;

// ── wasm backend ─────────────────────────────────────────────────────────

class WasmBackend {
  constructor(exports) {
    this.ex = exports;
    // TinyGo exports linear memory as "memory"; the standard Go toolchain
    // (local verification builds) exports it as "mem".
    this.mem = exports.memory ?? exports.mem;
    if (!this.mem) throw new Error('wasm module exports no linear memory');
    this.kind = 'wasm';
    this._rebuf();
  }
  _rebuf() {
    const ptr = this.ex.engine_buffer_ptr();
    const len = this.ex.engine_buffer_len();
    this._buf = new Float64Array(this.mem.buffer, ptr, len);
  }
  frameBuffer() {
    // Go/TinyGo may grow memory, detaching the old ArrayBuffer.
    // ALSO: the constructor runs _rebuf() before engine_init() allocates the
    // frame buffer, so the cached view can be zero-length forever (identity
    // check alone never fires — same ArrayBuffer). Detect that and re-buffer.
    if (this._buf.buffer !== this.mem.buffer || this._buf.length === 0) this._rebuf();
    return this._buf;
  }
  configure(id, r, d) { this.ex.engine_configure(id, r, d); }
  configureStandard(id, standard) {
    return this.ex.engine_configure_standard?.(id, standard) === 1;
  }
  setEpsilon(p, v) { this.ex.engine_set_epsilon(p, v); }
  animateTo(id, t) { this.ex.engine_animate_to(id, t); }
  animateToDelayed(id, t, d) { this.ex.engine_animate_to_delayed(id, t, d); }
  flickTo(id, t, v) { this.ex.engine_flick_to(id, t, v); }
  setValue(id, v) { this.ex.engine_set_value(id, v); }
  getValue(id) { return this.ex.engine_get_value(id); }
  getVelocity(id) { return this.ex.engine_get_velocity(id); }
  isActive(id) { return this.ex.engine_is_active(id) === 1; }
  stop(id) { this.ex.engine_stop(id); }
  tick(dt) { return this.ex.engine_tick(dt); }
  trackerPush(id, t, x, y) { this.ex.tracker_push(id, t, x, y); }
  trackerVelocity(id) { return [this.ex.tracker_velocity_x(id), this.ex.tracker_velocity_y(id)]; }
  trackerClear(id) { this.ex.tracker_clear(id); }
  project(v, rate) { return this.ex.project(v, rate); }
  rubberband(o, d, c) { return this.ex.rubberband(o, d, c); }
  rubberbandClamp(v, mn, mx, d, c) { return this.ex.rubberband_clamp(v, mn, mx, d, c); }
  bezier(x1, y1, x2, y2, x) { return this.ex.cubic_bezier_sample(x1, y1, x2, y2, x); }
}

/** Run whatever startup the module exposes, tolerating command-style main
 * that ends in proc_exit (runtime init already happened by then). */
function bootModule(instance) {
  const ex = instance.exports;
  if (typeof ex.__wasm_call_ctors === 'function') ex.__wasm_call_ctors();
  if (typeof ex._initialize === 'function') {
    ex._initialize();
  } else if (typeof ex._start === 'function') {
    try { ex._start(); } catch (err) { if (!isWasiExit(err)) throw err; }
  }
  if (typeof ex.engine_init !== 'function') throw new Error('engine_init missing');
  return new WasmBackend(ex);
}

async function instantiateWasm(url) {
  const bytes = await (await fetch(url)).arrayBuffer();

  // Tier 1: freestanding module — empty imports.
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return bootModule(instance);
  } catch { /* needs imports — try next tier */ }

  // Tier 2: TinyGo artifact — wasi_snapshot_preview1 via our shim.
  try {
    const { imports, setMemory } = createWasiShim();
    const { instance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: imports,
    });
    const ex = instance.exports;
    setMemory(ex.memory ?? ex.mem);
    return bootModule(instance);
  } catch { /* not a TinyGo-style module — try next tier */ }

  // Tier 3: local standard-Go verification build — needs the wasm_exec
  // glue (host page loads it beforehand: globalThis.Go).
  if (typeof globalThis.Go === 'function') {
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    go.run(instance); // never resolves (main blocks); exports live already
    const ex = instance.exports;
    if (typeof ex.engine_init !== 'function') throw new Error('engine_init missing');
    return new WasmBackend(ex);
  }
  throw new Error('zephyr_motion.wasm: unsupported module (no freestanding/wasi/stdgo path matched)');
}

// ── JS fallback backend (same math, shared golden vectors) ───────────────

class JsBackend {
  constructor() {
    this.kind = 'js';
    this.engine = null;
    this.trackers = [];
    for (let i = 0; i < TRACKER_COUNT; i++) this.trackers.push(new VelocityTracker());
  }
  init(capacity) {
    this.engine = new SpringEngine(capacity);
    this.trackers.forEach(t => t.clear());
  }
  frameBuffer() { return this.engine.buffer; }
  configure(id, r, d) { this.engine.configure(id, r, d); }
  configureStandard(id, _standard, fallback) {
    if (!fallback) return false;
    this.engine.configure(id, fallback.response, fallback.damping);
    return true;
  }
  setEpsilon(p, v) { this.engine.setEpsilon(p, v); }
  animateTo(id, t) { this.engine.animateTo(id, t); }
  animateToDelayed(id, t, d) { this.engine.animateToDelayed(id, t, d); }
  flickTo(id, t, v) { this.engine.flickTo(id, t, v); }
  setValue(id, v) { this.engine.setValue(id, v); }
  getValue(id) { return this.engine.getValue(id); }
  getVelocity(id) { return this.engine.getVelocity(id); }
  isActive(id) { return this.engine.isActive(id); }
  stop(id) { this.engine.stop(id); }
  tick(dt) { return this.engine.tick(dt); }
  trackerPush(id, t, x, y) { if (this.trackers[id]) this.trackers[id].push(t, x, y); }
  trackerVelocity(id) { return this.trackers[id] ? this.trackers[id].velocity() : [0, 0]; }
  trackerClear(id) { if (this.trackers[id]) this.trackers[id].clear(); }
  project(v, rate) { return project(v, rate); }
  rubberband(o, d, c) { return rubberband(o, d, c); }
  rubberbandClamp(v, mn, mx, d, c) { return rubberbandClamp(v, mn, mx, d, c); }
  bezier(x1, y1, x2, y2, x) { return cubicBezierSample(x1, y1, x2, y2, x); }
}

// ── engine facade ────────────────────────────────────────────────────────

export class Engine {
  constructor() {
    this._b = null;             // backend
    this._ready = false;
    this._queue = [];
    this._bind = new Map();     // id → Set<writer>
    this._rest = new Map();     // id → Set<callback>
    this._restActive = new Map(); // id → last-seen active flag (settle edges)
    this._rafId = 0;
    this._lastTs = -1;
    this._rm = false;
    this._rmOverride = null;
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      this._rm = mq.matches;
      mq.addEventListener?.('change', e => { this._rm = e.matches; });
    }
  }

  /** True once a backend is live. `usingWasm` reports which one. */
  get ready() { return this._ready; }
  get usingWasm() { return this._b?.kind === 'wasm'; }

  async init(capacity = 256) {
    if (this._ready) return this;
    // Concurrent callers (auto-boot + explicit Motion.init) must share ONE
    // boot — a second instantiate would swap in a fresh backend and zero
    // every in-flight spring.
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      let backend;
      try {
        backend = await instantiateWasm(WASM_URL);
      } catch (err) {
        backend = new JsBackend();
        // Kept for diagnostics (Motion.engine.initError) — the page must be
        // able to explain why it isn't running the wasm backend.
        this.initError = String(err?.message || err);
        if (typeof console !== 'undefined') {
          console.warn('[zephyr-motion] wasm unavailable, JS fallback active:', err?.message || err);
        }
      }
      this._b = backend;
      if (backend.kind === 'js') backend.init(capacity);
      else {
        backend.ex.engine_init(capacity);
        // engine_init allocates the frame buffer — refresh the cached view so
        // frameBuffer() reads live spring state from frame one.
        backend._rebuf?.();
      }
      this._ready = true;
      this._queue.splice(0).forEach(fn => fn());
      return this;
    })();
    return this._initPromise;
  }

  _whenReady(fn) {
    if (this._ready) fn();
    else this._queue.push(fn);
  }

  get reducedMotion() { return this._rmOverride ?? this._rm; }
  /** Pass true/false to override the media query (tests, demos); null to clear. */
  setReducedMotion(v) { this._rmOverride = v; }

  configure(id, response, damping) {
    this._whenReady(() => this._b.configure(id, response, damping));
  }

  /** Configure by stable Go-owned motion standard; preserves live state. */
  configureStandard(id, standard, fallback) {
    this._whenReady(() => {
      const ok = this._b.configureStandard?.(id, standard, fallback);
      if (!ok && fallback) this._b.configure(id, fallback.response, fallback.damping);
    });
  }

  setEpsilon(posEps, velEps) {
    this._whenReady(() => this._b.setEpsilon(posEps, velEps));
  }

  /** Interrupt-safe retarget; carries velocity. No-op animation under reduced motion. */
  animateTo(id, target, { delay = 0 } = {}) {
    this._whenReady(() => {
      if (this.reducedMotion) {
        this._b.setValue(id, target);
        this._flushId(id);
        this._fireRest(id);
        return;
      }
      if (delay > 0) this._b.animateToDelayed(id, target, delay);
      else this._b.animateTo(id, target);
      // Record activation now: a spring that settles on its first tick
      // would otherwise never produce a 1→0 edge for onRest.
      this._restActive.set(id, this._b.isActive(id));
      this._wake();
    });
  }

  /** Retarget with explicit initial velocity (gesture release handoff). */
  flickTo(id, target, velocity) {
    this._whenReady(() => {
      if (this.reducedMotion) {
        this._b.setValue(id, target);
        this._flushId(id);
        this._fireRest(id);
        return;
      }
      this._b.flickTo(id, target, velocity);
      this._restActive.set(id, this._b.isActive(id));
      this._wake();
    });
  }

  /** Instant set (bypasses animation even without reduced motion). */
  setValue(id, value) {
    this._whenReady(() => {
      this._b.setValue(id, value);
      this._flushId(id);
      this._fireRest(id);
    });
  }

  getValue(id) { return this._ready ? this._b.getValue(id) : 0; }
  getVelocity(id) { return this._ready ? this._b.getVelocity(id) : 0; }
  isActive(id) { return this._ready && this._b.isActive(id); }

  stop(id) {
    this._whenReady(() => {
      this._b.stop(id);
      this._flushId(id);
      this._fireRest(id);
    });
  }

  // ── bindings ───────────────────────────────────────────────────────────

  /** bind(id, writer) — writer receives the slot value every tick. */
  bind(id, writer) {
    if (!this._bind.has(id)) this._bind.set(id, new Set());
    this._bind.get(id).add(writer);
    // Paint current value immediately so first frame isn't stale.
    if (this._ready) writer(this._b.getValue(id));
  }

  /** Convenience: bind a slot to a CSS custom property. */
  bindProp(id, el, prop, unit = '') {
    const w = v => el.style.setProperty(prop, v + unit);
    this.bind(id, w);
    return w;
  }

  unbind(id, writer) {
    const set = this._bind.get(id);
    if (!set) return;
    if (writer) set.delete(writer);
    else set.clear();
  }

  /** Register a one-shot callback fired when the slot settles. */
  onRest(id, cb) {
    if (!this._rest.has(id)) this._rest.set(id, new Set());
    this._rest.get(id).add(cb);
  }

  offRest(id, cb) { this._rest.get(id)?.delete(cb); }

  _fireRest(id) {
    const set = this._rest.get(id);
    if (set) set.forEach(cb => { try { cb(); } catch (e) { console.error(e); } });
  }

  // ── gesture / helpers (proxy to backend) ───────────────────────────────

  trackerCount() { return TRACKER_COUNT; }
  trackerPush(id, t, x, y) { this._whenReady(() => this._b.trackerPush(id, t, x, y)); }
  trackerVelocity(id) { return this._ready ? this._b.trackerVelocity(id) : [0, 0]; }
  trackerClear(id) { this._whenReady(() => this._b.trackerClear(id)); }
  project(v, rate = 0.998) { return this._ready ? this._b.project(v, rate) : project(v, rate); }
  rubberband(o, dim, c = 0.55) { return this._ready ? this._b.rubberband(o, dim, c) : rubberband(o, dim, c); }
  rubberbandClamp(v, mn, mx, dim, c = 0.55) {
    return this._ready ? this._b.rubberbandClamp(v, mn, mx, dim, c) : rubberbandClamp(v, mn, mx, dim, c);
  }
  bezier(x1, y1, x2, y2) {
    const b = this._b;
    return x => (b ? b.bezier(x1, y1, x2, y2, x) : cubicBezierSample(x1, y1, x2, y2, x));
  }

  // ── frame loop ─────────────────────────────────────────────────────────

  /** One explicit step — for tests/SSR; the rAF loop calls this too. */
  tick(dt) {
    if (!this._ready) return 0;
    const active = this._b.tick(dt);
    this._flush();
    return active;
  }

  _flushId(id) {
    const writers = this._bind.get(id);
    if (!writers || !this._ready) return;
    const v = this._b.getValue(id);
    writers.forEach(w => w(v));
  }

  _flush() {
    const buf = this._b.frameBuffer();
    for (const [id, writers] of this._bind) {
      if (writers.size === 0) continue;
      const v = buf[id * BUFFER_STRIDE];
      for (const w of writers) w(v);
    }
    // Settle transitions: active 1 → 0 fires rest callbacks once.
    for (const [id, cbs] of this._rest) {
      if (cbs.size === 0) continue;
      const wasActive = this._restActive.get(id) ?? false;
      const isActive = buf[id * BUFFER_STRIDE + 2] === 1;
      if (wasActive && !isActive) this._fireRest(id);
      this._restActive.set(id, isActive);
    }
  }

  _loop() {
    if (typeof requestAnimationFrame !== 'function') return;
    this._rafId = requestAnimationFrame(ts => {
      const dt = this._lastTs < 0 ? 1 / 60 : (ts - this._lastTs) / 1000;
      this._lastTs = ts;
      const active = this.tick(dt);
      if (active > 0) {
        this._loop();
      } else {
        this._rafId = 0;
        this._lastTs = -1;
      }
    });
  }

  _wake() {
    if (this._rafId || typeof requestAnimationFrame !== 'function') return;
    this._loop();
  }
}

/** Shared singleton (import and use directly, or construct your own Engine). */
export const engine = new Engine();
