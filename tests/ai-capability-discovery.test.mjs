import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { searchAvailableCapabilities } from '../ai-capabilities.js';
import { TestServer } from './test-server.mjs';

let server;
let adminCookie;

before(async () => {
    server = new TestServer();
    await server.start();
    ({ cookie: adminCookie } = await server.bootstrapAdmin('capability-discovery-pass'));
    await server.api(adminCookie, 'PUT', '/api/settings', { ai: { enabled: true } });
});

after(async () => {
    await server.cleanup();
});

test('capability registry searches connection lifecycle without exposing human-only actions', () => {
    const results = searchAvailableCapabilities('连接 删除', { limit: 10 });
    assert.ok(results.some((item) => item.id === 'connection.delete'));
    assert.ok(searchAvailableCapabilities('代理 删除', { limit: 10 }).some((item) => item.id === 'proxy.delete'));
    assert.ok(searchAvailableCapabilities('SSH 密钥 指纹', { limit: 10 }).some((item) => item.id === 'sshkey.validate'));
    assert.ok(results.every((item) => item.mode === 'ai'));
    assert.ok(results.every((item) => !Object.hasOwn(item, 'keywords')));
});

test('capability_search tool returns playbook-oriented public metadata', async () => {
    const response = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'capability_search', args: { query: '打开 连接', limit: 5 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.ok, true);
    const open = response.body.result.data.capabilities.find((item) => item.id === 'connection.open');
    assert.ok(open);
    assert.deepEqual(open.toolIds, ['connection_open_v1']);
    assert.equal(open.playbookId, 'asset-management-v1');
    assert.equal(open.risk, 'R2');
    assert.equal(open.confirmation, 'always');
});

test('capability_search rejects unknown fields and hides secret reveal capability', async () => {
    const invalid = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'capability_search', args: { query: '密码', includeHumanOnly: true },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_tool_arguments');

    const search = await server.api(adminCookie, 'POST', '/api/ai/tools/run', {
        tool: 'capability_search', args: { query: '密码', limit: 10 },
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.result.data.capabilities.some((item) => item.id === 'security.secret.reveal'), false);
});
