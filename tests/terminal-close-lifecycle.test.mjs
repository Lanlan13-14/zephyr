import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Motion } from '../public/vendor/zephyr-motion/motion.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const brace = source.indexOf(') {', start) + 2;
  assert.ok(brace > 1, `could not find body for ${name}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function harness({ engine = {}, timers = globalThis } = {}) {
  const warnings = [];
  const context = {
    console: { warn: (...args) => warnings.push(args) },
    window: { Motion: engine, setTimeout: timers.setTimeout.bind(timers), clearTimeout: timers.clearTimeout.bind(timers) },
    sshKeyMotion: { engine },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('resetTerminalWindowLayoutMotion'),
    extractFunction('removeTerminalWindowElement'),
    extractFunction('playTerminalWindowCloseMotion'),
  ].join('\n'), context);
  return { context, warnings };
}

function fakeWindow() {
  const classes = new Set();
  const removed = [];
  const props = [];
  return {
    classes, removed, props,
    style: { transformOrigin: '', removeProperty: (key) => props.push(key) },
    classList: {
      add: (...names) => names.forEach((x) => classes.add(x)),
      remove: (...names) => names.forEach((x) => classes.delete(x)),
    },
    getAnimations: () => [{ cancel() { removed.push('cancel-animation'); } }],
    remove() { removed.push('remove'); },
  };
}

test('dispose cleanup cancels WAAPI and releases the actual motion owner', () => {
  const calls = [];
  const engine = { release: (win) => calls.push(['release', win]), stop: (...args) => calls.push(['stop', ...args]) };
  const { context } = harness({ engine });
  const win = fakeWindow();
  win.classes.add('terminal-window-morphing', 'layout-morphing', 'layout-morphing-radius');
  context.resetTerminalWindowLayoutMotion(win, { dispose: true });
  assert.deepEqual(calls, [['release', win]]);
  assert.deepEqual(win.removed, ['cancel-animation']);
  assert.deepEqual(win.props, ['--z-morph-l', '--z-morph-t', '--z-morph-w', '--z-morph-h']);
  assert.equal(win.classes.size, 0);
});

test('non-dispose cleanup stops only morph channels and removes stale styles', () => {
  const calls = [];
  const engine = { release: () => calls.push('release'), stop: (...args) => calls.push(args) };
  const { context } = harness({ engine });
  const win = fakeWindow();
  context.resetTerminalWindowLayoutMotion(win);
  assert.equal(calls[0][0], win);
  assert.deepEqual(Array.from(calls[0][1]), ['--z-morph-l', '--z-morph-t', '--z-morph-w', '--z-morph-h']);
  assert.equal(calls.some((x) => x === 'release'), false);
  assert.deepEqual(win.removed, ['cancel-animation']);
  assert.equal(win.props.length, 4);
});

test('close animation is bounded when Motion.to never settles', async () => {
  const calls = [];
  const engine = {
    set: (win) => calls.push(['set', win]),
    to: () => new Promise(() => {}),
    stop: (win) => calls.push(['stop', win]),
  };
  const { context } = harness({ engine });
  const win = fakeWindow();
  const started = Date.now();
  const result = await Promise.race([
    context.playTerminalWindowCloseMotion(win),
    new Promise((_, reject) => globalThis.setTimeout(() => reject(new Error('close helper hung past its own deadline')), 1800)),
  ]);
  assert.equal(result, true);
  assert.ok(Date.now() - started < 1500, 'the 900ms helper deadline should bound the close');
  assert.ok(calls.some((x) => x[0] === 'stop' && x[1] === win));
  assert.ok(win.classes.has('motion-closing'));
});

test('retiring an element disposes its motion owner before removing it', () => {
  const events = [];
  const engine = { release: (win) => events.push(['release', win]), stop: () => events.push(['stop']) };
  const { context } = harness({ engine });
  const win = fakeWindow();
  win.remove = () => events.push(['remove', win]);
  context.removeTerminalWindowElement(win);
  assert.deepEqual(events, [['release', win], ['remove', win]]);
  assert.deepEqual(win.removed, ['cancel-animation']);
});

test('real Motion engine recycles slots across 140 window lifecycles', async (t) => {
  try {
    await Motion.init({ capacity: 256 });
    Motion.setReducedMotion(false);
  } catch (error) {
    t.skip(`Motion engine unavailable: ${error?.message ?? error}`);
    return;
  }
  const { context } = harness({ engine: Motion });
  const windows = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    for (let i = 0; i < 140; i++) {
      const win = {
        style: { setProperty() {}, removeProperty() {} },
        classList: { add() {}, remove() {} },
        getAnimations: () => [], remove() {},
      };
      windows.push(win);
      Motion.set(win, { opacity: 0.7, scaleX: 0.93, scaleY: 0.94 });
      assert.equal(Motion.value(win, 'opacity'), 0.7, `window ${i} gets a real channel`);
      assert.equal(Motion.value(win, 'scaleY'), 0.94, `window ${i} gets all close channels`);
      // Create real engine channels before exercising the production disposer.
      Motion.to(win, { opacity: 0.5, scaleX: 0.9 }, { duration: 10 }).catch(() => {});
      context.removeTerminalWindowElement(win);
    }
    assert.equal(windows.length, 140);
    assert.equal(warnings.filter(x => /exhaust|pool/i.test(x)).length, 0);
  } finally {
    console.warn = originalWarn;
    for (const win of windows) {
      try { Motion.stop(win); Motion.release(win); } catch {}
    }
  }
});
