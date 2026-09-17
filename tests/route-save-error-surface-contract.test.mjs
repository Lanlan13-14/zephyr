import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const app = read('public/app.js');

/** Extract one top-level `async function <name>(...) { ... }` body by brace
 *  matching, so an assertion cannot accidentally match a neighbouring
 *  function that happens to contain the right words. */
function functionBody(source, name) {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} not found`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`unterminated function ${name}`);
}

/*
 * Saving a route that the server refuses is a normal outcome: the Agent is
 * offline, the hop is not usable, the name is taken. The form handlers are
 * bound straight to 'submit', so any rejection they do not catch reaches
 * window.onunhandledrejection, which reports the generic "前端异步错误" toast
 * and hides the reason the server actually gave. That is what users saw when
 * saving jump-host settings.
 */

test('the global unhandled-rejection toast still exists as the last resort', () => {
    // If this ever goes away the tests below stop describing a real risk.
    assert.match(app, /addEventListener\('unhandledrejection'/);
    assert.match(app, /前端异步错误/);
});

test('saveConnection reports the server error instead of leaking a rejection', () => {
    const body = functionBody(app, 'saveConnection');
    assert.match(body, /try \{/, 'the save call must be guarded');
    assert.match(body, /catch \(err\)/);
    // The user must see the server's message, not a generic failure.
    assert.match(body, /toast\(err\?\.message \|\| t\('保存失败'\)\)/);
    // A failed save must not close the modal or claim success.
    const catchBlock = body.slice(body.indexOf('catch (err)'));
    const returnIndex = catchBlock.indexOf('return;');
    assert.notEqual(returnIndex, -1, 'the catch must stop the success path');
    const beforeReturn = catchBlock.slice(0, returnIndex);
    assert.doesNotMatch(beforeReturn, /closeModal\(\)/);
    assert.doesNotMatch(beforeReturn, /连接已保存/);
});

test('saveProxy reports the server error instead of leaking a rejection', () => {
    const body = functionBody(app, 'saveProxy');
    assert.match(body, /try \{/);
    assert.match(body, /catch \(err\)/);
    assert.match(body, /toast\(err\?\.message \|\| t\('保存失败'\)\)/);
    const catchBlock = body.slice(body.indexOf('catch (err)'));
    const returnIndex = catchBlock.indexOf('return;');
    assert.notEqual(returnIndex, -1, 'the catch must stop the success path');
    const beforeReturn = catchBlock.slice(0, returnIndex);
    assert.doesNotMatch(beforeReturn, /closeProxyModal\(\)/);
    assert.doesNotMatch(beforeReturn, /代理已保存/);
});

test('an Agent-typed proxy save carries the agent id the server reads', () => {
    const body = functionBody(app, 'saveProxy');
    assert.match(body, /if \(type === 'agent'\) payload\.agentId =/);
});

test('the save-failure toast key exists in both catalogs', () => {
    // A missing key would render the raw string and fail the i18n audit.
    for (const locale of ['zh-CN', 'en']) {
        const catalog = JSON.parse(read(`public/i18n/locales/${locale}.json`));
        assert.ok(
            Object.prototype.hasOwnProperty.call(catalog, '保存失败'),
            `保存失败 missing from ${locale}`,
        );
    }
});

test('the server keeps Agent bastion proxy validation out of the 500 path', () => {
    const server = read('server.js');
    // getAgent() never existed; calling it made every Agent bastion proxy
    // save a 500 TypeError before any validation ran.
    assert.doesNotMatch(server, /fileAgentManager(?:\?\.|\.)getAgent\(/);
    assert.match(server, /fileAgentManager\.getAgentInfo\(String\(b\.agentId\)\)/);
    // Ownership is enforced for both create and edit of an Agent bastion.
    assert.match(server, /isAgentOwnedByUser\(String\(b\.agentId\), req\.user\)/);
    assert.match(server, /isAgentOwnedByUser\(agentId, req\.user\)/);
    // The edit path must not rewrite an Agent bastion's port to the SOCKS
    // default: `Number(0) || 1080` produced a proxy that could never connect.
    assert.match(server, /name: String\(b\.name \?\? old\.name\), host: agentId, port: 0, type: 'agent'/);
});

test('the jump hop validator accepts every id space the resolvers accept', () => {
    const resource = read('resource-service.js');
    assert.match(resource, /_assertJumpHopUsable\(user, jumpId, conn\)/);
    assert.match(resource, /_assertJumpConnectionUsable\(user, connectionId, conn\)/);
    // agent: sentinel, jump_hosts record, and a bare SSH connection id.
    assert.match(resource, /if \(id\.startsWith\('agent:'\)\)/);
    assert.match(resource, /const jump = this\._ownerOf\('jumpHost', id\);/);
    assert.match(resource, /const hop = this\.storage\.getConnectionById\(connectionId\);/);
    // A hop must be SSH and must not be the connection being edited.
    assert.match(resource, /跳板机只能是 SSH 连接/);
    assert.match(resource, /跳板机不能引用当前连接自身/);
});
