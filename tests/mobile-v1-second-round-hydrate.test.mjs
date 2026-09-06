import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  secretFieldsNeedingDownlink,
  changedStoredSecretFields,
  hasStoredSecret,
} = require(path.join(repoRoot, 'mobile-v1-entities.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'zephyr_one', 'mobile', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));

const spec = {
  secretFields: ['password', 'privateKey'],
};

test('rename does not count an empty privateKey as a stored secret change', () => {
  const before = { name: 'old', password: 's3cret', privateKey: '' };
  const after = { name: 'new', password: 's3cret', privateKey: '' };
  assert.deepEqual(changedStoredSecretFields(spec, before, after), []);
  assert.equal(hasStoredSecret(''), false);
  assert.equal(hasStoredSecret('******'), false);
});

test('password replacement is a stored secret change, empty privateKey is not', () => {
  const before = { password: 'old', privateKey: '' };
  const after = { password: 'new', privateKey: '' };
  assert.deepEqual(changedStoredSecretFields(spec, before, after), ['password']);
});

test('incremental name change does not reseal a password whose field-revision lagged', () => {
  const row = { password: 's3cret', privateKey: '' };
  const fields = secretFieldsNeedingDownlink(
    spec,
    row,
    { revision: 3, fieldMask: ['name'] },
    (field) => (field === 'password' ? 2 : 3),
  );
  assert.deepEqual(fields, []);
});

test('full replacement reseals stored secrets only', () => {
  const row = { password: 's3cret', privateKey: '' };
  const fields = secretFieldsNeedingDownlink(
    spec,
    row,
    { revision: 1, fieldMask: [] },
    () => 1,
  );
  assert.deepEqual(fields, ['password']);
});

test('renaming a connection does not stamp privateKey field revision', () => {
  const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
  const { MobileV1ChangeBridge } = require(path.join(repoRoot, 'mobile-v1-change-bridge.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-second-round-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  try {
    const bridge = new MobileV1ChangeBridge({ db, registry });
    const user = { userId: '8f9d1961-1fbb-436c-ab4a-09aaf7c42bce' };
    const id = 'be653bd6-0deb-4759-9574-ad53442476f9';
    const created = {
      id, ownerUserId: user.userId, name: 'old', host: 'h', port: 22, protocol: 'SSH',
      username: 'root', password: 's3cret', privateKey: '', revision: 2,
    };
    bridge.runMutation({
      entityType: 'connection', entityId: id, action: 'upsert', user,
      before: null, changedSecretFields: ['password', 'privateKey'],
    }, () => created);
    const renamed = { ...created, name: 'new', revision: 3 };
    bridge.runMutation({
      entityType: 'connection', entityId: id, action: 'upsert', user,
      before: created,
      changedSecretFields: ['privateKey'],
    }, () => renamed);
    const revisions = bridge.store.fieldRevisions(user.userId, 'connection', id);
    assert.equal(revisions.get('name'), 3);
    assert.equal(revisions.get('password'), 2);
    assert.notEqual(revisions.get('privateKey'), 3);
    const page = bridge.store.changePage(user.userId, 0, 20);
    const rename = page.changes.find((change) => change.revision === 3);
    assert.deepEqual(rename.fieldMask, ['name']);
    const downlink = secretFieldsNeedingDownlink(
      spec,
      { ...created, name: 'new', revision: 3 },
      rename,
      (field) => bridge.store.fieldRevision(user.userId, 'connection', id, field),
    );
    assert.deepEqual(downlink, []);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

