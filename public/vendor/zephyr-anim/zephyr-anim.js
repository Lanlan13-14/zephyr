/**
 * zephyr-anim.js — minimal Rust/WASM spring bridge
 *
 * RULES:
 *   1. Zero new CSS. Zero new transform/will-change/transition on any element.
 *   2. Only writes CSS custom properties that style.css @property already declares.
 *   3. Only patches two JS call sites:
 *        - updateDockMagnification  → smooth spring magnify follow
 *        - island grip press        → spring squish on --island-fluid-scale-x/y/blur
 *
 * Spring output buffer: Float64Array [value, velocity, active] × capacity
 * All WASM exports are plain C ABI (no wasm-bindgen needed).
 */

const WASM_URL = new URL('./zephyr_anim.wasm', import.meta.url).href;
const BUF_STRIDE = 3;

// Presets matching Apple HIG values
const PRESETS = {
  magnify : { k: 460, c: 32, m: 0.9 },  // dock: near-instant follow, spring tail on release
  island  : { k: 420, c: 15, m: 1.0 },  // Dynamic Island squish
  snappy  : { k: 300, c: 28, m: 1.0 },  // general fast
  bouncy  : { k: 380, c: 18, m: 1.0 },  // dock press release
};

class SpringEngine {
  constructor() {
    this._ex   = null;
    this._mem  = null;
    this._buf  = null;
    this._bind = new Map();   // id → { el, prop, unit }
    this._rafId = 0;
    this._lastTs = -1;
    this._ready = false;
    this._q = [];
    this._rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    matchMedia('(prefers-reduced-motion: reduce)')
      .addEventListener('change', e => { this._rm = e.matches; });
  }

  async init(cap = 128) {
    const { instance } = await WebAssembly.instantiate(
      await (await fetch(WASM_URL)).arrayBuffer(), {}
    );
    this._ex  = instance.exports;
    this._mem = instance.exports.memory;
    this._ex.engine_init(cap);
    this._rebuf();
    this._ready = true;
    this._q.forEach(f => f());
    this._q = [];
    return this;
  }

  _rebuf() {
    const ptr = this._ex.engine_buffer_ptr();
    const len = this._ex.engine_buffer_len();
    this._buf = new Float64Array(this._mem.buffer, ptr, len);
  }

  /** Configure spring slot with a named preset. */
  configure(id, preset = 'snappy') {
    if (!this._ready) { this._q.push(() => this.configure(id, preset)); return; }
    const p = PRESETS[preset] ?? PRESETS.snappy;
    this._ex.engine_configure(id, p.k, p.c, p.m);
  }

  /**
   * Animate slot id toward target.
   * Interrupt-safe: carries velocity from any running animation.
   */
  animateTo(id, target) {
    if (!this._ready) { this._q.push(() => this.animateTo(id, target)); return; }
    if (this._rm) { this._ex.engine_set_value(id, target); this._applyBind(id, target); return; }
    this._ex.engine_animate_to(id, target);
    this._wake();
  }

  /** Set value instantly (no animation). */
  setValue(id, value) {
    if (!this._ready) { this._q.push(() => this.setValue(id, value)); return; }
    this._ex.engine_set_value(id, value);
    this._applyBind(id, value);
  }

  getValue(id) { return this._ready ? this._ex.engine_get_value(id) : 0; }

  /**
   * Bind slot id to a CSS custom property on element el.
   * On each rAF tick the engine writes:  el.style.setProperty(prop, value + unit)
   */
  bind(id, el, prop, unit = '') {
    if (!this._bind.has(id)) this._bind.set(id, []);
    this._bind.get(id).push({ el, prop, unit });
  }

  unbind(id) { this._bind.delete(id); }

  // ── rAF loop ────────────────────────────────────────────────────────────

  _loop() {
    this._rafId = requestAnimationFrame(ts => {
      const dt = this._lastTs < 0 ? 0.016 : (ts - this._lastTs) / 1000;
      this._lastTs = ts;
      if (this._buf.buffer !== this._mem.buffer) this._rebuf();
      const active = this._ex.engine_tick(dt);
      for (const [id, binds] of this._bind) {
        const v = this._buf[id * BUF_STRIDE];
        for (const b of binds) b.el.style.setProperty(b.prop, v + b.unit);
      }
      if (active > 0) {
        this._loop();
      } else {
        this._rafId = 0;
        this._lastTs = -1;
      }
    });
  }

  _wake() { if (!this._rafId) this._loop(); }

  _applyBind(id, value) {
    const bs = this._bind.get(id);
    if (bs) for (const b of bs) b.el.style.setProperty(b.prop, value + b.unit);
  }
}

export const engine = new SpringEngine();
export { PRESETS };
