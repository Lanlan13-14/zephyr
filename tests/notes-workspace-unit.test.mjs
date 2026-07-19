import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NotesService } from '../notes-service.js';
import { WorkspaceService, scrubState } from '../workspace-service.js';
import { Authz } from '../authz.js';

let tmpDir;
let storage;
let db;
let authz;
let notes;
let workspaces;

function hashPasswordStub(password, salt = 'testsalt') {
    const hash = crypto.pbkdf2Sync(String(password), salt, 1000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-notes-unit-'));
    process.env.ZEPHYR_DATA_DIR = tmpDir;
    process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE = path.join(tmpDir, 'crypto', 'key.json');
    storage = await import('../storage.js');
    storage.init({ hashPassword: hashPasswordStub });
    db = storage.rawDb();
    authz = new Authz(db, { getUserById: (id) => storage.getUserById(id) });
    notes = new NotesService(db, authz);
    // minimal resource stub for restore filtering
    const resources = {
        storage,
        authz,
        _rawResource(type, id) { return type === 'connection' ? storage.getConnectionById(id) : null; },
    };
    workspaces = new WorkspaceService(db, { resources });
});

after(() => {
    try { storage.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('scrubState strips secret-like keys deeply', () => {
    const cleaned = scrubState({
        view: 'terminal',
        tabs: [{ id: '1', connectionId: 'c1', password: 'x' }],
        nested: { apiKey: 'k', keep: true, privateKey: 'pk' },
        token: 't',
    });
    assert.equal(cleaned.view, 'terminal');
    assert.equal(cleaned.tabs[0].connectionId, 'c1');
    assert.equal(cleaned.nested.keep, true);
    assert.ok(!('password' in cleaned.tabs[0]));
    assert.ok(!('apiKey' in cleaned.nested));
    assert.ok(!('privateKey' in cleaned.nested));
    assert.ok(!('token' in cleaned));
});

test('notes service enforces size limits and search', () => {
    const admin = storage.getUser('admin');
    const user = { userId: admin.userId, username: admin.username, role: 'admin', status: 'active' };
    const n = notes.create(user, { title: 'Alpha', content: 'needle in a haystack', tags: ['t1'], groupPath: 'g1' });
    assert.equal(n.title, 'Alpha');
    const found = notes.list(user, { q: 'needle' });
    assert.ok(found.notes.some((x) => x.noteId === n.noteId));
    assert.throws(() => notes.create(user, { title: 'x'.repeat(300) }), /标题/);
});

test('workspace optimistic concurrency', () => {
    const admin = storage.getUser('admin');
    const user = { userId: admin.userId, username: admin.username, role: 'admin', status: 'active' };
    const ws = workspaces.put(user, { clientId: 'c1', name: 'desk', state: { view: 'dashboard' } });
    assert.equal(ws.revision, 1);
    const ws2 = workspaces.put(user, { workspaceId: ws.workspaceId, clientId: 'c1', name: 'desk', state: { view: 'terminal' }, expectedRevision: 1 });
    assert.equal(ws2.revision, 2);
    assert.throws(
        () => workspaces.put(user, { workspaceId: ws.workspaceId, clientId: 'c1', name: 'desk', state: {}, expectedRevision: 1 }),
        (err) => err.status === 409,
    );
});
