/**
 * ABI + behavior tests against the real wasm build (TinyGo artifact or
 * local stdgo build via ZEPHYR_MOTION_WASM). Complements the native Go
 * tests: these verify the export surface, the shared-memory buffer
 * contract, and that the wasm math matches the golden vectors.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadMotionWasm, loadGolden, tickTo, EXPECTED_EXPORTS } from './motion-wasm-harness.mjs';

let wasm = null;

before(async () => {
  wasm = await loadMotionWasm();
});

function needWasm(t) {
  if (!wasm) {
    t.skip('no wasm artifact — build one (scripts/build-motion-wasm.sh --local) or let CI commit it');
    return true;
  }
  return false;
}

test('export surface is complete', t => {
  if (needWasm(t)) return;
  for (const name of EXPECTED_EXPORTS) {
    assert.equal(typeof wasm.exports[name], 'function', `missing export: ${name}`);
  }
});

test('Go-owned iOS card standards configure canonical springs', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(2);
  assert.equal(ex.engine_configure_standard(0, 3), 1, 'iOS card flip-open standard');
  assert.equal(ex.engine_configure_standard(1, 1), 1, 'iOS card geometry-open standard');
  assert.equal(ex.engine_configure_standard(0, 9999), 0, 'unknown standards rejected');
  ex.engine_animate_to(0, -180);
  ex.engine_animate_to(1, 1);
  let minRotation = 0;
  let maxGeometry = 0;
  for (let i = 0; i < 600; i++) {
    ex.engine_tick(1 / 240);
    minRotation = Math.min(minRotation, ex.engine_get_value(0));
    maxGeometry = Math.max(maxGeometry, ex.engine_get_value(1));
  }
  const overshoot = Math.abs(minRotation) - 180;
  assert.ok(overshoot > 0 && overshoot < 1, `sub-degree flip settle, got ${overshoot}`);
  assert.ok(maxGeometry <= 1.000001, `geometry must not overshoot, got ${maxGeometry}`);
});

test('engine init/capacity/buffer contract', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(8);
  assert.equal(ex.engine_capacity(), 8);
  assert.equal(ex.engine_buffer_len(), 8 * 3);
  assert.ok(ex.engine_buffer_ptr() > 0, 'buffer ptr must be non-zero');
});

test('buffer layout: [value, velocity, active] per slot', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(4);
  ex.engine_configure(1, 0.3, 1.0);
  ex.engine_animate_to(1, 50);
  ex.engine_tick(1 / 60);
  const mem = ex.memory ?? ex.mem; // TinyGo: "memory"; stdgo: "mem"
  const buf = new Float64Array(mem.buffer, ex.engine_buffer_ptr(), ex.engine_buffer_len());
  assert.equal(buf[1 * 3 + 2], 1, 'active flag');
  assert.ok(buf[1 * 3] > 0 && buf[1 * 3] < 50, `value in motion, got ${buf[1 * 3]}`);
  assert.ok(buf[1 * 3 + 1] > 0, 'velocity positive');
  assert.equal(buf[0 * 3 + 2], 0, 'slot 0 idle');
});

test('spring settles exactly on target and engine idles', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(2);
  ex.engine_configure(0, 0.4, 1.0);
  ex.engine_animate_to(0, 100);
  let active = 1;
  let frames = 0;
  while (active > 0 && frames < 240) {
    active = ex.engine_tick(1 / 60);
    frames++;
  }
  assert.equal(active, 0, 'engine must sleep');
  assert.ok(frames < 150, `settled too slowly (${frames} frames)`);
  assert.equal(ex.engine_get_value(0), 100);
  assert.equal(ex.engine_get_velocity(0), 0);
});

test('underdamped overshoots, critical does not', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(2);
  ex.engine_configure(0, 0.4, 0.7);
  ex.engine_configure(1, 0.4, 1.0);
  ex.engine_animate_to(0, 100);
  ex.engine_animate_to(1, 100);
  let peak = 0, peakCrit = 0;
  for (let i = 0; i < 240; i++) {
    ex.engine_tick(1 / 240);
    peak = Math.max(peak, ex.engine_get_value(0));
    peakCrit = Math.max(peakCrit, ex.engine_get_value(1));
  }
  assert.ok(peak > 100.5, `underdamped should overshoot, peak=${peak}`);
  assert.ok(peakCrit <= 100.0001, `critical must not overshoot, peak=${peakCrit}`);
});

test('retarget carries velocity (no brick wall)', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(1);
  ex.engine_configure(0, 0.4, 1.0);
  ex.engine_animate_to(0, 100);
  for (let i = 0; i < 12; i++) ex.engine_tick(1 / 60);
  const vBefore = ex.engine_get_velocity(0);
  const xBefore = ex.engine_get_value(0);
  ex.engine_animate_to(0, 500);
  assert.equal(ex.engine_get_velocity(0), vBefore, 'velocity must be identical after retarget');
  assert.equal(ex.engine_get_value(0), xBefore, 'value must not jump on retarget');
  assert.ok(Math.abs(vBefore) > 1, 'spring should actually be moving for this test to mean anything');
});

test('flick hands initial velocity', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(1);
  ex.engine_configure(0, 0.4, 1.0);
  ex.engine_set_value(0, 50);
  ex.engine_flick_to(0, 0, 400);
  assert.equal(ex.engine_get_velocity(0), 400);
  ex.engine_tick(1 / 60);
  assert.ok(ex.engine_get_value(0) > 50, 'must continue in throw direction first');
});

test('delayed animation holds value then starts', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(1);
  ex.engine_configure(0, 0.3, 1.0);
  ex.engine_animate_to_delayed(0, 100, 0.1);
  ex.engine_tick(1 / 60);
  assert.equal(ex.engine_get_value(0), 0, 'must hold during delay');
  assert.equal(ex.engine_is_active(0), 1, 'delayed slot counts active (keeps loop alive)');
  for (let i = 0; i < 240; i++) ex.engine_tick(1 / 60);
  assert.equal(ex.engine_get_value(0), 100);
});

test('set_value is instant and idles the slot', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(1);
  ex.engine_configure(0, 0.5, 0.8);
  ex.engine_set_value(0, 42);
  assert.equal(ex.engine_get_value(0), 42);
  assert.equal(ex.engine_is_active(0), 0);
});

test('velocity tracker: linear and window-following', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  ex.engine_init(1);
  ex.tracker_clear(0);
  for (let i = 0; i <= 8; i++) {
    const tm = i * 0.016;
    ex.tracker_push(0, tm, 1000 * tm, 0);
  }
  assert.ok(Math.abs(ex.tracker_velocity_x(0) - 1000) < 1, `vx=${ex.tracker_velocity_x(0)}`);
  assert.ok(Math.abs(ex.tracker_velocity_y(0)) < 1e-6);
  // Direction change: window must forget the old fast segment.
  ex.tracker_clear(0);
  for (let i = 0; i <= 12; i++) {
    const tm = i * 0.0167;
    const x = tm <= 0.1 ? 10000 * tm : 10000 * 0.1 + 100 * (tm - 0.1);
    ex.tracker_push(0, tm, x, 0);
  }
  assert.ok(Math.abs(ex.tracker_velocity_x(0) - 100) < 30, `vx=${ex.tracker_velocity_x(0)}`);
});

test('project matches Apple formula', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  assert.ok(Math.abs(ex.project(500, 0.998) - 249.5) < 1e-9);
  assert.equal(ex.project(500, 0), 0);
  assert.equal(ex.project(500, 1), 0);
  assert.ok(Math.abs(ex.project(-500, 0.998) + 249.5) < 1e-9);
});

test('rubberband properties', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  assert.equal(ex.rubberband(0, 100, 0.55), 0);
  let prev = 0;
  for (let o = 1; o <= 300; o++) {
    const v = ex.rubberband(o, 100, 0.55);
    assert.ok(v > prev, 'monotonic');
    assert.ok(v < 100, 'bounded by dimension');
    prev = v;
  }
  assert.ok(Math.abs(ex.rubberband(-25, 100, 0.55) + ex.rubberband(25, 100, 0.55)) < 1e-12, 'odd symmetry');
  // clamp variant
  assert.equal(ex.rubberband_clamp(50, 0, 100, 100, 0.55), 50);
  assert.ok(ex.rubberband_clamp(150, 0, 100, 100, 0.55) > 100);
  assert.ok(ex.rubberband_clamp(150, 0, 100, 100, 0.55) < 150);
});

test('cubic_bezier_sample matches CSS expectations', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  assert.ok(Math.abs(ex.cubic_bezier_sample(0.25, 0.1, 0.25, 1, 0.5) - 0.802403) < 1e-3);
  assert.equal(ex.cubic_bezier_sample(0.16, 1, 0.3, 1, 0), 0);
  assert.equal(ex.cubic_bezier_sample(0.16, 1, 0.3, 1, 1), 1);
});

test('golden vectors replay through tick()', t => {
  if (needWasm(t)) return;
  const ex = wasm.exports;
  const vectors = loadGolden();
  ex.engine_init(vectors.length);
  vectors.forEach((v, id) => {
    ex.engine_configure(id, v.response, v.damping);
    ex.engine_set_value(id, v.x0);
    ex.engine_flick_to(id, v.target, v.v0);
  });
  let tAbs = 0;
  const nTimes = vectors[0].times.length;
  for (let j = 0; j < nTimes; j++) {
    const tj = vectors[0].times[j];
    tAbs = tickTo(ex, tAbs, tj);
    vectors.forEach((v, id) => {
      const gotX = ex.engine_get_value(id);
      const gotV = ex.engine_get_velocity(id);
      if (ex.engine_is_active(id) === 0) {
        // Settled: engine snapped to the exact target — golden must simply
        // be within settle range (this asserts the snap, not math drift).
        assert.equal(gotX, v.target, `vector ${id} t=${tj}: settled value must equal target`);
        assert.ok(Math.abs(v.values[j] - v.target) <= 0.05,
          `vector ${id} t=${tj}: engine settled but golden still ${v.values[j] - v.target} from target`);
        assert.equal(gotV, 0);
        return;
      }
      const tolX = 1e-6 + Math.abs(v.values[j]) * 1e-9;
      const tolV = 1e-6 + Math.abs(v.velocities[j]) * 1e-9;
      assert.ok(Math.abs(gotX - v.values[j]) <= tolX,
        `vector ${id} t=${tj}: value ${gotX} vs golden ${v.values[j]}`);
      assert.ok(Math.abs(gotV - v.velocities[j]) <= tolV,
        `vector ${id} t=${tj}: velocity ${gotV} vs golden ${v.velocities[j]}`);
    });
  }
});
