import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDatabase } = require(path.join(root, 'sqlite-driver.js'));
const { NotesService } = require(path.join(root, 'notes-service.js'));
const { createWebDavBackupProvider } = require(path.join(root, 'webdav-backup-provider.js'));
const { wrapVaultArchive } = require(path.join(root, 'webdav-vault-password.js'));
const { applyUserSnapshot, openVaultPayload } = require(path.join(root, 'webdav-vault-restore.js'));
const { WebDavSyncService } = require(path.join(root, 'webdav-sync-service.js'));
const { generateBackupSecret } = require(path.join(root, 'backup-encryption.js'));

delete process.env.WEBDAV_BACKUP_KEY;

function freshNotes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-vault-restore-'));
  const db = createDatabase(path.join(dir, 'test.db'), { forceBuiltin: true });
  db.exec(`
    CREATE TABLE notes (
      note_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      group_path TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
      sort_order REAL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      visibility TEXT NOT NULL DEFAULT 'private',
      share_with_users INTEGER NOT NULL DEFAULT 0,
      share_with_admins INTEGER NOT NULL DEFAULT 0,
      allow_ai INTEGER NOT NULL DEFAULT 0,
      allow_ai_read INTEGER NOT NULL DEFAULT 0,
      allow_ai_write INTEGER NOT NULL DEFAULT 0
    );
  `);
  const notes = new NotesService(db, {
    can() { return false; },
    audit() {},
    getUserById: (id) => ({ userId: id, status: 'active' }),
  }, () => 1_700_000_000_000, { mobileChangeBridge: false });
  return {
    db,
    notes,
    cleanup() {
      try { db.close(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('password-wrapped zip restores notes without WEBDAV_BACKUP_KEY', async () => {
  const ctx = freshNotes();
  try {
    const user = { userId: 'alice', role: 'user', status: 'active' };
    const provider = createWebDavBackupProvider({
      instanceId: 'instance-main',
      backupKey: crypto.randomBytes(32).toString('base64url'),
      snapshotSource: async () => ({
        userId: 'alice',
        revision: 1,
        collections: {
          notes: [{ owner_user_id: 'alice', id: 'note-restored', title: 'Vault', content: 'hello-from-vault' }],
        },
      }),
    });
    const produced = await provider({ userId: 'alice', emit: 'zip' });
    const password = generateBackupSecret();
    const outer = wrapVaultArchive(produced.body, password);
    const payload = await openVaultPayload(outer, password);
    const result = applyUserSnapshot(payload, { user, notesService: ctx.notes });
    assert.equal(result.restored.notes, 1);
    const note = ctx.notes.get(user, 'note-restored');
    assert.equal(note.title, 'Vault');
    assert.equal(note.content, 'hello-from-vault');
  } finally {
    ctx.cleanup();
  }
});

test('wrong vault password does not insert notes', async () => {
  const ctx = freshNotes();
  try {
    const provider = createWebDavBackupProvider({
      instanceId: 'instance-main',
      backupKey: crypto.randomBytes(32).toString('base64url'),
      snapshotSource: async () => ({
        userId: 'alice',
        revision: 1,
        collections: {
          notes: [{ owner_user_id: 'alice', id: 'note-secret', title: 'Secret', content: 'nope' }],
        },
      }),
    });
    const produced = await provider({ userId: 'alice', emit: 'zip' });
    const outer = wrapVaultArchive(produced.body, generateBackupSecret());
    await assert.rejects(
      () => openVaultPayload(outer, generateBackupSecret()),
      (err) => err && err.code === 'webdav_vault_password_invalid',
    );
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
  } finally {
    ctx.cleanup();
  }
});

test('getConfig never returns the vault password', () => {
  const db = createDatabase(':memory:', { forceBuiltin: true });
  const values = new Map();
  const service = new WebDavSyncService({
    db,
    secretCrypto: {
      encryptSecret(value, aad) {
        const token = `enc:${crypto.randomUUID()}`;
        values.set(`${aad}:${token}`, String(value));
        return token;
      },
      decryptSecret(token, aad) {
        return values.get(`${aad}:${token}`);
      },
    },
    backupProvider: async () => ({ body: Buffer.from('x') }),
    allowHttpLoopback: true,
    allowLoopback: true,
  });
  const password = generateBackupSecret();
  const config = service.patchConfig('alice', {
    baseUrl: 'http://127.0.0.1:9/dav/',
    remotePath: 'backups',
    username: 'dav',
    password: 'dav-pass',
    vaultPassword: password,
    enabled: true,
  });
  assert.equal(config.hasVaultPassword, true);
  assert.equal(JSON.stringify(config).includes(password), false);
  assert.equal(config.vaultPassword, undefined);
});
