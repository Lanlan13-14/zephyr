import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyUserSnapshot } = require('../webdav-vault-restore.js');
const user = { userId: 'alice' };
const snapshot = (collections) => ({ userId: 'alice', collections });

test('nonempty restore with missing business services fails closed', () => {
  assert.throws(() => applyUserSnapshot(snapshot({ notes: [{ id: 'n' }] }), { user }),
    (error) => error.code === 'webdav_restore_unavailable');
  assert.throws(() => applyUserSnapshot(snapshot({ connections: [{ id: 'c' }] }), { user }),
    (error) => error.code === 'webdav_restore_unavailable');
});

test('restore rejects payload and row owner mismatches before writing', () => {
  const notes = { get() { return null; }, create() { assert.fail('foreign note'); } };
  for (const payload of [
    { userId: 'bob', collections: { notes: [{ id: 'n' }] } },
    snapshot({ notes: [{ id: 'n', owner_user_id: 'bob' }] }),
    snapshot({ notes: [{ id: 'n', ownerUserId: 'bob' }] }),
  ]) {
    assert.throws(() => applyUserSnapshot(payload, { user, notesService: notes }),
      (error) => error.code === 'webdav_backup_scope_invalid');
  }
});

test('restore preflights every collection before mutating an earlier collection', () => {
  const notes = { get() { return null; }, create() { assert.fail('must preflight all rows'); } };
  const resources = { storage: { getConnectionById: () => null } };
  assert.throws(() => applyUserSnapshot(snapshot({
    notes: [{ id: 'n', owner_user_id: 'alice' }], connections: [{ id: 'c', ownerUserId: 'bob' }],
  }), { user, notesService: notes, resourceService: resources }),
  (error) => error.code === 'webdav_backup_scope_invalid');
});

test('restore does not upsert a foreign connection id or shared foreign note id', () => {
  const resources = {
    storage: { getConnectionById: () => ({ id: 'c', ownerUserId: 'bob' }) },
    createConnection() { assert.fail('foreign ID upsert'); },
  };
  assert.throws(() => applyUserSnapshot(snapshot({ connections: [{ id: 'c' }] }), { user, resourceService: resources }),
    (error) => error.code === 'webdav_restore_conflict');
  const notes = {
    get: () => ({ noteId: 'n', ownerUserId: 'bob', revision: 1 }),
    stmtGet: { get: () => ({ id: 'n', owner_user_id: 'bob', revision: 1 }) },
    update() { assert.fail('foreign shared note update'); },
  };
  assert.throws(() => applyUserSnapshot(snapshot({ notes: [{ id: 'n' }] }), { user, notesService: notes }),
    (error) => error.code === 'webdav_restore_conflict');
});

test('restore counts real resource creation and restores references before connections', () => {
  const order = [];
    const resources = {
    storage: { getConnectionById: () => null, getProxyRaw: () => null, getSshKeyRaw: () => null, listJumpHosts: () => [] }, _rawResource: () => null,
    createOwned(_actor, type) { order.push(type); },
    createConnection() { order.push('connection'); },
  };
  const result = applyUserSnapshot(snapshot({
    proxies: [{ id: 'p' }], sshKeys: [{ id: 'k' }], jumpHosts: [{ id: 'j' }], connections: [{ id: 'c' }],
  }), { user, resourceService: resources });
  assert.deepEqual(order, ['proxy', 'sshKey', 'connection', 'jumpHost']);
  assert.deepEqual(result.restored, { connections: 1, proxies: 1, sshKeys: 1, jumpHosts: 1, notes: 0 });
});

test('update failure never falls through to a potentially destructive create/upsert', () => {
  const resources = {
    storage: { getConnectionById: () => ({ id: 'c', ownerUserId: 'alice' }) },
    updateConnection() { throw new Error('ACL denied'); },
    createConnection() { assert.fail('no fallback upsert'); },
  };
  assert.throws(() => applyUserSnapshot(snapshot({ connections: [{ id: 'c' }] }), { user, resourceService: resources }), /ACL denied/);
});
