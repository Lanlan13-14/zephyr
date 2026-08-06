import test from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

const { SyncEngine } = await import('../src/js/sync/sync-engine.js');

test('sync engine pulls and stores snapshot', async () => {
  localStorage.clear();
  const calls = [];
  const api = {
    pullSync: async (body, deviceToken) => {
      calls.push({ body, deviceToken });
      return {
        ok: true,
        revision: 3,
        data: { connections: [{ id: '1' }], notes: [], proxies: [], sshKeys: [] },
      };
    },
  };
  const engine = new SyncEngine({
    api,
    getBindState: () => ({ clientId: 'c1', deviceToken: 'dt', deviceName: 'n', platform: 'linux' }),
  });
  engine.setIntervalSec(60);
  await engine.enable();
  assert.equal(engine.status.enabled, true);
  assert.equal(engine.status.lastRevision, 3);
  assert.equal(engine.status.connectionCount, 1);
  assert.equal(calls.length, 1);
  engine.disable();
  assert.equal(engine.status.enabled, false);
});

test('sync engine errors without bind', async () => {
  localStorage.clear();
  const engine = new SyncEngine({
    api: { pullSync: async () => ({}) },
    getBindState: () => ({}),
  });
  await assert.rejects(() => engine.pull(), /绑定/);
});
