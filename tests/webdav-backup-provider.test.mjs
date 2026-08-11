import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unzipper = require('unzipper');
const {
  BACKUP_CONTENT_TYPE,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  PAYLOAD_FORMAT,
  PAYLOAD_VERSION,
  createWebDavBackupProvider,
  decodeBackupKey,
  parseHeader,
  verifyBackup,
} = require('../webdav-backup-provider');

function strongKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function userSnapshot(userId, { revision = 7, collections = {} } = {}) {
  return {
    userId,
    revision,
    collections: {
      connections: [{ ownerUserId: userId, id: `${userId}-connection`, host: 'server.example' }],
      notes: [{ owner_user_id: userId, noteId: `${userId}-note`, content: `private-${userId}` }],
      userSettings: [{ userId, key: 'locale', value: 'en-US' }],
      ...collections,
    },
  };
}

function makeProvider({ key = strongKey(), snapshotSource, ...options } = {}) {
  return {
    key,
    provider: createWebDavBackupProvider({
      instanceId: 'instance-main',
      backupKey: key,
      snapshotSource: snapshotSource || (async ({ userId }) => userSnapshot(userId)),
      now: () => Date.parse('2026-08-11T01:02:03.004Z'),
      ...options,
    }),
  };
}

async function openProduced(produced, key, userId, options = {}) {
  assert.equal(produced.contentType, BACKUP_CONTENT_TYPE);
  const verified = verifyBackup(produced.body, {
    backupKey: key,
    instanceId: options.instanceId || 'instance-main',
    userId,
  });
  const zip = await unzipper.Open.buffer(verified.archive);
  const files = new Map(zip.files.map((entry) => [entry.path, entry]));
  const manifest = JSON.parse((await files.get('manifest.json').buffer()).toString('utf8'));
  const payloadText = (await files.get('user-data.json').buffer()).toString('utf8');
  return { ...verified, zip, files, manifest, payloadText, payload: JSON.parse(payloadText) };
}

test('exports only the requested user snapshot and never packages the instance database', async () => {
  const observed = [];
  const { key, provider } = makeProvider({
    snapshotSource: async (context) => {
      observed.push(context);
      return userSnapshot(context.userId);
    },
  });
  const produced = await provider({ userId: 'alice', target: 'webdav-backup' });
  const opened = await openProduced(produced, key, 'alice');

  assert.equal(observed.length, 1);
  assert.deepEqual(
    { userId: observed[0].userId, target: observed[0].target },
    { userId: 'alice', target: 'webdav-backup' },
  );
  assert.deepEqual([...opened.files.keys()].sort(), ['manifest.json', 'user-data.json']);
  assert.equal(opened.files.has('zephyr.db'), false);
  assert.deepEqual(opened.payload, {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    userId: 'alice',
    exportedAt: '2026-08-11T01:02:03.004Z',
    revision: 7,
    collections: {
      connections: [{ host: 'server.example', id: 'alice-connection', ownerUserId: 'alice' }],
      notes: [{ content: 'private-alice', noteId: 'alice-note', owner_user_id: 'alice' }],
      userSettings: [{ key: 'locale', userId: 'alice', value: 'en-US' }],
    },
  });
  assert.equal(opened.payloadText.includes('private-bob'), false);
  assert.equal(produced.body.includes(Buffer.from('private-alice')), false, 'user data must not be cleartext on WebDAV');
  assert.equal(produced.body.includes(Buffer.from('alice')), false, 'raw user IDs stay inside the encrypted archive');
});

test('uses a stable versioned envelope and a checksummed user-data manifest', async () => {
  const { key, provider } = makeProvider();
  const produced = await provider({ userId: 'alice' });
  const parsed = parseHeader(produced.body);
  const opened = await openProduced(produced, key, 'alice');

  assert.equal(parsed.format, BACKUP_FORMAT);
  assert.equal(parsed.version, BACKUP_VERSION);
  assert.equal(parsed.instanceId, 'instance-main');
  assert.match(parsed.subject, /^[A-Za-z0-9_-]{43}$/);
  assert.match(parsed.keyId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(opened.manifest, {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    backupFormat: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    subject: parsed.subject,
    exportedAt: '2026-08-11T01:02:03.004Z',
    payload: {
      path: 'user-data.json',
      mediaType: 'application/json',
      bytes: Buffer.byteLength(opened.payloadText),
      sha256: crypto.createHash('sha256').update(opened.payloadText).digest('hex'),
    },
  });
});

test('fails closed when source scope is missing, mismatched, unowned, or cross-user', async () => {
  const cases = [
    { label: 'missing operation user', operation: {}, snapshot: userSnapshot('alice') },
    { label: 'wrong root user', operation: { userId: 'alice' }, snapshot: userSnapshot('bob') },
    {
      label: 'other owner row',
      operation: { userId: 'alice' },
      snapshot: userSnapshot('alice', { collections: { notes: [{ owner_user_id: 'bob', content: 'private-bob' }] } }),
    },
    {
      label: 'row without ownership proof',
      operation: { userId: 'alice' },
      snapshot: userSnapshot('alice', { collections: { notes: [{ noteId: 'unscoped' }] } }),
    },
    {
      label: 'nested cross-user reference',
      operation: { userId: 'alice' },
      snapshot: userSnapshot('alice', {
        collections: { notes: [{ owner_user_id: 'alice', share: { targetUserId: 'bob' } }] },
      }),
    },
  ];

  for (const item of cases) {
    let calls = 0;
    const { provider } = makeProvider({ snapshotSource: async () => { calls += 1; return item.snapshot; } });
    await assert.rejects(
      provider(item.operation),
      { code: 'webdav_backup_scope_invalid', message: 'The WebDAV backup data is outside the requested user scope.' },
      item.label,
    );
    if (!item.operation.userId) assert.equal(calls, 0, 'missing user scope must fail before the source runs');
  }
});

test('an already-aborted operation never starts snapshot publication', async () => {
  let sourceCalls = 0;
  const { provider } = makeProvider({
    snapshotSource: async ({ userId }) => {
      sourceCalls += 1;
      return userSnapshot(userId);
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider({ userId: 'alice', signal: controller.signal }), {
    code: 'webdav_backup_aborted',
  });
  assert.equal(sourceCalls, 0);
});

test('portable workspace identity snapshots are exact, owner-scoped, and conflict-free', async () => {
  const portable = {
    mappingVersion: 1,
    ownerUserId: 'alice',
    sourceClientId: 'desktop-a',
    sourceWorkspaceId: 'local-1',
    portableId: 'wsp_aaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const { key, provider } = makeProvider({
    snapshotSource: async () => userSnapshot('alice', {
      collections: { workspacePortableIdentitiesV1: [portable] },
    }),
  });
  const opened = await openProduced(await provider({ userId: 'alice' }), key, 'alice');
  assert.deepEqual(opened.payload.collections.workspacePortableIdentitiesV1, [portable]);

  const invalid = [
    { ...portable, ownerUserId: 'bob' },
    { ...portable, runtimeState: 'must-not-backup' },
    { ...portable, portableId: 'not-a-portable-id' },
    [portable, { ...portable, sourceWorkspaceId: 'local-2' }],
    [portable, { ...portable, portableId: 'wsp_bbbbbbbbbbbbbbbbbbbbbbbb' }],
  ];
  for (const collection of invalid) {
    const { provider: invalidProvider } = makeProvider({
      snapshotSource: async () => userSnapshot('alice', {
        collections: { workspacePortableIdentitiesV1: Array.isArray(collection) ? collection : [collection] },
      }),
    });
    await assert.rejects(invalidProvider({ userId: 'alice' }), { code: 'webdav_backup_scope_invalid' });
  }
});

test('rejects full-instance/system collections and master or WebDAV key material', async () => {
  const forbiddenSnapshots = [
    { userId: 'alice', revision: 1, collections: { users: [{ userId: 'alice' }] } },
    { userId: 'alice', revision: 1, collections: { auth_sessions: [{ user_id: 'alice' }] } },
    userSnapshot('alice', {
      collections: { settings: [{ userId: 'alice', encryptionKey: strongKey() }] },
    }),
    userSnapshot('alice', {
      collections: { settings: [{ userId: 'alice', WEBDAV_BACKUP_KEY: strongKey() }] },
    }),
    userSnapshot('alice', {
      collections: { webdavConfig: [{ userId: 'alice', username: 'dav-user' }] },
    }),
  ];
  for (const snapshot of forbiddenSnapshots) {
    const { provider } = makeProvider({ snapshotSource: async () => snapshot });
    await assert.rejects(provider({ userId: 'alice' }), { code: 'webdav_backup_scope_invalid' });
  }

  const { provider } = makeProvider({ snapshotSource: async () => Buffer.from('whole zephyr.db') });
  await assert.rejects(provider({ userId: 'alice' }), { code: 'webdav_backup_scope_invalid' });
});

test('missing, malformed, wrong-sized, and visibly weak backup keys fail before export', async () => {
  const invalidKeys = [
    undefined,
    '',
    'not-a-256-bit-key',
    Buffer.alloc(31, 1).toString('base64url'),
    Buffer.alloc(32, 0).toString('base64url'),
    'ab'.repeat(32),
  ];
  for (const backupKey of invalidKeys) {
    assert.throws(() => decodeBackupKey(backupKey), { code: 'webdav_backup_key_invalid' });
    let calls = 0;
    assert.throws(() => createWebDavBackupProvider({
        snapshotSource: async () => { calls += 1; return userSnapshot('alice'); },
        instanceId: 'instance-main',
        backupKey,
      }),
      { code: 'webdav_backup_key_invalid' },
    );
    assert.equal(calls, 0);
  }
});

test('uses only WEBDAV_BACKUP_KEY and does not fall back to the ordinary data key', async () => {
  const key = strongKey();
  const previousBackupKey = process.env.WEBDAV_BACKUP_KEY;
  const previousDataKey = process.env.ENCRYPTION_KEY;
  try {
    process.env.WEBDAV_BACKUP_KEY = key;
    process.env.ENCRYPTION_KEY = strongKey();
    const provider = createWebDavBackupProvider({
      snapshotSource: async ({ userId }) => userSnapshot(userId),
      instanceId: 'instance-main',
    });
    const produced = await provider({ userId: 'alice' });
    assert.doesNotThrow(() => verifyBackup(produced.body, {
      backupKey: key,
      instanceId: 'instance-main',
      userId: 'alice',
    }));

    delete process.env.WEBDAV_BACKUP_KEY;
    assert.throws(() => createWebDavBackupProvider({
        snapshotSource: async () => assert.fail('ordinary data key must not permit export'),
        instanceId: 'instance-main',
      }),
      { code: 'webdav_backup_key_invalid' },
    );
  } finally {
    if (previousBackupKey === undefined) delete process.env.WEBDAV_BACKUP_KEY;
    else process.env.WEBDAV_BACKUP_KEY = previousBackupKey;
    if (previousDataKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousDataKey;
  }
});

test('key fingerprints support explicit rotation without writing either key into the archive', async () => {
  const oldKey = strongKey();
  const newKey = strongKey();
  const oldProvider = createWebDavBackupProvider({
    snapshotSource: async ({ userId }) => userSnapshot(userId),
    instanceId: 'instance-main',
    backupKey: oldKey,
  });
  const newProvider = createWebDavBackupProvider({
      snapshotSource: async ({ userId }) => userSnapshot(userId),
      instanceId: 'instance-main',
      backupKey: newKey,
    });
  try {
    const oldBackup = await oldProvider({ userId: 'alice' });
    const newBackup = await newProvider({ userId: 'alice' });
    const oldHeader = parseHeader(oldBackup.body);
    const newHeader = parseHeader(newBackup.body);
    assert.notEqual(oldHeader.keyId, newHeader.keyId);

    const backupKeys = new Map([
      [oldHeader.keyId, oldKey],
      [newHeader.keyId, newKey],
    ]);
    for (const produced of [oldBackup, newBackup]) {
      const verified = verifyBackup(produced.body, {
        backupKeys,
        instanceId: 'instance-main',
        userId: 'alice',
      });
      assert.equal(verified.archive.includes(Buffer.from(oldKey)), false);
      assert.equal(verified.archive.includes(Buffer.from(newKey)), false);
    }
  } finally {
    await Promise.all([oldProvider.close(), newProvider.close()]);
  }
});

test('provider owns a clearable Buffer key and close aborts, drains, and disables exports', async () => {
  const keyText = strongKey();
  const keyInput = Buffer.from(keyText, 'base64url');
  keyInput.toString = () => assert.fail('Buffer backup keys must not be converted to strings');
  let bobStarted;
  let bobAborted = false;
  let heldKey;
  const started = new Promise((resolve) => { bobStarted = resolve; });
  const originalCreateCipheriv = crypto.createCipheriv;
  crypto.createCipheriv = function observedCreateCipheriv(algorithm, key, ...args) {
    if (algorithm === 'aes-256-gcm') heldKey = key;
    return originalCreateCipheriv.call(this, algorithm, key, ...args);
  };

  const provider = createWebDavBackupProvider({
    instanceId: 'instance-main',
    backupKey: keyInput,
    snapshotSource: async ({ userId, signal }) => {
      if (userId !== 'bob') return userSnapshot(userId);
      bobStarted();
      return new Promise((resolve, reject) => {
        const abort = () => {
          bobAborted = true;
          reject(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
  });

  try {
    keyInput.fill(0);
    const produced = await provider({ userId: 'alice' });
    assert.doesNotThrow(() => verifyBackup(produced.body, {
      backupKey: keyText,
      instanceId: 'instance-main',
      userId: 'alice',
    }));
    assert.ok(Buffer.isBuffer(heldKey));
    assert.notStrictEqual(heldKey, keyInput);
    assert.deepEqual(heldKey, Buffer.from(keyText, 'base64url'));

    const pending = provider({ userId: 'bob' });
    await started;
    const closing = provider.close();
    await assert.rejects(pending, { code: 'webdav_backup_failed' });
    await closing;
    assert.equal(bobAborted, true);
    assert.deepEqual(heldKey, Buffer.alloc(32), 'provider key must be zeroed after draining');
    await assert.rejects(provider({ userId: 'alice' }), { code: 'webdav_backup_failed' });
  } finally {
    await provider.close();
    crypto.createCipheriv = originalCreateCipheriv;
  }
});

test('ciphertext, tag, instance, and user scope tampering are rejected', async () => {
  const { key, provider } = makeProvider();
  const { body } = await provider({ userId: 'alice' });
  const parsed = parseHeader(body);
  for (const index of [parsed.ciphertextOffset, body.length - 1]) {
    const tampered = Buffer.from(body);
    tampered[index] ^= 0x01;
    assert.throws(
      () => verifyBackup(tampered, { backupKey: key, instanceId: 'instance-main', userId: 'alice' }),
      { code: 'webdav_backup_verification_failed' },
    );
  }
  assert.throws(
    () => verifyBackup(body, { backupKey: key, instanceId: 'other-instance', userId: 'alice' }),
    { code: 'webdav_backup_instance_mismatch' },
  );
  assert.throws(
    () => verifyBackup(body, { backupKey: key, instanceId: 'instance-main', userId: 'bob' }),
    { code: 'webdav_backup_user_mismatch' },
  );

  const altered = Buffer.from(body);
  const headerStart = parsed.ciphertextOffset - parsed.headerLength;
  const headerText = altered.subarray(headerStart, parsed.ciphertextOffset).toString('utf8');
  const changedSubject = `${parsed.subject[0] === 'A' ? 'B' : 'A'}${parsed.subject.slice(1)}`;
  Buffer.from(headerText.replace(parsed.subject, changedSubject), 'utf8').copy(altered, headerStart);
  assert.throws(
    () => verifyBackup(altered, { backupKey: key, instanceId: 'instance-main', userId: 'alice' }),
    { code: 'webdav_backup_user_mismatch' },
  );
});

test('singleflight is shared only within one user and never crosses tenants', async () => {
  const key = strongKey();
  const calls = new Map();
  let releaseAlice;
  let aliceStarted;
  const aliceGate = new Promise((resolve) => { releaseAlice = resolve; });
  const started = new Promise((resolve) => { aliceStarted = resolve; });
  const provider = createWebDavBackupProvider({
    instanceId: 'instance-main',
    backupKey: key,
    snapshotSource: async ({ userId }) => {
      calls.set(userId, (calls.get(userId) || 0) + 1);
      if (userId === 'alice') {
        aliceStarted();
        await aliceGate;
      }
      return userSnapshot(userId);
    },
  });

  const aliceFirst = provider({ userId: 'alice' });
  await started;
  const aliceSecond = provider({ userId: 'alice' });
  const bob = provider({ userId: 'bob' });
  const bobProduced = await bob;
  releaseAlice();
  const [aliceA, aliceB] = await Promise.all([aliceFirst, aliceSecond]);

  assert.equal(calls.get('alice'), 1);
  assert.equal(calls.get('bob'), 1);
  assert.strictEqual(aliceA, aliceB);
  assert.notStrictEqual(aliceA.body, bobProduced.body);
  assert.equal((await openProduced(aliceA, key, 'alice')).payload.userId, 'alice');
  assert.equal((await openProduced(bobProduced, key, 'bob')).payload.userId, 'bob');
});

test('snapshot and final body size limits fail before returning any partial backup', async () => {
  const largeRecord = (userId, size) => ({ userId, content: crypto.randomBytes(size).toString('base64url') });
  const key = strongKey();
  const snapshotLimited = createWebDavBackupProvider({
    instanceId: 'instance-main',
    backupKey: key,
    maxSnapshotBytes: 1024,
    snapshotSource: async ({ userId }) => ({
      userId,
      revision: 1,
      collections: { notes: [largeRecord(userId, 2048)] },
    }),
  });
  await assert.rejects(snapshotLimited({ userId: 'alice' }), { code: 'webdav_backup_too_large' });

  const outputLimited = createWebDavBackupProvider({
    instanceId: 'instance-main',
    backupKey: key,
    maxSnapshotBytes: 8192,
    maxBackupBytes: 1024,
    snapshotSource: async ({ userId }) => ({
      userId,
      revision: 1,
      collections: { notes: [largeRecord(userId, 2048)] },
    }),
  });
  await assert.rejects(outputLimited({ userId: 'alice' }), { code: 'webdav_backup_too_large' });
});

test('malformed envelopes and source failures expose only stable sanitized errors and no logs', async () => {
  for (const malformed of [undefined, null, {}, Buffer.alloc(0), Buffer.from('not-a-backup')]) {
    assert.throws(
      () => parseHeader(malformed),
      { code: 'webdav_backup_format_invalid', message: 'The WebDAV backup format is invalid.' },
    );
  }

  const key = strongKey();
  const credential = 'other-user:super-secret-password';
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const { provider } = makeProvider({
      key,
      snapshotSource: async () => { throw new Error(`source leaked ${credential}; key=${key}`); },
    });
    const error = await provider({ userId: 'alice' }).then(
      () => assert.fail('provider should reject'),
      (reason) => reason,
    );
    assert.equal(error.message, 'The WebDAV backup failed.');
    const observable = `${error.stack}\n${logs.join('\n')}`;
    assert.equal(observable.includes(key), false);
    assert.equal(observable.includes(credential), false);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});
