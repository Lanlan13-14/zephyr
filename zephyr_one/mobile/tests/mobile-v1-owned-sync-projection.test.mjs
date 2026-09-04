import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Owned-sync downlink projection.
 *
 * Two production bugs this locks:
 *  1. NotesService.list() redacts `content` to a 240-char preview. Bootstrap
 *     used that list, so One stored titles and empty bodies.
 *  2. Web library rows emit hasPassword=true / password='******' with no
 *     device envelope. One's mirror writer then aborts the whole page, which
 *     is why an empty account "syncs" and an account with connections fails.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { createDatabase } = require(path.join(repoRoot, 'sqlite-driver.js'));
const { MobileV1Api } = require(path.join(repoRoot, 'mobile-v1-routes.js'));
const { MobileV1Store } = require(path.join(repoRoot, 'mobile-v1-store.js'));
const { projectPayload } = require(path.join(repoRoot, 'mobile-v1-entities.js'));
const { NotesService } = require(path.join(repoRoot, 'notes-service.js'));
const mobileCrypto = require(path.join(repoRoot, 'mobile-v1-crypto.js'));

const registry = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'contracts', 'registries', 'entity-registry.json'),
  'utf8',
));
const connectionSpec = registry.entities.find((entity) => entity.type === 'connection');
const noteSpec = registry.entities.find((entity) => entity.type === 'note');
const user = { userId: 'owner-1', username: 'owner', role: 'admin', status: 'active' };

let mlKem = null;
try { mlKem = require('@noble/post-quantum/ml-kem.js').ml_kem768; } catch { mlKem = null; }

function installNotesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
      defaultPassword INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      isSuperAdmin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notes (
      note_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', group_path TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]', linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
      sort_order REAL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER, visibility TEXT NOT NULL DEFAULT 'private',
      share_with_users INTEGER NOT NULL DEFAULT 0, share_with_admins INTEGER NOT NULL DEFAULT 0,
      allow_ai INTEGER NOT NULL DEFAULT 0, allow_ai_read INTEGER NOT NULL DEFAULT 0,
      allow_ai_write INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS resource_acl (
      resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, subject_type TEXT NOT NULL DEFAULT 'user',
      subject_id TEXT NOT NULL, capabilities_json TEXT NOT NULL, granted_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
      PRIMARY KEY (resource_type, resource_id, subject_type, subject_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY, actor_user_id TEXT, target_user_id TEXT, resource_type TEXT,
      resource_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
  `);
  db.prepare(`INSERT INTO users (username, userId, passwordHash, createdAt, updatedAt, role, status)
    VALUES (?, ?, 'x', 1, 1, 'admin', 'active')`).run(user.username, user.userId);
}

function fakeAuthz(db) {
  const lookup = db.prepare('SELECT userId, status, role FROM users WHERE userId = ?');
  return {
    getUserById: (id) => lookup.get(String(id || '')) || null,
    listSubjectGrants: () => [],
    audit() {},
  };
}

test('web note list stays preview-only while owned sync carries the full body', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  try {
    installNotesSchema(db);
    const notes = new NotesService(db, fakeAuthz(db), () => 1_700_000_000_000, { mobileChangeBridge: false });
    const body = '# Runbook\n\n' + 'restart the blue service after approval. '.repeat(20);
    const created = notes.create(user, { title: 'ops', content: body, groupPath: 'ops' });
    assert.ok(body.length > 240);

    const web = notes.list(user, { limit: 50 });
    assert.equal(web.notes.length, 1);
    assert.equal(web.notes[0].content, undefined);
    assert.equal(web.notes[0].preview, body.slice(0, 240));

    const syncRows = notes.listOwnedForSync(user);
    assert.equal(syncRows.length, 1);
    assert.equal(syncRows[0].content, body);
    assert.equal(syncRows[0].preview, undefined);

    const listed = notes.listOwnedForSync(user);
    assert.equal(listed[0].content, body);

    const payload = projectPayload(noteSpec, listed[0]);
    assert.equal(payload.content, body);
    assert.equal(payload.preview, undefined);
    assert.equal(payload.noteId, created.noteId);
  } finally {
    try { db.close(); } catch {}
  }
});

test('sqlite integer columns become JSON booleans and rdpTouchMode stays an enum', () => {
  const payload = projectPayload(connectionSpec, {
    id: 'connection-sql',
    ownerUserId: user.userId,
    revision: 2,
    name: 'rdp',
    host: '10.0.0.9',
    port: 3389,
    protocol: 'RDP',
    username: 'admin',
    password: '',
    privateKey: '',
    rdpClipboard: 1,
    rdpMicrophone: 0,
    rdpCamera: '0',
    rdpStorage: '1',
    rdpLocation: false,
    rdpTouchMode: 'direct',
    visibility: 0,
    tags: '["prod","rdp"]',
    jumpHostIds: '["jh-1"]',
  });
  assert.equal(payload.rdpClipboard, true);
  assert.equal(payload.rdpMicrophone, false);
  assert.equal(payload.rdpCamera, false);
  assert.equal(payload.rdpStorage, true);
  assert.equal(payload.rdpLocation, false);
  assert.equal(payload.rdpTouchMode, 'direct');
  assert.equal(payload.visibility, 'private');
  assert.deepEqual(payload.tags, ['prod', 'rdp']);
  assert.deepEqual(payload.jumpHostIds, ['jh-1']);
  assert.equal(payload.ephemeral, undefined);
  assert.equal(payload.hasPassword, false);
  assert.equal(payload.hasPrivateKey, false);
});

test('secret-bearing connections emit presence flags, never placeholders or plaintext', () => {
  const payload = projectPayload(connectionSpec, {
    id: 'connection-1',
    ownerUserId: user.userId,
    revision: 3,
    name: 'prod',
    host: '10.0.0.8',
    port: 22,
    protocol: 'SSH',
    username: 'root',
    password: 'real-password',
    privateKey: '',
    capabilities: ['view', 'revealSecret'],
    owner: 'own',
    hasPassword: true,
  });
  assert.equal(payload.password, undefined);
  assert.equal(payload.privateKey, undefined);
  assert.equal(payload.capabilities, undefined);
  assert.equal(payload.owner, undefined);
  assert.equal(payload.hasPassword, true);
  assert.equal(payload.hasPrivateKey, false);
  assert.equal(payload.name, 'prod');
});

test('bootstrap seals stored secrets to the bound device and keeps note bodies intact', (t) => {
  if (!mlKem) return t.skip('@noble/post-quantum not installed');
  const pair = mlKem.keygen();
  const db = createDatabase(':memory:', { forceBuiltin: true });
  try {
    installNotesSchema(db);
    const notes = new NotesService(db, fakeAuthz(db), () => 1_700_000_000_001, { mobileChangeBridge: false });
    const body = 'full markdown body that must survive bootstrap';
    const note = notes.create(user, { title: 'keepalive', content: body });
    const connection = {
      id: 'connection-secret',
      ownerUserId: user.userId,
      revision: 4,
      name: 'bastion',
      host: '10.1.1.1',
      port: 22,
      protocol: 'SSH',
      username: 'root',
      password: 's3cret-downlink',
      privateKey: '',
      updatedAt: 4,
    };
    const store = new MobileV1Store({ db, entityRegistry: registry });
    store._hmacKey = Buffer.alloc(32, 0x5a);
    store.serverId = () => 'server-fixture';
    const device = {
      device_id: 'device-1',
      owner_user_id: user.userId,
      refresh_generation: 1,
      encryption_public_key: Buffer.from(pair.publicKey),
    };
    const api = Object.create(MobileV1Api.prototype);
    api.requireDevice = () => ({ user, device });
    api.bootstrapTypes = ['connection', 'note'];
    api.entityByType = new Map([['connection', connectionSpec], ['note', noteSpec]]);
    api.adapters = new Map([
      ['connection', {
        list: () => [connection],
        read: (_user, id) => id === connection.id ? connection : null,
        idOf: (row) => row.id,
        revisionOf: (row) => row.revision,
        residency: () => 'owned',
      }],
      ['note', {
        list: (owner) => notes.listOwnedForSync(owner),
        read: (owner, id) => notes.get(owner, id),
        idOf: (row) => row.noteId,
        revisionOf: (row) => row.revision,
        residency: () => 'owned',
      }],
    ]);
    api.store = store;
    api.serverEncryptionKey = () => ({ publicKey: Buffer.alloc(1184, 7), keyVersion: 1 });
    api.log = () => {};

    const res = {
      statusCode: 200, body: null,
      status(value) { this.statusCode = value; return this; },
      setHeader() {},
      json(value) { this.body = value; return value; },
    };
    api.handleBootstrap({ mobileRequestId: 'request-1', query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body).slice(0, 400));
    assert.equal(res.body.complete, true);

    const connChange = res.body.entities.find((entity) => entity.entityType === 'connection');
    const noteChange = res.body.entities.find((entity) => entity.entityType === 'note');
    assert.ok(connChange, 'connection missing from bootstrap');
    assert.ok(noteChange, 'note missing from bootstrap');
    assert.equal(connChange.payload.password, undefined);
    assert.equal(connChange.payload.hasPassword, true);
    assert.ok(connChange.secretEnvelopes?.password, 'password envelope missing');
    const aad = mobileCrypto.secretAadBytes({
      serverId: 'server-fixture',
      userId: user.userId,
      deviceId: device.device_id,
      entityType: 'connection',
      entityId: connection.id,
      fieldName: 'password',
      entityRevision: connection.revision,
      keyVersion: 1,
    });
    const opened = mobileCrypto.openEnvelope({
      envelope: connChange.secretEnvelopes.password,
      expectedAad: aad,
      privateKey: pair.secretKey,
    });
    assert.equal(opened.toString('utf8'), 's3cret-downlink');
    assert.equal(noteChange.payload.title, 'keepalive');
    assert.equal(noteChange.payload.content, body);
    assert.equal(noteChange.entityId, note.noteId);
  } finally {
    try { db.close(); } catch {}
  }
});
