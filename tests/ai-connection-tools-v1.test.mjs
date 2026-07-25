import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;
let connectionId;

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('tools-v1-admin-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });
    const created = await server.api(adminCookie, 'POST', '/api/connections', {
        name: 'before-rename', host: '10.0.0.10', username: 'ops', password: 'test-only-secret', protocol: 'SSH',
    });
    assert.equal(created.status, 200);
    connectionId = created.body.connection.id;
});

after(async () => {
    await server.cleanup();
});

test('canonical connection list and get tools are metadata-only', async () => {
    const listed = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_list_v1', args: { protocol: 'SSH', query: 'before' },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.ok, true);
    const row = listed.body.result.data.connections.find((item) => item.id === connectionId);
    assert.equal(row.name, 'before-rename');
    assert.equal(Object.hasOwn(row, 'password'), false);
    assert.equal(Object.hasOwn(row, 'privateKey'), false);
    assert.ok(row.revision > 0);

    const read = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_get_v1', args: { connectionId },
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.result.ok, true);
    assert.equal(read.body.result.data.connection.id, connectionId);
    assert.equal(read.body.result.data.connection.password, undefined);
});

test('canonical tools reject unknown or invalid arguments before work', async () => {
    const invalid = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_list_v1', args: { protocol: 'SSH', unknown: true },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_tool_arguments');

    const missing = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_get_v1', args: {},
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'invalid_tool_arguments');
});

test('canonical rename requires confirmation then enforces revision', async () => {
    const read = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_get_v1', args: { connectionId },
    });
    const revision = read.body.result.data.connection.revision;

    const forged = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_rename_v1', args: { connectionId, name: 'must-still-confirm', expectedRevision: revision }, confirmed: true,
    });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.result.confirmationRequired, true);

    const pending = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_rename_v1', args: { connectionId, name: 'after-rename', expectedRevision: revision },
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.result.confirmationRequired, true);

    const confirmed = await server.api(adminCookie, 'POST', `/api/ai/confirm/${pending.body.result.confirmation.id}`, { approve: true });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.result.ok, true);
    assert.equal(confirmed.body.result.data.connection.name, 'after-rename');
    assert.equal(confirmed.body.result.data.connection.revision, revision + 1);

    const stale = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_rename_v1', args: { connectionId, name: 'must-not-write', expectedRevision: revision },
    });
    assert.equal(stale.status, 200);
    const staleConfirmed = await server.api(adminCookie, 'POST', `/api/ai/confirm/${stale.body.result.confirmation.id}`, { approve: true });
    assert.equal(staleConfirmed.status, 409);
    assert.match(staleConfirmed.body.error, /重新读取/);
});
