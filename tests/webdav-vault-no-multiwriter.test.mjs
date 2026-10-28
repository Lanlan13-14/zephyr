import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createDatabase } = require('../sqlite-driver');
const {
  classifyWebdavWriter,
  assertBackupMode,
} = require('../webdav-writer-grade.js');
const {
  WebDavSyncError,
  WebDavSyncService,
} = require('../webdav-sync-service');

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceSource = fs.readFileSync(path.join(here, '../webdav-sync-service.js'), 'utf8');
const gradeSource = fs.readFileSync(path.join(here, '../webdav-writer-grade.js'), 'utf8');

function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const brace = source.indexOf('{', start);
  assert.ok(brace > start, `missing body for ${signature}`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unclosed ${signature}`);
  return '';
}

function memorySecretCrypto() {
  const values = new Map();
  return {
    encryptSecret(value, aad) {
      const ciphertext = `TEST_ENCRYPTED:${crypto.randomUUID()}`;
      values.set(`${aad}:${ciphertext}`, String(value));
      return ciphertext;
    },
    decryptSecret(ciphertext, aad) {
      const value = values.get(`${aad}:${ciphertext}`);
      if (value === undefined) throw new Error('bad test ciphertext');
      return value;
    },
  };
}

function makeService() {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const service = new WebDavSyncService({
    db,
    secretCrypto: memorySecretCrypto(),
    backupProvider: async () => ({ body: Buffer.from('backup-v1') }),
    allowHttpLoopback: true,
    allowLoopback: true,
  });
  return { db, service };
}

test('classifyWebdavWriter keeps original B0/B1/B2 rules; B2 is not relaxed', () => {
  const full = {
    strongEtag: true,
    conditionalWrite: true,
    atomicPublish: true,
    consistentReadback: true,
    writers: 2,
  };
  assert.equal(classifyWebdavWriter(full), 'B2');
  assert.equal(classifyWebdavWriter({ ...full, writers: 3 }), 'B2');
  assert.equal(classifyWebdavWriter({ ...full, writers: 1 }), 'B1');
  assert.equal(classifyWebdavWriter({ ...full, writers: 0 }), 'B0');
  assert.equal(classifyWebdavWriter({ ...full, strongEtag: false }), 'B1');
  assert.equal(classifyWebdavWriter({ ...full, conditionalWrite: false }), 'B1');
  assert.equal(classifyWebdavWriter({ ...full, atomicPublish: false }), 'B1');
  assert.equal(classifyWebdavWriter({ ...full, consistentReadback: false }), 'B1');
  assert.equal(classifyWebdavWriter(null), 'B0');
  assert.equal(classifyWebdavWriter({}), 'B0');
});

test('assertBackupMode never opens multi-writer even on a B2 grade', () => {
  assert.equal(assertBackupMode('B0'), 'backup');
  assert.equal(assertBackupMode('B1', { multiWriter: false }), 'backup');
  assert.equal(assertBackupMode('B2', {}), 'backup');
  assert.throws(
    () => assertBackupMode('B2', { multiWriter: true }),
    (error) => error.code === 'webdav_multiwriter_requires_B2' && error.status === 400,
  );
  assert.throws(
    () => assertBackupMode('B1', { multiWriter: true }),
    (error) => error.code === 'webdav_multiwriter_requires_B2' && error.status === 400,
  );
});

test('patchConfig({ multiWriter: true }) is 400 webdav_multiwriter_requires_B2', () => {
  const { db, service } = makeService();
  assert.throws(
    () => service.patchConfig('alice', { multiWriter: true }),
    (error) => (
      error instanceof WebDavSyncError
      && error.status === 400
      && error.code === 'webdav_multiwriter_requires_B2'
    ),
  );
  assert.equal(service.getConfig('alice').configured, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webdav_sync_configs').get().n, 0);

  const saved = service.patchConfig('alice', {
    baseUrl: 'http://127.0.0.1:9/dav/',
    remotePath: 'backups',
    username: 'dav-user',
    password: 'dav-password',
    enabled: true,
  });
  assert.equal(saved.configured, true);
  assert.throws(
    () => service.patchConfig('alice', { multiWriter: true }),
    (error) => error instanceof WebDavSyncError && error.code === 'webdav_multiwriter_requires_B2',
  );
  assert.equal(service.getConfig('alice').version, saved.version);
});

test('_syncNow source does not mention oplog/ or generations/', () => {
  const method = extractMethod(serviceSource, 'async _syncNow(');
  assert.equal(method.includes('oplog/'), false);
  assert.equal(method.includes('generations/'), false);
  assert.match(method, /zephyr-backup\.bin/);
  assert.match(method, /\.zephyr-upload-/);
  assert.equal(serviceSource.includes('oplog/'), false);
  assert.equal(serviceSource.includes('generations/'), false);
});

test('classifyWebdavWriter predicate in source is not relaxed', () => {
  assert.match(
    gradeSource,
    /strongEtag && conditionalWrite && atomicPublish && consistentReadback && writers > 1/,
  );
  assert.equal(gradeSource.includes('writers >= 1'), false);
  assert.equal(gradeSource.includes('writers > 0'), false);
});
