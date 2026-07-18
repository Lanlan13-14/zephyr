/**
 * The JS fallback solver (spring.js) must match the Go golden vectors
 * exactly (same closed form, same op order → bit-identical float64).
 * Also covers the JS-side engine/tracker/helpers behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGolden } from './motion-wasm-harness.mjs';
import {
  Spring, SpringEngine, VelocityTracker,
  project, rubberband, rubberbandClamp, cubicBezierSample,
} from '../public/vendor/zephyr-motion/spring.js';

test('JS solver matches golden vectors to 1e-9', () => {
  const vectors = loadGolden();
  for (const v of vectors) {
    const s = new Spring(v.response, v.damping);
    s.set(v.x0);
    s.flick(v.target, v.v0);
    for (let j = 0; j < v.times.length; j++) {
      const [x, vel] = s._eval(v.times[j]);
      assert.ok(Math.abs(x - v.values[j]) <= 1e-9 + Math.abs(v.values[j]) * 1e-12,
        `value divergence: js ${x} vs go ${v.values[j]} (case r=${v.response} d=${v.damping} t=${v.times[j]})`);
      assert.ok(Math.abs(vel - v.velocities[j]) <= 1e-9 + Math.abs(v.velocities[j]) * 1e-12,
        `velocity divergence: js ${vel} vs go ${v.velocities[j]}`);
    }
  }
});

test('JS engine: settle, idle, buffer contract', () => {
  const e = new SpringEngine(4);
  e.configure(0, 0.4, 1.0);
  e.animateTo(0, 100);
  let active = 1, frames = 0;
  while (active > 0 && frames < 240) {
    active = e.tick(1 / 60);
    frames++;
  }
  assert.equal(active, 0);
  assert.equal(e.getValue(0), 100);
  assert.equal(e.buffer[2], 0, 'active flag cleared');
  assert.equal(e.buffer[0], 100);
});

test('JS engine: retarget carries velocity', () => {
  const e = new SpringEngine(1);
  e.configure(0, 0.4, 1.0);
  e.animateTo(0, 100);
  for (let i = 0; i < 12; i++) e.tick(1 / 60);
  const v = e.getVelocity(0);
  const x = e.getValue(0);
  e.animateTo(0, 500);
  assert.equal(e.getVelocity(0), v);
  assert.equal(e.getValue(0), x);
});

test('JS engine: delay holds then runs', () => {
  const e = new SpringEngine(1);
  e.configure(0, 0.3, 1.0);
  e.animateToDelayed(0, 100, 0.1);
  e.tick(1 / 60);
  assert.equal(e.getValue(0), 0);
  assert.equal(e.isActive(0), true);
  for (let i = 0; i < 240; i++) e.tick(1 / 60);
  assert.equal(e.getValue(0), 100);
});

test('JS tracker matches Go behavior', () => {
  const tr = new VelocityTracker();
  for (let i = 0; i <= 8; i++) tr.push(i * 0.016, 1000 * i * 0.016, 0);
  const [vx, vy] = tr.velocity();
  assert.ok(Math.abs(vx - 1000) < 1e-6);
  assert.equal(vy, 0);
  tr.clear();
  assert.deepEqual(tr.velocity(), [0, 0]);
});

test('JS helpers match Go formulas', () => {
  assert.ok(Math.abs(project(500, 0.998) - 249.5) < 1e-9);
  assert.equal(rubberband(0, 100, 0.55), 0);
  assert.ok(rubberband(1e6, 100, 0.55) < 100);
  assert.equal(rubberbandClamp(50, 0, 100, 100), 50);
  assert.ok(Math.abs(cubicBezierSample(0.25, 0.1, 0.25, 1, 0.5) - 0.802403) < 1e-3);
});
