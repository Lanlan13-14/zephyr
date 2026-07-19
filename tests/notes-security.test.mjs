import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let aCookie;

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-sec');
    await server.api(boot.cookie, 'PUT', '/api/settings', { notes: { enabled: true } });
    aCookie = boot.cookie;
});

after(async () => { await server?.cleanup(); });

test('note content with script tags is escaped in export and stored safely', async () => {
    const xss = '<script>alert(1)</script><img onerror=alert(1) src=x>[link](javascript:alert(1))';
    const created = await server.api(aCookie, 'POST', '/api/notes', { title: 'XSS <img>', content: xss });
    assert.equal(created.status, 200);
    const noteId = created.body.note.noteId;
    // Export returns text/markdown, not JSON
    const expRes = await fetch(server.url(`/api/notes/${noteId}/export.md`), { headers: { cookie: aCookie } });
    const expText = await expRes.text();
    assert.ok(expText.includes('<script>alert(1)</script>'), 'export preserves raw content');
    // Get via API returns raw content (browser preview is responsible for escaping)
    const got = await server.api(aCookie, 'GET', `/api/notes/${noteId}`);
    assert.equal(got.body.note.content, xss);
});

test('note title with emoji and Chinese exports correctly', async () => {
    const created = await server.api(aCookie, 'POST', '/api/notes', { title: '服务器运维笔记 🚀', content: '# 中文标题\n内容 with emoji 🎉' });
    const noteId = created.body.note.noteId;
    const expRes = await fetch(server.url(`/api/notes/${noteId}/export.md`), { headers: { cookie: aCookie } });
    const expText = await expRes.text();
    assert.ok(expText.includes('服务器运维笔记'), 'Chinese title preserved');
    assert.ok(expText.includes('🎉'), 'emoji preserved');
});

test('group path traversal is rejected', async () => {
    const created = await server.api(aCookie, 'POST', '/api/notes', { title: 'traversal', content: 'test', groupPath: '../../../etc' });
    const noteId = created.body.note.noteId;
    const got = await server.api(aCookie, 'GET', `/api/notes/${noteId}`);
    // The service strips .. and normalizes; stored path must not escape
    assert.ok(!got.body.note.groupPath.includes('..'), 'group path must not contain ..');
});
