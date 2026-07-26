import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;

async function confirm(id) {
    const response = await server.api(adminCookie, 'POST', `/api/ai/confirm/${id}`, { approve: true });
    assert.equal(response.status, 200);
    return response.body.result;
}

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('lifecycle-v1-admin-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });
});

after(async () => {
    await server.cleanup();
});

test('canonical connection lifecycle supports TELNET without credential leaks', async () => {
    const rejectedSecret = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_create_v1',
        args: { name: 'must-reject-secret', protocol: 'TELNET', host: '127.0.0.1', password: 'not-accepted' },
    });
    assert.equal(rejectedSecret.status, 400);
    assert.equal(rejectedSecret.body.code, 'invalid_tool_arguments');

    const pendingCreate = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_create_v1',
        args: {
            name: 'ai-telnet-lifecycle', protocol: 'TELNET', host: '127.0.0.1', port: 1,
            username: 'ops', encoding: 'gbk',
            connectionMode: 'direct',
        },
    });
    assert.equal(pendingCreate.status, 200);
    assert.equal(pendingCreate.body.result.confirmationRequired, true);

    const created = await confirm(pendingCreate.body.result.confirmation.id);
    assert.equal(created.ok, true);
    const connection = created.data.connection;
    assert.equal(connection.protocol, 'TELNET');
    assert.equal(connection.connectionMode, 'direct');
    assert.equal(connection.encoding, 'gbk');
    assert.equal(connection.hasPassword, false);
    assert.equal(Object.hasOwn(connection, 'password'), false);
    assert.equal(Object.hasOwn(connection, 'privateKey'), false);
    assert.equal(connection.revision, 1);

    const openedPending = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_open_v1', args: { connectionId: connection.id },
    });
    assert.equal(openedPending.status, 200);
    const opened = await confirm(openedPending.body.result.confirmation.id);
    assert.equal(opened.ok, true);
    assert.equal(opened.data.uiAction, 'open_connection');
    assert.equal(opened.data.connectionId, connection.id);

    const read = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_get_v1', args: { connectionId: connection.id },
    });
    assert.equal(read.status, 200);
    const revision = read.body.result.data.connection.revision;

    const pendingUpdate = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_update_v1',
        args: { connectionId: connection.id, expectedRevision: revision, name: 'ai-telnet-updated', remark: 'managed by canonical tool' },
    });
    assert.equal(pendingUpdate.status, 200);
    const updated = await confirm(pendingUpdate.body.result.confirmation.id);
    assert.equal(updated.ok, true);
    assert.equal(updated.data.connection.name, 'ai-telnet-updated');
    assert.equal(updated.data.connection.revision, revision + 1);

    const tested = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_test_v1', args: { connectionId: connection.id, timeoutSeconds: 1 },
    });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.result.ok, true);
    assert.equal(tested.body.result.data.connection.id, connection.id);
    assert.equal(Object.hasOwn(tested.body.result.data.connection, 'password'), false);

    const staleDelete = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_delete_v1', args: { connectionId: connection.id, expectedRevision: revision },
    });
    const staleConfirmed = await server.api(adminCookie, 'POST', `/api/ai/confirm/${staleDelete.body.result.confirmation.id}`, { approve: true });
    assert.equal(staleConfirmed.status, 409);
    assert.equal(staleConfirmed.body.code, 'revision_conflict');
});

test('canonical delete rejects stale revision and removes current revision', async () => {
    const listed = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_list_v1', args: { query: 'ai-telnet-updated' },
    });
    const connection = listed.body.result.data.connections.find((item) => item.name === 'ai-telnet-updated');
    assert.ok(connection);

    const stale = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_delete_v1', args: { connectionId: connection.id, expectedRevision: connection.revision - 1 },
    });
    const staleConfirmed = await server.api(adminCookie, 'POST', `/api/ai/confirm/${stale.body.result.confirmation.id}`, { approve: true });
    assert.equal(staleConfirmed.status, 409);
    assert.equal(staleConfirmed.body.code, 'revision_conflict');

    const pendingDelete = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_delete_v1', args: { connectionId: connection.id, expectedRevision: connection.revision },
    });
    const deleted = await confirm(pendingDelete.body.result.confirmation.id);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.data.deleted, true);

    const absent = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'connection_get_v1', args: { connectionId: connection.id },
    });
    assert.equal(absent.status, 404);
});
