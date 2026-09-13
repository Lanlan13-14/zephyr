import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentTokenStore } = require('../file-agent-token-store.js');
const { createDatabase } = require('../sqlite-driver.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-link-identity-'));
  const db = createDatabase(path.join(dir, 'zephyr.db'), { forceBuiltin: true });
  const store = new AgentTokenStore(path.join(dir, 'tokens.json'), {
    db,
    keyFile: path.join(dir, 'keys.json'),
  });
  store.ensureReady();
  return { dir, db, store };
}

test('Link identity is token-scoped, idempotent, and persistent', () => {
  const { db, store } = setup();
  const a = store.create({ ownerUserId: 'owner-a', name: 'A', secret: 'a'.repeat(32) });
  const b = store.create({ ownerUserId: 'owner-b', name: 'B', secret: 'b'.repeat(32) });
  const jwk = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) };
  const identity = store.bindLinkIdentity('owner-a', a.id, 'agent-device-a-0001', jwk);
  assert.deepEqual(identity, { deviceId: 'agent-device-a-0001', signingJwk: JSON.stringify(jwk) });
  assert.deepEqual(store.bindLinkIdentity('owner-a', a.id, 'agent-device-a-0001', jwk), identity);
  assert.throws(() => store.bindLinkIdentity('owner-a', a.id, 'agent-device-a-0001', { ...jwk, x: 'z'.repeat(43) }), /already bound/);
  assert.throws(() => store.bindLinkIdentity('owner-b', b.id, 'agent-device-a-0001', jwk), /UNIQUE|constraint/i);
  assert.deepEqual(store.getLinkIdentity('owner-a', a.id), identity);
  store.close();
  db.close();
});
