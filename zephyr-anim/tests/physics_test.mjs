/**
 * Node.js unit test for the zephyr-anim WASM physics engine.
 * Tests: spring convergence, interrupt velocity carry-over,
 *        pointer tracker, cubic-bezier sampler.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(__dir, '../target/wasm32-unknown-unknown/release/zephyr_anim.wasm');
const wasmBuf  = readFileSync(wasmPath);

const { instance } = await WebAssembly.instantiate(wasmBuf, {});
const e = instance.exports;

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { console.log('  ✓', label); pass++; }
  else       { console.error('  ✗ FAIL:', label); fail++; }
}
function near(a, b, tol = 1e-4) { return Math.abs(a - b) < tol; }

// ── 1. Engine init ─────────────────────────────────────────────────────────
console.log('\n[1] Engine init');
e.engine_init(64);
assert('capacity = 64', e.engine_capacity() === 64);
const ptr = e.engine_buffer_ptr();
const len = e.engine_buffer_len();
assert('buffer ptr non-null', ptr > 0);
assert('buffer len = 192', len === 192); // 64 * 3

// ── 2. Spring converges to target ─────────────────────────────────────────
console.log('\n[2] Spring convergence (snappy: k=300, c=28, m=1)');
e.engine_configure(0, 300, 28, 1.0);
e.engine_set_value(0, 0.0);
e.engine_animate_to(0, 100.0);

let buf = new Float64Array(instance.exports.memory.buffer, ptr, len);
let steps = 0;
for (let t = 0; t < 3.0; t += 1/120) {
  const active = e.engine_tick(1/120);
  steps++;
  buf = new Float64Array(instance.exports.memory.buffer, ptr, len);
  if (active === 0) break;
}
const finalVal = buf[0]; // id=0, value
assert(`converges to 100 (got ${finalVal.toFixed(4)})`, near(finalVal, 100.0, 0.01));
assert('active=0 at rest', e.engine_is_active(0) === 0);
console.log(`  ticks to settle: ${steps}`);

// ── 3. Interrupt carries velocity ─────────────────────────────────────────
console.log('\n[3] Interrupt velocity carry-over');
e.engine_configure(1, 300, 28, 1.0);
e.engine_set_value(1, 0.0);
e.engine_animate_to(1, 50.0);
// Advance a few frames — spring is mid-flight
for (let i = 0; i < 10; i++) e.engine_tick(1/60);
const velBefore = e.engine_get_velocity(1);
const valBefore = e.engine_get_value(1);
// Interrupt: redirect to different target
e.engine_animate_to(1, 200.0);
// velocity should be inherited — immediately after redirect, velocity same sign (not zero)
const velAfter = e.engine_get_velocity(1);
assert(`velocity not zeroed on interrupt (${velBefore.toFixed(2)} → ${velAfter.toFixed(2)})`,
  Math.abs(velAfter) > 0.1);

// ── 4. Flick (inject velocity) ─────────────────────────────────────────────
console.log('\n[4] flick_to — injected velocity');
e.engine_configure(2, 300, 28, 1.0);
e.engine_set_value(2, 0.0);
e.engine_flick_to(2, 100.0, 500.0);  // high velocity push
// After 1 frame the value should be above what a zero-velocity start gives
e.engine_tick(1/120);
const flickVal = e.engine_get_value(2);
// A zero-velocity spring at k=300 covers ~2.5px in 1/120s; with v=500 it covers more
assert(`flick injected velocity moves element (${flickVal.toFixed(3)} > 2)`, flickVal > 2.0);

// ── 5. set_value teleport ──────────────────────────────────────────────────
console.log('\n[5] set_value teleport');
e.engine_set_value(3, 42.5);
assert('teleport value correct', near(e.engine_get_value(3), 42.5));
assert('teleport leaves spring inactive', e.engine_is_active(3) === 0);

// ── 6. stop() ─────────────────────────────────────────────────────────────
console.log('\n[6] stop()');
e.engine_configure(4, 300, 28, 1.0);
e.engine_set_value(4, 0.0);
e.engine_animate_to(4, 100.0);
e.engine_tick(1/60);
assert('active before stop', e.engine_is_active(4) === 1);
e.engine_stop(4);
assert('inactive after stop', e.engine_is_active(4) === 0);

// ── 7. Bouncy preset — overshoot ──────────────────────────────────────────
console.log('\n[7] Bouncy spring overshoots target');
e.engine_configure(5, 380, 18, 1.0);
e.engine_set_value(5, 0.0);
e.engine_animate_to(5, 100.0);
let maxVal = 0;
for (let i = 0; i < 240; i++) {
  e.engine_tick(1/120);
  const v = e.engine_get_value(5);
  if (v > maxVal) maxVal = v;
}
assert(`bouncy overshoots > 100 (max=${maxVal.toFixed(2)})`, maxVal > 100.5);

// ── 8. dt clamp (tab suspension survival) ─────────────────────────────────
console.log('\n[8] Large dt clamped (tab suspension)');
e.engine_configure(6, 300, 28, 1.0);
e.engine_set_value(6, 0.0);
e.engine_animate_to(6, 100.0);
e.engine_tick(999.0);  // simulate 1000s of tab suspension — should not NaN/explode
const afterSuspend = e.engine_get_value(6);
assert(`value valid after huge dt (${afterSuspend.toFixed(4)})`,
  Number.isFinite(afterSuspend) && !Number.isNaN(afterSuspend));

// ── 9. Pointer tracker ────────────────────────────────────────────────────
console.log('\n[9] Pointer tracker velocity');
e.tracker_init(0);
// Simulate pointer moving at 300 px/s over 100ms
for (let i = 0; i < 10; i++) {
  e.tracker_push(0, i * 10.0, i * 3.0, i * 3.0);
}
const vx = e.tracker_velocity_x(0);
const vy = e.tracker_velocity_y(0);
// Velocity should be ~300 px/s (300 px / 1s)
assert(`tracker vx ≈ 300 (got ${vx.toFixed(1)})`, near(vx, 300, 20));
assert(`tracker vy ≈ 300 (got ${vy.toFixed(1)})`, near(vy, 300, 20));
e.tracker_clear(0);
assert('cleared → vx=0', near(e.tracker_velocity_x(0), 0, 1));

// ── 10. cubic_bezier_sample ───────────────────────────────────────────────
console.log('\n[10] cubic_bezier_sample');
// Linear ease: bezier(0,0, 1,1) — at t=0.5 → 0.5
const linAt05 = e.cubic_bezier_sample(0, 0, 1, 1, 0.5);
assert(`linear at t=0.5 ≈ 0.5 (${linAt05.toFixed(4)})`, near(linAt05, 0.5, 0.01));
// ease-out: bezier(0,0, 0.58,1) — at t=0.5 progress should be > 0.5
const easeOutAt05 = e.cubic_bezier_sample(0, 0, 0.58, 1.0, 0.5);
assert(`ease-out at t=0.5 > 0.5 (${easeOutAt05.toFixed(4)})`, easeOutAt05 > 0.5);
// Bounds
assert('t=0 → 0', near(e.cubic_bezier_sample(0.42, 0, 0.58, 1, 0), 0, 0.001));
assert('t=1 → 1', near(e.cubic_bezier_sample(0.42, 0, 0.58, 1, 1), 1, 0.001));

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
