import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateLinkFrame } = require('../link-frame-validate.js');

function minimal() {
  return {
    protocol: 'zephyr-link',
    protocolVersion: 2,
    schemaVersion: 1,
    kind: 1,
    operation: 'sync.push',
    requestId: 'req_abcdefgh',
    idempotencyKey: 'idem_abcdefgh',
    deviceId: 'dev-1',
    bindingGeneration: 'gen-1',
    capability: 'sync.push',
    deadlineAt: 0,
    body: {},
  };
}

test('minimal valid frame is ok', () => {
  assert.equal(validateLinkFrame(minimal()).ok, true);
});

test('missing requestId is invalid_frame', () => {
  const frame = minimal();
  delete frame.requestId;
  const result = validateLinkFrame(frame);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_frame');
});

test('kind 0 is invalid_frame', () => {
  const frame = minimal();
  frame.kind = 0;
  assert.equal(validateLinkFrame(frame).ok, false);
});

test('uppercase operation is invalid_frame', () => {
  const frame = minimal();
  frame.operation = 'SYNC';
  assert.equal(validateLinkFrame(frame).ok, false);
});

test('protocolVersion 1 is invalid_frame', () => {
  const frame = minimal();
  frame.protocolVersion = 1;
  assert.equal(validateLinkFrame(frame).ok, false);
});

test('unknown field is invalid_frame', () => {
  const frame = minimal();
  frame.extra = true;
  assert.equal(validateLinkFrame(frame).ok, false);
});
