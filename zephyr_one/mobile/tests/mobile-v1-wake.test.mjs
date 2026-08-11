import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const express = require('express');
const { MobileV1Api } = require('../../../mobile-v1-routes.js');
const { MobileV1Wake } = require('../../../mobile-v1-wake.js');
const mobileProof = require('../../../mobile-v1-proof.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(here, '..', 'contracts', 'openapi-mobile-v1.json');
const WAKE_PATH = '/api/mobile/v1/sync/wake';

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requestProof(privateKey, deviceId, challenge) {
  const signed = mobileProof.signedProofPayload({
    deviceId,
    method: challenge.method,
    canonicalPath: challenge.canonicalPath,
    bodySha256: challenge.bodySha256,
    usage: challenge.usage,
    timestamp: challenge.timestamp,
    nonce: challenge.nonce,
  });
  const proof = crypto.sign('sha256', signed, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return {
    'x-zephyr-device-proof': proof,
    'x-zephyr-proof-timestamp': String(challenge.timestamp),
    'x-zephyr-server-nonce': challenge.nonce,
  };
}

class SseReader {
  constructor(response) {
    this.response = response;
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  async nextWake(timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let boundary = this.buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        if (lines.includes('event: wake')) {
          const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          return { id, data: JSON.parse(data), frame };
        }
        boundary = this.buffer.indexOf('\n\n');
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for wake event');
      const chunk = await within(this.reader.read(), remaining, 'timed out waiting for SSE bytes');
      if (chunk.done) throw new Error('wake stream closed before an event arrived');
      this.buffer += this.decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    }
  }

  async waitForClose(timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('wake stream did not close');
      const chunk = await within(this.reader.read(), remaining, 'wake stream did not close');
      if (chunk.done) return;
    }
  }
}

function makeDevice(ownerId, tokenId) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    ownerId,
    tokenId,
    privateKey: pair.privateKey,
    row: {
      device_id: 'dev-' + crypto.randomUUID(),
      owner_user_id: ownerId,
      token_id: tokenId,
      signing_public_jwk: JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
      enabled: 1,
      revoked_at: null,
    },
  };
}

test('authenticated SSE wake is owner-scoped, resumable and revocation-aware', async (t) => {
  const ownerA = makeDevice('owner-a', 'token-a');
  const ownerB = makeDevice('owner-b', 'token-b');
  const access = new Map([
    ['access-a', ownerA],
    ['access-b', ownerB],
  ]);
  const cursors = new Map([['owner-a', 4], ['owner-b', 9]]);
  const users = new Map([
    ['owner-a', { userId: 'owner-a', username: 'alice', status: 'active' }],
    ['owner-b', { userId: 'owner-b', username: 'bob', status: 'active' }],
  ]);
  const tokenIds = new Map([['alice', 'token-a'], ['bob', 'token-b']]);
  const challenges = new Map();

  const store = {
    registryHash: 'a'.repeat(64),
    serverId: () => 'wake-test-server',
    resolveAccess(credential) {
      const device = access.get(credential);
      if (!device || device.revoked || !device.row.enabled) throw new Error('revoked');
      return device.row;
    },
    touchDevice() {},
    latestCursor(ownerId) { return cursors.get(ownerId) || 0; },
    issueProofChallenge(binding) {
      const nonce = crypto.randomBytes(32).toString('base64url');
      const timestamp = Math.floor(Date.now() / 1000);
      challenges.set(nonce, { ...binding, timestamp, consumed: false });
      return { nonce, timestamp, expiresAt: Date.now() + 30000 };
    },
    consumeProofChallenge(binding) {
      const stored = challenges.get(binding.nonce);
      if (!stored || stored.consumed) return false;
      for (const key of ['ownerUserId', 'deviceId', 'method', 'canonicalPath', 'bodySha256', 'usage', 'timestamp']) {
        if (String(stored[key]) !== String(binding[key])) return false;
      }
      stored.consumed = true;
      return true;
    },
  };
  const wake = new MobileV1Wake({
    epoch: 'test-epoch',
    heartbeatMs: 30,
    maxClients: 4,
    maxClientsPerOwner: 2,
  });
  const api = new MobileV1Api({
    db: {},
    store,
    wake,
    blobs: {},
    entityRegistry: { entities: [] },
    shared: {},
    storage: { getUserBrief: (id) => users.get(id) || null },
    sessionStore: { resolve: () => null },
    resourceService: {},
    notesService: {},
    userSettingsService: {},
    authz: {},
    fileAgentManager: {
      listTokens(username) {
        const id = tokenIds.get(username);
        return id ? [{ id }] : [];
      },
    },
  });
  api.serverEncryptionKey = () => null;

  const app = express();
  app.use(express.json({
    verify(req, _res, buffer) {
      if (req.url.startsWith('/api/mobile/v1')) req.rawBody = buffer;
    },
  }));
  api.mountRoutes(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    wake.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const headersFor = async (credential, device) => {
    const challengeResponse = await fetch(base + '/api/mobile/v1/devices/proof-challenge', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', path: WAKE_PATH, bodySha256: mobileProof.EMPTY_BODY_SHA256 }),
    });
    assert.equal(challengeResponse.status, 200);
    assert.equal(challengeResponse.headers.get('cache-control'), 'no-store, private');
    const { challenge } = await challengeResponse.json();
    return {
      authorization: 'Bearer ' + credential,
      ...requestProof(device.privateKey, device.row.device_id, challenge),
    };
  };

  const missingProof = await fetch(base + WAKE_PATH, {
    headers: { authorization: 'Bearer access-a' },
  });
  assert.equal(missingProof.status, 401);
  assert.equal((await missingProof.json()).error.code, 'device_proof_invalid');

  const caps = api.capabilitiesPayload();
  assert.deepEqual(caps.wake, {
    enabled: true,
    transport: 'sse',
    path: WAKE_PATH,
    event: 'wake',
    payloadFields: ['cursor', 'epoch', 'reason'],
    heartbeatSec: 1,
    retryMs: 3000,
    supportsLastEventId: true,
    requiresDeviceAccess: true,
    requiresDeviceProof: true,
    maxConnections: 4,
    maxConnectionsPerOwner: 2,
    maxBufferedBytes: 65536,
  });
  assert.equal(caps.features.nearRealtimeWake, true);

  const abortA = new AbortController();
  const responseA = await fetch(base + WAKE_PATH, {
    headers: await headersFor('access-a', ownerA),
    signal: abortA.signal,
  });
  assert.equal(responseA.status, 200);
  assert.match(responseA.headers.get('content-type') || '', /^text\/event-stream/);
  assert.equal(responseA.headers.get('cache-control'), 'no-store, no-transform');
  const streamA = new SseReader(responseA);
  const connected = await streamA.nextWake();
  assert.deepEqual(connected.data, { cursor: 4, epoch: 'test-epoch', reason: 'connected' });
  assert.deepEqual(Object.keys(connected.data).sort(), ['cursor', 'epoch', 'reason']);
  assert.doesNotMatch(connected.frame, /owner|entity|secret|token/i);

  /* Fake bridge: production change delivery gets the same three-argument seam. */
  const fakePublisher = {
    publish: (ownerId, cursor, reason) => api.wake.publish(ownerId, cursor, reason),
  };
  cursors.set('owner-a', 5);
  assert.equal(fakePublisher.publish('owner-a', 5, 'change'), 1);
  assert.equal(fakePublisher.publish('owner-a', 5, 'change'), 0, 'duplicate cursor must coalesce');
  assert.equal(fakePublisher.publish('owner-a', 3, 'change'), 0, 'out-of-order cursor must be ignored');
  const changed = await streamA.nextWake();
  assert.deepEqual(changed.data, { cursor: 5, epoch: 'test-epoch', reason: 'change' });

  const abortB = new AbortController();
  const responseB = await fetch(base + WAKE_PATH, {
    headers: await headersFor('access-b', ownerB),
    signal: abortB.signal,
  });
  const streamB = new SseReader(responseB);
  assert.equal((await streamB.nextWake()).data.cursor, 9);
  cursors.set('owner-a', 6);
  assert.equal(fakePublisher.publish('owner-a', 6, 'change'), 1,
    'an owner publish must not count another owner subscriber');
  assert.equal((await streamA.nextWake()).data.cursor, 6);

  abortA.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reconnectAbort = new AbortController();
  const reconnectResponse = await fetch(base + WAKE_PATH, {
    headers: {
      ...await headersFor('access-a', ownerA),
      'last-event-id': 'test-epoch:6',
    },
    signal: reconnectAbort.signal,
  });
  const reconnect = new SseReader(reconnectResponse);
  cursors.set('owner-a', 7);
  assert.equal(fakePublisher.publish('owner-a', 7, 'manual'), 1);
  assert.deepEqual((await reconnect.nextWake()).data, {
    cursor: 7,
    epoch: 'test-epoch',
    reason: 'manual',
  });

  reconnectAbort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const epochAbort = new AbortController();
  const epochResponse = await fetch(base + WAKE_PATH, {
    headers: {
      ...await headersFor('access-a', ownerA),
      'last-event-id': 'stale-epoch:999999',
    },
    signal: epochAbort.signal,
  });
  const epochStream = new SseReader(epochResponse);
  assert.deepEqual((await epochStream.nextWake()).data, {
    cursor: 7,
    epoch: 'test-epoch',
    reason: 'epoch_changed',
  });

  ownerB.revoked = true;
  await streamB.waitForClose();
  epochAbort.abort();
  abortB.abort();
});

test('slow subscribers and owner connection overflow are cleaned without retained maps', () => {
  class FakeRequest extends EventEmitter {
    constructor() {
      super();
      this.headers = {};
    }
  }
  class SlowResponse extends EventEmitter {
    constructor() {
      super();
      this.headers = new Map();
      this.destroyed = false;
      this.writableEnded = false;
      this.writableLength = 0;
      this.socket = { setTimeout() {} };
    }
    setHeader(name, value) { this.headers.set(name, value); }
    flushHeaders() {}
    write() { return false; }
    destroy() { this.destroyed = true; }
    end() { this.writableEnded = true; }
  }

  const capped = new MobileV1Wake({ maxClients: 1, maxClientsPerOwner: 1 });
  const fastResponse = new SlowResponse();
  fastResponse.write = () => true;
  assert.equal(capped.subscribe({
    req: new FakeRequest(),
    res: fastResponse,
    ownerUserId: 'owner',
    deviceId: 'device-1',
    currentCursor: 0,
  }), true);
  assert.equal(capped.subscribe({
    req: new FakeRequest(),
    res: new SlowResponse(),
    ownerUserId: 'owner',
    deviceId: 'device-2',
    currentCursor: 0,
  }), false, 'the second owner connection must be rejected before SSE headers');
  assert.equal(capped.clientCount, 1);
  capped.close();
  assert.equal(capped.clientsByOwner.size, 0);

  const wake = new MobileV1Wake({ maxClients: 1, maxClientsPerOwner: 1 });
  const response = new SlowResponse();
  assert.equal(wake.subscribe({
    req: new FakeRequest(),
    res: response,
    ownerUserId: 'owner',
    deviceId: 'device',
    currentCursor: 1,
  }), true);
  assert.equal(response.destroyed, true, 'write backpressure must destroy the slow response');
  assert.equal(wake.clientCount, 0);
  assert.equal(wake.clientsByOwner.size, 0);
});

test('OpenAPI declares the exact SSE path, payload and AND security requirement', () => {
  const spec = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const operation = spec.paths[WAKE_PATH].get;
  assert.equal(operation.responses['200'].content['text/event-stream'].schema.type, 'string');
  assert.deepEqual(operation.security, [{ DeviceAccess: [], DeviceProof: [] }]);
  assert.equal(operation['x-zephyr-sse-event-schema'], '#/components/schemas/WakeEvent');
  assert.deepEqual(spec.components.schemas.WakeEvent.required, ['cursor', 'epoch', 'reason']);
  assert.equal(spec.components.schemas.WakeEvent.additionalProperties, false);
});
