/**
 * motion.js — the high-level API the app code uses.
 *
 * Design rules (enforced here so call sites can't regress):
 *   1. Every interactive animation is a spring: interruptible, retargets
 *      from the live presentation value, carries velocity.
 *   2. Only compositor-friendly outputs: transform / opacity / filter /
 *      declared CSS custom properties. width/height exist but are flagged
 *      layout-costly — prefer FLIP (morph) with transform.
 *   3. Gestures track 1:1, project momentum on release, hand velocity to
 *      the spring. No input lockouts anywhere in this layer.
 *   4. prefers-reduced-motion short-circuits to the end state.
 */

import { engine } from './runtime.js';
import { PRESETS, resolvePreset } from './presets.js';

// ── channel model ────────────────────────────────────────────────────────

const TRANSFORM_CH = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate']);
const FILTER_CH = new Set(['blur', 'saturate']);
const CHANNEL_DEFAULTS = {
  x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0,
  opacity: 1, radius: 0, blur: 0, saturate: 1, w: 0, h: 0,
};

function channelUnit(ch) {
  switch (ch) {
    case 'x': case 'y': case 'w': case 'h': case 'radius': case 'blur': return 'px';
    case 'rotate': return 'deg';
    default: return '';
  }
}

function composeTransform(tv) {
  const x = tv.x ?? 0, y = tv.y ?? 0;
  const sx = tv.scaleX ?? tv.scale ?? 1;
  const sy = tv.scaleY ?? tv.scale ?? 1;
  const rot = tv.rotate ?? 0;
  let out = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
  if (rot) out += ` rotate(${rot}deg)`;
  return out;
}

function composeFilter(fv) {
  const parts = [];
  if (fv.blur) parts.push(`blur(${fv.blur}px)`);
  if (fv.saturate != null && fv.saturate !== 1) parts.push(`saturate(${fv.saturate})`);
  return parts.join(' ');
}

// ── slot pool ────────────────────────────────────────────────────────────

const pool = {
  capacity: 256,
  next: 0,
  free: [],
  alloc() {
    if (this.free.length) return this.free.pop();
    if (this.next >= this.capacity) return -1;
    return this.next++;
  },
  release(id) {
    if (id < 0) return;
    this.free.push(id);
  },
};

const elStates = new WeakMap();

function stateFor(el) {
  let st = elStates.get(el);
  if (!st) {
    st = { el, slots: new Map(), tv: {}, fv: {}, managed: new Set() };
    elStates.set(el, st);
  }
  return st;
}

function defaultFor(ch) {
  if (ch.startsWith('--')) return 0;
  return CHANNEL_DEFAULTS[ch] ?? 0;
}

/** Writer for a channel: updates shared composition state, paints once. */
function writerFor(st, ch, unit) {
  const el = st.el;
  if (TRANSFORM_CH.has(ch)) {
    return v => {
      st.tv[ch] = v;
      el.style.transform = composeTransform(st.tv);
      st.managed.add('transform');
    };
  }
  if (FILTER_CH.has(ch)) {
    return v => {
      st.fv[ch] = v;
      el.style.filter = composeFilter(st.fv);
      st.managed.add('filter');
    };
  }
  switch (ch) {
    case 'opacity':
      return v => { el.style.opacity = String(v); st.managed.add('opacity'); };
    case 'radius':
      return v => { el.style.borderRadius = `${v}px`; st.managed.add('borderRadius'); };
    case 'w':
      return v => { el.style.width = `${v}px`; st.managed.add('width'); };
    case 'h':
      return v => { el.style.height = `${v}px`; st.managed.add('height'); };
    default:
      if (ch.startsWith('--')) {
        return v => { el.style.setProperty(ch, `${v}${unit}`); };
      }
      // Unknown channel: treat as CSS custom property verbatim.
      return v => { el.style.setProperty(ch, `${v}${unit}`); };
  }
}

/** Get (or lazily allocate+bind) the engine slot for (el, channel). */
function slotFor(el, ch, unit) {
  const st = stateFor(el);
  const key = ch;
  if (st.slots.has(key)) return st.slots.get(key);
  const id = pool.alloc();
  if (id < 0) {
    console.warn('[zephyr-motion] slot pool exhausted; increase capacity');
    return null;
  }
  const rec = { id, ch };
  st.slots.set(key, rec);
  engine.setValue(id, defaultFor(ch));
  engine.bind(id, writerFor(st, ch, unit ?? channelUnit(ch)));
  return rec;
}

function channelsOf(el) {
  const st = elStates.get(el);
  return st ? [...st.slots.values()] : [];
}

// ── public API ───────────────────────────────────────────────────────────

export const Motion = {
  engine,
  PRESETS,

  /** Boot the engine (idempotent). Await before first frame-critical use. */
  init({ capacity = 256 } = {}) {
    pool.capacity = capacity;
    return engine.init(capacity);
  },

  get ready() { return engine.ready; },
  get usingWasm() { return engine.usingWasm; },
  get reducedMotion() { return engine.reducedMotion; },
  setReducedMotion(v) { engine.setReducedMotion(v); },

  /**
   * Spring every prop to its target. Interrupt-safe: starts from the live
   * presentation value and carries velocity.
   *
   *   Motion.to(el, { x: 40, opacity: 1 }, { preset: 'snappy' })
   *
   * opts: preset | {response,damping} | delay (s, for stagger) |
   *       velocity (number, or {channel: v} for gesture handoff) |
   *       units ({channel: unit} for CSS vars)
   * Returns a Promise resolving when all channels settle.
   */
  to(el, props, opts = {}) {
    const p = resolvePreset(opts.preset ?? opts);
    const channels = Object.keys(props);
    if (!channels.length) return Promise.resolve();
    let pending = channels.length;
    const done = new Promise(res => {
      const settle = () => { if (--pending === 0) res(); };
      for (const ch of channels) {
        const rec = slotFor(el, ch, opts.units?.[ch]);
        if (!rec) { settle(); continue; }
        engine.configure(rec.id, p.response, p.damping);
        const target = Number(props[ch]);
        const vel = typeof opts.velocity === 'number' ? opts.velocity : opts.velocity?.[ch];
        const rest = () => { engine.offRest(rec.id, rest); settle(); };
        engine.onRest(rec.id, rest);
        if (vel != null) engine.flickTo(rec.id, target, vel);
        else engine.animateTo(rec.id, target, { delay: opts.delay ?? 0 });
      }
    });
    return done;
  },

  /** Instant set (no spring). Also the gesture 1:1-follow path. */
  set(el, props) {
    for (const ch of Object.keys(props)) {
      const rec = slotFor(el, ch);
      if (!rec) continue;
      engine.setValue(rec.id, Number(props[ch]));
    }
  },

  /** Freeze channels at their current values (on gesture grab). */
  stop(el, channels) {
    const list = channels ?? channelsOf(el).map(r => r.ch);
    for (const ch of list) {
      const st = elStates.get(el);
      const rec = st?.slots.get(ch);
      if (rec) engine.stop(rec.id);
    }
  },

  /** Current animated value of a channel (default when never animated). */
  value(el, ch) {
    const rec = elStates.get(el)?.slots.get(ch);
    return rec ? engine.getValue(rec.id) : defaultFor(ch);
  },

  isAnimating(el) {
    return channelsOf(el).some(r => engine.isActive(r.id));
  },

  /** Free all slots of an element and clear the styles this layer wrote. */
  release(el) {
    const st = elStates.get(el);
    if (!st) return;
    for (const rec of st.slots.values()) {
      engine.stop(rec.id);
      engine.unbind(rec.id);
      pool.release(rec.id);
    }
    st.slots.clear();
    for (const prop of st.managed) {
      if (prop.startsWith('--')) el.style.removeProperty(prop);
      else el.style[prop] = '';
    }
    st.managed.clear();
    st.tv = {};
    st.fv = {};
  },

  /**
   * FLIP morph: `el` is already at its final layout; make it APPEAR at
   * fromRect ({left, top, width, height}) and spring to identity.
   * If the element is mid-flight, retargets smoothly (no visual reset).
   */
  morph(el, fromRect, opts = {}) {
    const to = el.getBoundingClientRect();
    if (to.width <= 1 || to.height <= 1) return Promise.resolve();
    const inFlight = this.isAnimating(el);
    if (!inFlight) {
      el.style.transformOrigin = '0 0';
      this.set(el, {
        x: fromRect.left - to.left,
        y: fromRect.top - to.top,
        scaleX: fromRect.width / to.width,
        scaleY: fromRect.height / to.height,
      });
    }
    const props = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    if (opts.radiusFrom != null && opts.radiusTo != null && !inFlight) {
      this.set(el, { radius: opts.radiusFrom });
      props.radius = opts.radiusTo;
    }
    return this.to(el, props, { preset: 'morph', ...opts });
  },

  /** Reverse morph: spring the element so it ends up APPEARING at toRect. */
  morphTo(el, toRect, opts = {}) {
    const cur = el.getBoundingClientRect();
    if (cur.width <= 1 || cur.height <= 1) return Promise.resolve();
    el.style.transformOrigin = '0 0';
    const baseX = this.value(el, 'x');
    const baseY = this.value(el, 'y');
    const props = {
      x: baseX + (toRect.left - cur.left),
      y: baseY + (toRect.top - cur.top),
      scaleX: toRect.width / cur.width,
      scaleY: toRect.height / cur.height,
    };
    if (opts.radiusTo != null) props.radius = opts.radiusTo;
    return this.to(el, props, { preset: 'morph', ...opts });
  },

  /**
   * Low-level gesture tracker. Samples pointer position into the engine's
   * velocity tracker; handlers get live {x, y, dx, dy, vx, vy}.
   */
  track(el, handlers = {}) {
    const id = this._trackerFor(el);
    const st = { active: false, pid: -1, sx: 0, sy: 0, lx: 0, ly: 0 };
    const now = () => performance.now() / 1000;

    const down = e => {
      if (st.active) return;
      st.active = true;
      st.pid = e.pointerId;
      // May throw for synthetic/invalid pointer ids — capture is a
      // nice-to-have, never let it kill the gesture.
      try { el.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
      engine.trackerClear(id);
      engine.trackerPush(id, now(), e.clientX, e.clientY);
      st.sx = st.lx = e.clientX;
      st.sy = st.ly = e.clientY;
      handlers.onStart?.({ x: e.clientX, y: e.clientY, event: e });
    };
    const move = e => {
      if (!st.active || e.pointerId !== st.pid) return;
      engine.trackerPush(id, now(), e.clientX, e.clientY);
      const [vx, vy] = engine.trackerVelocity(id);
      st.lx = e.clientX;
      st.ly = e.clientY;
      handlers.onMove?.({
        x: e.clientX, y: e.clientY,
        dx: e.clientX - st.sx, dy: e.clientY - st.sy,
        vx, vy, event: e,
      });
    };
    const up = e => {
      if (!st.active || e.pointerId !== st.pid) return;
      st.active = false;
      const [vx, vy] = engine.trackerVelocity(id);
      handlers.onEnd?.({
        x: e.clientX, y: e.clientY,
        dx: e.clientX - st.sx, dy: e.clientY - st.sy,
        vx, vy, event: e,
      });
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return {
      trackerId: id,
      destroy: () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this._freeTracker(el, id);
      },
    };
  },

  /**
   * Full drag primitive: 1:1 follow → rubber-band at bounds → momentum
   * projection → snap → spring with the release velocity.
   *
   *   Motion.drag(el, {
   *     bounds: { minX: 0, maxX: 300 },
   *     snap: { x: [0, 150, 300] },
   *   })
   */
  drag(el, opts = {}) {
    const {
      bounds = null,
      snap = null,
      preset = 'ui',
      rubberband: rb = true,
      decelRate = 0.998,
    } = opts;
    let grab = { x: 0, y: 0 };

    const clampH = (v, hard) => {
      if (!bounds) return v;
      const mn = bounds.minX ?? -Infinity, mx = bounds.maxX ?? Infinity;
      if (hard) return Math.min(mx, Math.max(mn, v));
      const dim = isFinite(mx - mn) ? (mx - mn) : 300;
      return rb ? engine.rubberbandClamp(v, mn, mx, dim, 0.55) : Math.min(mx, Math.max(mn, v));
    };
    const clampV = (v, hard) => {
      if (!bounds) return v;
      const mn = bounds.minY ?? -Infinity, mx = bounds.maxY ?? Infinity;
      if (hard) return Math.min(mx, Math.max(mn, v));
      const dim = isFinite(mx - mn) ? (mx - mn) : 300;
      return rb ? engine.rubberbandClamp(v, mn, mx, dim, 0.55) : Math.min(mx, Math.max(mn, v));
    };
    const nearest = (pts, v) => pts.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, pts[0]);

    return this.track(el, {
      onStart: pt => {
        grab = { x: this.value(el, 'x'), y: this.value(el, 'y') };
        this.stop(el, ['x', 'y']);
        opts.onStart?.(pt);
      },
      onMove: p => {
        const nx = clampH(grab.x + p.dx, false);
        const ny = clampV(grab.y + p.dy, false);
        this.set(el, { x: nx, y: ny });
        opts.onMove?.({ ...p, x: nx, y: ny });
      },
      onEnd: p => {
        const rx = this.value(el, 'x');
        const ry = this.value(el, 'y');
        // Project the resting point from the release velocity, THEN snap —
        // animate to where the gesture is going, not where it stopped.
        let tx = rx + engine.project(p.vx, decelRate);
        let ty = ry + engine.project(p.vy, decelRate);
        if (snap?.x?.length) tx = nearest(snap.x, tx);
        if (snap?.y?.length) ty = nearest(snap.y, ty);
        tx = clampH(tx, true);
        ty = clampV(ty, true);
        const promise = this.to(el, { x: tx, y: ty }, {
          preset,
          velocity: { x: p.vx, y: p.vy },
        });
        opts.onEnd?.({ ...p, targetX: tx, targetY: ty, settled: promise });
      },
    });
  },

  /** Press feedback: squish on pointer-down, release on up. */
  press(el, { scale = 0.97, preset = 'snappy' } = {}) {
    const down = () => { this.to(el, { scale }, { preset }); };
    const up = () => { this.to(el, { scale: 1 }, { preset }); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    return {
      destroy: () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('pointerleave', up);
      },
    };
  },

  /** Stagger the same props across a list of elements. */
  stagger(els, props, { step = 0.03, ...opts } = {}) {
    return Promise.all([...els].map((el, i) =>
      this.to(el, props, { ...opts, delay: (opts.delay ?? 0) + i * step })
    ));
  },

  /** Physics helpers (proxy to the active backend). */
  project: (v, rate) => engine.project(v, rate),
  rubberband: (o, dim, c) => engine.rubberband(o, dim, c),
  rubberbandClamp: (v, mn, mx, dim, c) => engine.rubberbandClamp(v, mn, mx, dim, c),
  bezier: (...args) => engine.bezier(...args),

  // ── tracker pool (8 fixed) ─────────────────────────────────────────────
  _trackerMap: new WeakMap(),
  _trackerFree: [7, 6, 5, 4, 3, 2, 1, 0],
  _trackerFor(el) {
    let id = this._trackerMap.get(el);
    if (id != null) return id;
    id = this._trackerFree.length ? this._trackerFree.pop() : 0;
    this._trackerMap.set(el, id);
    return id;
  },
  _freeTracker(el, id) {
    if (this._trackerMap.get(el) !== id) return;
    this._trackerMap.delete(el);
    this._trackerFree.push(id);
  },
};
