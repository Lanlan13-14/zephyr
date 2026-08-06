import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OneClientManager, OneClientError } = require('../one-client-manager.js');
const { FileAgentManager } = require('../file-agent-manager.js');

function makeDb() {
  const db = new Database(':memory:');
  return db;
}

function makeFileAgent(tmpDir) {
  const tokenFile = path.join(tmpDir, 'agent-tokens.json');
  return new FileAgentManager({ tokenFile, log: () => {} });
}

test('bind requires existing file agent token', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-client-'));
  const db = makeDb();
  const fam = makeFileAgent(tmp);
  const mgr = new OneClientManager({
    db,
    fileAgentManager: fam,
    resourceService: { listConnections: () => [], listOwned: () => [] },
    notesService: { list: () => ({ notes: [], total: 0 }) },
    userSettingsService: { effective: () => ({}) },
    storage: {},
    log: () => {},
  });
  const user = { userId: 'u1', username: 'admin' };
  assert.throws(
    () => mgr.bind(user, { clientId: 'c1', deviceName: 'phone' }),
    (err) => err instanceof OneClientError && err.code === 'token_required',
  );

  const tok = fam.createToken('admin', 'phone-token');
  const bound = mgr.bind(user, {
    clientId: 'c1',
    deviceName: 'phone',
    platform: 'android',
    tokenId: tok.id,
    syncIntervalSec: 120,
  });
  assert.ok(bound.deviceToken);
  assert.equal(bound.client.clientId, 'c1');
  assert.equal(bound.client.syncIntervalSec, 120);
  assert.equal(bound.token.id, tok.id);

  const listed = mgr.listForUser('u1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenId, tok.id);
});

test('revoke removes client and device token stops working', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-client-'));
  const db = makeDb();
  const fam = makeFileAgent(tmp);
  const tok = fam.createToken('admin', 't1');
  const mgr = new OneClientManager({
    db,
    fileAgentManager: fam,
    resourceService: {
      listConnections: () => [{ id: 'conn1', name: 's1', owner: 'own' }],
      listOwned: () => [],
      getConnection: () => ({ id: 'conn1', password: 'secret' }),
    },
    notesService: {
      list: () => ({ notes: [{ noteId: 'n1', title: 'hi' }], total: 1 }),
      get: (_u, id) => ({ noteId: id, title: 'hi', content: 'body' }),
    },
    userSettingsService: { effective: () => ({ theme: 'dark' }) },
    storage: { getSshKeyRaw: () => null },
    log: () => {},
  });
  const user = { userId: 'u1', username: 'admin', role: 'admin' };
  const bound = mgr.bind(user, { clientId: 'dev-a', tokenId: tok.id, deviceName: 'pad' });
  const row = mgr.resolveDeviceToken(bound.deviceToken);
  assert.ok(row);
  const snap = mgr.buildSnapshot(user, row);
  assert.equal(snap.ok, true);
  assert.ok(Array.isArray(snap.data.connections));
  assert.equal(snap.data.connections[0].password, 'secret');

  mgr.revoke('u1', 'dev-a', 'test');
  assert.equal(mgr.resolveDeviceToken(bound.deviceToken), null);
  assert.equal(mgr.listForUser('u1').length, 0);
});

test('interval is clamped', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-client-'));
  const db = makeDb();
  const fam = makeFileAgent(tmp);
  const tok = fam.createToken('admin', 't1');
  const mgr = new OneClientManager({
    db,
    fileAgentManager: fam,
    resourceService: { listConnections: () => [], listOwned: () => [] },
    notesService: { list: () => ({ notes: [], total: 0 }) },
    userSettingsService: { effective: () => ({}) },
    storage: {},
    log: () => {},
  });
  const user = { userId: 'u1', username: 'admin' };
  mgr.bind(user, { clientId: 'c2', tokenId: tok.id, syncIntervalSec: 5 });
  const c = mgr.updateInterval('u1', 'c2', 999999);
  assert.equal(c.syncIntervalSec, 86400);
});
