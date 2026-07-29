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

async function runTool(cookie, tool, args = {}) {
    const first = await server.api(cookie, 'POST', '/api/ai/tools/run', { tool, args, context: {} });
    if (!first.body?.result?.confirmationRequired) return first;
    return server.api(cookie, 'POST', `/api/ai/confirm/${first.body.result.confirmation.id}`, { approve: true });
}

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-notes-ai');
    adminCookie = boot.cookie;
    // Enable AI so tool routes work
    await server.api(adminCookie, 'PUT', '/api/settings', {
        ai: { enabled: true, providers: [], permissions: { notesRead: true, notesWrite: true, remoteExecute: true } },
    });
    await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'noteaiA', password: 'a-pass-1', role: 'user' });
    await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'noteaiB', password: 'b-pass-1', role: 'user' });
    const aLogin = await server.login('noteaiA', 'a-pass-1');
    await server.api(aLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'a-pass-1', newPassword: 'a-real-1' });
    aCookie = aLogin.cookie;
    await server.api(aCookie, 'PUT', '/api/me/settings', { 'notes.enabled': true });
    const bLogin = await server.login('noteaiB', 'b-pass-1');
    await server.api(bLogin.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'b-pass-1', newPassword: 'b-real-1' });
    bCookie = bLogin.cookie;
    await server.api(bCookie, 'PUT', '/api/me/settings', { 'notes.enabled': true });
});

after(async () => {
    await server.cleanup();
});

test('note_create via tools/run creates a note owned by the calling user', async () => {
    const res = await runTool(aCookie, 'note_create', { title: 'AI Created', content: 'hello from AI', tags: ['ai'], group: 'ops' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.result?.data?.note?.noteId, 'must return noteId');
    aNoteId = res.body.result.data.note.noteId;
    assert.equal(res.body.result.data.note.allowAiRead, true, 'AI-created notes default allowAiRead=true');
    assert.equal(res.body.result.data.note.allowAiWrite, true, 'AI-created notes default allowAiWrite=true');
});

test('note_search finds notes by keyword; returns summary not full content', async () => {
    const res = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_search',
        args: { query: 'hello' },
        context: {},
    });
    assert.equal(res.status, 200);
    const notes = res.body.result?.data?.notes || [];
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
    assert.equal(res.body.result.data.note.content, 'hello from AI');
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


test('notesRead and notesWrite are enforced independently', async () => {
    let update = await server.api(adminCookie, 'PUT', '/api/settings', {
        ai: { enabled: true, providers: [], permissions: { notesRead: true, notesWrite: false } },
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    const readOk = await server.api(aCookie, 'POST', '/api/ai/tools/run', { tool: 'note_get', args: { noteId: aNoteId } });
    assert.equal(readOk.status, 200, JSON.stringify(readOk.body));
    const writeDenied = await server.api(aCookie, 'POST', '/api/ai/tools/run', { tool: 'note_create', args: { title: 'must fail' } });
    assert.ok(writeDenied.status >= 400, 'notesWrite=false must deny create');

    update = await server.api(adminCookie, 'PUT', '/api/settings', {
        ai: { enabled: true, providers: [], permissions: { notesRead: false, notesWrite: true } },
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    const readDenied = await server.api(aCookie, 'POST', '/api/ai/tools/run', { tool: 'note_get', args: { noteId: aNoteId } });
    assert.ok(readDenied.status >= 400, 'notesRead=false must deny read');
});

test('per-user notes toggle disables AI note tools', async () => {
    await server.api(adminCookie, 'PUT', '/api/settings', {
        ai: { enabled: true, providers: [], permissions: { notesRead: true, notesWrite: true, remoteExecute: true } },
    });
    await server.api(aCookie, 'PUT', '/api/me/settings', { 'notes.enabled': false });
    const denied = await server.api(aCookie, 'POST', '/api/ai/tools/run', { tool: 'note_create', args: { title: 'disabled' } });
    assert.ok(denied.status >= 400);
    assert.match(String(denied.body.error || ''), /未启用笔记/);
    await server.api(aCookie, 'PUT', '/api/me/settings', { 'notes.enabled': true });
});

test('notes without allowAiRead are invisible to AI list/get; write needs allowAiWrite', async () => {
    await server.api(adminCookie, 'PUT', '/api/settings', {
        ai: { enabled: true, providers: [], permissions: { notesRead: true, notesWrite: true, remoteExecute: true } },
    });
    // Human creates a private note via REST without AI flags.
    const created = await server.api(aCookie, 'POST', '/api/notes', {
        title: 'Human private',
        content: 'secret body',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const privateId = created.body.note.noteId;
    assert.equal(created.body.note.allowAiRead, false);
    assert.equal(created.body.note.allowAiWrite, false);

    const listed = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_list',
        args: {},
        context: {},
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const notes = listed.body.result?.data?.notes || [];
    assert.equal(notes.some((n) => n.noteId === privateId), false, 'private note must not appear in AI list');

    const got = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_get',
        args: { noteId: privateId },
        context: {},
    });
    assert.ok(got.status >= 400, 'AI get must fail for allowAiRead=false');
    assert.match(String(got.body.error || got.body.result?.error || ''), /未允许 AI|note_ai_read_disabled|AI/);

    // Enable read only → AI can get but not update.
    const readOnly = await server.api(aCookie, 'PUT', `/api/notes/${privateId}`, {
        allowAiRead: true,
        allowAiWrite: false,
        expectedRevision: created.body.note.revision,
    });
    assert.equal(readOnly.status, 200, JSON.stringify(readOnly.body));
    assert.equal(readOnly.body.note.allowAiRead, true);
    assert.equal(readOnly.body.note.allowAiWrite, false);
    const gotOk = await server.api(aCookie, 'POST', '/api/ai/tools/run', {
        tool: 'note_get',
        args: { noteId: privateId },
        context: {},
    });
    assert.equal(gotOk.status, 200, JSON.stringify(gotOk.body));
    assert.equal(gotOk.body.result.data.note.content, 'secret body');

    const writeDenied = await runTool(aCookie, 'note_update', {
        noteId: privateId,
        title: 'hack',
        expectedRevision: readOnly.body.note.revision,
    });
    assert.ok(writeDenied.status >= 400, 'AI update must fail without allowAiWrite');

    const writable = await server.api(aCookie, 'PUT', `/api/notes/${privateId}`, {
        allowAiWrite: true,
        expectedRevision: readOnly.body.note.revision,
    });
    assert.equal(writable.status, 200, JSON.stringify(writable.body));
    assert.equal(writable.body.note.allowAiWrite, true);
    const writeOk = await runTool(aCookie, 'note_update', {
        noteId: privateId,
        title: 'AI edited',
        expectedRevision: writable.body.note.revision,
    });
    assert.equal(writeOk.status, 200, JSON.stringify(writeOk.body));
    assert.equal(writeOk.body.result?.data?.note?.title || writeOk.body.result?.note?.title, 'AI edited');
});
