/**
 * Engine facade + Motion API tests in Node with fake elements.
 * No rAF in Node — tests drive engine.tick(dt) explicitly, which is also
 * the documented SSR/test path.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../public/vendor/zephyr-motion/runtime.js';
import { Motion } from '../public/vendor/zephyr-motion/motion.js';
import { PRESETS, MOTION_STANDARDS, STANDARD_FALLBACKS, resolvePreset } from '../public/vendor/zephyr-motion/presets.js';

// The Motion facade uses a module-global engine; boot it once (JS fallback
// in Node — no fetchable wasm URL).
before(async () => {
  Motion.setReducedMotion(false);
  await Motion.init({ capacity: 256 });
});

/** Minimal Element stand-in: inline style only. */
function fakeEl() {
  const props = {};
  return {
    style: {
      setProperty: (k, v) => { props[k] = v; },
      removeProperty: k => { delete props[k]; },
      _props: props,
      set transform(v) { props.transform = v; },
      get transform() { return props.transform; },
      set opacity(v) { props.opacity = v; },
      get opacity() { return props.opacity; },
      set filter(v) { props.filter = v; },
      get filter() { return props.filter; },
      set borderRadius(v) { props.borderRadius = v; },
      get borderRadius() { return props.borderRadius; },
    },
  };
}

function makeEngine(t) {
  const e = new Engine();
  e.setReducedMotion(false);
  return e;
}

test('engine boots on JS fallback in Node (no wasm fetch)', async () => {
  const e = new Engine();
  await e.init(16);
  assert.equal(e.ready, true);
  assert.equal(e.usingWasm, false); // fetch() of a wasm URL fails in Node → fallback
});

test('bindings flush on tick; settle fires onRest once', async () => {
  const e = await makeEngine().init(8);
  const el = fakeEl();
  e.configure(0, 0.3, 1.0);
  e.bindProp(0, el, '--test-x', 'px');
  let rests = 0;
  e.onRest(0, () => rests++);
  e.animateTo(0, 100);
  for (let i = 0; i < 240 && e.tick(1 / 60) > 0; i++);
  assert.equal(el.style._props['--test-x'], '100px');
  assert.equal(rests, 1, `rest fired ${rests}×`);
});

test('concurrent init() calls share one backend (no state wipe)', async () => {
  const e = new Engine();
  e.setReducedMotion(false);
  const [a, b] = await Promise.all([e.init(16), e.init(16)]);
  assert.equal(a, b);
  // Start a spring, then "re-init": must be a no-op that keeps state.
  e.configure(0, 0.4, 1.0);
  e.animateTo(0, 100);
  for (let i = 0; i < 10; i++) e.tick(1 / 60);
  const x = e.getValue(0);
  await e.init(16);
  assert.equal(e.getValue(0), x, 'init must not wipe in-flight springs');
});

test('reduced motion short-circuits to final value', async () => {
  const e = new Engine();
  e.setReducedMotion(true);
  await e.init(8);
  const el = fakeEl();
  e.configure(0, 0.3, 1.0);
  e.bindProp(0, el, '--rm', '');
  e.animateTo(0, 5);
  assert.equal(e.getValue(0), 5);
  assert.equal(el.style._props['--rm'], '5');
  assert.equal(e.isActive(0), false);
});

test('retarget keeps velocity through facade', async () => {
  const e = await makeEngine().init(8);
  e.configure(0, 0.4, 1.0);
  e.animateTo(0, 100);
  for (let i = 0; i < 12; i++) e.tick(1 / 60);
  const v = e.getVelocity(0);
  e.animateTo(0, 500);
  assert.equal(e.getVelocity(0), v);
});

test('iosCardOpen/Close follows one reversible anchored path', async () => {
  const makeStyle = () => {
    const props = {};
    return {
      setProperty: (k, v) => { props[k] = v; },
      removeProperty: k => { delete props[k]; },
      getPropertyValue: k => props[k] || '',
      getPropertyPriority: () => '',
      _props: props,
      set transform(v) { props.transform = v; }, get transform() { return props.transform || ''; },
      set opacity(v) { props.opacity = String(v); }, get opacity() { return props.opacity || ''; },
      set filter(v) { props.filter = v; }, get filter() { return props.filter || ''; },
      set borderRadius(v) { props.borderRadius = v; }, get borderRadius() { return props.borderRadius || ''; },
    };
  };
  const source = {
    style: makeStyle(), dataset: {}, offsetWidth: 120,
    getBoundingClientRect: () => ({ left: 40, top: 70, width: 120, height: 120 }),
  };
  const surface = {
    style: makeStyle(), hidden: true, dataset: {}, offsetWidth: 340,
    getBoundingClientRect() {
      return { left: 210, top: 100, width: 340, height: 480 };
    },
  };
  const front = { style: makeStyle() };
  const back = { style: makeStyle() };
  const scrim = { style: makeStyle() };

  const openP = Motion.iosCardOpen(surface, source, { frontEl: front, backEl: back, scrim });
  for (let i = 0; i < 600; i++) Motion.engine.tick(1 / 120);
  assert.equal(await openP, true);
  assert.equal(Motion.value(surface, 'rotateY'), -180);
  assert.equal(Motion.value(surface, 'scaleX'), 1);
  assert.equal(front.style.opacity, '0');
  assert.equal(back.style.opacity, '1');
  assert.equal(source.dataset.motionHidden, '1');

  const originalRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = cb => { queueMicrotask(cb); return 1; };
  try {
    const closeP = Motion.iosCardClose(surface, source, { frontEl: front, backEl: back, scrim });
    for (let i = 0; i < 600; i++) Motion.engine.tick(1 / 120);
    assert.equal(await closeP, true);
  } finally {
    globalThis.requestAnimationFrame = originalRAF;
  }
  assert.equal(Motion.value(surface, 'rotateY'), 0);
  assert.equal(surface.style.visibility, 'hidden');
  assert.equal(source.dataset.motionHidden, undefined);
  assert.equal(scrim.style.opacity, '0');
});

test('Motion.to accepts stable standard and composes rotateY', async () => {
  const el = fakeEl();
  const p = Motion.to(el, { rotateY: -180 }, { standard: MOTION_STANDARDS.iosCardFlipOpen });
  for (let i = 0; i < 500; i++) Motion.engine.tick(1 / 60);
  await p;
  assert.match(el.style.transform, /rotateY\(-180deg\)/);
  assert.deepEqual(STANDARD_FALLBACKS[MOTION_STANDARDS.iosCardFlipOpen], { response: 0.40, damping: 0.96 });
});

test('Motion.to composes transform and resolves on settle', async () => {
  const e = new Engine();
  e.setReducedMotion(false);
  await e.init(64);
  // Rewire Motion's singleton engine is module-global; test through it.
  const el = fakeEl();
  const p = Motion.to(el, { x: 120, scale: 1.2, opacity: 0.5 }, { preset: 'snappy' });
  assert.ok(p instanceof Promise);
  // Drive the shared engine manually.
  for (let i = 0; i < 400; i++) Motion.engine.tick(1 / 60);
  await p; // must not hang
  assert.match(el.style.transform, /translate3d\(120px, 0px, 0\) scale\(1.2, 1.2\)/);
  assert.equal(el.style.opacity, '0.5');
});

test('Motion.set is instant; Motion.value reads live channel', async () => {
  const el = fakeEl();
  Motion.set(el, { x: 40, rotate: 15 });
  assert.equal(Motion.value(el, 'x'), 40);
  assert.equal(Motion.value(el, 'rotate'), 15);
  assert.equal(Motion.value(el, 'scale'), 1, 'default for untouched channel');
  assert.match(el.style.transform, /rotate\(15deg\)/);
});

test('Motion.release frees slots and clears managed styles', async () => {
  const el = fakeEl();
  Motion.set(el, { x: 10, opacity: 0.3 });
  for (let i = 0; i < 10; i++) Motion.engine.tick(1 / 60);
  Motion.release(el);
  assert.equal(el.style.transform, '');
  assert.equal(el.style.opacity, '');
  assert.equal(Motion.value(el, 'x'), 0);
});

test('presets resolve by name and object', () => {
  assert.deepEqual(resolvePreset('snappy'), PRESETS.snappy);
  assert.deepEqual(resolvePreset({ response: 0.3, damping: 0.9 }), { response: 0.3, damping: 0.9 });
  assert.deepEqual(resolvePreset('nope'), PRESETS.ui);
  assert.ok(PRESETS.sheet.damping < 1, 'sheet must bounce slightly');
  assert.equal(PRESETS.ui.damping, 1, 'ui default critically damped');
});

test('Motion stagger assigns increasing delays without hanging', async () => {
  const els = [fakeEl(), fakeEl(), fakeEl()];
  const p = Motion.stagger(els, { x: 50 }, { step: 0.05, preset: 'snappy' });
  for (let i = 0; i < 400; i++) Motion.engine.tick(1 / 60);
  await p;
  for (const el of els) assert.match(el.style.transform, /translate3d\(50px/);
});

test('Motion.to seeds all transform channels before retargeting any channel', async () => {
  const el = fakeEl();
  Motion.set(el, { x: 120, y: 300, scaleX: 0.4, scaleY: 0.3, rotateY: 0 });
  const seeded = el.style.transform;
  const promise = Motion.to(el, {
    x: 0, y: 0, scaleX: 1, scaleY: 1, rotateY: -180,
  }, { standard: MOTION_STANDARDS.iosCardFlipOpen });
  assert.equal(el.style.transform, seeded, 'starting one channel must not repaint later channels to defaults');
  for (let i = 0; i < 180 && Motion.isAnimating(el); i++) Motion.engine.tick(1 / 60);
  await promise;
  assert.match(el.style.transform, /translate3d\(0px, 0px, 0\) scale\(1, 1\) rotateY\(-180deg\)/);
});
