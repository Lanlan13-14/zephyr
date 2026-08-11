import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDatabase } = require('../sqlite-driver');
const { WorkspaceService } = require('../workspace-service');
const { createBackupArchiveBuffer, extractBackupArchive } = require('../backup-archive');

const temporaryDirectories = new Set();

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-workspace-backup-'));
  temporaryDirectories.add(directory);
  return directory;
}

function openWorkspaceDatabase(filename) {
  const db = createDatabase(filename, { forceBuiltin: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      state_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, client_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL,
      ephemeral INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function addConnection(db, id, ownerUserId) {
  db.prepare('INSERT INTO connections (id,ownerUserId,ephemeral) VALUES (?,?,0)').run(id, ownerUserId);
}

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

test('account backup restore preserves owner-scoped portable workspace IDs and portable projection omits client runtime', async () => {
  const directory = temporaryDirectory();
  const sourceFile = path.join(directory, 'source.db');
  let source = openWorkspaceDatabase(sourceFile);
  try {
    addConnection(source, 'alice-connection', 'alice');
    addConnection(source, 'bob-connection', 'bob');
    const sourceWorkspaces = new WorkspaceService(source, { now: () => 100 });
    sourceWorkspaces.put({ userId: 'alice' }, {
      clientId: 'desktop-a',
      workspaceId: 'local-alice',
      name: 'Alice',
      state: {
        tabs: [{ connectionId: 'alice-connection', runtimeSessionId: 'never-portable' }],
        clipboard: 'never-portable',
      },
    });
    sourceWorkspaces.put({ userId: 'bob' }, {
      clientId: 'desktop-b',
      workspaceId: 'local-bob',
      name: 'Bob',
      state: { tabs: [{ connectionId: 'bob-connection' }] },
    });
    const sourceAlice = sourceWorkspaces.portableSyncService.list('alice');
    assert.equal(sourceAlice.length, 1);
    const stablePortableId = sourceAlice[0].workspaceId;
    assert.equal(JSON.stringify(sourceAlice[0]).includes('never-portable'), false);
    source.close();
    source = null;

    const archive = await createBackupArchiveBuffer({ database: fs.readFileSync(sourceFile) });
    const archiveFile = path.join(directory, 'account-backup.zip');
    const outputDirectory = path.join(directory, 'restored');
    fs.writeFileSync(archiveFile, archive, { mode: 0o600 });
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const restored = await extractBackupArchive({ archiveFile, outputDirectory });
    const target = openWorkspaceDatabase(restored.databaseFile);
    try {
      const targetWorkspaces = new WorkspaceService(target, { now: () => 200 });
      const restoredAlice = targetWorkspaces.portableSyncService.list('alice');
      assert.equal(restoredAlice.length, 1);
      assert.equal(restoredAlice[0].workspaceId, stablePortableId);
      assert.equal(targetWorkspaces.portableSyncService.list('bob').length, 1);
      assert.notEqual(targetWorkspaces.portableSyncService.list('alice')[0].workspaceId,
        targetWorkspaces.portableSyncService.list('bob')[0].workspaceId);
    } finally {
      target.close();
    }
  } finally {
    source?.close();
  }
});
