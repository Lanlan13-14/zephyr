import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

/* Stage 10 acceptance (FREEZE plan §10): AI note tools search-first,
 * read-on-demand, write needs confirmation, cross-user isolation. */

let server;
let adminCookie;
let aCookie;
let bCookie;
let aNoteId;

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-notes-ai');
    adminCookie = boot.cookie;
    // Enable AI so tool routes work
    await server.api(adminCookie, 'PUT', '/api/settings', {
        ai: { enabled: true, providers: [], permissions: { notes: true, remoteExecute: true } },
    });
    await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'noteaiA', password: 'a-pass-1', role: 'user' });
    await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'noteaiB', password: 'b-pass-1', role: 'user' });
    const aLogin = await server.login('noteaiA', 'a-pass-1');
    await server.api(aLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'a-pass-1', newPassword: 'a-real-1' });
    aCookie = aLogin.cookie;
    const bLogin = await server.login('noteaiB', 'b-pass-1');
    await server.api(bLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'b-pass-1', newPassword: 'b-real-1' });
    bCookie = bLogin.cookie;
});

after(async () => {
    await server.cleanup();
});

test('note_create via tools/run creates a note owned by the calling user', async () => {
    const res = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_create',
        args: { title: 'AI Created', content: 'hello from AI', tags: ['ai'], group: 'ops' },
        context: {},
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.result?.note?.noteId, 'must return noteId');
    aNoteId = res.body.result.note.noteId;
});

test('note_search finds notes by keyword; returns summary not full content', async () => {
    const res = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_search',
        args: { query: 'hello' },
        context: {},
    });
    assert.equal(res.status, 200);
    const notes = res.body.result?.notes || [];
    assert.ok(notes.some((n) => n.noteId === aNoteId), 'must find the created note');
    // Summary must not contain the full content
    const found = notes.find((n) => n.noteId === aNoteId);
    assert.ok(!('content' in found), 'search must not return full content');
    assert.ok('summary' in found, 'must return summary');
});

test('note_get returns full content for the owner', async () => {
    const res = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_get',
        args: { noteId: aNoteId },
        context: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.note.content, 'hello from AI');
});

test('user B cannot read user A note via note_get (cross-user isolation)', async () => {
    const res = await server.api(bCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_get',
        args: { noteId: aNoteId },
        context: {},
    });
    assert.ok(res.status >= 400, 'B must not read A note');
});

test('user B cannot update user A note', async () => {
    const res = await server.api(bCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_update',
        args: { noteId: aNoteId, title: 'hacked' },
        context: {},
    });
    assert.ok(res.status >= 400, 'B must not update A note');
});
