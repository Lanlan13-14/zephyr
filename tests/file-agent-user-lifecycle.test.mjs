import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAgentManager } = require('../file-agent-manager.js');
const { UserService } = require('../user-service.js');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
    this.terminated = false;
  }

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close'));
  }
}

class FakeSseResponse extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  write(value) {
    this.writes.push(String(value));
  }

  end() {
    this.writableEnded = true;
    queueMicrotask(() => {
      this.emit('finish');
      this.emit('close');
    });
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

class StubbornWebSocket extends FakeWebSocket {
  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
  }
}

function tempTokenFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-agent-lifecycle-'));
  return { directory, tokenFile: path.join(directory, 'agent-tokens.json') };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function persistedBytes(directory) {
  return Buffer.concat(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name))));
}

async function connect(manager, token, deviceId, SocketType = FakeWebSocket) {
  const socket = new SocketType();
  manager.handleConnection(socket);
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'hello',
    protocolVersion: 2,
    token,
    deviceId,
    deviceName: deviceId,
    capabilities: { read: true, binaryRead: true },
    share: { name: deviceId, readOnly: true },
  })));
  await nextTurn();
  const acknowledgement = socket.sent
    .map((value) => {
      try { return JSON.parse(String(value)); } catch { return null; }
    })
    .find((value) => value?.type === 'hello_ack');
  assert.equal(acknowledgement?.ok, true);
  return { socket, agentId: acknowledgement.agentId };
}

test('account cleanup drains agents and SSE, erases caches, persists revocation, and isolates peers', async () => {
  const { directory, tokenFile } = tempTokenFile();
  const logs = [];
  const manager = new FileAgentManager({
    tokenFile,
    teardownTimeoutMs: 50,
    log: (...parts) => logs.push(parts.map(String).join(' ')),
  });
  const oldUser = { userId: 'user-old', username: 'reused-name' };
  const peerUser = { userId: 'user-peer', username: 'peer-name' };
  const oldRecord = manager.createToken(oldUser, 'old device');
  const legacyRecord = manager.createToken(oldUser.username, 'legacy device');
  const peerRecord = manager.createToken(peerUser, 'peer device');
  const oldSecret = oldRecord.token;
  const legacySecret = legacyRecord.token;

  const oldConnection = await connect(manager, oldSecret, 'old-device', StubbornWebSocket);
  const peerConnection = await connect(manager, peerRecord.token, 'peer-device');
  const oldSse = new FakeSseResponse();
  const peerSse = new FakeSseResponse();
  manager.subscribeSse(oldSse, oldUser);
  manager.subscribeSse(peerSse, peerUser);

  manager.binaryReadCache.set(`${oldConnection.agentId}:handle:0:1`, {
    data: Buffer.from([1]), ts: Date.now(), size: 1,
  });
  manager.binaryReadCacheBytes = 1;
  manager.binaryReadQueues.set(`${oldConnection.agentId}:handle`, Promise.resolve());

  const cleanup = manager.deleteUserState(oldUser);
  assert.equal(manager.validateToken(oldSecret), null);
  assert.equal(manager.listTokens(oldUser, { includeToken: true }).length, 0);
  assert.throws(
    () => manager.createToken(oldUser, 'racing token'),
    (error) => error?.code === 'account_cleanup_in_progress',
  );
  const lateSse = new FakeSseResponse();
  assert.equal(manager.subscribeSse(lateSse, oldUser), false);
  assert.equal(lateSse.writableEnded, true);

  const result = await cleanup;
  assert.deepEqual(result, {
    deletedTokens: 2,
    disconnectedAgents: 1,
    closedSubscriptions: 1,
  });
  assert.equal(oldConnection.socket.closeCalls.length, 1);
  assert.equal(oldConnection.socket.terminated, true);
  assert.equal(oldSse.writableEnded, true);
  assert.equal(manager.agents.has(oldConnection.agentId), false);
  assert.equal(manager.sseClients.has(oldSse), false);
  assert.equal([...manager.binaryReadCache.keys()].some((key) => key.startsWith(`${oldConnection.agentId}:`)), false);
  assert.equal([...manager.binaryReadQueues.keys()].some((key) => key.startsWith(`${oldConnection.agentId}:`)), false);
  assert.equal(manager.validateToken(oldSecret), null);
  assert.equal(manager.validateToken(legacySecret), null);

  assert.equal(manager.validateToken(peerRecord.token), peerUser.userId);
  assert.equal(manager.agents.has(peerConnection.agentId), true);
  assert.equal(manager.sseClients.has(peerSse), true);
  assert.equal(manager.listTokens(peerUser).length, 1);

  const oldWriteCount = oldSse.writes.length;
  manager._broadcastEvent({ type: 'file_agent_online' }, oldUser.userId);
  assert.equal(oldSse.writes.length, oldWriteCount);

  const persisted = persistedBytes(directory).toString('utf8');
  assert.equal(persisted.includes(oldSecret), false);
  assert.equal(persisted.includes(legacySecret), false);
  assert.equal(persisted.includes(peerRecord.token), false);
  assert.equal(fs.existsSync(tokenFile), false, 'the plaintext JSON authority is retired');
  const tombstones = manager.db.prepare(`SELECT owner_user_id, secret_digest, deleted_at
    FROM encrypted_client_tokens WHERE owner_user_id = ?`).all(oldUser.userId);
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].secret_digest, null);
  assert.ok(tombstones[0].deleted_at);
  assert.equal(logs.join('\n').includes(oldSecret), false);
  assert.equal(logs.join('\n').includes(legacySecret), false);

  fs.writeFileSync(path.join(directory, '.agent-tokens.json.tmp-crash'), oldSecret);
  const restarted = new FileAgentManager({ tokenFile, log: (...parts) => logs.push(parts.join(' ')) });
  assert.equal(restarted.validateToken(oldSecret), null);
  assert.equal(restarted.validateToken(legacySecret), null);
  assert.equal(restarted.validateToken(peerRecord.token), peerUser.userId);
  assert.equal(fs.existsSync(path.join(directory, '.agent-tokens.json.tmp-crash')), false);
  manager.shutdown();
  restarted.shutdown();
});

test('same-name recreation receives an immutable namespace and never authenticates an old token', async () => {
  const { tokenFile } = tempTokenFile();
  const manager = new FileAgentManager({ tokenFile, teardownTimeoutMs: 20, log: () => {} });
  const deletedUser = { userId: 'generation-one', username: 'same-name' };
  const replacement = { userId: 'generation-two', username: 'same-name' };
  const oldToken = manager.createToken(deletedUser, 'old').token;

  await manager.deleteUserState(deletedUser);
  const replacementToken = manager.createToken(replacement, 'new').token;

  assert.equal(manager.validateToken(oldToken), null);
  assert.equal(manager.validateToken(replacementToken), replacement.userId);
  assert.equal(manager.listTokens(deletedUser).length, 0);
  assert.equal(manager.listTokens(replacement).length, 1);

  const oldSocket = new FakeWebSocket();
  manager.handleConnection(oldSocket);
  oldSocket.emit('message', Buffer.from(JSON.stringify({
    type: 'hello', protocolVersion: 2, token: oldToken, deviceId: 'reused-device',
  })));
  await nextTurn();
  const rejection = oldSocket.sent.map(String).join('\n');
  assert.match(rejection, /"ok":false/);
  assert.equal(manager.listAgentsForUser(replacement).length, 0);
  manager.shutdown();
});

test('legacy username tokens migrate only to a provable active identity and are denied after recycling', async () => {
  const activeFiles = tempTokenFile();
  const legacyToken = 'legacy-token-secret-active';
  fs.writeFileSync(activeFiles.tokenFile, JSON.stringify({
    version: 2,
    tokens: [{
      id: 'legacy-active',
      ownerId: 'legacy-name',
      name: 'legacy',
      token: legacyToken,
      createdAt: 1,
      updatedAt: 1,
    }],
  }));
  const activeUser = { userId: 'active-id', username: 'legacy-name', status: 'active' };
  const activeManager = new FileAgentManager({
    tokenFile: activeFiles.tokenFile,
    log: () => {},
    resolveOwner: () => ({ ...activeUser, legacyOwnerAllowed: true }),
  });
  assert.equal(activeManager.listTokens(activeUser).length, 1);
  assert.equal(activeManager.listTokens(activeUser.username).length, 1);
  assert.equal(activeManager.validateToken(legacyToken), activeUser.userId);
  assert.equal(fs.existsSync(activeFiles.tokenFile), false);
  assert.equal(fs.statSync(`${activeFiles.tokenFile}.migrated`).size, 0);
  const migrated = activeManager.db.prepare(`SELECT id, owner_user_id, secret_ciphertext
    FROM encrypted_client_tokens WHERE id = ?`).get('legacy-active');
  assert.equal(migrated.owner_user_id, activeUser.userId);
  assert.equal(String(migrated.secret_ciphertext).includes(legacyToken), false);

  const recycledFiles = tempTokenFile();
  const recycledToken = 'legacy-token-secret-recycled';
  fs.writeFileSync(recycledFiles.tokenFile, JSON.stringify({
    version: 2,
    tokens: [{
      id: 'legacy-recycled',
      ownerId: 'same-name',
      name: 'legacy',
      token: recycledToken,
      createdAt: 1,
      updatedAt: 1,
    }],
  }));
  const replacement = { userId: 'new-id', username: 'same-name', status: 'active' };
  const recycledManager = new FileAgentManager({
    tokenFile: recycledFiles.tokenFile,
    log: () => {},
    resolveOwner: () => ({ ...replacement, legacyOwnerAllowed: false }),
  });
  assert.equal(recycledManager.listTokens(replacement).length, 0);
  assert.equal(recycledManager.listTokens(replacement.username).length, 0);
  assert.equal(recycledManager.validateToken(recycledToken), null);
  await recycledManager.deleteUserState({ userId: 'old-id', username: 'same-name' });
  assert.equal(fs.existsSync(recycledFiles.tokenFile), false);
  assert.equal(fs.statSync(`${recycledFiles.tokenFile}.migrated`).size, 0);
  const replacementToken = recycledManager.createToken(replacement, 'new generation').token;
  assert.equal(recycledManager.listTokens(replacement.username).length, 1);
  assert.equal(recycledManager.validateToken(replacementToken), replacement.userId);
  activeManager.shutdown();
  recycledManager.shutdown();
});

test('SQLite revocation failure preserves the active token and blocks user delete and recreation', async () => {
  const { directory, tokenFile } = tempTokenFile();
  const logs = [];
  const manager = new FileAgentManager({ tokenFile, teardownTimeoutMs: 20, log: (...parts) => logs.push(parts.join(' ')) });
  const user = { userId: 'user-fail', username: 'write-fail' };
  const record = manager.createToken(user, 'must survive failed transaction');
  manager.tokenStore.revokeOwners = () => {
    const error = new Error('injected SQLite transaction failure');
    error.code = 'token_store_write_failed';
    throw error;
  };

  await assert.rejects(
    manager.deleteUserState(user),
    (error) => error?.code === 'token_store_write_failed' && !error.message.includes(record.token),
  );
  assert.equal(manager.validateToken(record.token), user.userId);
  assert.equal(persistedBytes(directory).includes(Buffer.from(record.token)), false);
  assert.equal(logs.join('\n').includes(record.token), false);

  const activeTarget = {
    userId: user.userId,
    username: user.username,
    role: 'user',
    status: 'active',
    isSuperAdmin: false,
  };
  const deletedTarget = { ...activeTarget, status: 'deleted' };
  let mutated = false;
  const storage = {
    getUserById: () => activeTarget,
    getUser: () => deletedTarget,
    listUsers: () => [activeTarget, { userId: 'admin', role: 'admin', status: 'active' }],
  };
  const service = new UserService(
    storage,
    () => ({}),
    {},
    () => 'hash',
    {
      prepareDeleteUser: () => manager.deleteUserState(user),
      prepareRecreateUser: () => manager.deleteUserState(user),
    },
  );
  service.deleteUser = () => { mutated = true; };
  service.createUser = () => { mutated = true; };
  const actor = { userId: 'admin', isSuperAdmin: true };

  await assert.rejects(service.deleteUserWithLifecycle(actor, user.userId));
  await assert.rejects(service.createUserWithLifecycle(actor, {
    username: user.username,
    password: 'new-password',
  }));
  assert.equal(mutated, false);

  const restarted = new FileAgentManager({ tokenFile, log: () => {} });
  assert.equal(restarted.validateToken(record.token), user.userId);
  restarted.shutdown();
});
