import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const notesSource = readFileSync(path.join(root, 'public', 'notes.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing ${start}`);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from + start.length, to);
}

const runtimeStart = appSource.indexOf('function createBrowserChangeWakeClient');
const runtimeEnd = appSource.indexOf('/* Browser change wake runtime end. */', runtimeStart);
assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'missing browser change wake runtime');
const runtimeSource = appSource.slice(runtimeStart, runtimeEnd);

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type) { for (const listener of this.listeners.get(type) || []) listener(); }
}

function fakeClock() {
  let nextId = 0;
  const tasks = new Map();
  return {
    set(fn, delay) {
      const id = ++nextId;
      tasks.set(id, { fn, delay });
      return id;
    },
    clear(id) { tasks.delete(id); },
    delays() { return [...tasks.values()].map((task) => task.delay); },
    runNext() {
      const entry = tasks.entries().next().value;
      assert.ok(entry, 'expected a scheduled task');
      const [id, task] = entry;
      tasks.delete(id);
      task.fn();
    },
  };
}

function runtimeHarness() {
  const context = vm.createContext({
    console,
    URL,
    window: { setTimeout, clearTimeout },
    Map,
    Set,
    Promise,
  });
  vm.runInContext(runtimeSource, context, { filename: 'public/app.js#browser-change-wake' });
  return context;
}

test('change wake uses one cookie-authenticated stream, validates payloads, and resumes with cursor backoff', () => {
  const context = runtimeHarness();
  const clock = fakeClock();
  const documentRef = new FakeTarget();
  documentRef.visibilityState = 'visible';
  const windowRef = new FakeTarget();
  const received = [];

  class FakeEventSource {
    static instances = [];
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      this.closed = false;
      FakeEventSource.instances.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(payload) { this.listeners.get('change')?.({ data: JSON.stringify(payload) }); }
    close() { this.closed = true; }
  }

  const client = context.createBrowserChangeWakeClient({
    endpoint: '/api/me/change-wake',
    entityTypes: ['connection', 'proxy'],
    onEntityTypes: (types) => received.push([...types]),
    EventSourceImpl: FakeEventSource,
    documentRef,
    windowRef,
    navigatorRef: { onLine: true },
    locationRef: { href: 'https://zephyr.test/app', origin: 'https://zephyr.test' },
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    baseRetryMs: 100,
    maxRetryMs: 800,
  });

  client.start();
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(FakeEventSource.instances[0].url, '/api/me/change-wake');
  assert.equal(FakeEventSource.instances[0].options.withCredentials, true);

  FakeEventSource.instances[0].emit({ sequence: 2, reason: 'connected', entityTypes: [] });
  FakeEventSource.instances[0].emit({ sequence: 3, reason: 'change', entityTypes: ['connection', 'connection'] });
  FakeEventSource.instances[0].emit({ sequence: 4, reason: 'change', entityTypes: ['unknown'] });
  assert.deepEqual(received, [['connection']]);
  assert.equal(client.state().lastSequence, 3, 'invalid payload must not advance the resume cursor');

  FakeEventSource.instances[0].onerror();
  assert.deepEqual(clock.delays(), [100]);
  clock.runNext();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(FakeEventSource.instances[1].url, '/api/me/change-wake?cursor=3');
  FakeEventSource.instances[1].onerror();
  assert.deepEqual(clock.delays(), [200]);

  documentRef.visibilityState = 'hidden';
  documentRef.emit('visibilitychange');
  assert.equal(clock.delays().length, 0);
  assert.equal(FakeEventSource.instances[1].closed, true);
  documentRef.visibilityState = 'visible';
  documentRef.emit('visibilitychange');
  assert.equal(FakeEventSource.instances.length, 3);
  assert.equal(FakeEventSource.instances.filter((source) => !source.closed).length, 1);
  client.stop();
});

test('entity debounce maps one resource burst to one single-flight loader run', async () => {
  const context = runtimeHarness();
  const documentRef = { visibilityState: 'visible' };
  let networkLoads = 0;
  const scheduler = context.createBrowserChangeRefreshScheduler({
    entityGroups: { proxy: 'network', sshKey: 'network', jumpHost: 'network' },
    loaders: { network: async () => { networkLoads += 1; } },
    documentRef,
    debounceMs: 5,
  });

  scheduler.schedule(['proxy', 'sshKey', 'jumpHost', 'proxy']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(networkLoads, 1);

  documentRef.visibilityState = 'hidden';
  scheduler.schedule(['proxy']);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(networkLoads, 1, 'hidden pages retain work without fetching');
  documentRef.visibilityState = 'visible';
  scheduler.resume();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(networkLoads, 2);
  scheduler.stop();
});

test('app mapping refreshes existing loaders and never restores workspace tabs from a wake', () => {
  assert.match(appSource, /endpoint:\s*'\/api\/me\/change-wake'/);
  assert.doesNotMatch(appSource, /\/api\/ai\/history\/events/);
  assert.match(appSource, /connection:\s*'connections'/);
  assert.match(appSource, /proxy:\s*'network'[\s\S]*sshKey:\s*'network'[\s\S]*jumpHost:\s*'network'/);
  assert.match(appSource, /aiConversation:\s*'aiHistory'[\s\S]*aiMessage:\s*'aiHistory'/);
  assert.match(appSource, /workspaceState:\s*'workspace'/);
  assert.match(appSource, /workspace:\s*\(\)\s*=>\s*markWorkspaceRemoteUpdate\(\)/);
  assert.match(appSource, /api\('\/api\/jump-hosts'\)/);

  const wakeSetup = between(appSource, 'function markWorkspaceRemoteUpdate()', 'async function init()');
  assert.doesNotMatch(wakeSetup, /restoreLastWorkspace|terminalTabs\s*=/);
});

test('Notes defers remote data while dirty or saving and refreshes only while active and clean', () => {
  assert.match(notesSource, /remoteUpdatePending:\s*false/);
  assert.match(notesSource, /if \(!state\.active \|\| state\.dirty \|\| state\.saving\) return false/);
  assert.match(notesSource, /state\.remoteUpdatePending = true/);
  assert.match(notesSource, /state\.savePromise = performSave\(\)/);
  assert.match(notesSource, /if \(state\.remoteUpdatePending && state\.active && !state\.dirty\)/);
  assert.match(notesSource, /async function leave\(\)[\s\S]*state\.active = false[\s\S]*await flushSave\(\)/);
  assert.match(notesSource, /const canApply = \(\) =>[\s\S]*!state\.dirty[\s\S]*!state\.saving/);
});
