import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const morphKeys = ['--z-morph-l', '--z-morph-t', '--z-morph-w', '--z-morph-h'];
const morphClasses = ['terminal-window-morphing', 'layout-morphing', 'layout-morphing-radius'];

// Evaluate the production function bodies, not a rewritten close transaction.
function extractFunction(name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing production function ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const brace = source.indexOf(') {', start) + 2;
  assert.ok(brace > start, `missing body for ${name}`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function classes(initial = []) {
  const values = new Set(initial);
  return {
    contains: name => values.has(name),
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
  };
}

const rect = (left, width) => ({ left, top: 24, width, height: 600 });
const plain = value => JSON.parse(JSON.stringify(value));

function harness(ids, { active = ids[0], stale = [] } = {}) {
  const events = [];
  const nodes = new Map();
  const jobs = new Map(ids.map(id => [id, deferred()]));
  const storage = new Map(ids.flatMap(id => [
    [`zephyr_ssh_params_${id}`, `ssh:${id}`],
    [`zephyr_remote_desktop_params_${id}`, `desktop:${id}`],
  ]));
  const snapshots = new Set(ids);
  const frames = new Map();
  for (const [index, id] of ids.entries()) {
    const properties = new Map(stale.includes(id)
      ? morphKeys.map((key, i) => [key, ['0px', '24px', '500px', '600px'][i]]) : []);
    const iframe = { id: `iframe:${id}`, contentWindow: { liveSession: id } };
    frames.set(id, iframe);
    const win = {
      dataset: { window: id },
      classList: classes(['terminal-window', ...(stale.includes(id) ? morphClasses : [])]),
      properties,
      layoutRect: rect(index * (1000 / ids.length), 1000 / ids.length),
      style: {
        removeProperty(key) {
          events.push(['remove-property', id, key]);
          properties.delete(key);
        },
      },
      getAnimations: () => [{ cancel: () => events.push(['cancel', id]) }],
      getBoundingClientRect() {
        // A stale fixed morph fill wins over the freshly rendered grid slot.
        const value = win.classList.contains('terminal-window-morphing')
          ? rect(parseFloat(properties.get('--z-morph-l')), parseFloat(properties.get('--z-morph-w')))
          : { ...win.layoutRect };
        events.push(['measure', id, { ...value }]);
        return value;
      },
      querySelector(selector) {
        assert.equal(selector, 'iframe.terminal-frame');
        return iframe;
      },
      remove() {
        events.push(['remove-node', id]);
        nodes.delete(id);
      },
    };
    nodes.set(id, win);
  }
  const workspace = {
    classList: classes(),
    querySelector(selector) {
      const match = selector.match(/data-window="([^"]+)"/);
      assert.ok(match, `unexpected workspace selector: ${selector}`);
      return nodes.get(match[1]) || null;
    },
  };
  const engine = {
    release(win) { events.push(['release', win.dataset.window]); },
    stop(win, keys) { events.push(['stop', win.dataset.window, Array.from(keys || [])]); },
    terminalWindowAvoidance(win, fromRect, toRect, options) {
      events.push(['avoidance', win.dataset.window, plain(fromRect), plain(toRect), plain(options)]);
      return Promise.resolve();
    },
  };
  const context = {
    console: { info() {}, warn: (...args) => events.push(['warning', ...args]) },
    CSS: { escape: String },
    terminalWorkspace: workspace,
    $: selector => {
      assert.equal(selector, '#terminalWorkspace');
      return workspace;
    },
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '#terminalWorkspace > .terminal-window:not(.minimized-keepalive)');
        return [...nodes.values()];
      },
    },
    window: {
      Motion: engine,
      clearTimeout: timer => events.push(['clear-timeout', timer]),
    },
    sshKeyMotion: { engine },
    terminalTabs: ids.map(id => ({ id, minimized: false })),
    openOrderStack: [...ids].reverse(),
    visualLayout: [...ids],
    recentUseStack: [...ids].reverse(),
    closingTerminalTabs: new Set(),
    pinnedStateByTabId: new Map(ids.map(id => [id, { pinned: true }])),
    minimizingTerminalTabs: new Set(ids),
    dockLaunchAnimatingWindows: new Set(ids),
    dockSwapAnimatingWindows: new Set(ids),
    terminalReconnectFallbackTimers: new Map(ids.map(id => [id, `timer:${id}`])),
    remoteExecSessions: new Map(),
    sessionStorage: {
      removeItem(key) {
        events.push(['remove-storage', key]);
        storage.delete(key);
      },
    },
    removeTerminalSnapshot(id) { events.push(['remove-snapshot', id]); snapshots.delete(id); },
    playTerminalWindowCloseMotion(win) {
      const id = win?.dataset.window;
      events.push(['close-motion', id]);
      assert.ok(jobs.has(id), `unexpected close motion ${id}`);
      return jobs.get(id).promise;
    },
    exitTerminalFullscreen(options) {
      events.push(['exit-fullscreen', plain(options || {})]);
      return Promise.resolve(false);
    },
    applySplitSlideState(options) { events.push(['split-slide', plain(options)]); },
    scheduleWorkspaceSave(reason, options) { events.push(['save', reason, plain(options)]); },
    // Dependencies are deliberately small: grid reflow, live-node reuse, and
    // production removal cleanup. They never choose or repair the active tab.
    renderTerminalTabs() {
      const visible = context.visualLayout.filter(id =>
        context.terminalTabs.some(tab => tab.id === id && !tab.minimized)
        && !context.closingTerminalTabs.has(id));
      events.push(['render', [...visible], context.activeTerminalTab]);
      for (const [id, win] of [...nodes]) {
        if (!visible.includes(id)) context.removeTerminalWindowElement(win);
      }
      visible.forEach((id, index) => {
        assert.ok(nodes.has(id), `render must preserve the existing iframe owner ${id}`);
        nodes.get(id).layoutRect = rect(index * (1000 / visible.length), 1000 / visible.length);
      });
    },
    detachRemoteExecFrame() { assert.fail('ordinary terminals must not detach a remote owner'); },
    disposeEphemeralConnection() { assert.fail('ordinary terminals have no ephemeral row'); },
    setTerminalSmartbarOpen() { assert.fail('these transactions leave a surviving terminal'); },
    resetTerminalWorkspaceKeyboard() { assert.fail('these transactions leave a surviving terminal'); },
    switchView() { assert.fail('closing a non-final tab must not switch views'); },
  };
  let activeId = active;
  Object.defineProperty(context, 'activeTerminalTab', {
    enumerable: true,
    get: () => activeId,
    set(value) {
      events.push(['activate', value, context.closingTerminalTabs.has(value)]);
      activeId = value;
    },
  });
  vm.createContext(context);
  vm.runInContext([
    extractFunction('resetTerminalWindowLayoutMotion'),
    extractFunction('removeTerminalWindowElement'),
    extractFunction('closeTerminalTab'),
  ].join('\n'), context, { filename: 'production-terminal-close.vm.js' });
  return { context, events, nodes, jobs, frames, storage, snapshots };
}

function assertState(env, expectedIds, active, closing = []) {
  const { context: c } = env;
  assert.deepEqual(Array.from(c.terminalTabs, tab => tab.id), expectedIds, 'terminalTabs order');
  assert.deepEqual(Array.from(c.openOrderStack), [...expectedIds].reverse(), 'openOrderStack order');
  assert.deepEqual(Array.from(c.visualLayout), expectedIds, 'visualLayout order');
  assert.deepEqual(Array.from(c.recentUseStack), [...expectedIds].reverse(), 'recentUseStack order');
  assert.deepEqual([...c.closingTerminalTabs], closing, 'closing IDs');
  assert.equal(c.activeTerminalTab, active, 'active terminal');
}

function assertRetired(env, id) {
  const { context: c, events } = env;
  for (const name of ['pinnedStateByTabId', 'minimizingTerminalTabs',
    'dockLaunchAnimatingWindows', 'dockSwapAnimatingWindows', 'terminalReconnectFallbackTimers']) {
    assert.equal(c[name].has(id), false, `${name} must retire ${id}`);
  }
  assert.equal(env.storage.has(`zephyr_ssh_params_${id}`), false);
  assert.equal(env.storage.has(`zephyr_remote_desktop_params_${id}`), false);
  assert.equal(env.snapshots.has(id), false);
  assert.equal(env.nodes.has(id), false, 'closed DOM owner removed');
  const release = events.findIndex(e => e[0] === 'release' && e[1] === id);
  const removal = events.findIndex(e => e[0] === 'remove-node' && e[1] === id);
  assert.ok(release >= 0 && release < removal, 'release motion channels before DOM removal');
  assert.equal(events.filter(e => e[0] === 'remove-node' && e[1] === id).length, 1);
  assert.equal(events.filter(e => e[0] === 'clear-timeout' && e[1] === `timer:${id}`).length, 1);
  assert.equal(events.filter(e => e[0] === 'remove-snapshot' && e[1] === id).length, 1);
}

function assertSurvivor(env, id, owner) {
  assert.strictEqual(env.nodes.get(id), owner, 'keep the live window owner');
  assert.strictEqual(owner.querySelector('iframe.terminal-frame'), env.frames.get(id), 'keep the live iframe');
  assert.equal(owner.querySelector('iframe.terminal-frame').contentWindow.liveSession, id);
  assert.equal(env.events.some(e => e[0] === 'release' && e[1] === id), false, 'never release live owner channels');
  for (const name of ['pinnedStateByTabId', 'minimizingTerminalTabs',
    'dockLaunchAnimatingWindows', 'dockSwapAnimatingWindows', 'terminalReconnectFallbackTimers']) {
    assert.equal(env.context[name].has(id), true, `${name} must retain ${id}`);
  }
  assert.equal(env.storage.has(`zephyr_ssh_params_${id}`), true);
  assert.equal(env.snapshots.has(id), true);
}

test('ordinary 2→1 close retires stale fixed half-width before render and measures full-width avoidance target', async () => {
  const env = harness(['a', 'b'], { active: 'a', stale: ['b'] });
  const survivor = env.nodes.get('b');
  const job = env.context.closeTerminalTab('a');
  assertState(env, ['a', 'b'], 'a', ['a']);
  assert.equal(env.events.some(e => e[0] === 'render'), false, 'close motion gates commit');
  env.jobs.get('a').resolve(true);
  await job;
  assertState(env, ['b'], 'b');
  assertRetired(env, 'a');
  assertSurvivor(env, 'b', survivor);
  for (const cls of morphClasses) assert.equal(survivor.classList.contains(cls), false);
  assert.equal(survivor.properties.size, 0);
  const renderIndex = env.events.findIndex(e => e[0] === 'render');
  const measurements = env.events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event[0] === 'measure' && event[1] === 'b');
  assert.equal(measurements.length, 2, 'capture old presentation and new grid geometry');
  assert.deepEqual(measurements[0].event[2], rect(0, 500));
  assert.deepEqual(measurements[1].event[2], rect(0, 1000));
  assert.ok(measurements[0].index < renderIndex && renderIndex < measurements[1].index);
  const stopIndex = env.events.findIndex(e => e[0] === 'stop' && e[1] === 'b');
  assert.ok(measurements[0].index < stopIndex && stopIndex < renderIndex);
  assert.deepEqual(env.events[stopIndex][2], morphKeys, 'stop only live layout morph channels');
  for (const key of morphKeys) {
    const cleanIndex = env.events.findIndex(e => e[0] === 'remove-property' && e[1] === 'b' && e[2] === key);
    assert.ok(stopIndex < cleanIndex && cleanIndex < renderIndex, `clean ${key} before render`);
  }
  const avoidance = env.events.filter(e => e[0] === 'avoidance');
  assert.deepEqual(avoidance, [[
    'avoidance', 'b', rect(0, 500), rect(0, 1000), { preset: { response: 0.36, damping: 0.96 } },
  ]]);
  const cancelIndex = env.events.findIndex(e => e[0] === 'cancel' && e[1] === 'b');
  assert.ok(measurements[0].index < cancelIndex && cancelIndex < stopIndex);
  assert.equal(env.events.filter(e => e[0] === 'save' && e[1] === 'close-terminal-tab').length, 1);
});

for (const completionOrder of [['a', 'b'], ['b', 'a']]) {
  test(`overlapping 3→1 closes (${completionOrder.join(' then ')}) never activate a closing ID`, async () => {
    const env = harness(['a', 'b', 'c'], { active: 'a' });
    const survivor = env.nodes.get('c');
    const pending = {
      a: env.context.closeTerminalTab('a'),
      b: env.context.closeTerminalTab('b'),
    };
    assertState(env, ['a', 'b', 'c'], 'a', ['a', 'b']);
    assert.equal(env.events.some(e => e[0] === 'render'), false);
    const [first, second] = completionOrder;
    env.jobs.get(first).resolve(true);
    await pending[first];
    const expectedIntermediate = ['a', 'b', 'c'].filter(id => id !== first);
    // Capture transient activation violations, but settle both close promises
    // and verify final retirement before reporting the regression.
    const intermediateActive = env.context.activeTerminalTab;
    const violations = env.events.filter(e => e[0] === 'activate' && e[2]);
    assertState(env, expectedIntermediate, intermediateActive, [second]);
    assertRetired(env, first);
    assertSurvivor(env, 'c', survivor);
    const firstRender = env.events.find(e => e[0] === 'render');
    assert.deepEqual(firstRender[1], ['c'], 'pending-closing owners are not visible');
    env.jobs.get(second).resolve(true);
    await pending[second];
    assertState(env, ['c'], 'c');
    assertRetired(env, second);
    assertSurvivor(env, 'c', survivor);
    assert.equal(env.events.filter(e => e[0] === 'close-motion').length, 2);
    assert.equal(env.events.filter(e => e[0] === 'save' && e[1] === 'close-terminal-tab').length, 2);
    assert.deepEqual(violations, [], 'a close commit must not activate an ID whose close promise is still pending');
    assert.equal(intermediateActive, 'c', 'only the non-closing survivor may be active in either completion order');
    assert.equal(firstRender[2], intermediateActive, 'render observes the committed active terminal');
  });
}

test('duplicate close of the same tab is idempotent both while pending and after commit', async () => {
  const env = harness(['a', 'b'], { active: 'b' });
  const survivor = env.nodes.get('b');
  const pending = env.context.closeTerminalTab('a');
  const beforeDuplicate = env.events.length;
  await env.context.closeTerminalTab('a');
  assert.equal(env.events.length, beforeDuplicate, 'pending duplicate has no side effects');
  assertState(env, ['a', 'b'], 'b', ['a']);
  env.jobs.get('a').resolve(true);
  await pending;
  assertState(env, ['b'], 'b');
  assertRetired(env, 'a');
  assertSurvivor(env, 'b', survivor);
  const afterCommit = env.events.length;
  await env.context.closeTerminalTab('a');
  assert.equal(env.events.length, afterCommit, 'already-removed duplicate has no side effects');
  assert.equal(env.events.filter(e => e[0] === 'close-motion' && e[1] === 'a').length, 1);
  assert.equal(env.events.filter(e => e[0] === 'render').length, 1);
  assert.equal(env.events.filter(e => e[0] === 'save' && e[1] === 'close-terminal-tab').length, 1);
});
