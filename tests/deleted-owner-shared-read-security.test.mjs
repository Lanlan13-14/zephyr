import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Authz, CAP } = require('../authz.js');
const { SharingService } = require('../sharing-service.js');
const { SharedResourceApi } = require('../mobile-v1-shared.js');

test('Authz denies live ACL, visibility and admin access when the owner is unavailable', () => {
  const users = new Map([
    ['borrower', { userId: 'borrower', role: 'user', status: 'active' }],
    ['admin', { userId: 'admin', role: 'admin', status: 'active' }],
    ['deleted-owner', { userId: 'deleted-owner', role: 'user', status: 'deleted' }],
    ['suspended-owner', { userId: 'suspended-owner', role: 'user', status: 'suspended' }],
  ]);
  const grant = {
    revoked_at: null,
    expires_at: null,
    capabilities_json: JSON.stringify([CAP.DISCOVER, CAP.VIEW, CAP.EDIT]),
  };
  const authz = Object.create(Authz.prototype);
  Object.assign(authz, {
    getUserById: (id) => users.get(id) || null,
    now: () => 1_000,
    stmtGrantGet: { get: () => grant },
    listSubjectGrants: () => [{
      resourceType: 'note', resourceId: 'orphan', capabilities: [CAP.DISCOVER, CAP.VIEW, CAP.EDIT],
    }],
  });
  const borrower = users.get('borrower');
  const admin = users.get('admin');

  for (const ownerUserId of ['missing-owner', 'deleted-owner', 'suspended-owner']) {
    const orphan = { id: 'orphan', ownerUserId, visibility: 'shared_all' };
    assert.equal(authz.effectiveCapabilities(borrower, 'note', orphan.id, orphan).size, 0);
    assert.equal(authz.effectiveCapabilities(admin, 'note', orphan.id, orphan).size, 0);
    assert.deepEqual([...authz.visibleIds(borrower, 'note', [orphan])], []);
  }
});

test('Web shared-with-me hides live grants owned by missing or inactive accounts', () => {
  const rows = new Map([
    ['active', { id: 'active', name: 'Active note', ownerUserId: 'owner-active', visibility: 'shared_all' }],
    ['deleted', { id: 'deleted', name: 'Deleted owner note', ownerUserId: 'owner-deleted', visibility: 'shared_all' }],
    ['missing', { id: 'missing', name: 'Missing owner note', ownerUserId: 'owner-missing', visibility: 'shared_all' }],
  ]);
  const owners = new Map([
    ['owner-active', { userId: 'owner-active', username: 'active-owner', status: 'active' }],
    ['owner-deleted', { userId: 'owner-deleted', username: 'deleted-owner', status: 'deleted' }],
  ]);
  const grants = [...rows.keys()].map((resourceId) => ({
    resourceType: 'note', resourceId, capabilities: ['discover', 'view'],
  }));
  const service = new SharingService(
    { listSubjectGrants: () => grants },
    { getUserById: (id) => owners.get(id) || null },
    { _rawResource: (_type, id) => rows.get(id) || null },
  );

  assert.deepEqual(service.listSharedWithMe({ userId: 'borrower' }), [{
    ...grants[0],
    resourceExists: true,
    resourceName: 'Active note',
    ownerName: 'active-owner',
  }]);
});

function mobileNoteHarness() {
  let owner = { userId: 'owner', username: 'owner', status: 'active' };
  let deletedAt = null;
  let getCalls = 0;
  let updateCalls = 0;
  const row = () => ({
    note_id: 'note-1',
    owner_user_id: 'owner',
    title: 'Owner note',
    content: 'owner-secret-body',
    revision: 3,
    deleted_at: deletedAt,
    share_with_users: 1,
  });
  const notesService = {
    stmtGet: { get: () => row() },
    get() {
      getCalls += 1;
      const value = row();
      return {
        noteId: value.note_id,
        ownerUserId: value.owner_user_id,
        title: value.title,
        content: value.content,
        revision: value.revision,
      };
    },
    update() {
      updateCalls += 1;
      return { revision: 4 };
    },
  };
  const api = Object.create(SharedResourceApi.prototype);
  Object.assign(api, {
    notesService,
    storage: { getUserById: (id) => (id === 'owner' ? owner : null) },
    authz: {
      listSubjectGrants: () => [{
        resourceType: 'note', resourceId: 'note-1', capabilities: ['discover', 'view', 'edit'], expiresAt: null,
      }],
      effectiveCapabilities: () => new Set(['discover', 'view', 'edit']),
    },
    log() {},
  });
  const user = { userId: 'borrower', role: 'user', status: 'active' };
  return {
    api,
    user,
    setOwner(next) { owner = next; },
    setDeletedAt(next) { deletedAt = next; },
    calls() { return { getCalls, updateCalls }; },
  };
}

test('Mobile note summary, detail, raw, read and update accept an active owner', () => {
  const h = mobileNoteHarness();
  assert.equal(h.api.listShared(h.user).items.length, 1);
  assert.equal(h.api.getShared(h.user, 'note', 'note-1').hasContent, true);
  assert.equal(h.api.rawResource('note', 'note-1').id, 'note-1');
  assert.equal(h.api.invokeNote(h.user, 'note-1', 'read', {}, {}).result.content, 'owner-secret-body');
  assert.equal(h.api.invokeNote(h.user, 'note-1', 'update', { title: 'updated' }, { expectedRevision: 3 }).result.saved, true);
  assert.deepEqual(h.calls(), { getCalls: 1, updateCalls: 1 });
});

test('Mobile note paths hide a deleted or missing owner even with live ACL and share flag', () => {
  for (const unavailableOwner of [
    { userId: 'owner', username: 'owner', status: 'deleted' },
    { userId: 'owner', username: 'owner', status: 'suspended' },
    null,
  ]) {
    const h = mobileNoteHarness();
    h.setOwner(unavailableOwner);
    assert.deepEqual(h.api.listShared(h.user), { items: [], nextPageToken: null });
    assert.equal(h.api.rawResource('note', 'note-1'), null);
    assert.throws(() => h.api.getShared(h.user, 'note', 'note-1'), (err) => err.status === 404);
    assert.throws(() => h.api.invokeNote(h.user, 'note-1', 'read', {}, {}), (err) => err.status === 404);
    assert.throws(
      () => h.api.invokeNote(h.user, 'note-1', 'update', { title: 'stolen' }, { expectedRevision: 3 }),
      (err) => err.status === 404,
    );
    assert.deepEqual(h.calls(), { getCalls: 0, updateCalls: 0 });
  }
});

test('Mobile note paths hide soft-deleted rows before canonical read or update', () => {
  const h = mobileNoteHarness();
  h.setDeletedAt(Date.now());
  assert.deepEqual(h.api.listShared(h.user), { items: [], nextPageToken: null });
  assert.equal(h.api.rawResource('note', 'note-1'), null);
  assert.throws(() => h.api.getShared(h.user, 'note', 'note-1'), (err) => err.status === 404);
  assert.throws(() => h.api.invokeNote(h.user, 'note-1', 'read', {}, {}), (err) => err.status === 404);
  assert.throws(
    () => h.api.invokeNote(h.user, 'note-1', 'update', { title: 'stolen' }, { expectedRevision: 3 }),
    (err) => err.status === 404,
  );
  assert.deepEqual(h.calls(), { getCalls: 0, updateCalls: 0 });
});
