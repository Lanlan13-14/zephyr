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
import { PRESETS, MOTION_STANDARDS, STANDARD_FALLBACKS, resolvePreset } from './presets.js';

// ── channel model ────────────────────────────────────────────────────────

const TRANSFORM_CH = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateY']);
const FILTER_CH = new Set(['blur', 'saturate']);
/** clip inset channels → clip-path: inset(top% right% bottom% left% round Rpx) */
const CLIP_CH = new Set(['clipTop', 'clipRight', 'clipBottom', 'clipLeft', 'clipRound']);
const CHANNEL_DEFAULTS = {
  x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotate: 0, rotateY: 0,
  opacity: 1, radius: 0, blur: 0, saturate: 1, w: 0, h: 0,
  clipTop: 0, clipRight: 0, clipBottom: 0, clipLeft: 0, clipRound: 0,
};

function channelUnit(ch) {
  switch (ch) {
    case 'x': case 'y': case 'w': case 'h': case 'radius': case 'blur': return 'px';
    case 'rotate': case 'rotateY': return 'deg';
    case 'clipTop': case 'clipRight': case 'clipBottom': case 'clipLeft': return ''; // %
    case 'clipRound': return 'px';
    default: return '';
  }
}

function paintClipPath(st) {
  const el = st.el;
  const t = st.clip?.clipTop ?? 0;
  const r = st.clip?.clipRight ?? 0;
  const b = st.clip?.clipBottom ?? 0;
  const l = st.clip?.clipLeft ?? 0;
  const rnd = st.clip?.clipRound ?? 0;
  // Values are percentages for T/R/B/L; round in px
  el.style.clipPath = `inset(${t}% ${r}% ${b}% ${l}% round ${Math.max(0, rnd)}px)`;
  st.managed.add('clipPath');
}

function composeTransform(tv) {
  const x = tv.x ?? 0, y = tv.y ?? 0;
  const sx = tv.scaleX ?? tv.scale ?? 1;
  const sy = tv.scaleY ?? tv.scale ?? 1;
  const rot = tv.rotate ?? 0;
  const rotY = tv.rotateY ?? 0;
  let out = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
  if (rot) out += ` rotate(${rot}deg)`;
  if (rotY) out += ` rotateY(${rotY}deg)`;
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
    st = { el, slots: new Map(), tv: {}, fv: {}, clip: {}, managed: new Set() };
    elStates.set(el, st);
  }
  if (!st.clip) st.clip = {};
  return st;
}

function defaultFor(ch) {
  if (ch.startsWith('--')) return 0;
  return CHANNEL_DEFAULTS[ch] ?? 0;
}

/** Apply radius compensate: keep VISUAL corner radius continuous under FLIP scale.
 *  Non-uniform scaleX ≠ scaleY (button→card) MUST use elliptical CSS radius
 *  (rx / ry). Compensating only by scaleX is what made the last frame jump
 *  from pill to rectangle when the surface landed on the button. */
function paintRadius(st) {
  const el = st.el;
  const visual = st.visualRadius;
  if (visual == null) return;
  if (st.radiusCompensate) {
    const sx = Math.max(0.001, Math.abs(st.tv.scaleX ?? st.tv.scale ?? 1));
    const sy = Math.max(0.001, Math.abs(st.tv.scaleY ?? st.tv.scale ?? 1));
    // CSS: border-radius: <horizontal> / <vertical> — screen-space corner ≈ visual px
    el.style.borderRadius = `${visual / sx}px / ${visual / sy}px`;
  } else {
    el.style.borderRadius = `${visual}px`;
  }
  st.managed.add('borderRadius');
}

/** Writer for a channel: updates shared composition state, paints once. */
function writerFor(st, ch, unit) {
  const el = st.el;
  if (TRANSFORM_CH.has(ch)) {
    return v => {
      st.tv[ch] = v;
      el.style.transform = composeTransform(st.tv);
      st.managed.add('transform');
      // Expose live scale so children can inverse-scale (icon glyph stays unstretched).
      const sx = st.tv.scaleX ?? st.tv.scale ?? 1;
      const sy = st.tv.scaleY ?? st.tv.scale ?? 1;
      el.style.setProperty('--motion-sx', String(sx));
      el.style.setProperty('--motion-sy', String(sy));
      st.managed.add('--motion-sx');
      st.managed.add('--motion-sy');
      // Re-paint radius when scale changes so corners stay continuous.
      if (st.radiusCompensate && st.visualRadius != null && (ch === 'scaleX' || ch === 'scale' || ch === 'scaleY')) {
        paintRadius(st);
      }
    };
  }
  if (FILTER_CH.has(ch)) {
    return v => {
      st.fv[ch] = v;
      el.style.filter = composeFilter(st.fv);
      st.managed.add('filter');
    };
  }
  if (CLIP_CH.has(ch)) {
    return v => {
      st.clip[ch] = v;
      paintClipPath(st);
    };
  }
  switch (ch) {
    case 'opacity':
      return v => { el.style.opacity = String(v); st.managed.add('opacity'); };
    case 'radius':
      return v => {
        // Channel stores VISUAL radius in px; optionally compensate by scale.
        st.visualRadius = v;
        paintRadius(st);
      };
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
  STANDARDS: MOTION_STANDARDS,

  /** Boot the engine (idempotent). Await before first frame-critical use. */
  init({ capacity = 256 } = {}) {
    pool.capacity = capacity;
    return engine.init(capacity).then(() => {
      // Auto-boot may have already initialized the engine with a different
      // capacity (index.js uses 256). pool.alloc must never hand out ids the
      // backend's frame buffer can't hold — clamp to the live capacity.
      const ex = engine._b?.ex;
      const actual = typeof ex?.engine_capacity === 'function' ? ex.engine_capacity() : capacity;
      if (Number.isFinite(actual) && actual > 0) {
        pool.capacity = Math.min(pool.capacity, actual);
      }
      return engine;
    });
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
    const standard = opts.standard;
    const p = standard != null
      ? (STANDARD_FALLBACKS[standard] || resolvePreset(opts.preset ?? opts))
      : resolvePreset(opts.preset ?? opts);
    const channels = Object.keys(props);
    if (!channels.length) return Promise.resolve();
    let pending = channels.length;
    const records = channels.map(ch => ({ ch, rec: slotFor(el, ch, opts.units?.[ch]) }));
    const done = new Promise(res => {
      const settle = () => { if (--pending === 0) res(); };
      for (const { ch, rec } of records) {
        if (!rec) { settle(); continue; }
        if (standard != null) engine.configureStandard(rec.id, standard, p);
        else engine.configure(rec.id, p.response, p.damping);
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

  tween(el, props, opts = {}) {
    if (!el || !props || typeof props !== 'object') return Promise.resolve(false);
    const duration = Math.max(0, Number(opts.duration ?? 500));
    const curve = Array.isArray(opts.bezier) ? opts.bezier : [0.32, 0.72, 0, 1];
    const ease = engine.bezier(...curve.map(Number));
    this.stop(el);
    const token = this._bump(el);
    const channels = [];
    for (const [prop, target] of Object.entries(props)) {
      if (!(prop in CHANNEL_DEFAULTS)) continue;
      const slot = slotFor(el, prop);
      channels.push({ slot, from: Number(engine.getValue(slot.id)), to: Number(target) });
    }
    if (!channels.length) return Promise.resolve(false);
    if (engine.reducedMotion || duration === 0) {
      channels.forEach(({ slot, to }) => engine.setValue(slot.id, to));
      engine.tick(0);
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const start = performance.now();
      const step = now => {
        if (this._genOf(el) !== token) return resolve(false);
        const raw = Math.min(1, Math.max(0, (now - start) / duration));
        const p = ease(raw);
        channels.forEach(({ slot, from, to }) => engine.setValue(slot.id, from + (to - from) * p));
        engine.tick(0);
        if (raw < 1) requestAnimationFrame(step);
        else resolve(true);
      };
      requestAnimationFrame(step);
    });
  },


  /**
   * Apple-style inline expand / collapse.
   * Uses height + opacity with interruptible cubic-bezier (same family as iOS sheet).
   *
   *   Motion.expand(el, { open: true })
   *   Motion.expand(el, { open: false, duration: 280, bezier: [0.32, 0.72, 0, 1] })
   *
   * Hidden state uses opts.hiddenClass (default: force-hidden → display:none).
   * Mid-flight reverse keeps the live height/opacity so open↔close feels continuous.
   */
  async expand(el, opts = {}) {
    if (!el) return false;
    const open = opts.open !== false;
    const duration = Math.max(0, Number(opts.duration ?? (open ? 340 : 280)));
    const bezier = Array.isArray(opts.bezier) ? opts.bezier : [0.32, 0.72, 0, 1];
    const hiddenClass = opts.hiddenClass || 'force-hidden';

    el.style.overflow = 'hidden';
    el.style.boxSizing = 'border-box';
    el.style.willChange = 'height, opacity';

    const liveH = () => {
      if (this.isAnimating(el) && Number.isFinite(this.value(el, 'h'))) {
        return Math.max(0, Number(this.value(el, 'h')) || 0);
      }
      const r = el.getBoundingClientRect?.();
      return Math.max(0, r?.height || el.scrollHeight || el.offsetHeight || 0);
    };
    const liveO = () => {
      if (this.isAnimating(el) && Number.isFinite(this.value(el, 'opacity'))) {
        return Math.max(0, Math.min(1, Number(this.value(el, 'opacity')) || 0));
      }
      const o = Number.parseFloat(getComputedStyle(el).opacity);
      return Number.isFinite(o) ? o : (open ? 0 : 1);
    };

    if (open) {
      this._edgeStop?.();
      el.style.paddingTop = '';
      el.style.borderTopWidth = '';
      el.classList.remove(hiddenClass);
      // Measure natural content height without flashing full opacity.
      const prevVisibility = el.style.visibility;
      el.style.visibility = 'hidden';
      el.style.height = 'auto';
      el.style.opacity = '0';
      const targetH = Math.max(0, el.scrollHeight || el.offsetHeight || 0);
      el.style.visibility = prevVisibility || '';
      const fromH = liveH();
      const fromO = liveO();
      this.set(el, { h: fromH > 0 && fromH < targetH ? fromH : 0, opacity: fromO < 1 ? fromO : 0 });
      // Force a layout seed so the first tween frame starts from 0/near-0.
      if (!(fromH > 0 && fromH < targetH)) this.set(el, { h: 0, opacity: 0 });
      const ok = await this.tween(el, { h: targetH, opacity: 1 }, { duration, bezier });
      if (!ok) return false;
      this.release(el);
      el.style.height = 'auto';
      el.style.opacity = '';
      el.style.overflow = '';
      el.style.willChange = '';
      return true;
    }

    // close
    if (el.classList.contains(hiddenClass)) return true;
    const startH = liveH();
    const startO = liveO();
    if (startH < 0.5) {
      this.release(el);
      el.style.height = '';
      el.style.opacity = '';
      el.style.overflow = '';
      el.style.willChange = '';
      el.classList.add(hiddenClass);
      return true;
    }
    // Clamp overflow while the box shrinks so inner inputs never jut out.
    el.style.overflow = 'hidden';
    el.style.willChange = 'height, opacity';
    this.set(el, { h: startH, opacity: startO });

    // Collapse padding-top + border-top-width on the same bezier so the box really
    // reaches 0 (border-box otherwise keeps a forced padding/border strip, which reads
    // as a two-step collapse: content stops, strip lingers, then display:none snaps).
    const cs = getComputedStyle(el);
    const pad0 = Math.max(0, parseFloat(cs.paddingTop) || 0);
    const bw0 = Math.max(0, parseFloat(cs.borderTopWidth) || 0);
    let edgeStopped = false;
    const stopEdge = () => { edgeStopped = true; };
    this._edgeStop = stopEdge;
    const easeEdge = engine.bezier(bezier[0], bezier[1], bezier[2], bezier[3]);
    const edgeStart = performance.now();
    const edgeDone = new Promise(resolve => {
      const step = now => {
        if (edgeStopped) return resolve();
        const raw = Math.min(1, Math.max(0, (now - edgeStart) / duration));
        const q = easeEdge(raw);
        if (pad0 > 0) el.style.paddingTop = `${(pad0 * (1 - q)).toFixed(2)}px`;
        if (bw0 > 0) el.style.borderTopWidth = `${(bw0 * (1 - q)).toFixed(2)}px`;
        if (raw < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });

    const ok = await this.tween(el, { h: 0, opacity: 0 }, { duration, bezier });
    if (!ok) { stopEdge(); this._edgeStop = null; return false; }
    await edgeDone;
    this.release(el);
    this._edgeStop = null;
    // Hide first, then clear inline styles — one task, no flash of natural height.
    el.classList.add(hiddenClass);
    el.style.height = '';
    el.style.opacity = '';
    el.style.overflow = '';
    el.style.willChange = '';
    el.style.paddingTop = '';
    el.style.borderTopWidth = '';
    return true;
  },

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
      else if (prop === 'clipPath') el.style.clipPath = '';
      else el.style[prop] = '';
    }
    st.managed.clear();
    st.tv = {};
    st.fv = {};
    st.clip = {};
  },

  /**
   * FLIP morph: `el` is already at its final layout; make it APPEAR at
   * fromRect and spring to identity. Mid-flight calls retarget from the
   * live presentation value (Apple interruptibility — no jump, no lockout).
   *
   * opts.radiusFrom / radiusTo: CSS border-radius in px.
   * opts.radiusCompensate (default true when radii given): writes
   *   border-radius = visualRadius / scaleX so corners stay continuous
   *   under non-uniform FLIP scale (matched geometry).
   * opts.preset: default 'shape' (response 0.38, damping 0.94).
   */
  morph(el, fromRect, opts = {}) {
    if (!el || !fromRect) return Promise.resolve();
    el.style.transformOrigin = '0 0';
    // Force layout box (final size) into the document before measuring.
    // Callers should have set display/visibility; we still reflow here.
    void el.offsetWidth;
    const to = el.getBoundingClientRect();
    if (to.width <= 1 || to.height <= 1) return Promise.resolve();

    const st = stateFor(el);
    st.layoutW = to.width;
    st.layoutH = to.height;
    st.layoutLeft = to.left - (this.value(el, 'x') || 0);
    st.layoutTop = to.top - (this.value(el, 'y') || 0);

    const compensate = opts.radiusCompensate !== false
      && (opts.radiusFrom != null || opts.radiusTo != null || opts.radiusVisualFrom != null);
    if (compensate) st.radiusCompensate = true;
    else if (opts.radiusCompensate === false) st.radiusCompensate = false;

    const sx0 = Math.max(0.001, fromRect.width / to.width);
    const sy0 = Math.max(0.001, fromRect.height / to.height);
    const inFlight = this.isAnimating(el);
    // forceFrom: re-seed even mid-flight (hard reset — rare; prefer retarget)
    const seed = opts.forceFrom || !inFlight;

    if (seed) {
      const setProps = {
        x: fromRect.left - to.left + (this.value(el, 'x') || 0),
        y: fromRect.top - to.top + (this.value(el, 'y') || 0),
        scaleX: sx0,
        scaleY: sy0,
      };
      // When not in flight, layout equals painted box so x = from.left - to.left.
      if (!inFlight) {
        setProps.x = fromRect.left - to.left;
        setProps.y = fromRect.top - to.top;
      }
      if (opts.radiusFrom != null || opts.radiusVisualFrom != null) {
        setProps.radius = Number(opts.radiusVisualFrom ?? opts.radiusFrom) || 0;
      }
      if (opts.blurFrom != null) setProps.blur = opts.blurFrom;
      if (opts.opacityFrom != null) setProps.opacity = opts.opacityFrom;
      this.set(el, setProps);
      // Synchronous paint before next frame — kills fullscreen flash.
      void el.offsetWidth;
    }

    const props = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    if (opts.radiusTo != null || opts.radiusVisualTo != null) {
      props.radius = Number(opts.radiusVisualTo ?? opts.radiusTo) || 0;
    }
    if (opts.blurTo != null) props.blur = opts.blurTo;
    if (opts.opacityTo != null) props.opacity = opts.opacityTo;

    return this.to(el, props, {
      preset: opts.preset ?? 'shape',
      delay: opts.delay,
      velocity: opts.velocity,
    });
  },

  /**
   * Reverse morph to toRect — always from live values (interrupt-safe).
   * Uses transform-origin 0 0: paintedTopLeft = layoutTopLeft + (x,y),
   * paintedSize = layoutSize * scale.
   */
  morphTo(el, toRect, opts = {}) {
    if (!el || !toRect) return Promise.resolve();
    el.style.transformOrigin = '0 0';
    const cur = el.getBoundingClientRect();
    if (cur.width <= 1 || cur.height <= 1) return Promise.resolve();
    const st = stateFor(el);
    if (opts.radiusCompensate !== false && (opts.radiusTo != null || opts.radiusVisualTo != null)) {
      st.radiusCompensate = true;
    }
    const baseX = this.value(el, 'x');
    const baseY = this.value(el, 'y');
    const liveSx = Math.max(0.001, this.value(el, 'scaleX') || 1);
    const liveSy = Math.max(0.001, this.value(el, 'scaleY') || 1);
    // Prefer cached layout size from last morph open (stable); fall back to invert.
    const layoutW = st.layoutW || (cur.width / liveSx);
    const layoutH = st.layoutH || (cur.height / liveSy);
    const props = {
      x: baseX + (toRect.left - cur.left),
      y: baseY + (toRect.top - cur.top),
      scaleX: toRect.width / Math.max(0.001, layoutW),
      scaleY: toRect.height / Math.max(0.001, layoutH),
    };
    if (opts.radiusTo != null || opts.radiusVisualTo != null) {
      props.radius = Number(opts.radiusVisualTo ?? opts.radiusTo) || 0;
    }
    if (opts.blurTo != null) props.blur = opts.blurTo;
    if (opts.opacityTo != null) props.opacity = opts.opacityTo;
    return this.to(el, props, {
      preset: opts.preset ?? 'shape',
      delay: opts.delay,
      velocity: opts.velocity,
    });
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
      // Allow onStart to veto (filter/handle checks) before we claim the pointer.
      const startInfo = { x: e.clientX, y: e.clientY, event: e };
      if (handlers.onStart?.(startInfo) === false) return;
      st.active = true;
      st.pid = e.pointerId;
      // May throw for synthetic/invalid pointer ids — capture is a
      // nice-to-have, never let it kill the gesture.
      try { el.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
      engine.trackerClear(id);
      engine.trackerPush(id, now(), e.clientX, e.clientY);
      st.sx = st.lx = e.clientX;
      st.sy = st.ly = e.clientY;
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
   *     bounds: { minX: 0, maxX: 300 },          // or () => bounds
   *     snap: { x: [0, 150, 300] },              // or (x,y,ctx) => ({x,y})
   *     handle,                                  // only start from this node
   *     activationThreshold: 4,                  // px before drag claims gesture
   *     filter: (e) => true,                     // return false to ignore down
   *     rubberband: true,
   *     preset: 'ui',
   *     onActivate / onMove / onRelease / onEnd
   *   })
   */
  drag(el, opts = {}) {
    const {
      snap = null,
      preset = 'ui',
      rubberband: rb = true,
      decelRate = 0.998,
      activationThreshold = 0,
      handle = null,
      filter = null,
    } = opts;
    const threshold = Math.max(0, Number(activationThreshold) || 0);
    let grab = { x: 0, y: 0 };
    let active = threshold <= 0;
    let liveBounds = null;
    let last = { x: 0, y: 0 };

    const readBounds = () => {
      const b = typeof opts.bounds === 'function' ? opts.bounds() : opts.bounds;
      return b || null;
    };
    const clampH = (v, hard, bounds) => {
      if (!bounds) return v;
      const mn = bounds.minX ?? -Infinity, mx = bounds.maxX ?? Infinity;
      if (hard) return Math.min(mx, Math.max(mn, v));
      const dim = isFinite(mx - mn) ? (mx - mn) : 300;
      return rb ? engine.rubberbandClamp(v, mn, mx, dim, 0.55) : Math.min(mx, Math.max(mn, v));
    };
    const clampV = (v, hard, bounds) => {
      if (!bounds) return v;
      const mn = bounds.minY ?? -Infinity, mx = bounds.maxY ?? Infinity;
      if (hard) return Math.min(mx, Math.max(mn, v));
      const dim = isFinite(mx - mn) ? (mx - mn) : 300;
      return rb ? engine.rubberbandClamp(v, mn, mx, dim, 0.55) : Math.min(mx, Math.max(mn, v));
    };
    const nearest = (pts, v) => pts.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, pts[0]);

    // track() always binds the listener target. Prefer handle so nested
    // controls outside it never start a drag, while the transformed element
    // remains `el` (the panel surface).
    const target = handle || el;
    return this.track(target, {
      onStart: pt => {
        if (typeof filter === 'function' && filter(pt.event) === false) {
          active = false;
          return false;
        }
        // If a handle is used, ensure the down really came from it / its kids.
        if (handle && pt.event) {
          const path = typeof pt.event.composedPath === 'function' ? pt.event.composedPath() : [];
          const ok = path.includes?.(handle) || handle === pt.event.target || handle.contains?.(pt.event.target);
          if (!ok) { active = false; return false; }
        }
        this.stop(el, ['x', 'y']);
        grab = { x: this.value(el, 'x') || 0, y: this.value(el, 'y') || 0 };
        last = { ...grab };
        liveBounds = readBounds();
        active = threshold <= 0;
        if (active) opts.onActivate?.({ ...pt, x: grab.x, y: grab.y });
        opts.onStart?.(pt);
        return true;
      },
      onMove: p => {
        // Ignore moves for gestures that filter rejected.
        if (grab == null) return;
        if (!active) {
          if (Math.hypot(p.dx, p.dy) < threshold) return;
          active = true;
          // Re-sample grab at activation so threshold travel is not a jump.
          this.stop(el, ['x', 'y']);
          grab = { x: this.value(el, 'x') || 0, y: this.value(el, 'y') || 0 };
          liveBounds = readBounds();
          opts.onActivate?.({ ...p, x: grab.x, y: grab.y });
        }
        // Refresh bounds each frame so resize/viewport changes stay correct.
        liveBounds = readBounds();
        const nx = clampH(grab.x + p.dx, false, liveBounds);
        const ny = clampV(grab.y + p.dy, false, liveBounds);
        last = { x: nx, y: ny };
        this.set(el, { x: nx, y: ny });
        opts.onMove?.({ ...p, x: nx, y: ny, active: true });
      },
      onEnd: p => {
        if (!active) {
          // Sub-threshold: leave clicks alone; no settle spring.
          opts.onCancel?.(p);
          liveBounds = null;
          return;
        }
        const rx = this.value(el, 'x');
        const ry = this.value(el, 'y');
        liveBounds = readBounds();
        // Project the resting point from the release velocity, THEN snap —
        // animate to where the gesture is going, not where it stopped.
        let tx = rx + engine.project(p.vx, decelRate);
        let ty = ry + engine.project(p.vy, decelRate);
        if (typeof snap === 'function') {
          const s = snap(tx, ty, { x: rx, y: ry, vx: p.vx, vy: p.vy }) || {};
          if (Number.isFinite(s.x)) tx = s.x;
          if (Number.isFinite(s.y)) ty = s.y;
        } else {
          if (snap?.x?.length) tx = nearest(snap.x, tx);
          if (snap?.y?.length) ty = nearest(snap.y, ty);
        }
        tx = clampH(tx, true, liveBounds);
        ty = clampV(ty, true, liveBounds);
        opts.onRelease?.({ ...p, x: rx, y: ry, targetX: tx, targetY: ty });
        const promise = this.to(el, { x: tx, y: ty }, {
          preset,
          velocity: { x: p.vx, y: p.vy },
        });
        const done = Promise.resolve(promise).then(() => {
          last = { x: tx, y: ty };
          liveBounds = null;
          active = false;
        }).catch(() => {
          liveBounds = null;
          active = false;
        });
        opts.onEnd?.({ ...p, x: rx, y: ry, targetX: tx, targetY: ty, settled: done });
      },
    });
  },

  /**
   * Press feedback (iOS-like): scale on pointer-down, spring back on up.
   * scale default 0.97 (Emil: 0.95–0.98). Critically damped snappy.
   * Accepts Element or NodeList/Array — one destroy unbinds all.
   * opts.scale / preset / onlyPrimary (ignore non-primary buttons)
   */
  press(elOrList, opts = {}) {
    const scale = Number.isFinite(Number(opts.scale)) ? Number(opts.scale) : 0.97;
    const preset = opts.preset ?? 'snappy';
    const onlyPrimary = opts.onlyPrimary !== false;
    const els = elOrList?.length != null && !elOrList.tagName
      ? [...elOrList]
      : (elOrList ? [elOrList] : []);
    const cleanups = [];
    for (const el of els) {
      if (!el?.addEventListener) continue;
      const down = (e) => {
        if (onlyPrimary && e.button != null && e.button !== 0) return;
        this.to(el, { scale }, { preset });
      };
      const up = () => { this.to(el, { scale: 1 }, { preset }); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      // Keyboard: Space/Enter activate — brief press flash
      const keydown = (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault?.();
          this.to(el, { scale }, { preset });
        }
      };
      const keyup = (e) => {
        if (e.key === ' ' || e.key === 'Enter') this.to(el, { scale: 1 }, { preset });
      };
      el.addEventListener('keydown', keydown);
      el.addEventListener('keyup', keyup);
      cleanups.push(() => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('pointerleave', up);
        el.removeEventListener('keydown', keydown);
        el.removeEventListener('keyup', keyup);
      });
    }
    return { destroy: () => cleanups.forEach((fn) => fn()) };
  },

  /** Stagger the same props across a list of elements. */
  stagger(els, props, { step = 0.03, ...opts } = {}) {
    return Promise.all([...els].map((el, i) =>
      this.to(el, props, { ...opts, delay: (opts.delay ?? 0) + i * step })
    ));
  },

  // ── semantic recipes (API only — production CSS call sites migrate later) ─
  // Defaults follow Emil/Apple: never scale(0); enter/exit same path;
  // sheets may use preset 'sheet' (damping 0.8); scrims stay critically damped.

  /** Floor for enter/exit scale — nothing appears from nothing. */
  MIN_ENTER_SCALE: 0.95,
  DEFAULT_ENTER_SCALE: 0.96,

  _clampEnterScale(v, fallback = 0.96) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (n <= 0 || n < 0.9) return fallback;
    return n;
  },

  /**
   * Enter recipe: rest pose → identity. Interrupt-safe retarget.
   * Default from: { opacity: 0, scale: 0.96 }  — NEVER scale 0.
   */
  present(el, opts = {}) {
    if (!el) return Promise.resolve();
    const fromIn = { opacity: 0, scale: this.DEFAULT_ENTER_SCALE, x: 0, y: 0, ...(opts.from || {}) };
    if (opts.fromScale != null && opts.from?.scale == null) fromIn.scale = opts.fromScale;
    fromIn.scale = this._clampEnterScale(fromIn.scale, this.DEFAULT_ENTER_SCALE);

    const toIn = { opacity: 1, scale: 1, x: 0, y: 0, ...(opts.to || {}) };
    // Never allow identity target of scale(0); treat 0 as "fully visible".
    if (Number(toIn.scale) === 0) toIn.scale = 1;

    const preset = opts.preset ?? 'snappy';
    const delay = opts.delay ?? 0;
    if (!this.isAnimating(el)) this.set(el, fromIn);
    return this.to(el, toIn, { preset, delay, velocity: opts.velocity, units: opts.units });
  },

  /**
   * Exit recipe: spring to a rest pose (same path as present by default).
   * thenHide: set el.hidden = true after settle (does not release slots).
   */
  dismiss(el, opts = {}) {
    if (!el) return Promise.resolve();
    const toIn = { opacity: 0, scale: this.DEFAULT_ENTER_SCALE, ...(opts.to || {}) };
    if (opts.toScale != null && opts.to?.scale == null) toIn.scale = opts.toScale;
    toIn.scale = this._clampEnterScale(toIn.scale, this.DEFAULT_ENTER_SCALE);
    const preset = opts.preset ?? 'snappy';
    return this.to(el, toIn, {
      preset,
      delay: opts.delay ?? 0,
      velocity: opts.velocity,
      units: opts.units,
    }).then(() => {
      if (opts.thenHide) el.hidden = true;
    });
  },

  /**
   * Origin-aware popover: transform-origin at trigger center, then present.
   * Pass a trigger Element or a DOMRect-like {left,top,width,height}.
   * Modals should NOT use this — keep center origin and use present().
   */
  popover(el, triggerElOrRect, opts = {}) {
    if (!el) return Promise.resolve();
    const fromScale = this._clampEnterScale(opts.fromScale ?? this.DEFAULT_ENTER_SCALE);
    const tr = triggerElOrRect && typeof triggerElOrRect.getBoundingClientRect === 'function'
      ? triggerElOrRect.getBoundingClientRect()
      : triggerElOrRect;
    const er = el.getBoundingClientRect();
    if (tr && er && er.width > 0 && er.height > 0) {
      const ox = (Number(tr.left) + Number(tr.width) / 2) - er.left;
      const oy = (Number(tr.top) + Number(tr.height) / 2) - er.top;
      if (Number.isFinite(ox) && Number.isFinite(oy)) {
        el.style.transformOrigin = `${ox}px ${oy}px`;
      }
    }
    return this.present(el, {
      from: { opacity: 0, scale: fromScale },
      to: { opacity: 1, scale: 1 },
      preset: opts.preset ?? 'snappy',
      delay: opts.delay ?? 0,
    });
  },

  /**
   * Edge sheet on transform x/y (+ optional scrim opacity).
   * edge: 'bottom' | 'top' | 'left' | 'right'
   * open: true opens from edge→0; false dismisses 0→edge
   * Body preset default 'sheet' (response 0.30, damping 0.80).
   * Scrim always critically damped ('snappy') — no bounce on dimming.
   */
  sheet(el, opts = {}) {
    if (!el) return Promise.resolve();
    const edge = opts.edge || 'bottom';
    const open = opts.open !== false;
    const preset = opts.preset ?? 'sheet';
    const rect = el.getBoundingClientRect();
    const h = Math.max(0, rect.height || el.offsetHeight || 0);
    const w = Math.max(0, rect.width || el.offsetWidth || 0);
    let channel = 'y';
    let off = h;
    if (edge === 'top') { channel = 'y'; off = -h; }
    else if (edge === 'bottom') { channel = 'y'; off = h; }
    else if (edge === 'left') { channel = 'x'; off = -w; }
    else if (edge === 'right') { channel = 'x'; off = w; }

    let body;
    if (open) {
      if (!this.isAnimating(el)) this.set(el, { [channel]: off, opacity: 1 });
      body = this.to(el, { [channel]: 0, opacity: 1 }, { preset, delay: opts.delay ?? 0 });
    } else {
      body = this.to(el, { [channel]: off }, { preset, delay: opts.delay ?? 0 });
    }

    const scrim = opts.scrim || null;
    const scrimOpacity = Number(opts.scrimOpacity);
    const scrimTarget = Number.isFinite(scrimOpacity) ? scrimOpacity : 0.24;
    let scrimP = Promise.resolve();
    if (scrim) {
      if (open) {
        if (!this.isAnimating(scrim)) this.set(scrim, { opacity: 0 });
        scrimP = this.to(scrim, { opacity: scrimTarget }, { preset: 'snappy' });
      } else {
        scrimP = this.to(scrim, { opacity: 0 }, { preset: 'snappy' });
      }
    }
    return Promise.all([body, scrimP]);
  },

  /**
   * Run spring steps in order.
   * step: { el, props, preset?, delay?, units? } | { wait: seconds }
   */
  async sequence(steps = []) {
    for (const step of steps) {
      if (!step) continue;
      if (typeof step.wait === 'number') {
        const ms = Math.max(0, Number(step.wait) * 1000);
        if (ms > 0) await new Promise(r => setTimeout(r, ms));
        continue;
      }
      if (step.el && step.props) {
        await this.to(step.el, step.props, {
          preset: step.preset,
          delay: step.delay ?? 0,
          units: step.units,
          velocity: step.velocity,
        });
      }
    }
  },

  /**
   * Spring CSS custom properties (e.g. dock --dock-scale / --dock-lift).
   * Prefer this over writing vars in rAF; units map required for px/deg.
   *
   *   Motion.cssVars(el, { '--dock-scale': 1.2, '--dock-lift': -12 }, {
   *     units: { '--dock-lift': 'px' }, preset: 'dock'
   *   })
   */
  cssVars(el, props = {}, opts = {}) {
    if (!el) return Promise.resolve();
    const units = opts.units || {};
    for (const ch of Object.keys(props)) {
      const unit = units[ch] ?? (ch.startsWith('--') ? '' : channelUnit(ch));
      slotFor(el, ch, unit);
    }
    if (opts.immediate) {
      this.set(el, props);
      return Promise.resolve();
    }
    return this.to(el, props, {
      preset: opts.preset ?? 'dock',
      delay: opts.delay ?? 0,
      units,
      velocity: opts.velocity,
    });
  },

  /**
   * Matched-geometry convenience: hide source (opacity 0), morph el from
   * source rect, optional scrim fade. Does not change layout of source.
   * Production connection FLIP should call this later — not wired yet.
   */
  sharedElement(el, sourceElOrRect, opts = {}) {
    if (!el) return Promise.resolve();
    const srcRect = sourceElOrRect && typeof sourceElOrRect.getBoundingClientRect === 'function'
      ? sourceElOrRect.getBoundingClientRect()
      : sourceElOrRect;
    if (sourceElOrRect && sourceElOrRect.style && opts.hideSource !== false) {
      sourceElOrRect.style.opacity = '0';
    }
    const parts = [];
    if (srcRect) parts.push(this.morph(el, srcRect, {
      preset: opts.preset ?? 'morph',
      radiusFrom: opts.radiusFrom,
      radiusTo: opts.radiusTo,
    }));
    const scrim = opts.scrim;
    if (scrim) {
      const o = Number(opts.scrimOpacity);
      const target = Number.isFinite(o) ? o : 0.24;
      if (!this.isAnimating(scrim)) this.set(scrim, { opacity: 0 });
      parts.push(this.to(scrim, { opacity: target }, { preset: 'snappy' }));
    }
    return Promise.all(parts);
  },

  /**
   * Named recipes mirroring public/style.css @keyframes (values distilled to
   * spring-friendly from/to poses). Production still uses CSS until migrated;
   * call Motion.play(el, 'connectionCardIn') when a surface opts in.
   *
   * Infinite/loop decorations (spin, pulse, loaders, breath) stay CSS-only —
   * listed under CSS_ONLY_RECIPES and rejected by play().
   */
  recipes: {
    // ── generic enter / view ────────────────────────────────────────────
    fadeIn: {
      from: { opacity: 0, y: 12 }, to: { opacity: 1, y: 0, scale: 1, blur: 0 },
      preset: 'snappy', css: 'fadeIn',
    },
    fadeInItem: {
      from: { opacity: 0, y: 8 }, to: { opacity: 1, y: 0 },
      preset: 'snappy', css: 'fadeInItem',
    },
    // ── connections ─────────────────────────────────────────────────────
    connectionCardIn: {
      from: { opacity: 0, y: 14, scale: 0.975, blur: 8 },
      to: { opacity: 1, y: 0, scale: 1, blur: 0 },
      preset: 'ui', css: 'connectionCardIn',
    },
    connectionCardDelete: {
      from: { opacity: 1, y: 0, scale: 1, blur: 0, saturate: 1 },
      to: { opacity: 0, y: -14, scale: 0.90, blur: 10, saturate: 0.72 },
      preset: 'snappy', css: 'connectionCardDelete', exit: true,
    },
    // ── floating / panels ───────────────────────────────────────────────
    floatingPanelOpenFromButton: {
      from: { opacity: 0, y: 18, scale: 0.92, blur: 10, radius: 30 },
      to: { opacity: 1, y: 0, scale: 1, blur: 0, radius: 16 },
      preset: 'morph', css: 'floatingPanelOpenFromButton',
    },
    floatingPanelCloseToButton: {
      from: { opacity: 1, y: 0, scale: 1, blur: 0 },
      to: { opacity: 0, y: 18, scale: 0.92, blur: 8 },
      preset: 'snappy', css: 'floatingPanelCloseToButton', exit: true,
    },
    panelFrontSwitch: {
      from: { opacity: 0.6, scale: 0.98 }, to: { opacity: 1, scale: 1 },
      preset: 'snappy', css: 'panelFrontSwitch',
    },
    panelMenuPopIn: {
      from: { opacity: 0, scale: 0.94, y: 6 }, to: { opacity: 1, scale: 1, y: 0 },
      preset: 'snappy', css: 'panelMenuPopIn',
    },
    panelMenuIn: {
      from: { opacity: 0, y: 10 }, to: { opacity: 1, y: 0 },
      preset: 'snappy', css: 'panelMenuIn',
    },
    panelMenuItemIn: {
      from: { opacity: 0, x: -8 }, to: { opacity: 1, x: 0 },
      preset: 'snappy', css: 'panelMenuItemIn',
    },
    transferPopoverIn: {
      from: { opacity: 0, y: -6, scale: 0.98 }, to: { opacity: 1, y: 0, scale: 1 },
      preset: 'snappy', css: 'transferPopoverIn',
    },
    // AI uses semantic panel/popover APIs below; legacy named recipes removed.
    // ── terminal / dock / smartbar ──────────────────────────────────────
    terminalWindowIn: {
      from: { opacity: 0, y: 18, scale: 0.965, blur: 10 },
      to: { opacity: 1, y: 0, scale: 1, blur: 0 },
      preset: 'ui', css: 'terminalWindowIn',
    },
    terminalDockSwapIn: {
      from: { opacity: 0, scale: 0.94, y: 12, blur: 8 },
      to: { opacity: 1, scale: 1, y: 0, blur: 0 },
      preset: 'morph', css: 'terminalDockSwapIn',
    },
    dockerDrawerIn: {
      from: { opacity: 0, y: 22 }, to: { opacity: 1, y: 0 },
      preset: 'sheet', css: 'dockerDrawerIn',
    },
    dockItemBloom: {
      from: { opacity: 0, y: 18, scale: 0.92, blur: 8 },
      to: { opacity: 1, y: 0, scale: 1, blur: 0 },
      preset: 'island', css: 'dockItemBloom',
    },
    dockGhostFloat: {
      from: { opacity: 0.4, y: 8, scale: 0.96 }, to: { opacity: 1, y: 0, scale: 1 },
      preset: 'gentle', css: 'dockGhostFloat',
    },
    smartbarPickerFloat: {
      from: { opacity: 0, y: -10, scale: 0.92, blur: 10, saturate: 0.88 },
      to: { opacity: 1, y: 0, scale: 1, blur: 0, saturate: 1 },
      preset: 'morph', css: 'smartbarPickerFloat',
    },
    smartbarPanelMacClose: {
      from: { opacity: 1, scale: 1, y: 0 }, to: { opacity: 0, scale: 0.94, y: 8 },
      preset: 'snappy', css: 'smartbarPanelMacClose', exit: true,
    },
    // ── island ──────────────────────────────────────────────────────────
    terminalIslandTapBounce: {
      // press phase target (not a full enter); use with islandSquish helpers
      from: { scaleX: 1, scaleY: 1, blur: 0 },
      to: { scaleX: 1.12, scaleY: 0.84, blur: 1.8 },
      preset: 'island', css: 'terminalIslandTapBounce',
    },
    terminalIslandFluidOpen: {
      from: { scaleX: 0.92, scaleY: 1.08, opacity: 0.85 },
      to: { scaleX: 1, scaleY: 1, opacity: 1 },
      preset: 'island', css: 'terminalIslandFluidOpen',
    },
    terminalIslandFluidClose: {
      from: { scaleX: 1, scaleY: 1, opacity: 1 },
      to: { scaleX: 0.94, scaleY: 1.06, opacity: 0.9 },
      preset: 'island', css: 'terminalIslandFluidClose', exit: true,
    },
    // Three-dot melt/return are multi-var — use Motion.islandDots / islandExpand.
    // Registered so catalog + playStagger discovery includes them.
    terminalIslandSourceMelt: {
      from: {}, to: {}, preset: 'island', css: 'terminalIslandSourceMelt',
      meta: { via: 'islandDots(melt)' },
    },
    terminalIslandDotsReturn: {
      from: {}, to: {}, preset: 'island', css: 'terminalIslandDotsReturn',
      meta: { via: 'islandDots(return)' },
    },
    terminalIslandSourceDotsToPanel: {
      from: { opacity: 1, scale: 1, blur: 0 },
      to: { opacity: 0, scale: 0.48, blur: 4 },
      preset: 'island', css: 'terminalIslandSourceDotsToPanel', exit: true,
    },
    terminalIslandSourceDotsReturn: {
      from: { opacity: 0, scale: 0.48, blur: 4 },
      to: { opacity: 1, scale: 1, blur: 0 },
      preset: 'island', css: 'terminalIslandSourceDotsReturn',
    },
    terminalIslandDotMelt: {
      from: { opacity: 1, scale: 1, blur: 0 },
      to: { opacity: 0.02, scale: 0.18, blur: 7 },
      preset: 'island', css: 'terminalIslandDotMelt', exit: true,
    },
    // iOS app open is multi-element — use Motion.iosAppOpen / appIconTransition.
    iosAppOpen: {
      from: {}, to: {}, preset: 'morph', css: null,
      meta: { via: 'iosAppOpen' },
    },
    // ── notes / misc UI ─────────────────────────────────────────────────
    notesListItemIn: {
      from: { opacity: 0, y: 4 }, to: { opacity: 1, y: 0 },
      preset: 'snappy', css: 'notesListItemIn',
    },
    terminalThemeFade: {
      from: { opacity: 0 }, to: { opacity: 1 },
      preset: 'snappy', css: 'terminalThemeFade',
    },
    // ── feedback ────────────────────────────────────────────────────────
    shake: {
      // multi-step handled by Motion.shake(); recipe marks the amplitude
      from: { x: 0 }, to: { x: 0 }, preset: 'snappy', css: 'shake',
      meta: { amplitude: 6 },
    },
    attention: {
      from: { scale: 1 }, to: { scale: 1 },
      preset: 'bouncy', css: null,
      meta: { peak: 1.04 },
    },
  },

  /** Loops / pure decoration — keep CSS; play() refuses these names. */
  CSS_ONLY_RECIPES: Object.freeze([
    'spin', 'pulse', 'aiRunningPulse', 'aiStopPulse', 'ai-bounce',
    'novncLoader', 'novncBell', 'transferIndeterminate',
    'dockActivePulse', 'dockDropTargetPulse', 'panelTrafficIslandBreath',
    'terminalIslandBreath', 'terminalIslandDotBreath', 'terminalIslandLiquidGlow',
    'appThemeRipple', 'themeToggleRipple',
  ]),

  /** Look up a recipe by name (css keyframe name or short alias). */
  recipe(name) {
    if (!name) return null;
    if (this.recipes[name]) return { name, ...this.recipes[name] };
    // allow css alias match
    for (const [k, v] of Object.entries(this.recipes)) {
      if (v.css === name) return { name: k, ...v };
    }
    return null;
  },

  /**
   * Play a named recipe (enter by default). Interrupt-safe.
   *   Motion.play(el, 'connectionCardIn')
   *   Motion.play(el, 'connectionCardDelete') // exit recipe
   */
  play(el, name, opts = {}) {
    if (!el) return Promise.resolve();
    if (this.CSS_ONLY_RECIPES.includes(name)) {
      return Promise.reject(new Error(
        `[zephyr-motion] "${name}" is a CSS-only loop/decoration — do not spring it`,
      ));
    }
    const r = this.recipe(name);
    if (!r) return Promise.reject(new Error(`[zephyr-motion] unknown recipe: ${name}`));
    if (name === 'shake' || r.css === 'shake') return this.shake(el, opts);
    if (name === 'attention') return this.attention(el, opts);
    if (name === 'terminalIslandSourceMelt' || r.css === 'terminalIslandSourceMelt') {
      return this.islandDots(el, 'melt', opts);
    }
    if (name === 'terminalIslandDotsReturn' || r.css === 'terminalIslandDotsReturn') {
      return this.islandDots(el, 'return', opts);
    }
    if (name === 'iosAppOpen' || r.meta?.via === 'iosAppOpen') {
      return Promise.reject(new Error(
        '[zephyr-motion] use Motion.iosAppOpen(surface, icon, opts) — multi-element signature API',
      ));
    }

    const preset = opts.preset ?? r.preset ?? 'snappy';
    const delay = opts.delay ?? 0;
    const from = { ...(r.from || {}), ...(opts.from || {}) };
    const to = { ...(r.to || {}), ...(opts.to || {}) };
    if (from.scale != null) from.scale = this._clampEnterScale(from.scale, this.DEFAULT_ENTER_SCALE);
    if (to.scale != null && Number(to.scale) === 0) to.scale = 1;

    if (opts.exit || r.exit) {
      // exit: spring toward `to` (already the exit pose in exit recipes)
      return this.to(el, to, { preset, delay, velocity: opts.velocity });
    }
    if (!this.isAnimating(el)) this.set(el, from);
    return this.to(el, to, { preset, delay, velocity: opts.velocity });
  },

  /** Stagger a recipe across many elements (list/card grids). */
  playStagger(els, name, { step = 0.04, ...opts } = {}) {
    return Promise.all([...els].map((el, i) =>
      this.play(el, name, { ...opts, delay: (opts.delay ?? 0) + i * step })
    ));
  },

  // ── named convenience wrappers (readable call sites) ───────────────────

  /** Opacity + slight Y — fadeIn / dockerDrawerIn class. */
  fadeLift(el, opts = {}) {
    return this.play(el, opts.subtle ? 'notesListItemIn' : 'fadeIn', opts);
  },

  /** Blurred lift enter — terminalWindowIn or generic fadeIn. */
  fadeLiftBlur(el, opts = {}) {
    return this.play(el, opts.kind === 'window' ? 'terminalWindowIn' : 'fadeIn', opts);
  },

  /** Pop scale enter through the semantic present API. */
  popIn(el, opts = {}) {
    return this.present(el, { from: { opacity: 0, scale: opts.fromScale ?? 0.96, y: opts.travel ?? 6 }, preset: opts.preset ?? 'snappy' });
  },

  /** Connection card enter/exit. */
  cardIn(el, opts = {}) { return this.play(el, 'connectionCardIn', opts); },
  cardOut(el, opts = {}) { return this.play(el, 'connectionCardDelete', opts); },

  /** Floating panel open/close pair. */
  floatPanelOpen(el, opts = {}) { return this.play(el, 'floatingPanelOpenFromButton', opts); },
  floatPanelClose(el, opts = {}) { return this.play(el, 'floatingPanelCloseToButton', opts); },

  /** Dock / smartbar. */
  dockBloom(el, opts = {}) { return this.play(el, 'dockItemBloom', opts); },
  pickerFloat(el, opts = {}) { return this.play(el, 'smartbarPickerFloat', opts); },
  windowIn(el, opts = {}) { return this.play(el, 'terminalWindowIn', opts); },

  /**
   * Error shake (sequence on x). Amplitude default 6px like CSS shake keyframes.
   */
  async shake(el, opts = {}) {
    if (!el) return;
    const a = Number(opts.amplitude) || 6;
    const preset = opts.preset ?? 'snappy';
    this.stop(el, ['x']);
    this.set(el, { x: 0 });
    await this.to(el, { x: -a }, { preset });
    await this.to(el, { x: a }, { preset });
    await this.to(el, { x: -a * 0.66 }, { preset });
    await this.to(el, { x: a * 0.66 }, { preset });
    await this.to(el, { x: 0 }, { preset });
  },

  /**
   * Dynamic-island style squish (terminal grip).
   * press=true → wide/short; false → identity.
   */
  islandSquish(el, press = true, opts = {}) {
    if (!el) return Promise.resolve();
    const preset = opts.preset ?? 'island';
    if (press) {
      return this.to(el, { scaleX: 1.12, scaleY: 0.84, blur: 1.8 }, { preset });
    }
    return this.to(el, { scaleX: 1, scaleY: 1, blur: 0 }, { preset });
  },

  /** One-shot attention pulse (scale 1 → peak → 1). */
  async attention(el, opts = {}) {
    if (!el) return;
    const peak = Number(opts.peak) || 1.04;
    const preset = opts.preset ?? 'bouncy';
    await this.to(el, { scale: peak }, { preset });
    await this.to(el, { scale: 1 }, { preset: 'snappy' });
  },

  /**
   * Toast enter from an edge (default top — iOS banner style).
   * Symmetric with toastDismiss. Interruptible mid-flight.
   *
   * edge: 'top' | 'bottom' | 'left' | 'right'
   * dist: travel in px (default 28 for top banner — short, not a long slide)
   * preset: default 'snappy' (critically damped short response)
   */
  toast(el, opts = {}) {
    if (!el) return Promise.resolve();
    const edge = opts.edge || 'top';
    // Short travel reads as a banner, not a sheet (iOS / Sonner-like)
    const dist = Number.isFinite(Number(opts.distance)) ? Number(opts.distance) : 28;
    const from = { opacity: 0, scale: this.DEFAULT_ENTER_SCALE };
    if (edge === 'top') from.y = -dist;
    else if (edge === 'bottom') from.y = dist;
    else if (edge === 'left') from.x = -dist;
    else from.x = dist;
    el.style.willChange = 'transform, opacity';
    el.style.pointerEvents = opts.interactive ? 'auto' : (el.style.pointerEvents || 'none');
    if (!this.isAnimating(el)) this.set(el, from);
    return this.to(el, { opacity: 1, x: 0, y: 0, scale: 1 }, {
      preset: opts.preset ?? 'snappy',
      delay: opts.delay ?? 0,
    });
  },

  /**
   * Toast dismiss — same edge as enter (spatial consistency, Apple §7).
   * thenRemove: remove node from DOM after settle.
   */
  async toastDismiss(el, opts = {}) {
    if (!el) return;
    const edge = opts.edge || 'top';
    const dist = Number.isFinite(Number(opts.distance)) ? Number(opts.distance) : 28;
    const to = { opacity: 0, scale: this.DEFAULT_ENTER_SCALE };
    if (edge === 'top') to.y = -dist;
    else if (edge === 'bottom') to.y = dist;
    else if (edge === 'left') to.x = -dist;
    else to.x = dist;
    await this.to(el, to, {
      preset: opts.preset ?? 'snappy',
      delay: opts.delay ?? 0,
    });
    if (opts.thenRemove && el.parentNode) el.parentNode.removeChild(el);
    else if (opts.thenHide) el.hidden = true;
  },

  /**
   * Imperative toast host (demo / future production wiring).
   * Creates a toast node inside `hostEl`, stacks with y offsets, auto-dismiss.
   *
   *   Motion.toastPush(host, { text: '已保存', kind: 'success', duration: 2.4 })
   *
   * Does NOT touch production #toast — call sites opt in later.
   * Stack: newer toasts push older ones down (or up for bottom edge).
   */
  toastPush(hostEl, opts = {}) {
    if (!hostEl) return Promise.resolve(null);
    if (!this._toastStacks) this._toastStacks = new WeakMap();
    let stack = this._toastStacks.get(hostEl);
    if (!stack) {
      stack = { items: [], edge: opts.edge || 'top', gap: Number(opts.gap) || 10 };
      this._toastStacks.set(hostEl, stack);
    }
    const edge = opts.edge || stack.edge || 'top';
    stack.edge = edge;
    const gap = stack.gap;
    const kind = opts.kind || 'info'; // info | success | error
    const duration = Number.isFinite(Number(opts.duration)) ? Number(opts.duration) : 2.4; // seconds
    const text = String(opts.text ?? opts.message ?? '');

    const el = document.createElement('div');
    el.className = `motion-toast motion-toast--${kind}`;
    el.setAttribute('role', 'status');
    el.textContent = text;
    // Minimal inline chrome so demo works without production CSS
    el.style.cssText = [
      'pointer-events:none',
      'min-width:160px', 'max-width:min(340px, calc(100vw - 32px))',
      'padding:10px 12px', 'border-radius:12px',
      'font:13px/1.35 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
      'color:#f4f4f6',
      'background:rgba(40,40,46,.92)',
      'border:1px solid rgba(255,255,255,.10)',
      'box-shadow:0 12px 36px rgba(0,0,0,.35)',
      'backdrop-filter:blur(16px) saturate(1.3)',
      '-webkit-backdrop-filter:blur(16px) saturate(1.3)',
      'will-change:transform,opacity',
      'position:relative',
    ].join(';');
    if (kind === 'success') el.style.borderColor = 'rgba(63,185,80,.45)';
    if (kind === 'error') { el.style.borderColor = 'rgba(248,81,73,.5)'; el.style.color = '#ff8a84'; }
    if (kind === 'info') el.style.borderColor = 'rgba(10,132,255,.45)';

    hostEl.appendChild(el);
    const item = { el, y: 0, timer: null };
    stack.items.unshift(item);

    const reflowStack = () => {
      let offset = 0;
      stack.items.forEach((it) => {
        const h = it.el.offsetHeight || 44;
        // top edge: stack downward; bottom edge: stack upward
        const y = edge === 'bottom' ? -offset : offset;
        it.y = y;
        this.to(it.el, { y }, { preset: 'snappy' });
        offset += h + gap;
      });
    };

    // Enter from edge at y=0 slot, then reflow others
    this.set(el, {
      opacity: 0,
      scale: this.DEFAULT_ENTER_SCALE,
      y: edge === 'bottom' ? 28 : -28,
      x: 0,
    });
    const enter = this.toast(el, { edge, distance: 28, preset: 'snappy' }).then(() => {
      reflowStack();
    });

    const dismiss = async () => {
      if (item.timer) { clearTimeout(item.timer); item.timer = null; }
      const idx = stack.items.indexOf(item);
      if (idx >= 0) stack.items.splice(idx, 1);
      await this.toastDismiss(el, { edge, distance: 24, thenRemove: true });
      reflowStack();
    };
    item.dismiss = dismiss;

    if (duration > 0) {
      item.timer = setTimeout(() => { dismiss(); }, duration * 1000);
    }
    // Return handle for manual dismiss / tests
    return Object.assign(enter.then(() => item), { el, dismiss, item });
  },

  /**
   * Content crossfade with optional light blur bridge (Emil blur mask ≤2–8px).
   * oldEl fades out, newEl fades in; both may share a brief blur.
   */
  async crossfade(oldEl, newEl, opts = {}) {
    const blur = Math.min(8, Math.max(0, Number(opts.blur) ?? 2));
    const preset = opts.preset ?? 'snappy';
    const jobs = [];
    if (oldEl) {
      jobs.push(this.to(oldEl, { opacity: 0, blur }, { preset }));
    }
    if (newEl) {
      if (!this.isAnimating(newEl)) this.set(newEl, { opacity: 0, blur });
      jobs.push(this.to(newEl, { opacity: 1, blur: 0 }, { preset }));
    }
    await Promise.all(jobs);
    if (oldEl) await this.to(oldEl, { blur: 0 }, { preset: 'snappy' });
  },

  /**
   * Toggle/switch thumb: spring x to 0 or travel (px).
   * iOS switch feel: snappy critically damped, short travel.
   *
   *   Motion.switchThumb(thumbEl, on, { travel: 18 })
   *   Motion.switchThumb(thumbEl, on, { travel: 20, trackEl, onColor, offColor })
   *
   * Optional trackEl: fades background via opacity of an overlay fill
   * (pass trackFillEl that sits inside track) — or set CSS vars on track.
   */
  switchThumb(el, on, opts = {}) {
    if (!el) return Promise.resolve();
    const travel = Number.isFinite(Number(opts.travel)) ? Number(opts.travel) : 18;
    const preset = opts.preset ?? 'snappy';
    // x only on primary spring — scale pop is separate so it does not cancel travel
    const jobs = [this.to(el, { x: on ? travel : 0 }, { preset })];
    if (opts.pop !== false) {
      this.to(el, { scale: 0.94 }, { preset: 'snappy' }).then(() => {
        this.to(el, { scale: 1 }, { preset: 'snappy' });
      });
    }
    if (opts.trackFillEl) {
      jobs.push(this.to(opts.trackFillEl, { opacity: on ? 1 : 0 }, { preset: 'snappy' }));
    }
    if (opts.trackEl && opts.trackVar) {
      jobs.push(this.cssVars(opts.trackEl, {
        [opts.trackVar]: on ? (opts.onValue ?? 1) : (opts.offValue ?? 0),
      }, { preset: 'snappy', units: opts.units }));
    }
    return Promise.all(jobs);
  },

  /** Scrim / dim layer opacity only (critically damped). */
  scrim(el, open = true, opts = {}) {
    if (!el) return Promise.resolve();
    const target = open
      ? (Number.isFinite(Number(opts.opacity)) ? Number(opts.opacity) : 0.24)
      : 0;
    if (open && !this.isAnimating(el)) this.set(el, { opacity: 0 });
    // Never blur-scrim over content unless caller opts in (Apple: dim ≠ frost)
    if (opts.blur == null && el.style) {
      el.style.backdropFilter = el.style.backdropFilter || 'none';
    }
    return this.to(el, { opacity: target }, { preset: opts.preset ?? 'snappy' });
  },

  /**
   * Set transform-origin of panel to the center of an anchor button
   * (viewport-relative → % of panel box). Used by macOS-style panels.
   * Mirrors public/floating-panel.js animatePanelFromButton origin math.
   */
  setOriginFromAnchor(panel, button) {
    if (!panel || !button) return null;
    const panelRect = panel.getBoundingClientRect?.();
    const buttonRect = button.getBoundingClientRect?.();
    if (!panelRect || !buttonRect || panelRect.width <= 1 || panelRect.height <= 1) return null;
    const ox = ((buttonRect.left + buttonRect.width / 2 - panelRect.left) / panelRect.width) * 100;
    const oy = ((buttonRect.top + buttonRect.height / 2 - panelRect.top) / panelRect.height) * 100;
    const x = Math.max(4, Math.min(96, ox));
    const y = Math.max(4, Math.min(96, oy));
    panel.style.transformOrigin = `${x}% ${y}%`;
    panel.style.setProperty('--panel-origin-x', `${x}%`);
    panel.style.setProperty('--panel-origin-y', `${y}%`);
    return { x, y, panelRect, buttonRect };
  },

  /**
   * macOS-style floating panel open/close from a toolbar/dock button.
   * Production today: CSS keyframes floatingPanelOpenFromButton (class panel-opening).
   *
   * Differences vs CSS (better Apple/macOS):
   *  - spring, interruptible, retarget mid-flight
   *  - origin pinned to the *actual* button center (not a fixed keyframe path)
   *  - no ease-in close (CSS close uses cubic-bezier(.4,0,.2,1) which eases in-ish)
   *  - scale floor 0.9 (never 0); short y travel toward anchor
   *
   * For terminal bottom chrome (file manager / docker / info / snippets):
   *   button is usually BELOW the panel → open grows upward from the button
   *   (seed y slightly positive / toward bottom, spring to 0).
   *
   *   Motion.macPanel(panel, button, { open: true })
   *   Motion.macPanel(panel, button, { open: false })
   *
   * Does NOT mutate production floating-panel.js — wire later.
   */
  /**
   * macOS / dock-style panel open-close — READABLE “grows from the button”.
   *
   * Default mode is FLIP from the button’s viewport rect → panel layout rect
   * (matched geometry). Pure origin-scale at 0.96 is too subtle to read as
   * “from this control”; FLIP makes the continuous surface obvious.
   *
   * opts.mode:
   *   'flip' (default) — morph from button rect (clear grow-from-source)
   *   'origin' — only transform-origin scale (Emil popover, subtler)
   *
   * Also: hideSource on button during open (no dual ghost); restore on close.
   * Critically damped `mac` / `macClose`. Interruptible (generation token).
   */
  async macPanel(panel, button, opts = {}) {
    if (!panel) return false;
    const token = this._bump(panel);
    const open = opts.open !== false;
    const mode = opts.mode || 'flip';
    const preset = opts.preset ?? (open ? 'mac' : 'macClose');
    const contentEl = opts.contentEl || null;
    // Default FALSE: toolbar/dock buttons must stay visible (macOS).
    // Continuous-surface hide is opt-in for icon-like launches only.
    const hideSource = opts.hideSource === true;

    panel.hidden = false;
    if (!panel.style.display || panel.style.display === 'none') {
      panel.style.display = 'flex';
    }
    panel.style.willChange = 'transform, opacity, filter';
    panel.style.pointerEvents = open ? 'auto' : panel.style.pointerEvents;
    panel.style.filter = 'none';

    // Capture button rect in viewport BEFORE any transform (stable anchor)
    const btnRect = button?.getBoundingClientRect?.() || null;

    if (open) {
      panel.style.visibility = 'hidden';
      void panel.offsetWidth;

      if (contentEl) {
        this.stop(contentEl);
        // Content fades slightly after geometry so the grow reads first
        this.set(contentEl, { opacity: opts.contentWithPanel ? 1 : 0 });
      }

      // Switching anchors: restore any previously hidden buttons for this panel
      this.restoreSources(panel);

      if (mode === 'flip' && btnRect && btnRect.width > 2) {
        // Identity layout measure
        this.stop(panel);
        panel.style.transform = 'none';
        panel.style.opacity = '0';
        void panel.offsetWidth;
        const layoutBox = panel.getBoundingClientRect();
        const st = stateFor(panel);
        st.layoutW = layoutBox.width;
        st.layoutH = layoutBox.height;
        st.radiusCompensate = true;
        const rFrom = Number(opts.radiusFrom) || Math.min(btnRect.width, btnRect.height) / 2 || 12;
        const rTo = Number(opts.radiusTo) || 12;
        st.visualRadius = rFrom;

        const sx0 = Math.max(0.001, btnRect.width / Math.max(1, layoutBox.width));
        const sy0 = Math.max(0.001, btnRect.height / Math.max(1, layoutBox.height));
        this.set(panel, {
          x: btnRect.left - layoutBox.left,
          y: btnRect.top - layoutBox.top,
          scaleX: sx0,
          scaleY: sy0,
          radius: rFrom,
          opacity: 1,
          blur: 0,
        });
        void panel.offsetWidth;
        panel.style.visibility = 'visible';

        if (hideSource && button) this.hideSource(panel, button);

        const jobs = [
          this.to(panel, {
            x: 0, y: 0, scaleX: 1, scaleY: 1,
            radius: rTo, opacity: 1, blur: 0,
          }, { preset }),
        ];
        if (contentEl && !opts.contentWithPanel) {
          jobs.push(this.to(contentEl, { opacity: 1 }, {
            preset: opts.contentPreset ?? 'content',
            delay: Number(opts.contentDelay) || 0.08,
          }));
        }
        await Promise.all(jobs);
        // If a close pre-empted us, still leave sources consistent for the closer
        if (this._genOf(panel) !== token) return false;
      } else {
        const fromScale = this._clampEnterScale(opts.fromScale ?? 0.92, 0.92);
        const travel = Number.isFinite(Number(opts.travel)) ? Number(opts.travel) : 8;
        void panel.offsetWidth;
        this.setOriginFromAnchor(panel, button);
        let dirY = 1;
        if (btnRect) {
          const pr = panel.getBoundingClientRect();
          const btnCy = btnRect.top + btnRect.height / 2;
          const panCy = pr.top + pr.height / 2;
          dirY = btnCy >= panCy ? 1 : -1;
        }
        if (!this.isAnimating(panel)) {
          this.set(panel, {
            opacity: 0, scale: fromScale, y: dirY * travel, x: 0, blur: 0,
          });
        }
        panel.style.visibility = 'visible';
        if (hideSource && button) this.hideSource(panel, button);
        await this.to(panel, {
          opacity: 1, scale: 1, y: 0, x: 0, blur: 0,
        }, { preset });
        if (contentEl && !opts.contentWithPanel) {
          await this.to(contentEl, { opacity: 1 }, {
            preset: opts.contentPreset ?? 'content',
            delay: 0.04,
          });
        }
        if (this._genOf(panel) !== token) return false;
      }
    } else {
      // Close: reverse into button rect (symmetric path)
      panel.style.visibility = 'visible';
      if (contentEl && !opts.contentWithPanel) {
        this.to(contentEl, { opacity: 0 }, {
          preset: opts.contentPreset ?? 'contentClose',
        });
      }
      try {
        if (mode === 'flip' && btnRect && btnRect.width > 2) {
          const rTo = Number(opts.radiusFrom) || Math.min(btnRect.width, btnRect.height) / 2 || 12;
          await this.morphTo(panel, btnRect, {
            preset,
            radiusTo: rTo,
            radiusCompensate: true,
            opacityTo: 1,
            blurTo: 0,
          });
        } else {
          const fromScale = this._clampEnterScale(opts.fromScale ?? 0.92, 0.92);
          const travel = Number.isFinite(Number(opts.travel)) ? Number(opts.travel) : 8;
          this.setOriginFromAnchor(panel, button);
          let dirY = 1;
          if (btnRect) {
            const pr = panel.getBoundingClientRect();
            dirY = (btnRect.top + btnRect.height / 2) >= (pr.top + pr.height / 2) ? 1 : -1;
          }
          await this.to(panel, {
            opacity: 0, scale: fromScale, y: dirY * travel, x: 0, blur: 0,
          }, { preset });
        }
      } finally {
        // ALWAYS restore every button hidden for this panel (even if pre-empted)
        this.restoreSources(panel);
        if (button) this.restoreSource(button);
      }
      if (this._genOf(panel) !== token) return false;

      if (opts.thenHide !== false) {
        panel.style.visibility = 'hidden';
        if (opts.thenDisplayNone) panel.style.display = 'none';
        this.set(panel, {
          x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1,
          opacity: 1, blur: 0, radius: 0,
        });
      }
    }
    return this._genOf(panel) === token;
  },

  /** Alias: open mac panel from button */
  macPanelOpen(panel, button, opts = {}) {
    return this.macPanel(panel, button, { ...opts, open: true });
  },
  /** Alias: close mac panel to button */
  macPanelClose(panel, button, opts = {}) {
    return this.macPanel(panel, button, { ...opts, open: false });
  },

  /**
   * Standardized connection / card → fullscreen open (iOS SpringBoard).
   * Defaults tuned for Zephyr connection modal (matches connection-home-blur):
   *   homeScale 0.92, scrimOpacity 0.24, pure dim (no frost over cards).
   * Implementation is iosAppOpen — this is the *product* name for wiring later.
   *
   *   Motion.connectionOpen(surface, cardEl, { scrim, home: appShell })
   */
  connectionOpen(surfaceEl, sourceElOrRect, opts = {}) {
    return this.iosAppOpen(surfaceEl, sourceElOrRect, {
      scrimOpacity: 0.24,
      homeScale: 0.92,
      homeBlur: 0,
      contentDelay: 0.16,
      faceDelay: 0.05,
      cloneSource: true,
      hideSource: true,
      ...opts,
    });
  },
  connectionClose(surfaceEl, sourceElOrRect, opts = {}) {
    return this.iosAppClose(surfaceEl, sourceElOrRect, {
      scrimOpacity: 0.24,
      homeScale: 0.92,
      homeBlur: 0,
      cloneSource: true,
      restoreSource: true,
      hideSurface: true,
      ...opts,
    });
  },

  /**
   * Smartbar / dock shelf open (macOS Dock-adjacent panel).
   * Short rise + fade; interruptible. Production uses smartbarPanelMacClose keyframes.
   * (Dock 4-channel magnify lives later as dockMagnify / dockMagnifyPointer.)
   *
   *   Motion.shelf(panel, { open: true, edge: 'bottom' })
   */
  async shelf(panel, opts = {}) {
    if (!panel) return false;
    const token = this._bump(panel);
    const open = opts.open !== false;
    const edge = opts.edge || 'bottom';
    const travel = Number.isFinite(Number(opts.travel)) ? Number(opts.travel) : 20;
    const preset = opts.preset ?? (open ? 'shape' : 'shapeClose');
    let fromY = travel;
    if (edge === 'top') fromY = -travel;
    if (edge === 'left' || edge === 'right') fromY = 0;
    const fromX = edge === 'left' ? -travel : edge === 'right' ? travel : 0;

    panel.hidden = false;
    panel.style.visibility = 'visible';
    panel.style.willChange = 'transform, opacity, filter';
    if (open) {
      if (!this.isAnimating(panel)) {
        this.set(panel, {
          opacity: 0,
          y: fromY,
          x: fromX,
          scale: 0.94,
          blur: 4,
        });
      }
      await this.to(panel, { opacity: 1, y: 0, x: 0, scale: 1, blur: 0 }, { preset });
    } else {
      await this.to(panel, {
        opacity: 0,
        y: fromY * 0.7,
        x: fromX * 0.7,
        scale: 0.94,
        blur: 4,
      }, { preset });
      if (this._genOf(panel) === token && opts.thenHide !== false) {
        panel.style.visibility = 'hidden';
      }
    }
    return this._genOf(panel) === token;
  },

  /**
   * Per-element generation tokens: mid-flight reverse invalidates the previous
   * open/close promise so callers don't hide the panel when a newer open wins.
   */
  _gen: new WeakMap(),
  _bump(el) {
    if (!el) return 0;
    const n = (this._gen.get(el) || 0) + 1;
    this._gen.set(el, n);
    return n;
  },
  _genOf(el) { return this._gen.get(el) || 0; },

  /**
   * Track elements hidden for continuous-surface handoff (icon/button under
   * expanding panel). MUST restore or they stay opacity:0 forever — a common
   * demo/production bug when switching anchors mid-open or interrupt fails.
   * WeakMap: surfaceEl → Set<sourceEl>
   */
  _hiddenBySurface: new WeakMap(),
  // Source controls frequently have CSS opacity/transform transitions. A plain
  // `style.opacity = '0'` therefore crossfades the live source while its clone
  // is already flying, producing a double-image flash. Preserve inline paint
  // so hide and handoff can be one composited state change.
  _sourcePaint: new WeakMap(),
  _sourcePaintGeneration: new WeakMap(),

  _captureSourcePaint(el) {
    const read = (name) => ({
      value: el.style.getPropertyValue(name),
      priority: el.style.getPropertyPriority(name),
    });
    return {
      opacity: read('opacity'), pointerEvents: read('pointer-events'),
      visibility: read('visibility'), transform: read('transform'), filter: read('filter'),
      transition: read('transition'), animation: read('animation'),
    };
  },

  _restoreInlinePaint(el, name, saved) {
    if (saved?.value) el.style.setProperty(name, saved.value, saved.priority);
    else el.style.removeProperty(name);
  },

  hideSource(surfaceEl, sourceEl) {
    if (!sourceEl?.style) return;
    let set = this._hiddenBySurface.get(surfaceEl);
    if (!set) {
      set = new Set();
      this._hiddenBySurface.set(surfaceEl, set);
    }
    set.add(sourceEl);
    if (!this._sourcePaint.has(sourceEl)) this._sourcePaint.set(sourceEl, this._captureSourcePaint(sourceEl));
    const generation = (this._sourcePaintGeneration.get(sourceEl) || 0) + 1;
    this._sourcePaintGeneration.set(sourceEl, generation);

    // Disable authored transitions BEFORE setting opacity. This must be
    // synchronous: the clone is made visible in the same call stack.
    sourceEl.style.setProperty('transition', 'none', 'important');
    sourceEl.style.setProperty('animation', 'none', 'important');
    sourceEl.style.setProperty('opacity', '0', 'important');
    sourceEl.style.setProperty('pointer-events', 'none', 'important');
    sourceEl.dataset.motionHidden = '1';
    // Commit the invisible source before iosAppOpen exposes the clone/surface.
    void sourceEl.offsetWidth;
  },

  restoreSource(sourceEl) {
    if (!sourceEl?.style) return;
    // CRITICAL: release motion slots first. If we only clear style.opacity,
    // the engine's next frame re-writes opacity:0 from the bound channel —
    // icons/buttons appear permanently gone after close.
    try { this.release(sourceEl); } catch { /* noop */ }
    const saved = this._sourcePaint.get(sourceEl);
    const generation = (this._sourcePaintGeneration.get(sourceEl) || 0) + 1;
    this._sourcePaintGeneration.set(sourceEl, generation);

    // Restore the target paint while transitions remain disabled. The close
    // caller can now atomically reveal the real control under the twin.
    for (const name of ['opacity', 'pointer-events', 'visibility', 'transform', 'filter']) {
      this._restoreInlinePaint(sourceEl, name, saved?.[name]);
    }
    sourceEl.style.setProperty('transition', 'none', 'important');
    sourceEl.style.setProperty('animation', 'none', 'important');
    delete sourceEl.dataset.motionHidden;
    void sourceEl.offsetWidth;

    // Re-enable authored motion only after the restored source has painted.
    // A rapid reopen increments generation, leaving the new hide authoritative.
    requestAnimationFrame(() => {
      if (this._sourcePaintGeneration.get(sourceEl) !== generation || sourceEl.dataset.motionHidden) return;
      this._restoreInlinePaint(sourceEl, 'transition', saved?.transition);
      this._restoreInlinePaint(sourceEl, 'animation', saved?.animation);
      this._sourcePaint.delete(sourceEl);
    });
  },

  /** Restore every source ever hidden for this surface (or one specific). */
  restoreSources(surfaceEl, onlyEl = null) {
    const set = this._hiddenBySurface.get(surfaceEl);
    if (!set) {
      if (onlyEl) this.restoreSource(onlyEl);
      return;
    }
    const list = onlyEl ? [onlyEl] : [...set];
    for (const el of list) {
      this.restoreSource(el);
      set.delete(el);
    }
    if (!set.size) this._hiddenBySurface.delete(surfaceEl);
  },

  /**
   * Dynamic Island — three-dot grip melt / return via CSS custom properties.
   * Mirrors terminalIslandSourceMelt / terminalIslandDotsReturn (production CSS).
   * All channels spring together with preset 'island' so a reverse mid-melt
   * retargets from live values (interruptible).
   */
  islandDots(el, phase = 'melt', opts = {}) {
    if (!el) return Promise.resolve();
    const preset = opts.preset ?? 'island';
    const units = {
      '--island-dot-spread': 'px',
      '--island-fluid-blur': 'px',
    };
    // Identity rest pose (production defaults)
    const rest = {
      '--island-dot-spread': 10,
      '--island-dot-scale': 1,
      '--island-dot-opacity': 1,
      '--island-fluid-scale-x': 1,
      '--island-fluid-scale-y': 1,
      '--island-fluid-blur': 0,
    };
    // Melt end pose from terminalIslandSourceMelt 100%
    const melt = {
      '--island-dot-spread': 5,
      '--island-dot-scale': 0.84,
      '--island-dot-opacity': 0.18,
      '--island-fluid-scale-x': 0.965,
      '--island-fluid-scale-y': 0.92,
      '--island-fluid-blur': 0.8,
    };
    // Mid squash (dynamic morph ~28%) for more "liquid" travel if phase==='squash'
    const squash = {
      '--island-dot-spread': 2,
      '--island-dot-scale': 0.62,
      '--island-dot-opacity': 0.76,
      '--island-fluid-scale-x': 0.88,
      '--island-fluid-scale-y': 0.86,
      '--island-fluid-blur': 1.6,
    };
    const target = phase === 'return' ? rest : phase === 'squash' ? squash : melt;
    // Seed rest once so first melt has somewhere to leave from
    if (phase !== 'return' && !this.isAnimating(el)) {
      const has = this.value(el, '--island-dot-spread');
      if (!has) this.cssVars(el, rest, { units, immediate: true });
    }
    return this.cssVars(el, target, { units, preset });
  },

  /**
   * Merged Dynamic Island OPEN — multi-phase fluid expand (mirrors your CSS
   * terminalIslandFluidOpen keyframes), but fully interruptible via springs.
   *
   * Production CSS stages (simplified to spring targets):
   *   0%  scaleX≈0.34 scaleY≈0.18 blur 3  radius pill  opacity .68
   *  24%  scaleX≈0.66 scaleY≈0.38 blur 6  (liquid stretch)
   *  44%  scaleX≈1.025 scaleY≈0.92 blur 3 (overshoot width)
   * 100%  scale 1 radius 22 blur 0
   *
   * We seed from the grip capsule (FLIP), then spring through a liquid
   * mid-pose into settle — all retargetable if collapse is called mid-flight.
   */
  /**
   * Dynamic Island OPEN — ONE continuous spring (no multi-phase handoffs).
   * Multi-phase targets create a velocity "brick wall" and feel abrupt.
   * Seed panel as the grip capsule, hide grip, spring to identity.
   * Dots melt in parallel on the same time scale.
   */
  async islandExpand({ grip, panel, fromRect = null, scrim = null, opts = {} } = {}) {
    if (!panel) return false;
    const token = this._bump(panel);
    const g = grip || null;
    const rect = fromRect || (g?.getBoundingClientRect?.() ?? null);
    const shapePreset = opts.shapePreset ?? opts.preset ?? 'island';
    const rFrom = Number(opts.radiusFrom) || (rect ? Math.min(rect.width, rect.height) / 2 : 11);
    const rTo = Number(opts.radiusTo) || 22;

    panel.hidden = false;
    if (!panel.style.display || panel.style.display === 'none') panel.style.display = 'block';
    panel.style.visibility = 'hidden';
    panel.style.pointerEvents = 'none';
    panel.style.overflow = 'hidden';
    panel.style.willChange = 'transform, opacity, filter, border-radius';
    panel.style.transformOrigin = '0 0';

    const jobs = [];
    if (g) jobs.push(this.islandDots(g, 'melt', { preset: shapePreset }));
    if (scrim) jobs.push(this.scrim(scrim, true, { opacity: opts.scrimOpacity ?? 0.12, preset: 'scrim' }));

    if (rect) {
      this.stop(panel);
      panel.style.transform = 'none';
      panel.style.opacity = '0';
      void panel.offsetWidth;
      const layoutBox = panel.getBoundingClientRect();
      const st = stateFor(panel);
      st.layoutW = layoutBox.width;
      st.layoutH = layoutBox.height;
      st.radiusCompensate = true;
      st.visualRadius = rFrom;
      const sx0 = Math.max(0.001, rect.width / layoutBox.width);
      const sy0 = Math.max(0.001, rect.height / layoutBox.height);
      // Seed: identical capsule over the three dots (opacity 1 — no ghost fade)
      this.set(panel, {
        x: rect.left - layoutBox.left,
        y: rect.top - layoutBox.top,
        scaleX: sx0,
        scaleY: sy0,
        radius: rFrom,
        opacity: 1,
        blur: 0,
        saturate: 1,
      });
      void panel.offsetWidth;
      panel.style.visibility = 'visible';
      panel.style.pointerEvents = 'auto';
      if (g?.style && opts.hideGrip !== false) g.style.opacity = '0';

      // Single continuous spring to rest — interruptible mid-flight
      jobs.push(this.to(panel, {
        x: 0, y: 0, scaleX: 1, scaleY: 1,
        radius: rTo, opacity: 1, blur: 0, saturate: 1,
      }, { preset: shapePreset }));
    } else {
      panel.style.visibility = 'visible';
      panel.style.pointerEvents = 'auto';
    }

    await Promise.all(jobs);
    return this._genOf(panel) === token;
  },

  /**
   * Dynamic Island CLOSE — panel morphs to capsule WHILE dots return in
   * parallel (no "snap back" handoff after settle). Grip is revealed under
   * the shrinking panel so the surface reads continuous.
   */
  async islandCollapse({ grip, panel, toRect = null, scrim = null, opts = {} } = {}) {
    if (!panel) return false;
    const token = this._bump(panel);
    const g = grip || null;
    // Measure grip BEFORE unhiding (identity). Keep grip under panel until near end.
    const rect = toRect || (g?.getBoundingClientRect?.() ?? null);
    const shapePreset = opts.shapePreset ?? opts.preset ?? 'island';
    const rTo = Number(opts.radiusTo) || (rect ? Math.min(rect.width, rect.height) / 2 : 11);

    panel.style.visibility = 'visible';
    panel.style.pointerEvents = 'auto';
    panel.style.overflow = 'hidden';

    // Pre-position dots at melt pose (hidden under panel), then spring them
    // back to rest in parallel with the panel shrink — avoids post-settle pop.
    if (g) {
      // Ensure grip participates in layout for correct toRect, but stay
      // visually under the panel until handoff.
      g.style.visibility = 'visible';
      g.style.opacity = '0';
      g.style.pointerEvents = 'none';
      // Start dots near melt so return has a smooth spring path
      this.islandDots(g, 'melt', { preset: shapePreset });
    }

    const jobs = [];
    if (rect) {
      // Stay opaque until the last stretch so grip can take over without a hole
      jobs.push(this.morphTo(panel, rect, {
        preset: shapePreset,
        radiusTo: rTo,
        radiusCompensate: true,
        blurTo: 0,
        opacityTo: 1,
      }));
    }
    if (scrim) jobs.push(this.scrim(scrim, false, { preset: 'scrim' }));

    // Dots return in PARALLEL with panel collapse (not after)
    if (g) {
      jobs.push((async () => {
        // Brief delay so panel has started covering → then show grip + return dots
        await new Promise(r => setTimeout(r, 90));
        if (this._genOf(panel) !== token) return;
        g.style.opacity = '1';
        await this.islandDots(g, 'return', { preset: shapePreset });
      })());
    }

    await Promise.all(jobs);
    if (this._genOf(panel) !== token) return false;

    // Final handoff: grip fully on, panel off (same frame)
    if (g) {
      g.style.opacity = '1';
      g.style.pointerEvents = '';
      g.style.visibility = '';
    }
    if (opts.hidePanel !== false) {
      panel.style.visibility = 'hidden';
      panel.style.pointerEvents = 'none';
      this.set(panel, {
        x: 0, y: 0, scaleX: 1, scaleY: 1, radius: rTo,
        opacity: 1, blur: 0, saturate: 1,
      });
    }
    return true;
  },

  /**
   * iOS SpringBoard app OPEN — continuous surface from home icon.
   *
   * Multi-layer, interruptible (generation token). Channels:
   *   shape   surface x/y/scaleX/scaleY/radius  → preset 'shape'   0.48 / 0.96
   *   content surface opacity + blur            → preset 'content' critically damped
   *   scrim   dim layer opacity                 → preset 'scrim'
   *   home    wallpaper scale + blur            → preset 'home'    (recede)
   *   icon    source icon scale + opacity       → preset 'icon'    (grow & fade)
   *   elev    optional --elev 0→1 for shadow    → content
   *
   * Why this beats pure CSS top/left/width/height tweens:
   *   - compositor-only (transform/opacity/filter)
   *   - mid-flight reverse carries velocity (Apple interruptibility)
   *   - radius compensated by scaleX (matched corner continuity)
   *   - home recedes while app expands (spatial hierarchy)
   *
   * surfaceEl must already occupy final layout (fullscreen). Callers should
   * not await-lock — fire open/close freely for reverse.
   *
   * opts:
   *   scrim, home, hideSource=true, radiusFrom, radiusTo=0,
   *   scrimOpacity=0.40, homeScale=0.92, homeBlur=8,
   *   iconScale=1.35, contentDelay=0.02,
   *   elevVar, shapePreset, contentPreset, scrimPreset, homePreset, iconPreset
   */
  /**
   * Pixel-perfect twin of the source icon/button, planted as a continuous
   * surface over the morphing card. iOS SpringBoard does NOT morph a vaguely
   * similar blob — it morphs a surface that IS the icon until chrome crossfades.
   *
   * Structure:
   *   [data-motion-source-visual]  absolute inset 0, inherits surface radius
   *     └ twin (cloneNode of icon)  fixed to icon's layout size, inverse-scaled
   *                                 so non-uniform FLIP never stretches glyphs
   *
   * Full computed paint (bg / color / font / padding / shadow / border) is
   * copied so the twin is indistinguishable from the live button.
   * Margin is forced to 0 — theme classes like .btn-primary { margin-top: 8px }
   * would otherwise shift the twin off the true button rect and flash at handoff.
   */
  _ensureSourceVisual(surfaceEl, iconEl) {
    if (!surfaceEl || !iconEl) return null;
    let layer = surfaceEl.querySelector(':scope > [data-motion-source-visual]');
    if (!layer) {
      layer = document.createElement('div');
      layer.dataset.motionSourceVisual = '1';
      surfaceEl.insertBefore(layer, surfaceEl.firstChild);
    }
    const cs = getComputedStyle(iconEl);
    const ir = iconEl.getBoundingClientRect();
    // Use subpixel-accurate rect size so twin covers the live button exactly.
    const iw = Math.max(1, ir.width);
    const ih = Math.max(1, ir.height);
    const bg = (cs.backgroundImage && cs.backgroundImage !== 'none')
      ? cs.background
      : (cs.backgroundColor || 'transparent');

    // Layer fills the morphing surface; radius inherits compensated surface radius.
    // Background matches button so any 1px peek under twin never flashes card chrome.
    layer.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:1', 'pointer-events:none',
      'display:flex', 'align-items:center', 'justify-content:center',
      'overflow:hidden', 'border-radius:inherit',
      'will-change:opacity',
      `background:${bg}`,
    ].join(';');

    // Twin: exact DOM + paint of the source control
    let twin = layer.querySelector(':scope > [data-motion-source-face]');
    if (!twin) {
      twin = iconEl.cloneNode(true);
      twin.dataset.motionSourceFace = '1';
      // Strip interactive / a11y so it never steals focus or fire events
      twin.removeAttribute('id');
      twin.removeAttribute('name');
      twin.removeAttribute('href');
      twin.tabIndex = -1;
      twin.setAttribute('aria-hidden', 'true');
      twin.querySelectorAll?.('button,a,input,textarea,select,[tabindex]').forEach((n) => {
        n.removeAttribute('id');
        n.tabIndex = -1;
        n.setAttribute('aria-hidden', 'true');
      });
      layer.innerHTML = '';
      layer.appendChild(twin);
    } else if (twin.innerHTML !== iconEl.innerHTML) {
      twin.innerHTML = iconEl.innerHTML;
    }

    // Keep theme classes for token resolution, but paint is driven by inline
    // computed styles so cascade order (e.g. .btn-primary margin-top) can't
    // pull the twin off the true button box.
    if (iconEl.className && typeof iconEl.className === 'string') {
      twin.className = iconEl.className;
    }

    twin.style.cssText = [
      'box-sizing:border-box',
      `width:${iw}px`, `height:${ih}px`,
      'flex:0 0 auto', 'max-width:none', 'max-height:none',
      // CRITICAL: kill margin from theme classes (.btn-primary { margin-top: 8px })
      'margin:0', 'margin-top:0', 'margin-bottom:0', 'margin-left:0', 'margin-right:0',
      // Inverse scale keeps the twin unstretched while surface FLIPs non-uniformly
      'transform:scale(calc(1 / max(var(--motion-sx, 1), 0.001)), calc(1 / max(var(--motion-sy, 1), 0.001)))',
      'transform-origin:center center',
      'pointer-events:none', 'cursor:default',
      // Full paint copy — pixel match, not "roughly similar"
      `background:${bg}`,
      `background-color:${cs.backgroundColor}`,
      `color:${cs.color}`,
      `font:${cs.font}`,
      `font-size:${cs.fontSize}`,
      `font-weight:${cs.fontWeight}`,
      `font-family:${cs.fontFamily}`,
      `letter-spacing:${cs.letterSpacing}`,
      `line-height:${cs.lineHeight}`,
      `text-align:${cs.textAlign}`,
      `padding:${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      `border-style:${cs.borderStyle}`,
      `border-width:${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth}`,
      `border-color:${cs.borderTopColor} ${cs.borderRightColor} ${cs.borderBottomColor} ${cs.borderLeftColor}`,
      `border-radius:${cs.borderRadius}`,
      `box-shadow:${cs.boxShadow}`,
      `display:${cs.display === 'inline' ? 'inline-flex' : (cs.display || 'flex')}`,
      `align-items:${cs.alignItems || 'center'}`,
      `justify-content:${cs.justifyContent || 'center'}`,
      `gap:${cs.gap || '0px'}`,
      `white-space:${cs.whiteSpace || 'nowrap'}`,
      'overflow:hidden',
      // Kill transitions / press scale so twin never fights the spring
      'transition:none !important', 'animation:none !important',
      'opacity:1', 'filter:none', 'outline:none',
      // Avoid iOS tap highlight / selection flash on the twin
      '-webkit-tap-highlight-color:transparent', 'user-select:none',
    ].join(';');
    // Re-assert margin after class-driven stylesheet could race
    twin.style.setProperty('margin', '0', 'important');
    twin.style.setProperty('margin-top', '0', 'important');
    twin.style.setProperty('transform',
      'scale(calc(1 / max(var(--motion-sx, 1), 0.001)), calc(1 / max(var(--motion-sy, 1), 0.001)))');
    layer.style.opacity = '1';
    return layer;
  },

  _clearSourceVisual(surfaceEl) {
    surfaceEl?.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
  },

  /**
   * Standard iOS card flip + matched-geometry transition.
   *
   * Go owns all spring profiles through engine_configure_standard. Geometry
   * and rotation use independent standards so the card can land cleanly while
   * the half-turn carries a restrained, sub-degree soft settle.
   *
   * Required DOM: surface contains front/back faces with backface-visibility
   * hidden; pass them as opts.frontEl / opts.backEl to crossfade content.
   */
  async iosCardTransition(surfaceEl, sourceElOrRect, opts = {}) {
    if (!surfaceEl) return false;
    const open = opts.open !== false;
    const token = this._bump(surfaceEl);
    const source = sourceElOrRect && typeof sourceElOrRect.getBoundingClientRect === 'function'
      ? sourceElOrRect : null;
    const anchorRect = source ? source.getBoundingClientRect() : sourceElOrRect;
    const scrim = opts.scrim || null;
    const frontEl = opts.frontEl || null;
    const backEl = opts.backEl || null;
    const hideSource = opts.hideSource !== false;
    const geometryStandard = open
      ? MOTION_STANDARDS.iosCardGeometryOpen
      : MOTION_STANDARDS.iosCardGeometryClose;
    const flipStandard = open
      ? MOTION_STANDARDS.iosCardFlipOpen
      : MOTION_STANDARDS.iosCardFlipClose;
    const scrimOpacity = Number.isFinite(Number(opts.scrimOpacity)) ? Number(opts.scrimOpacity) : 0.42;
    const radiusFrom = Number(opts.radiusFrom) || (
      anchorRect ? Math.min(anchorRect.width, anchorRect.height) * 0.233 : 28
    );
    const radiusTo = Number.isFinite(Number(opts.radiusTo)) ? Number(opts.radiusTo) : 36;

    surfaceEl.hidden = false;
    if (!surfaceEl.style.display || surfaceEl.style.display === 'none') surfaceEl.style.display = 'block';
    surfaceEl.style.transformStyle = 'preserve-3d';
    surfaceEl.style.transformOrigin = '0 0';
    surfaceEl.style.willChange = 'transform, opacity';
    surfaceEl.style.pointerEvents = open ? 'auto' : surfaceEl.style.pointerEvents;

    if (open) {
      surfaceEl.style.visibility = 'hidden';
      this.stop(surfaceEl);
      surfaceEl.style.transform = 'none';
      void surfaceEl.offsetWidth;
      const layoutBox = surfaceEl.getBoundingClientRect();
      const st = stateFor(surfaceEl);
      st.layoutW = layoutBox.width;
      st.layoutH = layoutBox.height;
      st.radiusCompensate = true;
      st.visualRadius = radiusFrom;
      if (anchorRect && layoutBox.width > 1 && layoutBox.height > 1) {
        this.set(surfaceEl, {
          x: anchorRect.left - layoutBox.left,
          y: anchorRect.top - layoutBox.top,
          scaleX: Math.max(0.001, anchorRect.width / layoutBox.width),
          scaleY: Math.max(0.001, anchorRect.height / layoutBox.height),
          rotateY: 0,
          radius: radiusFrom,
          opacity: 1,
        });
      }
      if (frontEl) this.set(frontEl, { opacity: 1 });
      if (backEl) this.set(backEl, { opacity: 0 });
      if (scrim) {
        scrim.style.backdropFilter = 'none';
        scrim.style.webkitBackdropFilter = 'none';
        if (!this.isAnimating(scrim)) this.set(scrim, { opacity: 0 });
      }
      if (source && hideSource) this.hideSource(surfaceEl, source);
      surfaceEl.style.visibility = 'visible';

      const jobs = [
        this.to(surfaceEl, { x: 0, y: 0, scaleX: 1, scaleY: 1, radius: radiusTo, opacity: 1 }, { standard: geometryStandard }),
        this.to(surfaceEl, { rotateY: -180 }, { standard: flipStandard }),
      ];
      if (frontEl) jobs.push(this.to(frontEl, { opacity: 0 }, { standard: MOTION_STANDARDS.iosCardContent, delay: 0.06 }));
      if (backEl) jobs.push(this.to(backEl, { opacity: 1 }, { standard: MOTION_STANDARDS.iosCardContent, delay: 0.10 }));
      if (scrim) jobs.push(this.to(scrim, { opacity: scrimOpacity }, { standard: MOTION_STANDARDS.iosCardScrim }));
      await Promise.all(jobs);
      return this._genOf(surfaceEl) === token;
    }

    const toRect = source ? source.getBoundingClientRect() : anchorRect;
    if (source && hideSource) this.hideSource(surfaceEl, source);
    const jobs = [];
    if (toRect) {
      const cur = surfaceEl.getBoundingClientRect();
      const st = stateFor(surfaceEl);
      const layoutW = st.layoutW || Math.max(1, cur.width / Math.max(0.001, this.value(surfaceEl, 'scaleX') || 1));
      const layoutH = st.layoutH || Math.max(1, cur.height / Math.max(0.001, this.value(surfaceEl, 'scaleY') || 1));
      jobs.push(this.to(surfaceEl, {
        x: this.value(surfaceEl, 'x') + toRect.left - cur.left,
        y: this.value(surfaceEl, 'y') + toRect.top - cur.top,
        scaleX: toRect.width / layoutW,
        scaleY: toRect.height / layoutH,
        radius: radiusFrom,
        opacity: 1,
      }, { standard: geometryStandard }));
    }
    jobs.push(this.to(surfaceEl, { rotateY: 0 }, { standard: flipStandard }));
    if (frontEl) jobs.push(this.to(frontEl, { opacity: 1 }, { standard: MOTION_STANDARDS.iosCardContent, delay: 0.035 }));
    if (backEl) jobs.push(this.to(backEl, { opacity: 0 }, { standard: MOTION_STANDARDS.iosCardContent }));
    if (scrim) jobs.push(this.to(scrim, { opacity: 0 }, { standard: MOTION_STANDARDS.iosCardScrim }));
    try {
      await Promise.all(jobs);
    } finally {
      if (opts.restoreSource !== false) {
        this.restoreSources(surfaceEl);
        if (source) this.restoreSource(source);
      }
    }
    if (this._genOf(surfaceEl) !== token) return false;
    if (opts.thenHide !== false) {
      surfaceEl.style.visibility = 'hidden';
      surfaceEl.style.pointerEvents = 'none';
      this.set(surfaceEl, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotateY: 0, radius: 0, opacity: 1 });
    }
    return true;
  },

  iosCardOpen(surfaceEl, sourceElOrRect, opts = {}) {
    return this.iosCardTransition(surfaceEl, sourceElOrRect, { ...opts, open: true });
  },

  iosCardClose(surfaceEl, sourceElOrRect, opts = {}) {
    return this.iosCardTransition(surfaceEl, sourceElOrRect, { ...opts, open: false });
  },

  /**
   * iOS SpringBoard OPEN — one continuous critically-damped spring.
   * No multi-phase handoffs. Surface is seeded as the icon (clone + FLIP),
   * real icon hidden underneath, home recedes, chrome fades late.
   */
  async iosAppOpen(surfaceEl, iconElOrRect, opts = {}) {
    if (!surfaceEl) return false;
    const token = this._bump(surfaceEl);
    const icon = iconElOrRect && typeof iconElOrRect.getBoundingClientRect === 'function'
      ? iconElOrRect : null;
    const fromRect = icon ? icon.getBoundingClientRect() : iconElOrRect;
    const scrim = opts.scrim || null;
    const home = opts.home || null;
    const contentEl = opts.contentEl || null;
    const radiusFrom = Number(opts.radiusFrom) || (
      fromRect ? Math.min(fromRect.width, fromRect.height) * 0.225 : 14
    );
    const radiusTo = opts.radiusTo != null ? Number(opts.radiusTo) : 0;
    const shapePreset = opts.shapePreset ?? 'shape';
    const contentPreset = opts.contentPreset ?? 'content';
    const scrimPreset = opts.scrimPreset ?? 'scrim';
    const homePreset = opts.homePreset ?? 'home';
    const scrimOpacity = Number.isFinite(Number(opts.scrimOpacity)) ? Number(opts.scrimOpacity) : 0.28;
    const homeScale = Number.isFinite(Number(opts.homeScale)) ? Number(opts.homeScale) : 0.92;
    const homeBlur = Number.isFinite(Number(opts.homeBlur)) ? Number(opts.homeBlur) : 0;
    // Chrome arrives after geometry leads; icon face leaves slightly earlier
    // so it never sits as a frosted sheet over app content.
    const contentDelay = Number.isFinite(Number(opts.contentDelay))
      ? Number(opts.contentDelay)
      : 0.14;
    const faceDelay = Number.isFinite(Number(opts.faceDelay))
      ? Number(opts.faceDelay)
      : Math.max(0, contentDelay * 0.35);

    surfaceEl.hidden = false;
    if (!surfaceEl.style.display || surfaceEl.style.display === 'none') {
      surfaceEl.style.display = 'block';
    }
    surfaceEl.style.visibility = 'hidden';
    surfaceEl.style.pointerEvents = 'none';
    surfaceEl.style.zIndex = surfaceEl.style.zIndex || '6';
    surfaceEl.style.overflow = 'hidden';
    // border-radius 每帧写但不进 will-change（提示会迫使主线程每帧栅格化）
    surfaceEl.style.willChange = 'transform, opacity';
    surfaceEl.style.transformOrigin = '0 0';

    // App material under the icon face (crossfade later)
    if (opts.appBackground) surfaceEl.style.background = opts.appBackground;

    if (contentEl) {
      this.stop(contentEl);
      this.set(contentEl, { opacity: 0 });
    }

    // Icon face clone (continuous surface)
    let sourceVisual = null;
    if (icon && opts.cloneSource !== false) {
      sourceVisual = this._ensureSourceVisual(surfaceEl, icon);
    }

    // Identity layout measure
    this.stop(surfaceEl);
    surfaceEl.style.transform = 'none';
    surfaceEl.style.opacity = '0';
    void surfaceEl.offsetWidth;
    const layoutBox = surfaceEl.getBoundingClientRect();

    const st = stateFor(surfaceEl);
    st.layoutW = layoutBox.width;
    st.layoutH = layoutBox.height;
    st.radiusCompensate = true;
    st.visualRadius = radiusFrom;

    if (fromRect && layoutBox.width > 1 && layoutBox.height > 1) {
      this.set(surfaceEl, {
        x: fromRect.left - layoutBox.left,
        y: fromRect.top - layoutBox.top,
        scaleX: Math.max(0.001, fromRect.width / layoutBox.width),
        scaleY: Math.max(0.001, fromRect.height / layoutBox.height),
        radius: radiusFrom,
        opacity: 1,
        blur: 0,
      });
      void surfaceEl.offsetWidth;
    }

    // Cover icon first, then reveal surface (same pixels → no jump)
    // Cover original icon only via CSS (NEVER Motion.set opacity — that binds a
    // channel which re-applies opacity:0 after close and "deletes" the icon).
    if (icon && opts.hideSource !== false) {
      this.hideSource(surfaceEl, icon);
    }
    surfaceEl.style.visibility = 'visible';
    surfaceEl.style.pointerEvents = 'auto';

    const jobs = [];
    // ONE shape spring — critically damped, no mid-target handoff
    jobs.push(this.to(surfaceEl, {
      x: 0, y: 0, scaleX: 1, scaleY: 1,
      radius: radiusTo, opacity: 1, blur: 0,
    }, { preset: shapePreset }));

    // Icon face out first (never cover chrome); chrome in after
    if (sourceVisual) {
      jobs.push(this.to(sourceVisual, { opacity: 0 }, {
        preset: contentPreset,
        delay: faceDelay,
      }));
    }
    if (contentEl) {
      // Ensure chrome is above source visual
      if (contentEl.style) {
        contentEl.style.position = contentEl.style.position || 'relative';
        contentEl.style.zIndex = contentEl.style.zIndex || '2';
      }
      jobs.push(this.to(contentEl, { opacity: 1 }, {
        preset: contentPreset,
        delay: contentDelay,
      }));
    }
    // Pure black dim under the expanding surface — NO backdrop-filter blur.
    // Blurring home icons reads as a frosted sheet covering them (user complaint).
    if (scrim) {
      scrim.style.backdropFilter = 'none';
      scrim.style.webkitBackdropFilter = 'none';
      if (!this.isAnimating(scrim)) this.set(scrim, { opacity: 0 });
      jobs.push(this.to(scrim, { opacity: scrimOpacity }, { preset: scrimPreset }));
    }
    // Wallpaper scale only — keep homeBlur default 0 (blur would mush icons)
    if (home) {
      home.style.willChange = 'transform';
      home.style.transformOrigin = 'center center';
      if (!this.isAnimating(home)) this.set(home, { scale: 1, blur: 0 });
      jobs.push(this.to(home, {
        scale: homeScale,
        blur: homeBlur > 0 ? homeBlur : 0,
      }, { preset: homePreset }));
    }
    if (opts.elevVar) {
      jobs.push(this.cssVars(surfaceEl, { [opts.elevVar]: opts.elevTo ?? 1 }, { preset: contentPreset }));
    }

    await Promise.all(jobs);
    return this._genOf(surfaceEl) === token;
  },

  /**
   * iOS SpringBoard CLOSE — reverse single spring into icon, handoff at end.
   */
  async iosAppClose(surfaceEl, iconElOrRect, opts = {}) {
    if (!surfaceEl) return false;
    const token = this._bump(surfaceEl);
    const icon = iconElOrRect && typeof iconElOrRect.getBoundingClientRect === 'function'
      ? iconElOrRect : null;

    // Keep icon in the hidden registry; measure while opacity:0 (layout intact).
    // Do NOT Motion.set(icon, {opacity:0}) — that creates a sticky channel.
    if (icon && opts.hideSource !== false && opts.restoreSource !== false) {
      this.hideSource(surfaceEl, icon);
    }
    const toRect = icon ? icon.getBoundingClientRect() : iconElOrRect;
    const scrim = opts.scrim || null;
    const home = opts.home || null;
    const contentEl = opts.contentEl || null;
    const radiusTo = Number(opts.radiusTo) || (
      toRect ? Math.min(toRect.width, toRect.height) * 0.225 : 14
    );
    const shapePreset = opts.shapePreset ?? 'shapeClose';
    const contentPreset = opts.contentPreset ?? 'contentClose';
    const scrimPreset = opts.scrimPreset ?? 'scrim';
    const homePreset = opts.homePreset ?? 'home';

    surfaceEl.style.overflow = 'hidden';
    surfaceEl.style.visibility = 'visible';
    surfaceEl.style.pointerEvents = 'auto';

    let sourceVisual = surfaceEl.querySelector(':scope > [data-motion-source-visual]');
    if (!sourceVisual && icon && opts.cloneSource !== false) {
      sourceVisual = this._ensureSourceVisual(surfaceEl, icon);
    }
    if (sourceVisual) {
      this.stop(sourceVisual);
      // Fade icon face back in as we shrink (late, so chrome leaves first)
      this.set(sourceVisual, { opacity: Number(sourceVisual.style.opacity) || 0 });
    }

    const jobs = [];
    if (toRect) {
      jobs.push(this.morphTo(surfaceEl, toRect, {
        preset: shapePreset,
        radiusTo,
        radiusCompensate: true,
        blurTo: 0,
        opacityTo: 1,
      }));
    }
    if (contentEl) {
      jobs.push(this.to(contentEl, { opacity: 0 }, { preset: contentPreset }));
    }
    if (sourceVisual) {
      jobs.push(this.to(sourceVisual, { opacity: 1 }, {
        preset: contentPreset,
        // 源面（像素级 twin）在几何中段就接回——落点时 twin 已完全盖住表面，
        // release 交换时零跳变。0.12 太晚，最后一帧才露脸会"突然变圆角"。
        delay: Number.isFinite(Number(opts.faceInDelay)) ? Number(opts.faceInDelay) : 0.04,
      }));
    }
    if (scrim) jobs.push(this.to(scrim, { opacity: 0 }, { preset: scrimPreset }));
    if (home) jobs.push(this.to(home, { scale: 1, blur: 0 }, { preset: homePreset }));
    if (opts.elevVar) {
      jobs.push(this.cssVars(surfaceEl, { [opts.elevVar]: 0 }, { preset: contentPreset }));
    }

    try {
      await Promise.all(jobs);
    } finally {
      // ALWAYS restore icons — even if a newer open pre-empted this close.
      // release() clears any accidental Motion channels on the icon.
      if (opts.restoreSource !== false) {
        this.restoreSources(surfaceEl);
        if (icon) this.restoreSource(icon);
      }
    }
    if (this._genOf(surfaceEl) !== token) return false;

    // Atomic handoff: surface off after icon is already restored
    if (opts.hideSurface !== false) {
      surfaceEl.style.visibility = 'hidden';
      surfaceEl.style.pointerEvents = 'none';
      this.set(surfaceEl, {
        x: 0, y: 0, scaleX: 1, scaleY: 1, radius: 0, opacity: 1, blur: 0,
      });
    }
    if (opts.clearSourceVisual !== false) this._clearSourceVisual(surfaceEl);
    if (opts.release) this.release(surfaceEl);
    return true;
  },

  /**
   * Interrupt-safe controller: open/close share one generation counter.
   * Rapid open→close→open never leaves the surface stuck or jumps.
   */
  appIconTransition(surfaceEl, iconEl, opts = {}) {
    let open = false;
    const self = this;
    return {
      get isOpen() { return open; },
      open: async (icon = iconEl) => {
        open = true;
        if (surfaceEl) {
          surfaceEl.hidden = false;
          surfaceEl.style.visibility = 'visible';
          surfaceEl.style.pointerEvents = 'auto';
        }
        const ok = await self.iosAppOpen(surfaceEl, icon || iconEl, opts);
        if (!ok) return false;
        // If a close started while we were opening, honour the later flag
        if (!open) return self.iosAppClose(surfaceEl, icon || iconEl, opts);
        return true;
      },
      close: async (icon = iconEl) => {
        open = false;
        return self.iosAppClose(surfaceEl, icon || iconEl, opts);
      },
      /** Toggle with no await lock — safe to spam. */
      toggle: async (icon = iconEl) => {
        if (open) return self.iosAppClose(surfaceEl, icon || iconEl, opts).then((r) => { open = false; return r; });
        open = true;
        if (surfaceEl) {
          surfaceEl.hidden = false;
          surfaceEl.style.visibility = 'visible';
          surfaceEl.style.pointerEvents = 'auto';
        }
        return self.iosAppOpen(surfaceEl, icon || iconEl, opts);
      },
    };
  },

  /** List every recipe name (for demos / docs). */
  listRecipes() {
    return {
      spring: Object.keys(this.recipes),
      cssOnly: [...this.CSS_ONLY_RECIPES],
      signature: [
        'iosCardTransition', 'iosCardOpen', 'iosCardClose',
        'iosAppOpen', 'iosAppClose', 'appIconTransition',
        'connectionOpen', 'connectionClose',
        'islandExpand', 'islandCollapse', 'islandDots', 'islandSquish', 'islandSize',
        'macPanel', 'macPanelOpen', 'macPanelClose',
        'shelf', 'toastPush', 'toastDismiss',
        'dockMagnify', 'dockMagnifyPointer', 'dockMagnifyVerticalPointer', 'dockMagnifyReset',
        'aiPanelOpen', 'aiPanelClose', 'clipInset',
        'stretchExpand',
      ],
    };
  },

  /**
   * Bottom-anchored vertical fill driven by the Go spring engine
   * (StandardStretchExpandOpen/Close). Open and close share the same critical
   * spring so mid-flight reverse is continuous — no CSS transition.
   *
   *   Motion.stretchExpand(el, { open: true, fromRect, toHeight, radiusFrom, radiusTo })
   *   Motion.stretchExpand(el, { open: false, fromRect, toHeight, radiusFrom, radiusTo })
   *
   * Geometry: bottom edge fixed, only height + radius spring. Interruptible:
   * a second call retargets from the live presentation height/radius.
   */
  async stretchExpand(el, opts = {}) {
    if (!el) return false;
    // Ensure engine (wasm preferred) is ready before allocating slots.
    try { await this.init({ capacity: 256 }); } catch { /* use whatever is live */ }

    const token = this._bump(el);
    const open = opts.open !== false;
    const standard = open
      ? (MOTION_STANDARDS.stretchExpandOpen ?? 7)
      : (MOTION_STANDARDS.stretchExpandClose ?? 8);
    const vh = Number(opts.viewportHeight)
      || Math.max(
        (typeof window !== 'undefined' ? window.innerHeight : 0) || 0,
        (typeof document !== 'undefined' ? document.documentElement?.clientHeight : 0) || 0,
        1,
      );
    const live = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 };
    const fromRect = opts.fromRect || live;
    // Vertical-only fill (reference HTML): always full viewport width.
    // NEVER animate left/width — that caused a one-frame horizontal flash when
    // settling into custom-fullscreen (inset:0 / 100vw).
    const fullBleedX = opts.fullBleedX !== false;
    const pinBottom = Number.isFinite(Number(opts.pinBottom))
      ? Math.max(0, Number(opts.pinBottom))
      : 0; // bottom edge glued to viewport bottom; only the top edge moves
    // Explicit from→to heights. Open: collapsed→viewport. Close: full→collapsed.
    const measuredH = Math.max(1, Number(fromRect.height) || live.height || el.offsetHeight || 1);
    const startH = Math.max(1, Number(opts.fromHeight) || measuredH);
    const endH = Math.max(1, Number(opts.toHeight) || (open ? Math.max(startH, vh - pinBottom) : startH));
    const radiusFrom = Number.isFinite(Number(opts.radiusFrom))
      ? Number(opts.radiusFrom)
      : (open ? 18 : 0);
    const radiusTo = Number.isFinite(Number(opts.radiusTo))
      ? Number(opts.radiusTo)
      : (open ? 0 : 18);

    // Pin bottom edge; only height + radius spring. No horizontal motion.
    el.style.position = 'fixed';
    if (fullBleedX) {
      el.style.left = '0';
      el.style.right = '0';
      el.style.width = '100vw';
    } else {
      const left = Number.isFinite(Number(opts.left)) ? Number(opts.left) : (Number(fromRect.left) || live.left || 0);
      const width = Number.isFinite(Number(opts.width))
        ? Number(opts.width)
        : Math.max(1, Number(fromRect.width) || live.width || el.offsetWidth || 1);
      el.style.left = `${left}px`;
      el.style.width = `${width}px`;
      el.style.right = 'auto';
    }
    el.style.top = 'auto';
    el.style.bottom = `${pinBottom}px`;
    el.style.maxHeight = 'none';
    el.style.minHeight = '0';
    el.style.zIndex = String(opts.zIndex || 1000);
    el.style.willChange = 'height, border-radius';
    el.style.overflow = el.style.overflow || 'hidden';
    el.style.boxSizing = 'border-box';
    // Kill host CSS transitions so radius/height aren't double-driven.
    el.style.transition = 'none';

    const animating = this.isAnimating(el);
    const liveH = animating && Number.isFinite(this.value(el, 'h'))
      ? Math.max(1, this.value(el, 'h'))
      : startH;
    const liveR = animating && Number.isFinite(this.value(el, 'radius'))
      ? this.value(el, 'radius')
      : radiusFrom;

    // Seed only when idle so interrupt keeps live velocity.
    if (!animating) {
      this.set(el, { h: liveH, radius: liveR });
    }

    // Go-owned standard (wasm configureStandard); JS fallback uses STANDARD_FALLBACKS.
    await this.to(el, { h: endH, radius: radiusTo }, {
      standard,
      delay: opts.delay ?? 0,
    });

    if (this._genOf(el) !== token) return false;
    if (opts.release !== false) {
      this.release(el);
      if (opts.clearInline !== false) {
        for (const prop of ['position', 'left', 'width', 'right', 'top', 'bottom', 'zIndex', 'willChange', 'maxHeight', 'minHeight', 'overflow', 'boxSizing', 'height', 'borderRadius', 'transition']) {
          el.style[prop] = '';
        }
      }
    }
    return this._genOf(el) === token;
  },

  // ── clip-path inset (liquid island / progressive reveal) ───────────────

  /**
   * Animate clip-path: inset(top% right% bottom% left% round Rpx).
   * Mirrors production terminalIslandFluidOpen clip evolution.
   *
   *   Motion.clipInset(el, { top:0, right:0, bottom:0, left:0, round:22 })
   *   Motion.clipInset(el, { top:0, right:44, bottom:86, left:44, round:999 }) // pill mask
   */
  clipInset(el, opts = {}) {
    if (!el) return Promise.resolve();
    const props = {};
    if (opts.top != null) props.clipTop = Number(opts.top);
    if (opts.right != null) props.clipRight = Number(opts.right);
    if (opts.bottom != null) props.clipBottom = Number(opts.bottom);
    if (opts.left != null) props.clipLeft = Number(opts.left);
    if (opts.round != null) props.clipRound = Number(opts.round);
    // aliases
    if (opts.t != null) props.clipTop = Number(opts.t);
    if (opts.r != null) props.clipRight = Number(opts.r);
    if (opts.b != null) props.clipBottom = Number(opts.b);
    if (opts.l != null) props.clipLeft = Number(opts.l);
    if (opts.radius != null) props.clipRound = Number(opts.radius);
    if (!Object.keys(props).length) return Promise.resolve();
    if (opts.immediate) {
      this.set(el, props);
      return Promise.resolve();
    }
    return this.to(el, props, {
      preset: opts.preset ?? 'island',
      delay: opts.delay ?? 0,
    });
  },

  // ── Dynamic Island size vars (production --island-w / --island-h) ──────

  /**
   * Spring --island-w / --island-h (and optional fluid scales) on a grip/panel.
   * Matches production CSS variable island morph without keyframes.
   *
   *   Motion.islandSize(grip, { w: 214, h: 34, preset: 'island' })
   */
  islandSize(el, opts = {}) {
    if (!el) return Promise.resolve();
    const props = {};
    const units = {
      '--island-w': 'px',
      '--island-h': 'px',
      '--island-fluid-blur': 'px',
      '--island-dot-spread': 'px',
    };
    if (opts.w != null) props['--island-w'] = Number(opts.w);
    if (opts.h != null) props['--island-h'] = Number(opts.h);
    if (opts.fluidScaleX != null) props['--island-fluid-scale-x'] = Number(opts.fluidScaleX);
    if (opts.fluidScaleY != null) props['--island-fluid-scale-y'] = Number(opts.fluidScaleY);
    if (opts.fluidBlur != null) props['--island-fluid-blur'] = Number(opts.fluidBlur);
    if (opts.dotSpread != null) props['--island-dot-spread'] = Number(opts.dotSpread);
    if (opts.dotScale != null) props['--island-dot-scale'] = Number(opts.dotScale);
    if (opts.dotOpacity != null) props['--island-dot-opacity'] = Number(opts.dotOpacity);
    return this.cssVars(el, props, {
      units,
      preset: opts.preset ?? 'island',
      immediate: !!opts.immediate,
      delay: opts.delay ?? 0,
    });
  },

  // ── Dock magnification (production --dock-scale/lift/shift/rotate/blur) ─

  /**
   * Set one dock item's CSS vars via springs (full 5-channel).
   * Production: transform: translate3d(shift, lift, 0) scale(scale) rotateZ(rotate)
   *             filter: blur(dock-blur)
   *
   *   Motion.dockMagnify(item, { scale:1.2, lift:-12, shift:4, rotate:-1, blur:0 })
   */
  dockMagnify(el, opts = {}) {
    if (!el) return Promise.resolve();
    const props = {};
    const units = {
      '--dock-lift': 'px',
      '--dock-shift': 'px',
      '--dock-rotate': 'deg',
      '--dock-blur': 'px',
    };
    if (opts.scale != null) props['--dock-scale'] = Number(opts.scale);
    if (opts.lift != null) props['--dock-lift'] = Number(opts.lift);
    if (opts.shift != null) props['--dock-shift'] = Number(opts.shift);
    if (opts.rotate != null) props['--dock-rotate'] = Number(opts.rotate);
    if (opts.blur != null) props['--dock-blur'] = Number(opts.blur);
    return this.cssVars(el, props, {
      units,
      preset: opts.preset ?? 'dock',
      immediate: !!opts.immediate,
    });
  },

  /**
   * Pointer-driven HORIZONTAL dock magnification (macOS bottom dock).
   * CSS: transform: translate3d(shift, lift, 0) scale()  with origin 50% 100%.
   *   lift = up (negative Y), shift = neighbor push along X.
   *
   * Vertical rails MUST use dockMagnifyVerticalPointer — different axis mapping
   * and transform-origin (center). Do not pass vertical:true here for production.
   */
  dockMagnifyPointer(dockEl, clientX, clientY, opts = {}) {
    if (!dockEl) return;
    // Explicit vertical route — keep one entry point for demos that pass vertical:true
    if (opts.vertical) {
      return this.dockMagnifyVerticalPointer(dockEl, clientX, clientY, opts);
    }
    const sel = opts.itemSelector || '.smartbar-session, .smartbar-add, [data-dock-item]';
    const items = [...dockEl.querySelectorAll(sel)];
    if (!items.length) return;
    const influence = Number(opts.influence) || 142;
    const maxScale = Number(opts.maxScale) || 1.26;
    const maxLift = Number(opts.maxLift) || 15;
    const maxShift = Number(opts.maxShift) || 8;
    const maxRotate = Number(opts.maxRotate) || 0.7;
    const maxBlur = Number(opts.maxBlur) || 0.14;
    const pointer = clientX ?? 0;

    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const d = Math.abs(pointer - center);
      const t = Math.max(0, 1 - d / influence);
      const eased = 1 - Math.pow(1 - t, 3);
      const dir = Math.sign(center - pointer) || 0;
      this.dockMagnify(item, {
        scale: 1 + eased * (maxScale - 1),
        lift: -eased * maxLift,
        shift: dir * eased * maxShift,
        rotate: dir * eased * -maxRotate,
        blur: (1 - eased) * maxBlur,
        preset: opts.preset ?? 'dock',
      });
    });
  },

  /**
   * Pointer-driven VERTICAL dock magnification (edge rail column).
   * Same spring feel as horizontal, axes remapped for a column:
   *
   *   Horizontal: lift = float UP (−Y);  shift = neighbor push LEFT/RIGHT (X)
   *   Vertical:   lift = float UP (−Y) + neighbor push UP/DOWN (Y);
   *               shift = 0  (no side pop — user wants 上浮, not 侧向弹出)
   *
   * Horizontal "left/right neighbor" becomes vertical "up/down neighbor" on Y.
   * The shared "float up" stays −Y (same as bottom dock).
   *
   *   Motion.dockMagnifyVerticalPointer(dock, x, y, {
   *     maxScale: 1.22, maxLift: 12, maxSpread: 8
   *   })
   */
  dockMagnifyVerticalPointer(dockEl, clientX, clientY, opts = {}) {
    if (!dockEl) return;
    const sel = opts.itemSelector || '.smartbar-session, .smartbar-add, [data-dock-item]';
    const items = [...dockEl.querySelectorAll(sel)];
    if (!items.length) return;
    const influence = Number(opts.influence) || 110;
    const maxScale = Number(opts.maxScale) || 1.22;
    // 上浮：与横栏同向（负 Y）
    const maxLift = Number.isFinite(Number(opts.maxLift)) ? Number(opts.maxLift) : 12;
    // 上下推邻：对应横栏左右 shift
    const maxSpread = Number.isFinite(Number(opts.maxSpread))
      ? Number(opts.maxSpread)
      : (Number.isFinite(Number(opts.maxShift)) ? Number(opts.maxShift) : 8);
    const maxRotate = Number(opts.maxRotate) || 0.7;
    const maxBlur = Number(opts.maxBlur) || 0.12;
    const pointer = clientY ?? 0;
    const dockRect = dockEl.getBoundingClientRect();
    const scrollTop = dockEl.scrollTop || 0;

    items.forEach((item) => {
      // Layout-stable Y center via offsetTop relative to dock content
      // (avoids getBoundingClientRect chasing live spring transforms).
      let topInDock = 0;
      let n = item;
      while (n && n !== dockEl) {
        topInDock += n.offsetTop || 0;
        n = n.parentElement;
        if (!n || !dockEl.contains(n)) break;
      }
      const center = (n === dockEl || item.parentElement === dockEl)
        ? dockRect.top + (item.parentElement === dockEl ? item.offsetTop : topInDock)
          + (item.offsetHeight || 0) / 2 - scrollTop
        : (() => { const r = item.getBoundingClientRect(); return r.top + r.height / 2; })();
      const d = Math.abs(pointer - center);
      const t = Math.max(0, 1 - d / influence);
      const eased = 1 - Math.pow(1 - t, 3);
      const dir = Math.sign(center - pointer) || 0;
      this.dockMagnify(item, {
        scale: 1 + eased * (maxScale - 1),
        // 上浮（−Y）+ 上下推邻（dir·Y）——横栏 lift/shift 的纵向对应
        lift: -eased * maxLift + dir * eased * maxSpread,
        shift: 0,
        rotate: dir * eased * -maxRotate,
        blur: (1 - eased) * maxBlur,
        preset: opts.preset ?? 'dock',
      });
    });
  },

  /**
   * Reset all dock items to rest (scale 1, lift 0…).
   */
  dockMagnifyReset(dockEl, opts = {}) {
    if (!dockEl) return Promise.resolve();
    const sel = opts.itemSelector || '.smartbar-session, .smartbar-add, [data-dock-item]';
    const items = [...dockEl.querySelectorAll(sel)];
    return Promise.all(items.map((item) => this.dockMagnify(item, {
      scale: 1, lift: 0, shift: 0, rotate: 0, blur: 0,
      preset: opts.preset ?? 'snappy',
    })));
  },

  // ── AI assistant panel semantic API (no legacy CSS/keyframe dependency) ─

  /**
   * AI panel open — product name for openAiAssistantPanel wiring.
   * FLIP from trigger button (continuous surface), content rides with panel.
   *
   *   Motion.aiPanelOpen(panel, triggerBtn, { contentEl })
   */
  async aiPanelOpen(panel, trigger = null, opts = {}) {
    if (!panel) return false;
    const contentEl = opts.contentEl
      || panel.querySelector?.('.ai-agent-window')
      || null;
    if (trigger) {
      return this.macPanel(panel, trigger, {
        open: true,
        mode: opts.mode || 'flip',
        hideSource: false,
        // Content stays with the growing surface (readable expand).
        contentEl,
        contentWithPanel: opts.contentWithPanel !== false,
        preset: opts.preset ?? 'mac',
        radiusTo: opts.radiusTo,
        ...opts,
        // Force after spread so callers cannot accidentally blank contentEl.
        contentEl,
        contentWithPanel: opts.contentWithPanel !== false,
      });
    }
    panel.hidden = false;
    panel.style.visibility = 'visible';
    panel.style.display = panel.style.display === 'none' ? 'flex' : (panel.style.display || 'flex');
    return this.present(panel, {
      from: { opacity: 0, scale: opts.fromScale ?? 0.96, y: opts.travel ?? 8, x: 0 },
      preset: opts.preset ?? 'mac',
    });
  },

  /**
   * AI panel close — reverse of open without a readable “mini AI window”.
   *
   * Open = opaque FLIP grow from the trigger (content rides along).
   * Close = content/chrome vanish immediately, then the surface FLIPs back to
   * the trigger while fading out. Never reset opacity/transform while still
   * visible (that flash is what looked like a stuck postage-stamp panel).
   */
  async aiPanelClose(panel, trigger = null, opts = {}) {
    if (!panel) return false;
    const token = this._bump(panel);
    const contentEl = opts.contentEl
      || panel.querySelector?.('.ai-agent-window')
      || null;
    const btn = trigger && typeof trigger.getBoundingClientRect === 'function'
      ? trigger
      : null;
    // Measure trigger BEFORE any style changes.
    const btnRect = btn?.getBoundingClientRect?.() || null;
    const preset = opts.preset ?? 'macClose';
    const contentPreset = opts.contentPreset ?? 'contentClose';

    panel.style.pointerEvents = 'none';
    panel.style.overflow = 'hidden';
    panel.style.willChange = 'transform, opacity, filter, border-radius';
    panel.classList.add('ai-panel-motion-closing');

    // 1) Kill readability first — content + traffic light / resize chrome.
    const chrome = [
      contentEl,
      panel.querySelector?.('.panel-drag-handle'),
      ...Array.from(panel.querySelectorAll?.('.panel-resize-handle') || []),
    ].filter(Boolean);
    for (const el of chrome) {
      try {
        this.stop(el);
        this.set(el, { opacity: 0 });
      } catch { /* ignore */ }
      if (el?.style) {
        el.style.opacity = '0';
        el.style.visibility = 'hidden';
      }
    }

    try {
      if (btnRect && btnRect.width > 2 && btnRect.height > 2) {
        const rTo = Number(opts.radiusFrom)
          || Math.min(btnRect.width, btnRect.height) / 2
          || 12;
        // Parallel: geometry shrinks to trigger, surface opacity → 0 (snappy).
        // Two jobs so opacity can finish slightly ahead of geometry.
        await Promise.all([
          this.morphTo(panel, btnRect, {
            preset,
            radiusTo: rTo,
            radiusCompensate: true,
            opacityTo: 0,
            blurTo: 0,
          }),
          this.to(panel, { opacity: 0 }, { preset: 'snappy' }),
        ]);
      } else {
        if (btn) this.setOriginFromAnchor(panel, btn);
        const fromScale = this._clampEnterScale(opts.fromScale ?? 0.94, 0.92);
        await this.to(panel, {
          opacity: 0,
          scale: fromScale,
          y: Number.isFinite(Number(opts.travel)) ? Number(opts.travel) : 6,
          x: 0,
          blur: 0,
        }, { preset });
      }
    } finally {
      this.restoreSources(panel);
      if (btn) this.restoreSource(btn);
    }
    if (this._genOf(panel) !== token) {
      panel.classList.remove('ai-panel-motion-closing');
      return false;
    }

    // 2) Hide BEFORE identity reset — otherwise one frame of full-size / mini panel.
    panel.style.visibility = 'hidden';
    panel.style.pointerEvents = 'none';
    if (opts.thenDisplayNone || opts.thenHide !== false) {
      // Caller may set display:none; keep hidden regardless.
      if (opts.thenDisplayNone) panel.style.display = 'none';
    }

    // 3) Reset channels only while invisible.
    this.stop(panel);
    this.set(panel, {
      x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1,
      opacity: 1, blur: 0, radius: 0,
    });
    for (const el of chrome) {
      try { this.stop(el); this.set(el, { opacity: 1 }); } catch { /* ignore */ }
      if (el?.style) {
        el.style.opacity = '';
        el.style.visibility = '';
      }
    }
    panel.classList.remove('ai-panel-motion-closing');
    panel.style.willChange = '';
    panel.style.overflow = '';
    if (opts.release) this.release(panel);
    return true;
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
