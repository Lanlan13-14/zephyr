import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDatabase } = require('../sqlite-driver');
const {
  createCredentialCrypto,
  createUserScopedSnapshotSource,
  createWebDavProductionManager,
  decodeProductionKeys,
  persistentBackupInstanceId,
} = require('../webdav-production');

function strongKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function createSnapshotDb() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  db.exec(`
    CREATE TABLE users (userId TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE connections (
      id TEXT PRIMARY KEY, ownerUserId TEXT, ephemeral INTEGER, name TEXT, host TEXT, port INTEGER,
      protocol TEXT, username TEXT, password TEXT, privateKey TEXT, remark TEXT, tags TEXT,
      connectionMode TEXT, proxyId TEXT, jumpHostId TEXT, jumpHostIds TEXT, sshKeyId TEXT,
      rdpSoundMode TEXT, rdpClipboard INTEGER, rdpMicrophone INTEGER, rdpCamera INTEGER,
      rdpStorage INTEGER, rdpLocation INTEGER, rdpResolution TEXT, rdpQuality TEXT, rdpFps INTEGER,
      rdpPipeline TEXT, rdpTouchMode TEXT, rdpTouchSensitivity REAL, rdpDomain TEXT, encoding TEXT,
      visibility TEXT, createdAt INTEGER, updatedAt INTEGER, revision INTEGER, lastConnectedAt INTEGER
    );
    CREATE TABLE proxies (
      id TEXT PRIMARY KEY, ownerUserId TEXT, name TEXT, host TEXT, port INTEGER, type TEXT,
      username TEXT, password TEXT, visibility TEXT, createdAt INTEGER, updatedAt INTEGER, revision INTEGER
    );
    CREATE TABLE ssh_keys (
      id TEXT PRIMARY KEY, ownerUserId TEXT, name TEXT, privateKey TEXT, passphrase TEXT, remark TEXT,
      visibility TEXT, createdAt INTEGER, updatedAt INTEGER, revision INTEGER
    );
    CREATE TABLE jump_hosts (
      id TEXT PRIMARY KEY, ownerUserId TEXT, name TEXT, connectionId TEXT, visibility TEXT,
      createdAt INTEGER, updatedAt INTEGER, revision INTEGER
    );
    CREATE TABLE notes (
      note_id TEXT PRIMARY KEY, owner_user_id TEXT, title TEXT, content TEXT, group_path TEXT,
      tags_json TEXT, linked_connection_ids_json TEXT, sort_order REAL, revision INTEGER,
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, visibility TEXT,
      share_with_users INTEGER, share_with_admins INTEGER, allow_ai INTEGER,
      allow_ai_read INTEGER, allow_ai_write INTEGER
    );
    CREATE TABLE user_settings (user_id TEXT, key TEXT, value TEXT, updated_at INTEGER);
    CREATE TABLE workspaces (
      workspace_id TEXT, user_id TEXT, client_id TEXT, name TEXT, state_json TEXT,
      revision INTEGER, updated_at INTEGER
    );
    CREATE TABLE workspace_portable_identities (
      owner_user_id TEXT, source_client_id TEXT, source_workspace_id TEXT, portable_id TEXT,
      sync_revision INTEGER, projection_json TEXT, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE auth_sessions (token_hash TEXT, user_id TEXT);
    CREATE TABLE audit_events (event_id TEXT, actor_user_id TEXT, metadata_json TEXT);
  `);
  for (const userId of ['alice', 'bob']) {
    db.prepare('INSERT INTO users VALUES (?,?)').run(userId, 'active');
    db.prepare(`INSERT INTO connections
      (id,ownerUserId,ephemeral,name,host,port,protocol,username,password,privateKey,remark,tags,
       connectionMode,jumpHostIds,rdpSoundMode,rdpClipboard,rdpMicrophone,rdpCamera,rdpStorage,
       rdpLocation,rdpResolution,rdpQuality,rdpFps,rdpPipeline,rdpTouchMode,rdpTouchSensitivity,
       rdpDomain,encoding,visibility,createdAt,updatedAt,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `${userId}-connection`, userId, 0, `${userId} host`, `${userId}.example`, 22, 'SSH', userId,
      `${userId}-password`, `${userId}-private-key`, '', '[]', 'direct', '[]', 'local', 1, 0, 0,
      0, 0, '1080p', 'balanced', 30, 'worker-gpu-v2', 'direct', 1.5, '', 'utf-8', 'private',
      10, 20, 2,
    );
    db.prepare(`INSERT INTO proxies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `${userId}-proxy`, userId, `${userId} proxy`, 'proxy.example', 1080, 'socks5', userId,
      `${userId}-proxy-password`, 'private', 10, 21, 2,
    );
    db.prepare(`INSERT INTO ssh_keys VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      `${userId}-key`, userId, `${userId} key`, `${userId}-key-material`, `${userId}-passphrase`,
      '', 'private', 10, 22, 2,
    );
    db.prepare(`INSERT INTO jump_hosts VALUES (?,?,?,?,?,?,?,?)`).run(
      `${userId}-jump`, userId, `${userId} jump`, `${userId}-connection`, 'private', 10, 23, 2,
    );
    db.prepare(`INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `${userId}-note`, userId, `${userId} note`, `${userId} private note`, '', '[]', '[]', null,
      3, 10, 24, null, 'private', 0, 0, 0, 0, 0,
    );
    db.prepare('INSERT INTO user_settings VALUES (?,?,?,?)').run(
      userId, 'appearance.theme', JSON.stringify(userId === 'alice' ? 'light' : 'dark'), 25,
    );
    db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?,?)').run(
      `${userId}-workspace`, userId, `${userId}-client`, `${userId} workspace`,
      JSON.stringify({ tabs: [`${userId}-connection`] }), 4, 26,
    );
    db.prepare(`INSERT INTO workspace_portable_identities
      VALUES (?,?,?,?,?,?,?,?)`).run(
      userId, `${userId}-client`, `${userId}-workspace`,
      `wsp_${userId === 'alice' ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbb'}`,
      1, JSON.stringify({ name: `${userId} workspace`, state: { runtimeSecret: `${userId}-runtime-secret` } }), 27, null,
    );
    db.prepare('INSERT INTO auth_sessions VALUES (?,?)').run(`${userId}-session-secret`, userId);
    db.prepare('INSERT INTO audit_events VALUES (?,?,?)').run(`${userId}-audit`, userId, `${userId}-audit-secret`);
  }
  return db;
}

function fakeStorage(db) {
  const get = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  return {
    rawDb: () => db,
    getConnectionById: (id) => {
      const row = get('connections', id);
      return row && { ...row, tags: JSON.parse(row.tags), jumpHostIds: JSON.parse(row.jumpHostIds) };
    },
    getProxyRaw: (id) => get('proxies', id),
    getSshKeyRaw: (id) => get('ssh_keys', id),
  };
}

test('credential AEAD is dedicated, AAD-bound, and rejects key reuse', () => {
  const backupKey = strongKey();
  const credentialKey = strongKey();
  const keys = decodeProductionKeys({ backupKey, credentialKey });
  const credentialCrypto = createCredentialCrypto(keys.credential);
  const ciphertext = credentialCrypto.encryptSecret('dav-password', 'alice:https://dav.example:password');
  assert.equal(ciphertext.includes('dav-password'), false);
  assert.equal(credentialCrypto.decryptSecret(ciphertext, 'alice:https://dav.example:password'), 'dav-password');
  assert.throws(
    () => credentialCrypto.decryptSecret(ciphertext, 'bob:https://dav.example:password'),
    { code: 'webdav_keys_unavailable' },
  );
  credentialCrypto.close();
  assert.throws(
    () => credentialCrypto.encryptSecret('after-close', 'alice:https://dav.example:password'),
    { code: 'webdav_keys_unavailable' },
  );
  keys.backup.fill(0);
  keys.credential.fill(0);
  assert.throws(
    () => decodeProductionKeys({ backupKey, credentialKey: backupKey }),
    { code: 'webdav_keys_must_differ' },
  );
  assert.throws(
    () => decodeProductionKeys({
      backupKey,
      credentialKey,
      encryptionKey: Buffer.from(backupKey, 'base64url').toString('hex').toUpperCase(),
    }),
    { code: 'webdav_keys_must_differ' },
  );
});

test('persistent backup instance identity survives process-style manager rebuilds', () => {
  const db = createSnapshotDb();
  try {
    const first = persistentBackupInstanceId(db);
    const second = persistentBackupInstanceId(db);
    assert.equal(second, first);
    assert.match(first, /^zephyr-[0-9a-f-]{36}$/);
  } finally {
    db.close();
  }
});

test('snapshot source reads one consistent owner-only whitelist and excludes system tables', async () => {
  const db = createSnapshotDb();
  try {
    const extraSettings = [
      ['appearance.customColors.accent', JSON.stringify('#123456')],
      ['WEBDAV_BACKUP_KEY', JSON.stringify('secret')],
      ['webdav.password', JSON.stringify('dav-secret')],
      ['apiToken', JSON.stringify('token-secret')],
      ['encryption.key', JSON.stringify('encryption-secret')],
      ['system.theme', JSON.stringify('system-secret')],
      ['internal.debug', JSON.stringify('internal-secret')],
      ['locale', JSON.stringify('legacy-secret')],
      ['unknown.preference', JSON.stringify('unknown-secret')],
      ['appearance.customColors.apiToken', JSON.stringify('nested-token-secret')],
    ];
    for (const [key, value] of extraSettings) {
      db.prepare('INSERT INTO user_settings VALUES (?,?,?,?)').run('alice', key, value, 27);
    }
    const snapshot = await createUserScopedSnapshotSource({ storage: fakeStorage(db) })({ userId: 'alice' });
    assert.equal(snapshot.userId, 'alice');
    assert.deepEqual(Object.keys(snapshot.collections).sort(), [
      'connections', 'jumpHosts', 'notes', 'proxies', 'sshKeys', 'userSettings',
      'workspacePortableIdentitiesV1', 'workspaces',
    ]);
    for (const [name, records] of Object.entries(snapshot.collections)) {
      assert.equal(records.length, name === 'userSettings' ? 2 : 1);
      for (const record of records) assert.equal(record.ownerUserId || record.userId, 'alice');
    }
    assert.deepEqual(snapshot.collections.userSettings.map(({ key }) => key), [
      'appearance.customColors.accent',
      'appearance.theme',
    ]);
    const text = JSON.stringify(snapshot);
    assert.equal(text.includes('bob'), false);
    assert.equal(text.includes('alice-session-secret'), false);
    assert.equal(text.includes('alice-audit-secret'), false);
    assert.equal(text.includes('alice-runtime-secret'), false);
    assert.deepEqual(snapshot.collections.workspacePortableIdentitiesV1, [{
      mappingVersion: 1,
      ownerUserId: 'alice',
      sourceClientId: 'alice-client',
      sourceWorkspaceId: 'alice-workspace',
      portableId: 'wsp_aaaaaaaaaaaaaaaaaaaaaaaa',
    }]);
    assert.equal(text.includes('WEBDAV_BACKUP_KEY'), false);
    assert.equal(text.includes('webdav.password'), false);
    for (const secret of [
      'secret', 'dav-secret', 'token-secret', 'encryption-secret', 'system-secret',
      'internal-secret', 'legacy-secret', 'unknown-secret', 'nested-token-secret',
    ]) assert.equal(text.includes(secret), false, `${secret} must not be exported`);
    assert.equal(text.includes('alice-password'), true, 'user credentials are protected by the outer backup AEAD');
  } finally {
    db.close();
  }
});

test('snapshot byte budget stops lazy row iteration before a full snapshot is built', async () => {
  const db = createSnapshotDb();
  const originalPrepare = db.prepare.bind(db);
  let settingRowsRead = 0;
  try {
    db.prepare('INSERT INTO user_settings VALUES (?,?,?,?)').run(
      'alice',
      'appearance.customCss',
      JSON.stringify('x'.repeat(16 * 1024)),
      28,
    );
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!String(sql).includes('FROM user_settings')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'iterate') {
            return (...args) => (function* rows() {
              for (const row of target.iterate(...args)) {
                settingRowsRead += 1;
                yield row;
              }
            }());
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    const source = createUserScopedSnapshotSource({
      storage: fakeStorage(db),
      maxSnapshotBytes: 4096,
    });
    await assert.rejects(source({ userId: 'alice' }), {
      status: 413,
      code: 'webdav_backup_too_large',
    });
    assert.equal(settingRowsRead, 1, 'the iterator must not materialize later rows after the first oversize row');
  } finally {
    db.prepare = originalPrepare;
    db.close();
  }
});

test('portable workspace identity backup tolerates legacy databases but rejects duplicate identity maps', async () => {
  const legacy = createSnapshotDb();
  try {
    legacy.exec('DROP TABLE workspace_portable_identities');
    const snapshot = await createUserScopedSnapshotSource({ storage: fakeStorage(legacy) })({ userId: 'alice' });
    assert.deepEqual(snapshot.collections.workspacePortableIdentitiesV1, []);
  } finally {
    legacy.close();
  }

  const duplicate = createSnapshotDb();
  try {
    duplicate.prepare(`INSERT INTO workspace_portable_identities VALUES (?,?,?,?,?,?,?,?)`).run(
      'alice', 'alice-client', 'different-local-id', 'wsp_aaaaaaaaaaaaaaaaaaaaaaaa', 1, '{}', 30, null,
    );
    await assert.rejects(
      createUserScopedSnapshotSource({ storage: fakeStorage(duplicate) })({ userId: 'alice' }),
      { status: 500, code: 'webdav_backup_failed' },
    );
  } finally {
    duplicate.close();
  }
});

test('portable workspace identity collection has a distinct bounded record limit', async () => {
  const db = createSnapshotDb();
  try {
    for (let index = 0; index <= 4096; index += 1) {
      db.prepare(`INSERT INTO workspace_portable_identities VALUES (?,?,?,?,?,?,?,?)`).run(
        'alice', `client-${index}`, `workspace-${index}`,
        `wsp_${index.toString(36).padStart(24, 'a')}`, 1, '{}', 31, null,
      );
    }
    await assert.rejects(
      createUserScopedSnapshotSource({ storage: fakeStorage(db), maxRecords: 100_000 })({ userId: 'alice' }),
      { status: 413, code: 'webdav_backup_too_large' },
    );
  } finally {
    db.close();
  }
});

test('portable workspace identity rows consume the snapshot byte budget before serialization', async () => {
  const db = createSnapshotDb();
  const originalPrepare = db.prepare.bind(db);
  let identityRowsRead = 0;
  try {
    db.exec(`DELETE FROM connections; DELETE FROM proxies; DELETE FROM ssh_keys; DELETE FROM jump_hosts;
      DELETE FROM notes; DELETE FROM user_settings; DELETE FROM workspaces;
      DELETE FROM workspace_portable_identities;`);
    for (let index = 0; index < 3; index += 1) {
      db.prepare(`INSERT INTO workspace_portable_identities VALUES (?,?,?,?,?,?,?,?)`).run(
        'alice', `byte-client-${index}`, 'w'.repeat(256),
        `wsp_${index.toString(36).padStart(24, 'a')}`, 1, '{}', 31, null,
      );
    }
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!String(sql).includes('FROM workspace_portable_identities')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'iterate') {
            return (...args) => (function* rows() {
              for (const row of target.iterate(...args)) {
                identityRowsRead += 1;
                yield row;
              }
            }());
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    await assert.rejects(
      createUserScopedSnapshotSource({ storage: fakeStorage(db), maxSnapshotBytes: 1024 })({ userId: 'alice' }),
      { status: 413, code: 'webdav_backup_too_large' },
    );
    assert.equal(identityRowsRead, 2, 'the mapping iterator must stop at the first over-budget record');
  } finally {
    db.prepare = originalPrepare;
    db.close();
  }
});

test('missing keys fail closed, are removed from child-process env, and do not touch storage', async () => {
  const db = createSnapshotDb();
  const env = { WEBDAV_BACKUP_KEY: strongKey() };
  const manager = createWebDavProductionManager({ storage: fakeStorage(db), env });
  try {
    assert.equal(manager.available, false);
    assert.equal(manager.unavailableCode, 'webdav_keys_unavailable');
    assert.equal(Object.hasOwn(env, 'WEBDAV_BACKUP_KEY'), false);
    assert.equal(Object.hasOwn(env, 'WEBDAV_CREDENTIAL_KEY'), false);
    await assert.rejects(
      Promise.resolve().then(() => manager.service.getConfig('alice')),
      { status: 503, code: 'webdav_unavailable' },
    );
  } finally {
    await manager.close();
    db.close();
  }
});

test('storage replacement drains the old service and rebuilds on the imported database handle', async () => {
  const firstDb = createSnapshotDb();
  const importedDb = createSnapshotDb();
  let activeDb = firstDb;
  const storage = {
    rawDb: () => activeDb,
    getConnectionById: (id) => fakeStorage(activeDb).getConnectionById(id),
    getProxyRaw: (id) => fakeStorage(activeDb).getProxyRaw(id),
    getSshKeyRaw: (id) => fakeStorage(activeDb).getSshKeyRaw(id),
  };
  const manager = createWebDavProductionManager({
    storage,
    env: {
      WEBDAV_BACKUP_KEY: strongKey(),
      WEBDAV_CREDENTIAL_KEY: strongKey(),
      ENCRYPTION_KEY: strongKey(),
    },
  });
  try {
    manager.service.patchConfig('alice', {
      baseUrl: 'https://old-dav.example/root/',
      remotePath: 'old-database',
      username: 'alice',
      password: 'old-dav-password',
      enabled: true,
    });
    assert.equal(manager.service.getConfig('alice').configured, true);

    await manager.beforeStorageClose();
    assert.equal(manager.available, false);
    await assert.rejects(
      Promise.resolve().then(() => manager.service.getConfig('alice')),
      { status: 503, code: 'webdav_unavailable' },
    );

    activeDb = importedDb;
    assert.equal(manager.rebuild(), true);
    assert.equal(manager.available, true);
    assert.equal(manager.service.getConfig('alice').configured, false);
    assert.equal(firstDb.prepare('SELECT COUNT(*) AS count FROM webdav_sync_configs').get().count, 1);
    assert.equal(importedDb.prepare('SELECT COUNT(*) AS count FROM webdav_sync_configs').get().count, 0);
  } finally {
    await manager.close();
    firstDb.close();
    importedDb.close();
  }
});

test('manager keeps keys in clearable Buffers, closes every copy, and never stringifies key bytes', async () => {
  const db = createSnapshotDb();
  const backupText = strongKey();
  const credentialText = strongKey();
  const backupInput = Buffer.from(backupText, 'base64url');
  const credentialInput = Buffer.from(credentialText, 'base64url');
  backupInput.toString = () => assert.fail('manager must not stringify backup key bytes');
  credentialInput.toString = () => assert.fail('manager must not stringify credential key bytes');
  const env = {
    WEBDAV_BACKUP_KEY: backupInput,
    WEBDAV_CREDENTIAL_KEY: credentialInput,
    ENCRYPTION_KEY: strongKey(),
  };
  const observedKeys = [];
  const originalCreateCipheriv = crypto.createCipheriv;
  crypto.createCipheriv = function observedCreateCipheriv(algorithm, key, ...args) {
    if (algorithm === 'aes-256-gcm' && Buffer.isBuffer(key)) observedKeys.push(key);
    return originalCreateCipheriv.call(this, algorithm, key, ...args);
  };
  const manager = createWebDavProductionManager({
    storage: fakeStorage(db),
    env,
    serviceOptions: {
      lookup: async () => { throw new Error('offline'); },
      timeoutMs: 50,
      maxRetries: 0,
    },
  });

  try {
    assert.equal(manager.available, true);
    assert.equal(Object.hasOwn(env, 'WEBDAV_BACKUP_KEY'), false);
    assert.equal(Object.hasOwn(env, 'WEBDAV_CREDENTIAL_KEY'), false);
    assert.equal(Object.hasOwn(env, 'ENCRYPTION_KEY'), true);
    assert.equal(backupInput.every((byte) => byte === 0), true);
    assert.equal(credentialInput.every((byte) => byte === 0), true);

    manager.service.patchConfig('alice', {
      baseUrl: 'https://dav.example/',
      remotePath: 'backups',
      username: 'alice',
      password: 'dav-password',
      enabled: true,
    });
    await assert.rejects(manager.service.syncNow('alice'));
    const credentialCopy = observedKeys.find((key) => key.equals(Buffer.from(credentialText, 'base64url')));
    const backupCopy = observedKeys.find((key) => key.equals(Buffer.from(backupText, 'base64url')));
    assert.ok(credentialCopy, 'credential crypto must use its owned Buffer');
    assert.ok(backupCopy, 'backup provider must use its owned Buffer');

    assert.equal(manager.rebuild(), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(backupCopy, Buffer.alloc(32), 'rebuild must clear the retired provider key');
    assert.notDeepEqual(credentialCopy, Buffer.alloc(32), 'shared credential key remains live until manager close');
    await manager.close();
    assert.deepEqual(credentialCopy, Buffer.alloc(32));
    assert.equal(manager.available, false);
    await assert.rejects(
      Promise.resolve().then(() => manager.service.getConfig('alice')),
      { status: 503, code: 'webdav_unavailable' },
    );
  } finally {
    await manager.close();
    crypto.createCipheriv = originalCreateCipheriv;
    db.close();
  }
});
