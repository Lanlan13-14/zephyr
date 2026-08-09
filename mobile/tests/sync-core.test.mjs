// Client-side sync rules from SYNC_STATE_MACHINE.md. These are the invariants both ports must keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BINDING_STATES, RUN_PHASES, FIRST_BIND_PHASES, NORMAL_PHASES, MAX_OPS_PER_BATCH,
  INTERVAL_SEC_MIN, INTERVAL_SEC_MAX, BACKOFF_STEPS_MS,
  nextBindingState, phasesFor, canRunManualSync, canRunAutomaticSync, clampIntervalSec, backoffMs,
  sortOperationsForPush, batchOperations, sanitizeFieldMask, foldPendingOperations,
  classifyPush, shouldApplyChange, resolveConflict, CONFLICT_RESOLUTIONS,
} from '../tools/lib/sync-core.mjs';
import { syncCases } from '../tools/lib/fixtures.mjs';

test('binding states and phases match the frozen enumerations', () => {
  assert.deepEqual([...BINDING_STATES], [
    'UNBOUND', 'BOUND_NEEDS_BOOTSTRAP', 'BOOTSTRAPPING', 'CATCHING_UP', 'IDLE',
    'RUNNING', 'CONFLICTED', 'REAUTH_REQUIRED', 'REVOKED', 'FATAL_INCOMPATIBLE',
  ]);
  assert.deepEqual([...RUN_PHASES], [
    'VALIDATE_BINDING', 'RECOVER_BOOTSTRAP', 'BOOTSTRAP_PAGE', 'CATCH_UP_PULL',
    'PUSH_PENDING', 'PULL_CHANGES', 'APPLY_BLOBS', 'ACK_CURSOR', 'COMMIT_SUCCESS',
  ]);
});

test('first bind catches up before pushing; normal rounds push first', () => {
  assert.deepEqual([...FIRST_BIND_PHASES], [
    'VALIDATE_BINDING', 'BOOTSTRAP_PAGE', 'CATCH_UP_PULL', 'PUSH_PENDING',
    'PULL_CHANGES', 'APPLY_BLOBS', 'ACK_CURSOR', 'COMMIT_SUCCESS',
  ]);
  const first = [...FIRST_BIND_PHASES];
  assert.ok(
    first.indexOf('CATCH_UP_PULL') < first.indexOf('PUSH_PENDING'),
    'never push onto a stale snapshot',
  );
  const normal = [...NORMAL_PHASES];
  assert.ok(
    normal.indexOf('PUSH_PENDING') < normal.indexOf('PULL_CHANGES'),
    'normal rounds push first to shorten local edit visibility',
  );
  assert.deepEqual(phasesFor('BOUND_NEEDS_BOOTSTRAP'), [...FIRST_BIND_PHASES]);
  assert.deepEqual(phasesFor('IDLE'), [...NORMAL_PHASES]);
});

test('state transitions follow the frozen table', () => {
  assert.equal(nextBindingState('UNBOUND', 'bind_success'), 'BOUND_NEEDS_BOOTSTRAP');
  assert.equal(nextBindingState('BOUND_NEEDS_BOOTSTRAP', 'run'), 'BOOTSTRAPPING');
  assert.equal(nextBindingState('BOOTSTRAPPING', 'snapshot_complete'), 'CATCHING_UP');
  assert.equal(nextBindingState('CATCHING_UP', 'success'), 'IDLE');
  assert.equal(nextBindingState('IDLE', 'trigger'), 'RUNNING');
  assert.equal(nextBindingState('RUNNING', 'success'), 'IDLE');
  assert.equal(nextBindingState('RUNNING', 'conflict_only'), 'CONFLICTED');
  assert.equal(nextBindingState('CONFLICTED', 'conflicts_resolved'), 'IDLE');
});

test('SID expiry leaves the data plane untouched', () => {
  for (const state of BINDING_STATES) {
    assert.equal(nextBindingState(state, 'sid_expired'), state, state + ' must ignore SID expiry');
  }
});

test('revocation, reauth and incompatibility override any bound state', () => {
  for (const state of BINDING_STATES.filter((s) => s !== 'UNBOUND')) {
    assert.equal(nextBindingState(state, 'device_revoked'), 'REVOKED');
    assert.equal(nextBindingState(state, 'refresh_invalid'), 'REAUTH_REQUIRED');
    assert.equal(nextBindingState(state, 'token_rotated'), 'REAUTH_REQUIRED');
    assert.equal(nextBindingState(state, 'registry_incompatible'), 'FATAL_INCOMPATIBLE');
    assert.equal(nextBindingState(state, 'cursor_expired'), 'BOUND_NEEDS_BOOTSTRAP');
  }
  assert.equal(nextBindingState('UNBOUND', 'device_revoked'), 'UNBOUND');
});

test('manual sync ignores the automatic switch but not an unusable binding', () => {
  assert.equal(canRunManualSync('IDLE', false), true, 'automatic off must not disable Sync Now');
  assert.equal(canRunManualSync('CONFLICTED', false), true);
  assert.equal(canRunManualSync('UNBOUND', true), false, 'unbound devices have nothing to sync');
  assert.equal(canRunManualSync('REVOKED', true), false);
  assert.equal(canRunAutomaticSync('IDLE', false), false, 'automatic off blocks scheduled rounds');
  assert.equal(canRunAutomaticSync('IDLE', true), true);
  assert.equal(canRunAutomaticSync('REAUTH_REQUIRED', true), false);
});

test('interval clamps to the 30s-24h product range', () => {
  assert.equal(INTERVAL_SEC_MIN, 30);
  assert.equal(INTERVAL_SEC_MAX, 86400);
  assert.equal(clampIntervalSec(1), 30);
  assert.equal(clampIntervalSec(300), 300);
  assert.equal(clampIntervalSec(999999), 86400);
});

test('backoff grows to a 15 minute ceiling and stays jittered in range', () => {
  assert.equal(BACKOFF_STEPS_MS[0], 1000);
  assert.equal(BACKOFF_STEPS_MS.at(-1), 900000);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const step = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
    const value = backoffMs(attempt, () => 0.5);
    assert.ok(value >= step * 0.5 - 1 && value <= step * 1.5 + 1, 'attempt ' + attempt + ' out of jitter range');
  }
  assert.ok(backoffMs(99, () => 1) <= 900000 * 1.5 + 1);
});

test('field masks accept only edited editable fields', () => {
  const ok = sanitizeFieldMask('connection', ['name', 'host', 'rdpQuality']);
  assert.deepEqual(ok.accepted, ['name', 'host', 'rdpQuality']);
  assert.deepEqual(ok.rejected, []);

  const dirty = sanitizeFieldMask('connection', ['name', 'password', 'revision', 'rdpPipeline', 'ephemeral', 'nope']);
  assert.deepEqual(dirty.accepted, ['name']);
  const byField = Object.fromEntries(dirty.rejected.map((r) => [r.field, r.reason]));
  assert.equal(byField.password, 'forbidden', 'secrets must never be named in a mask');
  assert.equal(byField.revision, 'forbidden', 'server authority fields are not ours to write');
  assert.equal(byField.rdpPipeline, 'forbidden', 'opaque Web fields stay opaque');
  assert.equal(byField.ephemeral, 'forbidden', 'device-local fields never sync');
  assert.equal(byField.nope, 'unknown', 'unknown future fields are dropped, not guessed');
});

test('append-only and secret-only entities reject every mask', () => {
  assert.deepEqual(sanitizeFieldMask('activityEvent', ['message']).accepted, []);
  assert.deepEqual(sanitizeFieldMask('clientToken', ['name', 'token']).accepted, ['name']);
});

test('nested mask paths are validated by their root field', () => {
  const nested = sanitizeFieldMask('note', ['title', 'tags[0]']);
  assert.deepEqual(nested.accepted, ['title', 'tags[0]']);
});

test('unsent operations fold per entity', () => {
  const created = foldPendingOperations([
    { opId: 'op-1', entityType: 'connection', entityId: 'c1', action: 'upsert', baseRevision: 0, createdLocally: true, fieldMask: ['name'], payload: { name: 'A' } },
    { opId: 'op-2', entityType: 'connection', entityId: 'c1', action: 'upsert', baseRevision: 0, fieldMask: ['host'], payload: { host: 'h1' } },
    { opId: 'op-3', entityType: 'connection', entityId: 'c1', action: 'upsert', baseRevision: 0, fieldMask: ['name'], payload: { name: 'B' } },
  ]);
  assert.equal(created.length, 1, 'create plus updates is one upsert');
  assert.equal(created[0].opId, 'op-1', 'the original opId survives so replays stay idempotent');
  assert.deepEqual(created[0].fieldMask, ['name', 'host']);
  assert.equal(created[0].payload.name, 'B', 'last write wins inside one unsent batch');

  const createdThenDeleted = foldPendingOperations([
    { opId: 'op-1', entityType: 'note', entityId: 'n1', action: 'upsert', baseRevision: 0, createdLocally: true, fieldMask: ['title'], payload: { title: 'draft' } },
    { opId: 'op-2', entityType: 'note', entityId: 'n1', action: 'delete', baseRevision: 0, fieldMask: [], payload: {} },
  ]);
  assert.deepEqual(createdThenDeleted, [], 'a locally created then deleted entity never reaches the server');

  const merged = foldPendingOperations([
    { opId: 'op-1', entityType: 'note', entityId: 'n2', action: 'upsert', baseRevision: 4, fieldMask: ['title'], payload: { title: 't1' } },
    { opId: 'op-2', entityType: 'note', entityId: 'n2', action: 'upsert', baseRevision: 6, fieldMask: ['content'], payload: { content: 'body' } },
  ]);
  assert.equal(merged[0].baseRevision, 4, 'merged masks keep the oldest baseRevision');

  const deleted = foldPendingOperations([
    { opId: 'op-1', entityType: 'snippet', entityId: 's1', action: 'upsert', baseRevision: 2, fieldMask: ['name'], payload: { name: 'x' } },
    { opId: 'op-2', entityType: 'snippet', entityId: 's1', action: 'delete', baseRevision: 2, fieldMask: [], payload: {} },
  ]);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].action, 'delete', 'delete dominates a later stale edit');
  assert.deepEqual(deleted[0].fieldMask, []);
  assert.deepEqual(deleted[0].payload, {});
});

test('folding keeps unrelated entities separate', () => {
  const folded = foldPendingOperations([
    { opId: 'a', entityType: 'note', entityId: 'n1', action: 'upsert', baseRevision: 1, fieldMask: ['title'], payload: {} },
    { opId: 'b', entityType: 'note', entityId: 'n2', action: 'upsert', baseRevision: 1, fieldMask: ['title'], payload: {} },
    { opId: 'c', entityType: 'connection', entityId: 'n1', action: 'upsert', baseRevision: 1, fieldMask: ['name'], payload: {} },
  ]);
  assert.equal(folded.length, 3, 'entity identity is (type, id)');
});

test('push order is dependency topology and batches cap at 200 ops', () => {
  const ops = [
    { opId: 'o1', entityType: 'note', entityId: 'n1' },
    { opId: 'o2', entityType: 'connection', entityId: 'c1' },
    { opId: 'o3', entityType: 'jumpHost', entityId: 'j1' },
    { opId: 'o4', entityType: 'sshKey', entityId: 'k1' },
  ];
  const order = sortOperationsForPush(ops).map((o) => o.opId);
  assert.ok(order.indexOf('o4') < order.indexOf('o3'), 'ssh key before jump host');
  assert.ok(order.indexOf('o3') < order.indexOf('o2'), 'jump host before connection');
  assert.ok(order.indexOf('o2') < order.indexOf('o1'), 'connection before note');

  assert.equal(MAX_OPS_PER_BATCH, 200);
  const many = Array.from({ length: 450 }, (_, i) => ({ opId: 'op-' + i, entityType: 'note', entityId: 'n' + i }));
  const batches = batchOperations(many);
  assert.deepEqual(batches.map((b) => b.length), [200, 200, 50]);
});

test('same-entity ordering is stable so replays keep their sequence', () => {
  const ops = Array.from({ length: 5 }, (_, i) => ({ opId: 'op-' + i, entityType: 'note', entityId: 'n1' }));
  assert.deepEqual(sortOperationsForPush(ops).map((o) => o.opId), ops.map((o) => o.opId));
});

test('non-overlapping fields merge; overlapping fields conflict', () => {
  assert.equal(classifyPush({ localMask: ['name'], serverChangedFields: [], baseRevision: 7, currentRevision: 7 }).status, 'accepted');
  assert.equal(classifyPush({ localMask: ['name'], serverChangedFields: ['remark'], baseRevision: 7, currentRevision: 8 }).status, 'accepted');
  const conflict = classifyPush({ localMask: ['name'], serverChangedFields: ['name'], baseRevision: 7, currentRevision: 8 });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.fields, ['name']);
});

test('server revision wins for echoes and tombstones always apply', () => {
  assert.equal(shouldApplyChange(7, { action: 'upsert', revision: 8 }), true);
  assert.equal(shouldApplyChange(8, { action: 'upsert', revision: 8 }), false, 'our own echo is a no-op');
  assert.equal(shouldApplyChange(9, { action: 'upsert', revision: 8 }), false, 'never regress a revision');
  assert.equal(shouldApplyChange(12, { action: 'delete', revision: 5 }), true, 'delete wins over local edits');
});

test('conflict resolutions mint a fresh op against the newest baseRevision', () => {
  assert.deepEqual([...CONFLICT_RESOLUTIONS], ['use_server', 'keep_local', 'copy_as_new', 'manual_merge']);

  const useServer = resolveConflict({ resolution: 'use_server', entityType: 'connection', entityId: 'c1', serverRevision: 9, newOpId: 'op-new', mask: ['name'], payload: {} });
  assert.equal(useServer.operation, null, 'accepting the server writes nothing back');

  const keepLocal = resolveConflict({ resolution: 'keep_local', entityType: 'connection', entityId: 'c1', serverRevision: 9, newOpId: 'op-new', mask: ['name'], payload: { name: 'mine' } });
  assert.equal(keepLocal.operation.baseRevision, 9, 'rebase onto the server revision instead of replaying a stale op');
  assert.equal(keepLocal.operation.opId, 'op-new', 'a resolution is a new operation identity');

  const copy = resolveConflict({ resolution: 'copy_as_new', entityType: 'connection', entityId: 'c1', serverRevision: 9, newOpId: 'op-new', mask: ['name', 'password'], payload: { name: 'mine' } });
  assert.equal(copy.operation.baseRevision, 0, 'a copy is a create');
  assert.notEqual(copy.operation.entityId, 'c1');
  assert.deepEqual(copy.operation.fieldMask, ['name'], 'secrets are stripped from the copied mask');

  assert.throws(() => resolveConflict({ resolution: 'silent_overwrite', entityType: 'note', entityId: 'n1', serverRevision: 1, newOpId: 'x', mask: [], payload: {} }), /unknown resolution/);
});

test('generated sync fixtures agree with the reference implementation', () => {
  const fixture = syncCases();
  for (const entry of fixture.fieldMask) {
    assert.deepEqual(sanitizeFieldMask(entry.entityType, entry.requested), entry.expected, entry.name);
  }
  for (const entry of fixture.fold) {
    assert.deepEqual(foldPendingOperations(entry.operations), entry.expected, entry.name);
  }
  for (const entry of fixture.classifyPush) {
    assert.deepEqual(classifyPush(entry), entry.expected, entry.name);
  }
  for (const entry of fixture.applyChange) {
    assert.equal(shouldApplyChange(entry.localRevision, entry.change), entry.expected, entry.name);
  }
  for (const entry of fixture.transitions) {
    assert.equal(nextBindingState(entry.from, entry.event), entry.expected, entry.from + '/' + entry.event);
  }
  assert.deepEqual(fixture.pushOrder.expectedOpIds, sortOperationsForPush(fixture.pushOrder.input).map((o) => o.opId));
});
