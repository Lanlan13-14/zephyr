import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileAgentManager } = require('../file-agent-manager.js');
const { AgentTokenStore, ENVELOPE_PREFIX } = require('../file-agent-token-store.js');
const { createClientTokenKeyring } = require('../storage.js');
const { createDatabase } = require('../sqlite-driver.js');
const { ClientTokenMetadataService } = require('../acl-token-metadata-service.js');

function freshFiles(prefix = 'zephyr-encrypted-client-token-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    databaseFile: path.join(directory, 'zephyr.db'),
    tokenFile: path.join(directory, 'agent-tokens.json'),
    keyFile: path.join(directory, 'crypto', 'client-token-keys.json'),
  };
}

function openDb(file) {
  return createDatabase(file, { forceBuiltin: true });
}

function allDiskBytes(directory) {
  return Buffer.concat(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name))));
}

function ownerResolver(users) {
  return ({ userId, username, legacy }) => {
    const immutable = users.find((user) => user.userId === userId);
    if (immutable) return immutable;
    if (!legacy) return null;
    const candidate = users.find((user) => user.username === username);
    return candidate ? { ...candidate, legacyOwnerAllowed: true } : null;
  };
}

test('SQLite is authoritative, disk holds only AEAD envelopes, and metadata never exposes credentials', () => {
  const files = freshFiles();
  const db = openDb(files.databaseFile);
  const users = [
    { userId: 'owner-a', username: 'alice', status: 'active' },
    { userId: 'owner-b', username: 'bob', status: 'active' },
  ];
  const logs = [];
  const manager = new FileAgentManager({
    tokenFile: files.tokenFile,
    tokenKeyFile: files.keyFile,
    db,
    resolveOwner: ownerResolver(users),
    log: (...parts) => logs.push(parts.map(String).join(' ')),
  });
  const alice = manager.createToken(users[0], 'Alice laptop');
  const bob = manager.createToken(users[1], 'Bob phone');

  assert.equal(fs.existsSync(files.tokenFile), false);
  assert.equal(manager.validateToken(alice.token), users[0].userId);
  assert.equal(manager.validateToken(bob.token), users[1].userId);
  assert.equal(manager.listTokenMetadata(users[0].userId).length, 1);
  assert.deepEqual(manager.metadataSyncContract, {
    version: 1, storage: 'encrypted-sqlite', secretsEncrypted: true,
  });
  const metadata = manager.listTokenMetadata(users[0].userId)[0];
  assert.deepEqual(Object.keys(metadata).sort(), [
    'createdAt', 'deletedAt', 'id', 'lastUsedAt', 'name', 'ownerId',
    'ownerUserId', 'revision', 'updatedAt',
  ]);
  assert.equal(JSON.stringify(metadata).includes(alice.token), false);
  assert.equal(manager.readTokenMetadata(users[1].userId, alice.id), null);
  const changeBridge = {
    db,
    runMutation(_input, mutate) { return db.transaction(mutate)(); },
  };
  const metadataService = new ClientTokenMetadataService({ db, source: manager, changeBridge });
  assert.equal(metadataService.available, true);
  const renamed = metadataService.update(users[0], alice.id, { name: 'Work laptop' }, { expectedRevision: 1 });
  assert.deepEqual(renamed, {
    id: alice.id,
    ownerUserId: users[0].userId,
    name: 'Work laptop',
    revision: 2,
    createdAt: alice.createdAt,
    updatedAt: renamed.updatedAt,
    lastUsedAt: renamed.lastUsedAt,
  });
  assert.equal(JSON.stringify(renamed).includes(alice.token), false);

  const row = db.prepare('SELECT * FROM encrypted_client_tokens WHERE id = ?').get(alice.id);
  assert.match(row.secret_ciphertext, new RegExp(`^${ENVELOPE_PREFIX}`));
  assert.equal(String(row.secret_ciphertext).includes(alice.token), false);
  assert.equal(row.secret_digest.byteLength, 32);
  assert.equal(row.revision, 2);
  assert.ok(row.key_id);
  for (const canary of [alice.token, bob.token]) {
    assert.equal(allDiskBytes(files.directory).includes(Buffer.from(canary)), false);
    assert.equal(logs.join('\n').includes(canary), false);
  }

  manager.shutdown();
  db.close();
});

test('restart, owner isolation, optimistic concurrency, and revocation remain fail closed', () => {
  const files = freshFiles();
  const users = [
    { userId: 'owner-a', username: 'alice', status: 'active' },
    { userId: 'owner-b', username: 'bob', status: 'active' },
  ];
  let db = openDb(files.databaseFile);
  const storeA = new AgentTokenStore(files.tokenFile, { db, keyFile: files.keyFile });
  const storeB = new AgentTokenStore(files.tokenFile, { db, keyFile: files.keyFile });
  const managerA = new FileAgentManager({ tokenFile: files.tokenFile, tokenStore: storeA, resolveOwner: ownerResolver(users), log: () => {} });
  const managerB = new FileAgentManager({ tokenFile: files.tokenFile, tokenStore: storeB, resolveOwner: ownerResolver(users), log: () => {} });
  const alice = managerA.createToken(users[0], 'Laptop');
  const bob = managerB.createToken(users[1], 'Phone');
  const renamed = managerA.renameTokenMetadata(users[0].userId, alice.id, 'Work laptop', { expectedRevision: 1 });
  assert.equal(renamed.revision, 2);
  assert.throws(
    () => managerB.revokeTokenMetadata(users[0].userId, alice.id, { expectedRevision: 1 }),
    (error) => error?.code === 'revision_conflict',
  );
  assert.equal(managerB.revokeTokenMetadata(users[0].userId, alice.id, { expectedRevision: 2 }), true);
  assert.equal(managerA.validateToken(alice.token), null);
  assert.equal(managerA.validateToken(bob.token), users[1].userId);
  const tombstone = managerA.readTokenMetadata(users[0].userId, alice.id, { includeDeleted: true });
  assert.equal(tombstone.revision, 3);
  assert.ok(tombstone.deletedAt);
  assert.equal(managerA.listTokenMetadata(users[0].userId).length, 0);

  managerA.shutdown();
  managerB.shutdown();
  db.close();
  db = openDb(files.databaseFile);
  const restarted = new FileAgentManager({
    tokenFile: files.tokenFile,
    tokenKeyFile: files.keyFile,
    db,
    resolveOwner: ownerResolver(users),
    log: () => {},
  });
  assert.equal(restarted.validateToken(alice.token), null);
  assert.equal(restarted.validateToken(bob.token), users[1].userId);
  restarted.shutdown();
  db.close();
});

test('dedicated key isolation, rotation, and wrong-key startup are enforced', () => {
  const files = freshFiles();
  const reusedKey = Buffer.alloc(32, 0x41);
  const priorWebDavKey = process.env.WEBDAV_CREDENTIAL_KEY;
  process.env.WEBDAV_CREDENTIAL_KEY = reusedKey.toString('base64url');
  let randomCall = 0;
  const unsafeKeyring = createClientTokenKeyring({
    filePath: path.join(files.directory, 'unsafe-keys.json'),
    randomBytes(size) {
      randomCall += 1;
      return size === 32 && randomCall === 1 ? Buffer.from(reusedKey) : Buffer.alloc(size, 0x42);
    },
  });
  assert.throws(() => unsafeKeyring.ensure(), /must not reuse/);
  if (priorWebDavKey === undefined) delete process.env.WEBDAV_CREDENTIAL_KEY;
  else process.env.WEBDAV_CREDENTIAL_KEY = priorWebDavKey;

  const db = openDb(files.databaseFile);
  const user = { userId: 'owner-a', username: 'alice', status: 'active' };
  const manager = new FileAgentManager({
    tokenFile: files.tokenFile,
    tokenKeyFile: files.keyFile,
    db,
    resolveOwner: ownerResolver([user]),
    log: () => {},
  });
  const token = manager.createToken(user, 'Rotating token');
  const before = db.prepare('SELECT key_id, secret_ciphertext, revision FROM encrypted_client_tokens WHERE id = ?').get(token.id);
  const rotation = manager.rotateTokenEncryptionKey();
  const after = db.prepare('SELECT key_id, secret_ciphertext, revision FROM encrypted_client_tokens WHERE id = ?').get(token.id);
  assert.equal(rotation.rotated, 1);
  assert.notEqual(after.key_id, before.key_id);
  assert.notEqual(after.secret_ciphertext, before.secret_ciphertext);
  assert.equal(after.revision, before.revision, 'cryptographic rotation is not a metadata edit');
  assert.equal(manager.validateToken(token.token), user.userId);
  manager.shutdown();
  db.close();

  const replacementKey = Buffer.alloc(32, 0x55);
  fs.writeFileSync(files.keyFile, `${JSON.stringify({
    version: 1,
    purpose: 'zephyr-client-token-aead-only',
    currentKeyId: Buffer.alloc(16, 0x44).toString('base64url'),
    keys: [{
      id: Buffer.alloc(16, 0x44).toString('base64url'),
      key: replacementKey.toString('base64url'),
      createdAt: Date.now(),
    }],
  })}\n`, { mode: 0o600 });
  const wrongDb = openDb(files.databaseFile);
  const logs = [];
  const wrongKeyManager = new FileAgentManager({
    tokenFile: files.tokenFile,
    tokenKeyFile: files.keyFile,
    db: wrongDb,
    resolveOwner: ownerResolver([user]),
    log: (...parts) => logs.push(parts.map(String).join(' ')),
  });
  assert.equal(wrongKeyManager.validateToken(token.token), null);
  assert.throws(
    () => wrongKeyManager.listTokens(user),
    (error) => ['token_store_unavailable', 'token_key_unavailable', 'token_decryption_failed'].includes(error?.code),
  );
  assert.equal(logs.join('\n').includes(token.token), false);
  wrongKeyManager.shutdown();
  wrongDb.close();
});

test('database rebind changes the authority and does not authenticate a token from the replaced database', () => {
  const files = freshFiles();
  const secondDbFile = path.join(files.directory, 'replacement.db');
  let currentDb = openDb(files.databaseFile);
  const firstDb = currentDb;
  const secondDb = openDb(secondDbFile);
  const user = { userId: 'owner-a', username: 'alice', status: 'active' };
  const manager = new FileAgentManager({
    tokenFile: files.tokenFile,
    tokenKeyFile: files.keyFile,
    getDb: () => currentDb,
    resolveOwner: ownerResolver([user]),
    log: () => {},
  });
  const firstToken = manager.createToken(user, 'Old database');
  assert.equal(manager.validateToken(firstToken.token), user.userId);

  currentDb = secondDb;
  const rebound = manager.rebindTokenDatabase();
  assert.equal(rebound.changed, true);
  assert.equal(manager.db, secondDb);
  assert.equal(manager.validateToken(firstToken.token), null);
  const replacementToken = manager.createToken(user, 'Replacement database');
  assert.equal(manager.validateToken(replacementToken.token), user.userId);
  assert.equal(firstDb.prepare('SELECT COUNT(*) AS count FROM encrypted_client_tokens WHERE deleted_at IS NULL').get().count, 1);
  assert.equal(secondDb.prepare('SELECT COUNT(*) AS count FROM encrypted_client_tokens WHERE deleted_at IS NULL').get().count, 1);

  manager.shutdown();
  firstDb.close();
  secondDb.close();
});
