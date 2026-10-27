import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { mapSyncOperation } = require('../link-v2-sync-envelope.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(
  path.join(here, '../docs/zephyr-link/conformance/cases/sync-envelope-v1.json'),
  'utf8',
));

const STORE_BOUND_REJECT = new Set([
  'SE-REJECT-030',
  'SE-BOUNDARY-002',
  'SE-BOUNDARY-003',
  'SE-SECURITY-001',
  'SE-SECURITY-002',
  'SE-SECURITY-003',
  'SE-SECURITY-004',
  'SE-SECURITY-005',
  'SE-SECURITY-006',
  'SE-SECURITY-007',
]);

function sessionFrom(test) {
  const source = test.input || test.legacy || {};
  return {
    envelopeVersion: source.envelopeVersion ?? 1,
    authenticatedDeviceId: test.authenticatedDeviceId,
    currentRevision: test.currentRevision,
    serverRegistryHash: test.serverRegistryHash,
    maxOperations: test.maxOperations,
  };
}

for (const testCase of cases.filter((entry) => entry.family === 'valid')) {
  test(`${testCase.id} maps a valid ${testCase.op} body`, () => {
    const mapped = mapSyncOperation(testCase.legacy, sessionFrom(testCase));
    assert.equal(mapped.error, undefined, JSON.stringify(mapped));
    assert.equal(mapped.operation, testCase.operation);
    assert.equal(mapped.kind, 1);
    assert.equal(mapped.responseShape, testCase.response);
    assert.equal(Object.hasOwn(mapped.body, 'op'), false);
    if (testCase.expectedBody) assert.deepEqual(mapped.body, testCase.expectedBody);
    if (testCase.idempotencyPrefix) assert.equal(mapped.idempotency.key, testCase.idempotencyPrefix);
    if (testCase.op === 'push') {
      assert.equal(mapped.idempotency.kind, 'batch');
      assert.equal(mapped.idempotency.operationIdsPreserved, true);
    } else if (testCase.op === 'ack') {
      assert.equal(mapped.idempotency.kind, 'monotonic-ack');
    } else {
      assert.equal(mapped.idempotency.kind, 'read-only');
    }
  });
}

for (const testCase of cases.filter((entry) => entry.expectedError && !STORE_BOUND_REJECT.has(entry.id))) {
  test(`${testCase.id} rejects with ${testCase.expectedError}`, () => {
    const mapped = mapSyncOperation(testCase.input, sessionFrom(testCase));
    assert.equal(mapped.error, testCase.expectedError, JSON.stringify(mapped));
  });
}

test('SE-BOUNDARY-004/005/006/008/009 keep the original response shape without guessing v2', () => {
  for (const id of ['SE-BOUNDARY-004', 'SE-BOUNDARY-005', 'SE-BOUNDARY-006', 'SE-BOUNDARY-008', 'SE-BOUNDARY-009']) {
    const testCase = cases.find((entry) => entry.id === id);
    const mapped = mapSyncOperation(testCase.input, sessionFrom(testCase));
    assert.equal(mapped.error, undefined, id);
    assert.equal(mapped.responseShape, testCase.response, id);
  }
});

test('unnegotiated session never infers v2 from field presence', () => {
  const mapped = mapSyncOperation({ op: 'status', operation: 'sync.status' }, { envelopeVersion: 1 });
  assert.equal(mapped.error, undefined);
  assert.equal(mapped.operation, 'sync.status');
  const rejected = mapSyncOperation({ op: 'status', operation: 'sync.status' }, { envelopeVersion: 99 });
  assert.equal(rejected.error, 'unsupported_protocol_version');
});

test('push without a device id is device_proof_invalid', () => {
  const mapped = mapSyncOperation({
    op: 'push',
    protocolVersion: 1,
    batchId: 'batch-1',
    operations: [],
  });
  assert.equal(mapped.error, 'device_proof_invalid');
});

test('currentRevision is taken only from sessionContext', () => {
  const mapped = mapSyncOperation({
    op: 'push',
    protocolVersion: 1,
    deviceId: 'dev-1',
    batchId: 'batch-1',
    currentRevision: 99,
    operations: [{
      opId: 'op-1',
      entityType: 'note',
      entityId: 'n1',
      action: 'upsert',
      baseRevision: 5,
      fieldMask: ['title'],
      payload: { title: 'x' },
    }],
  }, { authenticatedDeviceId: 'dev-1', currentRevision: 0 });
  assert.equal(mapped.error, 'revision_conflict');
});
