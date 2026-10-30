import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { createDatabase } = require('../sqlite-driver');
const { NotesService } = require('../notes-service');
const { createWebDavProductionManager } = require('../webdav-production');
const { createWebDavSyncRouter } = require('../webdav-sync-routes');
const { createWebDavBackupProvider } = require('../webdav-backup-provider');
const { wrapVaultArchive } = require('../webdav-vault-password');

const secret = () => crypto.randomBytes(32).toString('base64url');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });

function createNotes(db) {
  db.exec(`CREATE TABLE notes (
    note_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '', group_path TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]', linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
    sort_order REAL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, deleted_at INTEGER, visibility TEXT NOT NULL DEFAULT 'private',
    share_with_users INTEGER NOT NULL DEFAULT 0, share_with_admins INTEGER NOT NULL DEFAULT 0,
    allow_ai INTEGER NOT NULL DEFAULT 0, allow_ai_read INTEGER NOT NULL DEFAULT 0,
    allow_ai_write INTEGER NOT NULL DEFAULT 0);`);
  return new NotesService(db, {
    can: () => false, audit() {}, getUserById: (id) => ({ userId: id, status: 'active' }),
  }, () => Date.now(), { mobileChangeBridge: false });
}

test('production manager -> authenticated restore route -> real DAV GET -> NotesService transaction', async () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const notes = createNotes(db);
  const password = secret();
  const provider = createWebDavBackupProvider({
    instanceId: 'restore-source', backupKey: secret(),
    snapshotSource: async () => ({ userId: 'alice', revision: 1, collections: {
      notes: [{ id: 'note-restore', owner_user_id: 'alice', title: 'Restore', content: 'from real DAV GET' }],
    } }),
  });
  const zip = await provider({ userId: 'alice', emit: 'zip' });
  let body = wrapVaultArchive(zip.body, password);
  let getCount = 0;
  const dav = http.createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    getCount += 1;
    res.writeHead(200, { 'content-type': 'application/octet-stream', etag: '"vault-1"' });
    res.end(body);
  });
  const davUrl = await listen(dav);
  const manager = createWebDavProductionManager({
    storage: { rawDb: () => db, getConnectionById: () => null, getProxyRaw: () => null, getSshKeyRaw: () => null },
    env: { WEBDAV_BACKUP_KEY: secret(), WEBDAV_CREDENTIAL_KEY: secret() },
    serviceOptions: { allowHttpLoopback: true, allowLoopback: true, maxRetries: 0 },
  });
  manager.setRestoreServices({ notesService: notes });
  const app = express();
  app.use(express.json());
  app.use('/api/webdav-sync', createWebDavSyncRouter({
    service: manager.service,
    authentication(req, _res, next) { req.user = { userId: 'alice' }; next(); },
    sensitiveRateLimiter(_req, _res, next) { next(); },
    sensitiveVerification(_req, _res, next) { next(); },
  }));
  const api = http.createServer(app);
  const apiUrl = await listen(api);
  const restore = (vaultPassword) => fetch(`${apiUrl}/api/webdav-sync/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaultPassword }),
  });
  try {
    assert.equal(manager.available, true);
    assert.equal(typeof manager.service.restoreFromRemote, 'function');
    manager.service.patchConfig('alice', {
      baseUrl: `${davUrl}/dav/`, remotePath: 'backups', username: 'dav', password: 'dav-secret', enabled: true,
    });
    const wrong = await restore(secret());
    assert.equal(wrong.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
    const success = await restore(password);
    const result = await success.json();
    assert.equal(success.status, 200, JSON.stringify(result));
    assert.equal(result.result.restored.notes, 1);
    assert.equal(notes.get({ userId: 'alice' }, 'note-restore').content, 'from real DAV GET');

    // The stable proxy must retain restore dependencies after database/service rebuild.
    assert.equal(manager.rebuild(), true);
    const replay = await restore(password);
    assert.equal(replay.status, 200, await replay.text());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 1);

    // Truncation/tampering must not add or alter stored notes.
    body = Buffer.from(body);
    body[body.length - 1] ^= 1;
    const tampered = await restore(password);
    assert.equal(tampered.status, 400);
    assert.equal(notes.get({ userId: 'alice' }, 'note-restore').content, 'from real DAV GET');
    assert.equal(getCount, 4);
  } finally {
    await close(api);
    await close(dav);
    await manager.close();
    await provider.close();
    db.close();
  }
});

test('unavailable production proxy exposes restore and returns structured 503', async () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const manager = createWebDavProductionManager({ storage: { rawDb: () => db }, env: {} });
  try {
    assert.equal(typeof manager.service.restoreFromRemote, 'function');
    await assert.rejects(Promise.resolve().then(() => manager.service.restoreFromRemote('alice', {})),
      (error) => error.status === 503 && error.code === 'webdav_unavailable');
  } finally {
    await manager.close();
    db.close();
  }
});
