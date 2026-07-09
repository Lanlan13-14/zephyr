/*!
 * zephyr-anim — Apple-grade animation physics engine
 *
 * Physics: closed-form underdamped/critical/overdamped spring
 *   identical to CASpringAnimation.  No Euler integration → stable at 120 Hz.
 *
 * ABI: plain #[no_mangle] extern "C" with primitive types only.
 *      Zero extra dependencies; works with wasm32-unknown-unknown + std.
 *
 * Memory layout of output buffer (Float64Array on JS side):
 *   [ value₀, velocity₀, active₀,  value₁, velocity₁, active₁, … ]
 *   stride = 3.  active is 1.0 while animating, 0.0 at rest.
 */

use std::cell::UnsafeCell;

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_SPRINGS: usize = 256;
const REST_X:      f64   = 1e-5;
const REST_V:      f64   = 1e-5;
const BUF_STRIDE:  usize = 3;
const TRACKER_CAP: usize = 32;
const TRACKER_WIN: f64   = 100.0; // ms

// ─── Closed-form spring solver ───────────────────────────────────────────────
#[derive(Clone, Copy, Default)]
struct Solver {
    omega0: f64,
    zeta:   f64,
    x0:     f64,   // initial displacement (current - target)
    v0:     f64,   // initial velocity
}

impl Solver {
    fn new(k: f64, c: f64, m: f64) -> Self {
        let k = k.max(0.01);
        let m = m.max(0.001);
        let c = c.max(0.0);
        let omega0 = (k / m).sqrt();
        let zeta   = c / (2.0 * (k * m).sqrt());
        Solver { omega0, zeta, x0: 0.0, v0: 0.0 }
    }

    /// Returns (displacement_from_target, velocity) at time t seconds.
    #[inline]
    fn eval(&self, t: f64) -> (f64, f64) {
        let (o, z, x0, v0) = (self.omega0, self.zeta, self.x0, self.v0);
        if z < 1.0 - 1e-6 {
            // Underdamped — oscillates, decays exponentially
            let wd    = o * (1.0 - z * z).sqrt();
            let decay = (-z * o * t).exp();
            let c1    = x0;
            let c2    = (v0 + z * o * x0) / wd;
            let cos_t = (wd * t).cos();
            let sin_t = (wd * t).sin();
            let x  =  decay * (c1 * cos_t + c2 * sin_t);
            let dx = -z * o * decay * (c1 * cos_t + c2 * sin_t)
                   + decay * wd * (-c1 * sin_t + c2 * cos_t);
            (x, dx)
        } else if z > 1.0 + 1e-6 {
            // Overdamped — two distinct real roots
            let sq = (z * z - 1.0).sqrt();
            let r1 = -o * (z - sq);
            let r2 = -o * (z + sq);
            let c1 = (v0 - r2 * x0) / (r1 - r2);
            let c2 = (r1 * x0 - v0) / (r1 - r2);
            let x  = c1 * (r1 * t).exp() + c2 * (r2 * t).exp();
            let dx = c1 * r1 * (r1 * t).exp() + c2 * r2 * (r2 * t).exp();
            (x, dx)
        } else {
            // Critically damped
            let decay = (-o * t).exp();
            let c2 = v0 + o * x0;
            let x  = (x0 + c2 * t) * decay;
            let dx = (c2 - o * (x0 + c2 * t)) * decay;
            (x, dx)
        }
    }
}

// ─── Slot ────────────────────────────────────────────────────────────────────
#[derive(Clone, Copy)]
struct Slot {
    stiffness: f64,
    damping:   f64,
    mass:      f64,
    active:    bool,
    t:         f64,
    target:    f64,
    value:     f64,
    velocity:  f64,
    solver:    Solver,
}

impl Slot {
    const fn new() -> Self {
        Slot {
            stiffness: 300.0,
            damping:   28.0,
            mass:      1.0,
            active:    false,
            t:         0.0,
            target:    0.0,
            value:     0.0,
            velocity:  0.0,
            solver:    Solver { omega0: 0.0, zeta: 0.0, x0: 0.0, v0: 0.0 },
        }
    }
}

// ─── Engine ──────────────────────────────────────────────────────────────────
struct Engine {
    slots: Vec<Slot>,
    buf:   Vec<f64>,
}

impl Engine {
    fn new(cap: usize) -> Self {
        let cap = cap.clamp(1, MAX_SPRINGS);
        Engine {
            slots: vec![Slot::new(); cap],
            buf:   vec![0.0; cap * BUF_STRIDE],
        }
    }

    fn configure(&mut self, id: usize, k: f64, c: f64, m: f64) {
        if let Some(s) = self.slots.get_mut(id) {
            s.stiffness = k.max(0.01);
            s.damping   = c.max(0.0);
            s.mass      = m.max(0.001);
        }
    }

    fn animate_to(&mut self, id: usize, target: f64, inject_vel: Option<f64>) {
        if let Some(slot) = self.slots.get_mut(id) {
            let vel = inject_vel.unwrap_or(slot.velocity);
            let mut solver = Solver::new(slot.stiffness, slot.damping, slot.mass);
            solver.x0 = slot.value - target;
            solver.v0 = vel;
            slot.solver   = solver;
            slot.target   = target;
            slot.t        = 0.0;
            slot.active   = true;
        }
    }

    fn set_value(&mut self, id: usize, value: f64) {
        if let Some(s) = self.slots.get_mut(id) {
            s.active   = false;
            s.value    = value;
            s.velocity = 0.0;
            s.t        = 0.0;
        }
    }

    fn stop(&mut self, id: usize) {
        if let Some(s) = self.slots.get_mut(id) {
            s.active   = false;
            s.velocity = 0.0;
        }
    }

    fn tick(&mut self, dt: f64) -> u32 {
        let dt = dt.min(0.1); // survive tab suspension
        let mut count = 0u32;
        for (i, slot) in self.slots.iter_mut().enumerate() {
            let base = i * BUF_STRIDE;
            if !slot.active {
                self.buf[base]     = slot.value;
                self.buf[base + 1] = 0.0;
                self.buf[base + 2] = 0.0;
                continue;
            }
            slot.t += dt;
            let (x, v) = slot.solver.eval(slot.t);
            let at_rest = x.abs() < REST_X && v.abs() < REST_V;
            slot.value    = if at_rest { slot.target } else { slot.target + x };
            slot.velocity = if at_rest { 0.0 } else { v };
            if at_rest { slot.active = false; } else { count += 1; }
            self.buf[base]     = slot.value;
            self.buf[base + 1] = slot.velocity;
            self.buf[base + 2] = if at_rest { 0.0 } else { 1.0 };
        }
        count
    }
}

// ─── Pointer velocity tracker ─────────────────────────────────────────────────
struct Tracker {
    buf:  [(f64, f64, f64); TRACKER_CAP], // (t_ms, x, y)
    head: usize,
    len:  usize,
}

impl Tracker {
    fn new() -> Self {
        Tracker { buf: [(0.0, 0.0, 0.0); TRACKER_CAP], head: 0, len: 0 }
    }

    fn push(&mut self, t: f64, x: f64, y: f64) {
        self.buf[self.head % TRACKER_CAP] = (t, x, y);
        self.head += 1;
        if self.len < TRACKER_CAP { self.len += 1; }
    }

    fn velocity(&self, axis: u8) -> f64 {
        if self.len < 2 { return 0.0; }
        let latest = self.buf[(self.head + TRACKER_CAP - 1) % TRACKER_CAP].0;
        let cutoff = latest - TRACKER_WIN;
        let mut sw = 0.0f64; let mut swt = 0.0; let mut swx = 0.0;
        let mut swxt = 0.0;  let mut swtt = 0.0;
        for i in 0..self.len {
            let s = self.buf[(self.head + TRACKER_CAP - self.len + i) % TRACKER_CAP];
            if s.0 < cutoff { continue; }
            let t = (s.0 - latest) / 1000.0;
            let x = if axis == 0 { s.1 } else { s.2 };
            sw += 1.0; swt += t; swx += x; swxt += x * t; swtt += t * t;
        }
        let d = sw * swtt - swt * swt;
        if d.abs() < 1e-12 { return 0.0; }
        (sw * swxt - swt * swx) / d
    }

    fn clear(&mut self) { self.head = 0; self.len = 0; }
}

// ─── Global singletons (WASM is single-threaded) ─────────────────────────────
struct GlobalState {
    engine:   Option<Engine>,
    trackers: [Option<Tracker>; 4],
}

// WASM target is always single-threaded; Sync is safe here.
struct SyncCell(UnsafeCell<GlobalState>);
unsafe impl Sync for SyncCell {}

static STATE: SyncCell = SyncCell(UnsafeCell::new(GlobalState {
    engine:   None,
    trackers: [None, None, None, None],
}));

#[inline(always)]
unsafe fn state() -> &'static mut GlobalState { &mut *STATE.0.get() }

// ─── Exported C ABI ──────────────────────────────────────────────────────────

#[no_mangle] pub unsafe extern "C" fn engine_init(capacity: u32) {
    state().engine = Some(Engine::new(capacity as usize));
}

#[no_mangle] pub unsafe extern "C" fn engine_buffer_ptr() -> *const f64 {
    state().engine.as_ref().map(|e| e.buf.as_ptr()).unwrap_or(std::ptr::null())
}

#[no_mangle] pub unsafe extern "C" fn engine_buffer_len() -> u32 {
    state().engine.as_ref().map(|e| e.buf.len() as u32).unwrap_or(0)
}

#[no_mangle] pub unsafe extern "C" fn engine_configure(id: u32, k: f64, c: f64, m: f64) {
    if let Some(e) = state().engine.as_mut() { e.configure(id as usize, k, c, m); }
}

#[no_mangle] pub unsafe extern "C" fn engine_animate_to(id: u32, target: f64) {
    if let Some(e) = state().engine.as_mut() { e.animate_to(id as usize, target, None); }
}

#[no_mangle] pub unsafe extern "C" fn engine_flick_to(id: u32, target: f64, vel: f64) {
    if let Some(e) = state().engine.as_mut() { e.animate_to(id as usize, target, Some(vel)); }
}

#[no_mangle] pub unsafe extern "C" fn engine_set_value(id: u32, value: f64) {
    if let Some(e) = state().engine.as_mut() { e.set_value(id as usize, value); }
}

#[no_mangle] pub unsafe extern "C" fn engine_stop(id: u32) {
    if let Some(e) = state().engine.as_mut() { e.stop(id as usize); }
}

#[no_mangle] pub unsafe extern "C" fn engine_tick(dt: f64) -> u32 {
    state().engine.as_mut().map(|e| e.tick(dt)).unwrap_or(0)
}

#[no_mangle] pub unsafe extern "C" fn engine_get_value(id: u32) -> f64 {
    state().engine.as_ref()
        .and_then(|e| e.slots.get(id as usize))
        .map(|s| s.value).unwrap_or(0.0)
}

#[no_mangle] pub unsafe extern "C" fn engine_get_velocity(id: u32) -> f64 {
    state().engine.as_ref()
        .and_then(|e| e.slots.get(id as usize))
        .map(|s| s.velocity).unwrap_or(0.0)
}

#[no_mangle] pub unsafe extern "C" fn engine_is_active(id: u32) -> u32 {
    state().engine.as_ref()
        .and_then(|e| e.slots.get(id as usize))
        .map(|s| s.active as u32).unwrap_or(0)
}

#[no_mangle] pub unsafe extern "C" fn engine_capacity() -> u32 {
    state().engine.as_ref().map(|e| e.slots.len() as u32).unwrap_or(0)
}

// Tracker
#[no_mangle] pub unsafe extern "C" fn tracker_init(tid: u32) {
    let id = (tid as usize).min(3);
    state().trackers[id] = Some(Tracker::new());
}

#[no_mangle] pub unsafe extern "C" fn tracker_push(tid: u32, t: f64, x: f64, y: f64) {
    let id = (tid as usize).min(3);
    if state().trackers[id].is_none() { state().trackers[id] = Some(Tracker::new()); }
    state().trackers[id].as_mut().unwrap().push(t, x, y);
}

#[no_mangle] pub unsafe extern "C" fn tracker_velocity_x(tid: u32) -> f64 {
    state().trackers[(tid as usize).min(3)].as_ref().map(|t| t.velocity(0)).unwrap_or(0.0)
}

#[no_mangle] pub unsafe extern "C" fn tracker_velocity_y(tid: u32) -> f64 {
    state().trackers[(tid as usize).min(3)].as_ref().map(|t| t.velocity(1)).unwrap_or(0.0)
}

#[no_mangle] pub unsafe extern "C" fn tracker_clear(tid: u32) {
    if let Some(t) = state().trackers[(tid as usize).min(3)].as_mut() { t.clear(); }
}

// Cubic Bezier tween (for value-over-duration tweens, not spring)
#[no_mangle] pub extern "C" fn cubic_bezier_sample(
    p1x: f64, p1y: f64, p2x: f64, p2y: f64, t: f64
) -> f64 {
    let t = t.clamp(0.0, 1.0);
    let cx = 3.0 * p1x; let bx = 3.0 * (p2x - p1x) - cx; let ax = 1.0 - cx - bx;
    let cy = 3.0 * p1y; let by = 3.0 * (p2y - p1y) - cy; let ay = 1.0 - cy - by;
    let bx_ = |u: f64| ((ax * u + bx) * u + cx) * u;
    let bxp  = |u: f64| (3.0 * ax * u + 2.0 * bx) * u + cx;
    let by_  = |u: f64| ((ay * u + by) * u + cy) * u;
    let mut u = t;
    for _ in 0..8 {
        let dx = bx_(u) - t;
        if dx.abs() < 1e-7 { break; }
        let d = bxp(u);
        if d.abs() < 1e-10 { break; }
        u -= dx / d;
    }
    by_(u.clamp(0.0, 1.0))
}
