import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClientTokenMetadataService } = require('../acl-token-metadata-service.js');
const { FileAgentManager } = require('../file-agent-manager.js');
const { MobileV1ChangeBridge } = require('../mobile-v1-change-bridge.js');
const { createDatabase } = require('../sqlite-driver.js');

function ownerResolver(users) {
  return ({ userId, username, legacy }) => {
    const byId = users.find((user) => user.userId === userId);
    if (byId) return byId;
    if (!legacy) return null;
    return users.find((user) => user.username === username) || null;
  };
}

function routeHarness(manager, verifySensitiveAccess = () => {}) {
  const handlers = new Map();
  const app = {};
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (route, ...chain) => handlers.set(`${method.toUpperCase()} ${route}`, chain.at(-1));
  }
  manager.mountRoutes(app, (_req, _res, next) => next?.(), (req) => req.user, verifySensitiveAccess);
  return (method, route, { user, body = {}, params = {}, query = {} } = {}) => {
    const handler = handlers.get(`${method.toUpperCase()} ${route}`);
    assert.ok(handler, `missing route ${method} ${route}`);
    const response = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    handler({ user, body, params, query }, response);
    return response;
  };
}

function metadataFeed(bridge, ownerUserId) {
  return bridge.store.changePage(ownerUserId, 0, 100).changes
    .filter((change) => change.entityType === 'clientToken');
}

test('Web Client Token routes atomically emit owner-scoped secret-free metadata changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-token-web-feed-'));
  const databaseFile = path.join(directory, 'zephyr.db');
  const db = createDatabase(databaseFile, { forceBuiltin: true });
  const users = [
    { userId: 'owner-a', username: 'alice', status: 'active' },
    { userId: 'owner-b', username: 'bob', status: 'active' },
  ];
  const logs = [];
  const manager = new FileAgentManager({
    tokenFile: path.join(directory, 'agent-tokens.json'),
    tokenKeyFile: path.join(directory, 'crypto', 'client-token-keys.json'),
    db,
    resolveOwner: ownerResolver(users),
    log: (...parts) => logs.push(parts.map(String).join(' ')),
  });
  const bridge = new MobileV1ChangeBridge({ db });
  const service = new ClientTokenMetadataService({ db, source: manager, changeBridge: bridge });
  assert.equal(service.available, true);

  const tokenCanaries = [
    'ALICE_CREATE_SECRET_CANARY_12345678901234567890',
    'BOB_CREATE_SECRET_CANARY_1234567890123456789012',
    'ALICE_ROTATE_SECRET_CANARY_12345678901234567890',
    'ROLLBACK_SECRET_CANARY_123456789012345678901234',
  ];
  manager._generateToken = () => tokenCanaries.shift();
  const verifyCanary = 'SENSITIVE_VERIFY_CANARY_DO_NOT_LOG';
  const invoke = routeHarness(manager, (_req, secret) => assert.equal(secret, verifyCanary));

  try {
    const created = invoke('POST', '/api/rdp/file-agent-tokens', {
      user: users[0], body: { name: 'Alice laptop', length: 50 },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.token.token, 'ALICE_CREATE_SECRET_CANARY_12345678901234567890');
    const tokenId = created.body.token.id;
    assert.equal(bridge.store.fieldRevisions(users[0].userId, 'clientToken', tokenId).get('token'), 1);

    const bobCreated = invoke('POST', '/api/rdp/file-agent-tokens', {
      user: users[1], body: { name: 'Bob phone', length: 50 },
    });
    assert.equal(bobCreated.statusCode, 200);
    const foreignRename = invoke('PATCH', '/api/rdp/file-agent-tokens/:tokenId', {
      user: users[1], params: { tokenId }, body: { name: 'Cross-account rename' },
    });
    assert.equal(foreignRename.statusCode, 404);

    const renamed = invoke('PATCH', '/api/rdp/file-agent-tokens/:tokenId', {
      user: users[0], params: { tokenId }, body: { name: 'Work laptop' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.body.token.name, 'Work laptop');
    assert.equal(bridge.store.fieldRevisions(users[0].userId, 'clientToken', tokenId).get('token'), 1,
      'metadata-only rename must not move the secret CAS ledger');

    const rotated = invoke('POST', '/api/rdp/file-agent-tokens/:tokenId/regenerate', {
      user: users[0], params: { tokenId }, body: { secret: verifyCanary, length: 50 },
    });
    assert.equal(rotated.statusCode, 200);
    assert.equal(rotated.body.token.token, 'ALICE_ROTATE_SECRET_CANARY_12345678901234567890');
    assert.equal(bridge.store.fieldRevisions(users[0].userId, 'clientToken', tokenId).get('token'), 3);

    const revoked = invoke('POST', '/api/rdp/file-agent-tokens/:tokenId/delete', {
      user: users[0], params: { tokenId }, body: { secret: verifyCanary },
    });
    assert.equal(revoked.statusCode, 200);

    const aliceFeed = metadataFeed(bridge, users[0].userId);
    assert.deepEqual(aliceFeed.map((change) => [change.action, change.revision]), [
      ['upsert', 1],
      ['upsert', 2],
      ['upsert', 3],
      ['delete', 4],
    ]);
    assert.deepEqual(aliceFeed.map((change) => change.actorDeviceId), [null, null, null, null]);
    assert.deepEqual(aliceFeed.map((change) => change.entityId), [tokenId, tokenId, tokenId, tokenId]);
    assert.deepEqual(aliceFeed[2].fieldMask, [], 'secret-only rotation has an empty public field mask');
    for (const change of aliceFeed) assert.ok(!change.fieldMask?.includes('token'));
    assert.deepEqual(metadataFeed(bridge, users[1].userId).map((change) => change.entityId), [
      bobCreated.body.token.id,
    ]);
    assert.equal(service.read(users[0], tokenId), null);
    const tombstone = service.read(users[0], tokenId, { includeDeleted: true });
    assert.equal(tombstone.revision, 4);

    const encryptedRow = db.prepare(`SELECT secret_ciphertext, secret_digest, key_id
      FROM encrypted_client_tokens WHERE id = ?`).get(tokenId);
    const feedSurface = JSON.stringify({
      aliceFeed,
      bobFeed: metadataFeed(bridge, users[1].userId),
      outbox: bridge.pendingWakeEvents(),
      projection: tombstone,
      logs,
    });
    for (const canary of [
      created.body.token.token,
      bobCreated.body.token.token,
      rotated.body.token.token,
      verifyCanary,
      encryptedRow.secret_ciphertext,
      Buffer.from(encryptedRow.secret_digest || []).toString('hex'),
      encryptedRow.key_id,
    ].filter(Boolean)) {
      assert.equal(feedSurface.includes(canary), false, `${canary} leaked into metadata/change/log`);
    }

    const beforeRows = db.prepare('SELECT COUNT(*) AS count FROM encrypted_client_tokens').get().count;
    const beforeAliceFeed = aliceFeed.length;
    db.exec(`CREATE TRIGGER reject_client_token_feed BEFORE INSERT ON mobile_sync_changes
      WHEN NEW.entity_type = 'clientToken'
      BEGIN SELECT RAISE(ABORT, 'Client Token feed unavailable'); END;`);
    assert.throws(() => invoke('POST', '/api/rdp/file-agent-tokens', {
      user: users[0], body: { name: 'Must roll back', length: 50 },
    }), /Client Token feed unavailable/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM encrypted_client_tokens').get().count, beforeRows);
    assert.equal(metadataFeed(bridge, users[0].userId).length, beforeAliceFeed);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM mobile_change_outbox
      WHERE owner_user_id = ?`).get(users[0].userId).count, beforeAliceFeed);
  } finally {
    service.uninstall();
    manager.shutdown();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('database rebind replaces the installed seam and mobile-origin rename is not double-emitted', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-token-feed-rebind-'));
  const firstDb = createDatabase(path.join(directory, 'first.db'), { forceBuiltin: true });
  const secondDb = createDatabase(path.join(directory, 'second.db'), { forceBuiltin: true });
  let currentDb = firstDb;
  const user = { userId: 'owner-a', username: 'alice', status: 'active' };
  const manager = new FileAgentManager({
    tokenFile: path.join(directory, 'agent-tokens.json'),
    tokenKeyFile: path.join(directory, 'crypto', 'client-token-keys.json'),
    getDb: () => currentDb,
    resolveOwner: ownerResolver([user]),
    log: () => {},
  });
  const firstBridge = new MobileV1ChangeBridge({ db: firstDb });
  const firstService = new ClientTokenMetadataService({
    db: firstDb, source: manager, changeBridge: firstBridge,
  });
  manager._generateToken = () => 'FIRST_DATABASE_SECRET_CANARY_123456789012345678901';
  const first = manager.createToken(user, 'First database');
  assert.equal(metadataFeed(firstBridge, user.userId).length, 1);

  try {
    currentDb = secondDb;
    assert.equal(manager.rebindTokenDatabase().changed, true);
    const secondBridge = new MobileV1ChangeBridge({ db: secondDb });
    const secondService = new ClientTokenMetadataService({
      db: secondDb, source: manager, changeBridge: secondBridge,
    });
    manager._generateToken = () => 'SECOND_DATABASE_SECRET_CANARY_12345678901234567890';
    const second = manager.createToken(user, 'Second database');
    assert.equal(metadataFeed(firstBridge, user.userId).length, 1, 'the replaced database must receive no event');
    assert.equal(metadataFeed(secondBridge, user.userId).length, 1);
    assert.equal(secondBridge.store.fieldRevisions(user.userId, 'clientToken', second.id).get('token'), 1);
    assert.equal(manager.validateToken(first.token), null);

    const receipt = {};
    secondService.update(user, second.id, { name: 'Renamed from mobile' }, {
      expectedRevision: second.revision,
      mutationContext: { actorDeviceId: 'mobile-device-a', mutationReceipt: receipt },
    });
    const changes = metadataFeed(secondBridge, user.userId);
    assert.equal(changes.length, 2, 'mobile-origin mutation must append exactly one event');
    assert.equal(changes[1].actorDeviceId, 'mobile-device-a');
    assert.equal(receipt.changeSeq, changes[1].changeSeq);
    assert.equal(firstService.originals, null, 'rebind installs a fresh service instead of stacking wrappers');
    secondService.uninstall();
  } finally {
    firstService.uninstall();
    manager.shutdown();
    firstDb.close();
    secondDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
