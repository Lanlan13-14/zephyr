import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const {
  MobileV1Api,
  MAX_OPS_PER_BATCH,
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_OPERATION_PAYLOAD_BYTES,
  validatePushRequest,
  fieldPathsOverlap,
  setPatchValueAtPath,
  createPushJsonBodyParser,
} = require('../../../mobile-v1-routes.js');
const express = require('express');
const { assertMaskAllowed } = require('../../../mobile-v1-entities.js');
const { secretAadBytes, sharedUseAadBytes } = require('../../../mobile-v1-crypto.js');

const registryHash = 'a'.repeat(64);

function operation(overrides = {}) {
  return {
    opId: 'op-1',
    entityType: 'connection',
    entityId: 'connection-1',
    action: 'upsert',
    baseRevision: 0,
    fieldMask: ['name'],
    payload: { name: 'safe' },
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    v: 1,
    alg: 'ML-KEM-768+HKDF-SHA256+AES-256-GCM',
    kem: 'ML-KEM-768',
    aead: 'AES-256-GCM',
    ct: 'AA==',
    iv: 'AA==',
    tag: 'AA==',
    data: 'AA==',
    aad: 'AA==',
    keyVersion: 1,
    entityRevision: 1,
    ...overrides,
  };
}

function pushBody(overrides = {}) {
  return {
    protocolVersion: 1,
    deviceId: 'device-1234567890',
    batchId: 'batch-1',
    baseCursor: 0,
    registryHash,
    operations: [operation()],
    ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    locals: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
  };
}

function rejectedPush(body, rawBody = Buffer.from(JSON.stringify(body))) {
  let starts = 0;
  let transactions = 0;
  let authChecks = 0;
  const api = Object.create(MobileV1Api.prototype);
  api.requireDevice = () => {
    authChecks += 1;
    return {
      user: { userId: 'user-1' },
      device: {
        device_id: 'device-1234567890',
        owner_user_id: 'user-1',
        last_acked_cursor: 0,
      },
    };
  };
  api.assertRegistry = () => true;
  api.entityByType = new Map([['connection', {
    type: 'connection',
    editableFields: ['name', 'settings.theme'],
    secretFields: ['password'],
    serverAuthorityFields: [],
    opaquePreserveFields: [],
    deviceLocalFields: [],
  }]]);
  api.store = {
    startRun() { starts += 1; return 'run-1'; },
  };
  api.db = {
    transaction() {
      transactions += 1;
      return () => { throw new Error('transaction must not execute'); };
    },
  };
  const res = response();
  api.handlePush({
    headers: {},
    rawBody,
    body,
    mobileRequestId: 'request-1',
  }, res);
  return { res, starts, transactions, authChecks };
}

test('fieldMask accepts only exact registry paths and rejects every prototype segment', () => {
  const spec = {
    editableFields: ['name', 'settings.theme'],
    secretFields: [],
    serverAuthorityFields: [],
    opaquePreserveFields: [],
    deviceLocalFields: [],
  };
  assert.doesNotThrow(() => assertMaskAllowed(spec, ['name', 'settings.theme']));
  assert.throws(() => assertMaskAllowed(spec, ['settings.future']), /\u5b57\u6bb5/);
  for (const path of [
    '__proto__',
    'settings.__proto__.polluted',
    'settings.prototype.polluted',
    'settings.constructor.prototype.polluted',
    'settings[constructor].polluted',
  ]) {
    assert.throws(() => assertMaskAllowed({ ...spec, editableFields: [...spec.editableFields, path] }, [path]));
  }
});

test('null-prototype patch construction cannot mutate the global object prototype', () => {
  delete Object.prototype.mobilePushPolluted;
  const patch = Object.create(null);
  setPatchValueAtPath(patch, 'settings.__proto__.mobilePushPolluted', true);
  assert.equal(Object.prototype.mobilePushPolluted, undefined);
  assert.equal(Object.getPrototypeOf(patch), null);
  assert.equal(Object.getPrototypeOf(patch.settings), null);
  assert.equal(Object.getPrototypeOf(patch.settings.__proto__), null);
  assert.equal(patch.settings.__proto__.mobilePushPolluted, true);
});

test('push validation enforces the complete frozen operation schema', () => {
  assert.equal(validatePushRequest(pushBody()).operations.length, 1);

  const invalid = [
    operation({ opId: 'x'.repeat(81) }),
    operation({ entityType: 'x'.repeat(81) }),
    operation({ entityId: 'x'.repeat(161) }),
    operation({ opId: 'op\u0000suffix' }),
    operation({ fieldMask: ['name', 'name'] }),
    operation({ extra: true }),
    operation({
      fieldMask: [], payload: {},
      secretEnvelopes: { password: envelope() }, clearSecretFields: ['password'],
    }),
    operation({
      fieldMask: [], payload: {},
      secretEnvelopes: { password: envelope({ unknown: true }) },
    }),
    operation({ action: 'delete', fieldMask: [], payload: { name: 'not-empty' } }),
    operation({ action: 'restore', fieldMask: ['name'], payload: {} }),
  ];
  for (const candidate of invalid) {
    assert.throws(() => validatePushRequest(pushBody({ operations: [candidate] })));
  }
});

test('push validation fails closed on unknown and inherited request properties', () => {
  assert.throws(() => validatePushRequest(pushBody({ unknown: true })));

  const inheritedBody = Object.assign(Object.create({ unknown: true }), pushBody());
  assert.throws(() => validatePushRequest(inheritedBody), /own JSON properties/);

  const inheritedOperation = Object.assign(Object.create({ opId: 'inherited' }), operation());
  delete inheritedOperation.opId;
  assert.throws(() => validatePushRequest(pushBody({ operations: [inheritedOperation] })), /own JSON properties/);
});

test('push validation caps batch ids, batch count, and individual payloads', () => {
  assert.throws(() => validatePushRequest(pushBody({ batchId: 'b'.repeat(81) })), /batchId/);
  assert.throws(() => validatePushRequest(pushBody({
    operations: Array.from({ length: MAX_OPS_PER_BATCH + 1 }, (_, index) => operation({ opId: 'op-' + index })),
  })), (error) => error.code === 'payload_too_large' && error.status === 413);

  const content = 'x'.repeat(MAX_PUSH_OPERATION_PAYLOAD_BYTES + 1);
  assert.throws(() => validatePushRequest(pushBody({
    operations: [operation({ payload: { name: content } })],
  })), (error) => error.code === 'payload_too_large' && error.status === 413);
});

test('schema and registry failures reject the whole push before run or transaction persistence', () => {
  const schemaFailure = rejectedPush(pushBody({ operations: [operation({ extra: true })] }));
  assert.equal(schemaFailure.res.statusCode, 400);
  assert.equal(schemaFailure.res.body.error.code, 'invalid_request');
  assert.equal(schemaFailure.starts, 0);
  assert.equal(schemaFailure.transactions, 0);

  const maskFailure = rejectedPush(pushBody({
    operations: [operation({ fieldMask: ['settings.__proto__.polluted'], payload: {} })],
  }));
  assert.equal(maskFailure.res.statusCode, 400);
  assert.equal(maskFailure.res.body.error.code, 'invalid_request');
  assert.equal(maskFailure.starts, 0);
  assert.equal(maskFailure.transactions, 0);
  assert.equal(Object.prototype.polluted, undefined);
});

test('push body limit rejects before authentication, run creation, or transactions', () => {
  const result = rejectedPush(pushBody(), Buffer.alloc(MAX_PUSH_BODY_BYTES + 1));
  assert.equal(result.res.statusCode, 413);
  assert.equal(result.res.body.error.code, 'payload_too_large');
  assert.equal(result.authChecks, 0);
  assert.equal(result.starts, 0);
  assert.equal(result.transactions, 0);
});

test('parent and child registry paths overlap in either direction', () => {
  assert.equal(fieldPathsOverlap('settings', 'settings.theme'), true);
  assert.equal(fieldPathsOverlap('settings.theme', 'settings'), true);
  assert.equal(fieldPathsOverlap('settings.theme', 'settings.theme'), true);
  assert.equal(fieldPathsOverlap('settings.theme', 'settings.locale'), false);
  assert.equal(fieldPathsOverlap('setting', 'settings.theme'), false);

  const api = Object.create(MobileV1Api.prototype);
  api.store = {
    hasOverlap: () => false,
    fieldRevisions: () => new Map([['settings', 3]]),
  };
  assert.equal(api.hasFieldOverlap('user-1', 'settings', 'entity-1', 2, ['settings.theme']), true);
  assert.equal(api.hasFieldOverlap('user-1', 'settings', 'entity-1', 3, ['settings.theme']), false);
});

function postOversized(port, { chunked }) {
  const body = Buffer.concat([
    Buffer.from('{"padding":"'),
    Buffer.alloc(MAX_PUSH_BODY_BYTES + 1024, 0x78),
    Buffer.from('"}'),
  ]);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/mobile/v1/sync/push',
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        connection: 'close',
        ...(chunked ? {} : { 'content-length': String(body.length) }),
      },
    }, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => {
        settled = true;
        resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') });
      });
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    if (chunked) {
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        req.write(body.subarray(offset, offset + 64 * 1024));
      }
      req.end();
    } else {
      req.end(body);
    }
  });
}

test('the dedicated parser rejects declared and chunked bodies before downstream auth/business handlers', async () => {
  const app = express();
  let downstreamCalls = 0;
  app.post('/api/mobile/v1/sync/push', createPushJsonBodyParser(), (_req, res) => {
    downstreamCalls += 1;
    res.json({ ok: true });
  });
  app.use((error, _req, res, _next) => {
    res.status(error.type === 'entity.too.large' ? 413 : 500).json({ code: error.type });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    for (const chunked of [false, true]) {
      const result = await postOversized(port, { chunked });
      assert.equal(result.status, 413, result.body);
      assert.match(result.body, /entity\.too\.large/);
    }
    assert.equal(downstreamCalls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('every caller-controlled AAD part rejects embedded NUL bytes', () => {
  const secret = {
    serverId: 'server-1',
    userId: 'user-1',
    deviceId: 'device-1',
    entityType: 'connection',
    entityId: 'connection-1',
    fieldName: 'password',
    entityRevision: 1,
    keyVersion: 1,
  };
  for (const field of Object.keys(secret)) {
    assert.throws(() => secretAadBytes({ ...secret, [field]: String(secret[field]) + '\u0000suffix' }));
  }

  const shared = {
    serverId: 'server-1',
    userId: 'user-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    resourceId: 'resource-1',
    resourceRevision: 1,
    purpose: 'terminal',
    expiresAt: 1,
    clientNonce: 'nonce-1',
  };
  for (const field of Object.keys(shared)) {
    assert.throws(() => sharedUseAadBytes({ ...shared, [field]: String(shared[field]) + '\u0000suffix' }));
  }
});
