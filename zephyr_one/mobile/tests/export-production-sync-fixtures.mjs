import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));

const registry = {
  classification: ['editableSync', 'opaquePreserve', 'serverOnly', 'deviceLocal'],
  entities: [{
    type: 'connection',
    ownerField: 'ownerUserId',
    editableFields: ['name'],
    secretFields: [],
    serverAuthorityFields: ['ownerUserId', 'revision'],
    opaquePreserveFields: [],
    deviceLocalFields: [],
  }],
};
const user = { userId: 'owner-1', username: 'owner' };
const device = { device_id: 'device-1', owner_user_id: user.userId, refresh_generation: 1 };
const row = { id: 'connection-1', ownerUserId: user.userId, revision: 1, name: 'fixture', updatedAt: 1 };

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    setHeader() {},
    getHeader() { return undefined; },
    json(value) { this.body = value; return value; },
  };
}

const db = createDatabase(':memory:', { forceBuiltin: true });
try {
  const store = new MobileV1Store({ db, entityRegistry: registry });
  store._hmacKey = Buffer.alloc(32, 0x5a);
  const api = Object.create(MobileV1Api.prototype);
  api.requireDevice = () => ({ user, device });
  api.bootstrapTypes = ['connection'];
  api.entityByType = new Map([['connection', registry.entities[0]]]);
  api.adapters = new Map([['connection', {
    list: () => [row],
    read: (_user, id) => id === row.id ? row : null,
    get: (_user, id) => id === row.id ? row : null,
    idOf: (value) => value.id,
    revisionOf: (value) => value.revision,
  }]]);
  api.store = store;
  store.serverId = () => 'server-fixture';
  api.serverEncryptionKey = () => null;
  api.wake = { capabilities: (route) => ({
    enabled: true,
    transport: 'sse',
    path: route,
    event: 'wake',
    payloadFields: ['cursor', 'epoch', 'reason'],
    heartbeatSec: 25,
    retryMs: 3000,
    supportsLastEventId: true,
    requiresDeviceAccess: true,
    requiresDeviceProof: true,
    maxConnections: 100,
    maxConnectionsPerOwner: 4,
    maxBufferedBytes: 65536,
  }) };

  const bootstrapResponse = fakeResponse();
  api.handleBootstrap({ mobileRequestId: 'fixture-bootstrap', query: {} }, bootstrapResponse);
  if (bootstrapResponse.statusCode !== 200) throw new Error('bootstrap fixture failed');

  store.appendChange({
    ownerUserId: user.userId,
    entityType: 'connection',
    entityId: row.id,
    action: 'upsert',
    revision: row.revision,
    fieldMask: ['name'],
  });
  db.prepare('UPDATE mobile_sync_changes SET changed_at = 2 WHERE owner_user_id = ?')
    .run(user.userId);
  const changes = api.executeChangesForDevice({ user, device }, { sinceCursor: 0, limit: 100 });

  process.stdout.write(JSON.stringify({
    capabilities: api.capabilitiesPayload(),
    bootstrap: bootstrapResponse.body,
    changes,
  }, null, 2) + '\n');
} finally {
  try { db.close(); } catch {}
}
