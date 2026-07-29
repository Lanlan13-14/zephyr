import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { NotesService } from '../notes-service.js';

function makeService() {
  const db = new Database(':memory:');
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
  const authz = {
    can() { return false; },
    audit() {},
    listSubjectGrants() { return []; },
  };
  return new NotesService(db, authz, () => 1_700_000_000_000);
}

test('human create defaults both AI flags off; listForAi only returns readable', () => {
  const notes = makeService();
  const user = { userId: 'u1', role: 'user' };
  const privateNote = notes.create(user, { title: 'private', content: 'x' });
  assert.equal(privateNote.allowAiRead, false);
  assert.equal(privateNote.allowAiWrite, false);
  const openNote = notes.create(user, { title: 'open', content: 'y', allowAiRead: true, allowAiWrite: true });
  assert.equal(openNote.allowAiRead, true);
  assert.equal(openNote.allowAiWrite, true);

  const forAi = notes.listForAi(user, { limit: 50 });
  assert.equal(forAi.notes.length, 1);
  assert.equal(forAi.notes[0].noteId, openNote.noteId);

  assert.throws(() => notes.assertAiAccess(user, privateNote.noteId), (err) => err.code === 'note_ai_read_disabled');
  const ok = notes.assertAiAccess(user, openNote.noteId);
  assert.equal(ok.noteId, openNote.noteId);
});

test('write implies read; read-only rejects write access', () => {
  const notes = makeService();
  const user = { userId: 'u1', role: 'user' };
  const note = notes.create(user, { title: 'n', content: 'c' });
  const readOnly = notes.update(user, note.noteId, { allowAiRead: true, allowAiWrite: false, expectedRevision: note.revision });
  assert.equal(readOnly.allowAiRead, true);
  assert.equal(readOnly.allowAiWrite, false);
  notes.assertAiAccess(user, note.noteId, { write: false });
  assert.throws(() => notes.assertAiAccess(user, note.noteId, { write: true }), (err) => err.code === 'note_ai_write_disabled');

  const both = notes.update(user, note.noteId, { allowAiWrite: true, expectedRevision: readOnly.revision });
  assert.equal(both.allowAiRead, true);
  assert.equal(both.allowAiWrite, true);
});

test('legacy allowAi alias sets both flags', () => {
  const notes = makeService();
  const user = { userId: 'u1', role: 'user' };
  const note = notes.create(user, { title: 'legacy', content: 'c', allowAi: true });
  assert.equal(note.allowAiRead, true);
  assert.equal(note.allowAiWrite, true);
  assert.equal(note.allowAi, true);
});
