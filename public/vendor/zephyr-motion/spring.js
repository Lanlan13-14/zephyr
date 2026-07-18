/**
 * spring.js — pure-JS mirror of the Go physics core (motion-wasm/motion).
 *
 * Two jobs:
 *   1. Fallback backend for runtime.js when zephyr_motion.wasm is missing
 *      (e.g. a fresh checkout before CI has committed the artifact).
 *   2. Executable documentation of the exact math.
 *
 * Every formula mirrors the Go implementation operation-for-operation so
 * both produce bit-identical float64 results; tests/motion-golden.test.mjs
 * pins them to the same golden vectors (motion-wasm/motion/testdata).
 * Keep this file DOM-free so Node can import it.
 */

export const BUFFER_STRIDE = 3; // [value, velocity, active]
const ZETA_EPS = 1e-9;
const MIN_DAMPING = 0.05;
export const MAX_DT = 0.064;

export class Spring {
  constructor(response = 0.4, damping = 1.0) {
    this.value = 0;
    this.velocity = 0;
    this.target = 0;
    this.active = false;
    this.delay = 0;
    this.x0 = 0;
    this.v0 = 0;
    this.t = 0;
    this.configure(response, damping);
  }

  configure(response, damping) {
    if (response <= 0) {
      this.instant = true;
      this.omega = 0;
      this.zeta = 1;
      return;
    }
    if (damping < MIN_DAMPING) damping = MIN_DAMPING;
    this.instant = false;
    this.omega = 2 * Math.PI / response;
    this.zeta = damping;
  }

  _rebase(newTarget) {
    if (this.active && this.delay <= 0 && this.t > 0) {
      const [x, v] = this._eval(this.t);
      this.value = x;
      this.velocity = v;
    }
    this.target = newTarget;
    this.x0 = this.value - newTarget;
    this.v0 = this.velocity;
    this.t = 0;
    this.delay = 0;
  }

  setTarget(target) {
    this._rebase(target);
    if (this.instant) {
      this.value = target;
      this.velocity = 0;
      this.active = false;
      return;
    }
    this.active = true;
  }

  setTargetDelayed(target, delay) {
    if (delay <= 0) return this.setTarget(target);
    this._rebase(target);
    this.velocity = 0;
    this.v0 = 0;
    this.delay = delay;
    this.active = true;
  }

  flick(target, velocity) {
    this._rebase(target);
    this.velocity = velocity;
    this.v0 = velocity;
    if (this.instant) {
      this.value = target;
      this.velocity = 0;
      this.active = false;
      return;
    }
    this.active = true;
  }

  set(value) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.x0 = 0;
    this.v0 = 0;
    this.t = 0;
    this.active = false;
    this.delay = 0;
  }

  stop() {
    this._rebase(this.value);
    this.velocity = 0;
    this.v0 = 0;
    this.active = false;
    this.delay = 0;
  }

  advance(dt) {
    if (!this.active) return [this.value, this.velocity];
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return [this.value, this.velocity];
      this.x0 = this.value - this.target;
      this.v0 = 0;
      this.t = 0;
      if (this.instant) {
        this.value = this.target;
        this.velocity = 0;
        this.active = false;
        return [this.value, this.velocity];
      }
    }
    if (dt > MAX_DT) dt = MAX_DT;
    this.t += dt;
    const [x, v] = this._eval(this.t);
    this.value = x;
    this.velocity = v;
    return [x, v];
  }

  _eval(t) {
    const a = this.x0;
    const w = this.omega;
    const z = this.zeta;
    if (z < 1 - ZETA_EPS) {
      const wd = w * Math.sqrt(1 - z * z);
      const b = (this.v0 + z * w * a) / wd;
      const e = Math.exp(-z * w * t);
      const cosT = Math.cos(wd * t), sinT = Math.sin(wd * t);
      const x = this.target + e * (a * cosT + b * sinT);
      const v = e * (-z * w) * (a * cosT + b * sinT) + e * wd * (b * cosT - a * sinT);
      return [x, v];
    }
    if (z > 1 + ZETA_EPS) {
      const r = w * Math.sqrt(z * z - 1);
      const r1 = -z * w + r;
      const r2 = -z * w - r;
      const c2 = (this.v0 - r1 * a) / (r2 - r1);
      const c1 = a - c2;
      const e1 = Math.exp(r1 * t), e2 = Math.exp(r2 * t);
      const x = this.target + c1 * e1 + c2 * e2;
      const v = c1 * r1 * e1 + c2 * r2 * e2;
      return [x, v];
    }
    const c1 = a;
    const c2 = this.v0 + w * a;
    const e = Math.exp(-w * t);
    const x = this.target + (c1 + c2 * t) * e;
    const v = (c2 - w * (c1 + c2 * t)) * e;
    return [x, v];
  }

  settled(posEps, velEps) {
    if (!this.active || this.delay > 0) return false;
    return Math.abs(this.value - this.target) <= posEps &&
           Math.abs(this.velocity) <= velEps;
  }

  snapIfSettled(posEps, velEps) {
    if (!this.settled(posEps, velEps)) return false;
    this.value = this.target;
    this.velocity = 0;
    this.x0 = 0;
    this.v0 = 0;
    this.t = 0;
    this.active = false;
    return true;
  }
}

/** Fixed pool of springs + shared frame buffer, same contract as the wasm ABI. */
export class SpringEngine {
  constructor(capacity = 128) {
    this.slots = [];
    for (let i = 0; i < Math.max(1, capacity); i++) this.slots.push(new Spring());
    this.buffer = new Float64Array(this.slots.length * BUFFER_STRIDE);
    this.posEps = 0.01;
    this.velEps = 0.01;
  }

  get capacity() { return this.slots.length; }
  _ok(id) { return id >= 0 && id < this.slots.length; }
  _write(id) {
    const s = this.slots[id];
    const b = id * BUFFER_STRIDE;
    this.buffer[b] = s.value;
    this.buffer[b + 1] = s.velocity;
    this.buffer[b + 2] = s.active ? 1 : 0;
  }

  configure(id, response, damping) { if (this._ok(id)) this.slots[id].configure(response, damping); }
  setEpsilon(posEps, velEps) {
    if (posEps > 0) this.posEps = posEps;
    if (velEps > 0) this.velEps = velEps;
  }
  animateTo(id, target) { if (this._ok(id)) this.slots[id].setTarget(target); }
  animateToDelayed(id, target, delay) { if (this._ok(id)) this.slots[id].setTargetDelayed(target, delay); }
  flickTo(id, target, velocity) { if (this._ok(id)) this.slots[id].flick(target, velocity); }
  setValue(id, value) { if (this._ok(id)) { this.slots[id].set(value); this._write(id); } }
  getValue(id) { return this._ok(id) ? this.slots[id].value : 0; }
  getVelocity(id) { return this._ok(id) ? this.slots[id].velocity : 0; }
  isActive(id) { return this._ok(id) && this.slots[id].active; }
  stop(id) { if (this._ok(id)) { this.slots[id].stop(); this._write(id); } }

  tick(dt) {
    let active = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      s.advance(dt);
      s.snapIfSettled(this.posEps, this.velEps);
      this._write(i);
      if (s.active) active++;
    }
    return active;
  }
}

/** Velocity tracker — mirrors motion-wasm/motion/tracker.go. */
export const TRACKER_SAMPLES = 16;
export const TRACKER_WINDOW = 0.1;
const TRACKER_TAU = TRACKER_WINDOW / 2;

export class VelocityTracker {
  constructor() { this.buf = []; }

  push(t, x, y) {
    this.buf.push({ t, x, y });
    if (this.buf.length > TRACKER_SAMPLES) this.buf.shift();
  }

  clear() { this.buf.length = 0; }

  velocity() {
    const n0 = this.buf.length;
    if (n0 < 2) return [0, 0];
    const tEnd = this.buf[n0 - 1].t;
    let sw = 0, st = 0, sx = 0, sy = 0, n = 0;
    const ws = new Array(n0).fill(0);
    for (let i = 0; i < n0; i++) {
      const s = this.buf[i];
      const dt = tEnd - s.t;
      if (dt < 0 || dt > TRACKER_WINDOW) continue;
      const w = Math.exp(-dt / TRACKER_TAU);
      ws[i] = w;
      sw += w; st += w * s.t; sx += w * s.x; sy += w * s.y;
      n++;
    }
    if (n < 2 || sw === 0) return [0, 0];
    const tbar = st / sw, xbar = sx / sw, ybar = sy / sw;
    let numX = 0, numY = 0, den = 0;
    for (let i = 0; i < n0; i++) {
      const w = ws[i];
      if (w === 0) continue;
      const s = this.buf[i];
      const dt = s.t - tbar;
      numX += w * dt * (s.x - xbar);
      numY += w * dt * (s.y - ybar);
      den += w * dt * dt;
    }
    if (den === 0) return [0, 0];
    return [numX / den, numY / den];
  }
}

/** Apple's momentum projection (Designing Fluid Interfaces sample code). */
export function project(velocity, decelRate = 0.998) {
  if (decelRate <= 0 || decelRate >= 1) return 0;
  return (velocity / 1000) * decelRate / (1 - decelRate);
}

/** Progressive boundary resistance (iOS overscroll feel). */
export function rubberband(overshoot, dimension, constant = 0.55) {
  if (constant <= 0) constant = 0.55;
  if (dimension <= 0) return overshoot;
  const d = Math.abs(overshoot);
  return Math.sign(overshoot) * (d * dimension * constant) / (dimension + constant * d);
}

export function rubberbandClamp(value, min, max, dimension, constant = 0.55) {
  if (value < min) return min + rubberband(value - min, dimension, constant);
  if (value > max) return max + rubberband(value - max, dimension, constant);
  return value;
}

/** CSS cubic-bezier(x1,y1,x2,y2) easing sampler — fallback for non-spring loops. */
export function cubicBezierSample(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bez = (t, p1, p2) => {
    const u = 1 - t;
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
  };
  const bezD = (t, p1, p2) => {
    const u = 1 - t;
    return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
  };
  let t = x;
  for (let i = 0; i < 8; i++) {
    const cx = bez(t, x1, x2) - x;
    if (Math.abs(cx) < 1e-6) return bez(t, y1, y2);
    const d = bezD(t, x1, x2);
    if (Math.abs(d) < 1e-6) break;
    t -= cx / d;
  }
  let lo = 0, hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const cx = bez(t, x1, x2) - x;
    if (Math.abs(cx) < 1e-6) break;
    if (cx > 0) hi = t; else lo = t;
    t = (lo + hi) / 2;
  }
  return bez(t, y1, y2);
}
