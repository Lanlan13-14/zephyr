/**
 * zephyr-anim.js  v2 — Rust/WASM spring physics bridge
 *
 * New in v2:
 *   • Per-element per-property spring registry  (springEl / stopEl / setEl)
 *   • Dynamic spring ID allocation from a shared pool (IDs 64-255)
 *   • Multi-property element animation:  animateElTo(el, { left, top, … }, preset)
 *   • Spring group: animate multiple IDs together with the same preset
 *
 * Buffer layout (Float64Array, zero-copy):
 *   offset = id * 3  →  [value, velocity, active(0|1)]
 */

const WASM_URL = new URL('./zephyr_anim.wasm', import.meta.url).href;

export const SPRING_PRESETS = Object.freeze({
  snappy      : { stiffness: 300, damping: 28,  mass: 1.0 },
  gentle      : { stiffness: 200, damping: 26,  mass: 1.0 },
  bouncy      : { stiffness: 380, damping: 18,  mass: 1.0 },
  stiff       : { stiffness: 600, damping: 44,  mass: 1.0 },
  flick       : { stiffness: 260, damping: 22,  mass: 0.8 },
  sheet       : { stiffness: 240, damping: 30,  mass: 1.2 },
  island      : { stiffness: 420, damping: 15,  mass: 1.0 },
  dock        : { stiffness: 340, damping: 26,  mass: 1.0 },
  hero        : { stiffness: 280, damping: 30,  mass: 1.1 }, // full-screen hero transition
  magnify     : { stiffness: 460, damping: 32,  mass: 0.9 }, // dock magnification follow
  window_open : { stiffness: 320, damping: 26,  mass: 1.0 },
  window_close: { stiffness: 380, damping: 38,  mass: 1.0 },
});

export const BEZIER_PRESETS = Object.freeze({
  easeInOut : [0.42, 0.0,  0.58, 1.0],
  easeOut   : [0.0,  0.0,  0.58, 1.0],
  easeIn    : [0.42, 0.0,  1.0,  1.0],
  iosSpring : [0.32, 0.72, 0.0,  1.0],
  iosBounce : [0.34, 1.56, 0.64, 1.0],
  smooth    : [0.16, 1.0,  0.3,  1.0],
});

const BUF_STRIDE    = 3;
const POOL_START_ID = 64;   // IDs 0-63 are reserved for named slots in ui.js
const POOL_SIZE     = 192;  // total capacity = 256

// ── Binding ───────────────────────────────────────────────────────────────────
class Binding {
  constructor(el, prop, unit, formatFn) {
    this.el = el; this.prop = prop; this.unit = unit; this.formatFn = formatFn;
  }
  apply(v) {
    if (this.formatFn) this.el.style.setProperty(this.prop, this.formatFn(v));
    else               this.el.style.setProperty(this.prop, v + this.unit);
  }
}

// ── Tween ─────────────────────────────────────────────────────────────────────
class Tween {
  constructor(from, to, ms, bezier, onUpdate, onDone) {
    Object.assign(this, { from, to, ms, bezier, onUpdate, onDone, elapsed: 0, done: false });
  }
  tick(dt, sampleFn) {
    if (this.done) return;
    this.elapsed += dt * 1000;
    const t = Math.min(this.elapsed / this.ms, 1.0);
    const [p1x, p1y, p2x, p2y] = this.bezier;
    const e = sampleFn(p1x, p1y, p2x, p2y, t);
    this.onUpdate(this.from + (this.to - this.from) * e);
    if (t >= 1.0) { this.done = true; this.onDone?.(); }
  }
}

// ── Per-element registry ───────────────────────────────────────────────────────
// Key: `${elId}:${prop}`  →  { springId, el, prop, unit, formatFn }
let _elSeq = 0;
function elId(el) {
  if (!el.__zaId) el.__zaId = ++_elSeq;
  return el.__zaId;
}

// ── Main engine ───────────────────────────────────────────────────────────────
export class ZephyrAnimEngine {
  constructor() {
    this._ex      = null;
    this._mem     = null;
    this._buf     = null;
    this._bind    = new Map();    // springId → Binding[]
    this._elMap   = new Map();    // `${elId}:${prop}` → springId
    this._pool    = [];           // free spring IDs from pool
    this._tweens  = [];
    this._rafId   = 0;
    this._lastTs  = -1;
    this._ready   = false;
    this._queue   = [];
    this._rm      = matchMedia('(prefers-reduced-motion: reduce)').matches;
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e => {
      this._rm = e.matches;
    });
  }

  async init(capacity = 256) {
    const resp           = await fetch(WASM_URL);
    const buf            = await resp.arrayBuffer();
    const { instance }   = await WebAssembly.instantiate(buf, {});
    this._ex  = instance.exports;
    this._mem = instance.exports.memory;
    this._ex.engine_init(capacity);
    this._rebuf();
    // Pre-fill pool with IDs POOL_START_ID … capacity-1
    for (let i = capacity - 1; i >= POOL_START_ID; i--) this._pool.push(i);
    this._ready = true;
    for (const f of this._queue) f();
    this._queue.length = 0;
    return this;
  }

  whenReady(fn) { this._ready ? fn() : this._queue.push(fn); }

  _rebuf() {
    const ptr = this._ex.engine_buffer_ptr();
    const len = this._ex.engine_buffer_len();
    this._buf = new Float64Array(this._mem.buffer, ptr, len);
  }

  // ── Named-slot spring API (IDs 0-63, set by ui.js) ────────────────────────

  configure(id, preset = 'snappy') {
    if (!this._ready) { this.whenReady(() => this.configure(id, preset)); return this; }
    const p = typeof preset === 'string' ? (SPRING_PRESETS[preset] ?? SPRING_PRESETS.snappy) : preset;
    this._ex.engine_configure(id, p.stiffness, p.damping, p.mass);
    return this;
  }

  animateTo(id, target) {
    if (!this._ready) { this.whenReady(() => this.animateTo(id, target)); return this; }
    if (this._rm) { this._ex.engine_set_value(id, target); this._flush(id, target); return this; }
    this._ex.engine_animate_to(id, target);
    this._wake();
    return this;
  }

  flickTo(id, target, velocity) {
    if (!this._ready) { this.whenReady(() => this.flickTo(id, target, velocity)); return this; }
    if (this._rm) { this._ex.engine_set_value(id, target); this._flush(id, target); return this; }
    this._ex.engine_flick_to(id, target, velocity);
    this._wake();
    return this;
  }

  setValue(id, value) {
    if (!this._ready) { this.whenReady(() => this.setValue(id, value)); return this; }
    this._ex.engine_set_value(id, value);
    this._flush(id, value);
    return this;
  }

  stop(id)      { if (this._ready) this._ex.engine_stop(id); return this; }
  getValue(id)  { return this._ready ? this._ex.engine_get_value(id) : 0; }
  getVel(id)    { return this._ready ? this._ex.engine_get_velocity(id) : 0; }
  active(id)    { return this._ready && this._ex.engine_is_active(id) === 1; }

  bind(id, el, prop, unit = '', formatFn = null) {
    if (!this._bind.has(id)) this._bind.set(id, []);
    this._bind.get(id).push(new Binding(el, prop, unit, formatFn));
    return this;
  }

  unbind(id) { this._bind.delete(id); return this; }

  // ── Per-element registry (dynamic IDs from pool) ──────────────────────────

  /** Get or allocate a spring ID for (el, cssCustomProp). */
  _elSpringId(el, prop) {
    const key = `${elId(el)}:${prop}`;
    if (this._elMap.has(key)) return this._elMap.get(key);
    if (!this._pool.length) {
      console.warn('[zephyr-anim] spring pool exhausted');
      return 0;
    }
    const sid = this._pool.pop();
    this._elMap.set(key, sid);
    return sid;
  }

  /**
   * Animate element CSS custom property toward target using spring physics.
   * el       – DOM element
   * prop     – CSS custom property (e.g. '--za-my-val')
   * target   – numeric target value
   * preset   – spring preset name or {stiffness,damping,mass}
   * unit     – CSS unit suffix ('px', '%', 'deg', '')
   * formatFn – optional (value) => string override
   */
  springEl(el, prop, target, preset = 'snappy', unit = '', formatFn = null) {
    if (!this._ready) {
      this.whenReady(() => this.springEl(el, prop, target, preset, unit, formatFn));
      return this;
    }
    const sid = this._elSpringId(el, prop);
    // Ensure binding exists
    const key = `${elId(el)}:${prop}`;
    if (!this._bind.has(sid)) {
      this._bind.set(sid, [new Binding(el, prop, unit, formatFn)]);
      this.configure(sid, preset);
    }
    if (this._rm) {
      this._ex.engine_set_value(sid, target);
      this._flush(sid, target);
    } else {
      this.configure(sid, preset);
      this._ex.engine_animate_to(sid, target);
      this._wake();
    }
    return sid;
  }

  /** Animate multiple CSS custom properties on one element simultaneously. */
  springElProps(el, propsMap, preset = 'snappy') {
    // propsMap: { '--my-var': { target, unit?, formatFn? }, … }
    for (const [prop, opts] of Object.entries(propsMap)) {
      const { target, unit = '', formatFn = null } = typeof opts === 'number'
        ? { target: opts }
        : opts;
      this.springEl(el, prop, target, preset, unit, formatFn);
    }
    return this;
  }

  /** Teleport element CSS prop with no animation. */
  setEl(el, prop, value, unit = '', formatFn = null) {
    if (!this._ready) { this.whenReady(() => this.setEl(el, prop, value, unit, formatFn)); return this; }
    const sid = this._elSpringId(el, prop);
    if (!this._bind.has(sid)) {
      this._bind.set(sid, [new Binding(el, prop, unit, formatFn)]);
    }
    this._ex.engine_set_value(sid, value);
    this._flush(sid, value);
    return this;
  }

  /** Stop a per-element spring. */
  stopEl(el, prop) {
    const key = `${elId(el)}:${prop}`;
    const sid = this._elMap.get(key);
    if (sid != null && this._ready) this._ex.engine_stop(sid);
    return this;
  }

  /** Release a per-element spring slot back to pool. */
  releaseEl(el, prop) {
    const key = `${elId(el)}:${prop}`;
    const sid = this._elMap.get(key);
    if (sid != null) {
      this._ex.engine_stop(sid);
      this._bind.delete(sid);
      this._elMap.delete(key);
      this._pool.push(sid); // return to pool
    }
    return this;
  }

  /** Release ALL springs bound to an element. */
  releaseAllEl(el) {
    const prefix = `${elId(el)}:`;
    for (const [key, sid] of this._elMap) {
      if (key.startsWith(prefix)) {
        this._ex.engine_stop(sid);
        this._bind.delete(sid);
        this._elMap.delete(key);
        this._pool.push(sid);
      }
    }
    return this;
  }

  // ── Tween ──────────────────────────────────────────────────────────────────

  tween(from, to, ms, bezierOrName = 'smooth', onUpdate) {
    if (this._rm) { onUpdate(to); return Promise.resolve(); }
    const bz = typeof bezierOrName === 'string'
      ? (BEZIER_PRESETS[bezierOrName] ?? BEZIER_PRESETS.smooth)
      : bezierOrName;
    return new Promise(res => {
      this._tweens.push(new Tween(from, to, ms, bz, onUpdate, res));
      this._wake();
    });
  }

  // ── Pointer tracker ────────────────────────────────────────────────────────

  trackerInit(tid)           { if (this._ready) this._ex.tracker_init(tid); return this; }
  trackerPush(tid, t, x, y) { if (this._ready) this._ex.tracker_push(tid, t, x, y); return this; }
  trackerVX(tid)             { return this._ready ? this._ex.tracker_velocity_x(tid) : 0; }
  trackerVY(tid)             { return this._ready ? this._ex.tracker_velocity_y(tid) : 0; }
  trackerClear(tid)          { if (this._ready) this._ex.tracker_clear(tid); return this; }

  // ── rAF loop ───────────────────────────────────────────────────────────────

  _loop() {
    this._rafId = requestAnimationFrame(ts => {
      const dt = this._lastTs < 0 ? 0.016 : (ts - this._lastTs) / 1000;
      this._lastTs = ts;
      if (this._buf.buffer !== this._mem.buffer) this._rebuf();
      const activeCount = this._ex.engine_tick(dt);
      for (const [id, bs] of this._bind) {
        if (!bs.length) continue;
        const v = this._buf[id * BUF_STRIDE];
        for (const b of bs) b.apply(v);
      }
      if (this._tweens.length) {
        const sfn = this._ex.cubic_bezier_sample.bind(this._ex);
        this._tweens = this._tweens.filter(tw => { tw.tick(dt, sfn); return !tw.done; });
      }
      if (activeCount > 0 || this._tweens.length > 0) {
        this._loop();
      } else {
        this._rafId = 0;
        this._lastTs = -1;
      }
    });
  }

  _wake() { if (!this._rafId) this._loop(); }

  _flush(id, value) {
    const bs = this._bind.get(id);
    if (bs) for (const b of bs) b.apply(value);
  }

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._bind.clear();
    this._tweens = [];
  }
}

export const animEngine = new ZephyrAnimEngine();
