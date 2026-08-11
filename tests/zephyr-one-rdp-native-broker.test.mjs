import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mountRoutes } = require('../zephyr-one-rdp-native-broker');

function harness({ connection = {}, verifyShellRequest = () => ({ ok: true }) } = {}) {
    let route = null;
    const app = {
        post(path, ...handlers) {
            route = { path, handlers };
        },
    };
    const authorized = [];
    mountRoutes(app, {
        requireUser(req, _res, next) {
            req.user = { userId: 'user-1', status: 'active' };
            next();
        },
        verifyShellRequest,
        authorizeConnection(user, connectionId, capability) {
            authorized.push({ user, connectionId, capability });
            return {
                id: connectionId,
                protocol: 'RDP',
                connectionMode: 'direct',
                host: 'stored.internal',
                port: 3389,
                username: 'stored-user',
                password: 'stored-password',
                rdpDomain: 'STORED',
                rdpClipboard: true,
                ...connection,
            };
        },
        logger: { info() {} },
    });

    function invoke(body) {
        const response = { statusCode: 200, headers: {}, body: null };
        const res = {
            setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
            status(statusCode) { response.statusCode = statusCode; return this; },
            json(value) { response.body = value; return response; },
        };
        const req = { body, headers: {}, get() { return ''; } };
        const [authenticate, handler] = route.handlers;
        authenticate(req, res, () => handler(req, res));
        return response;
    }

    return { route, invoke, authorized };
}

test('native RDP broker requires shell auth in addition to the app session', () => {
    const api = harness({ verifyShellRequest: () => ({ ok: false, reason: 'bad_mac' }) });
    const response = api.invoke({
        connectionId: 'connection-1',
        sessionId: 'session-1',
        ownerLabel: 'main',
    });
    assert.equal(api.route.path, '/api/one/rdp/native/authorize-open');
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'shell_auth_required');
    assert.equal(api.authorized.length, 0);
    assert.equal(response.headers['cache-control'], 'no-store');
});

test('renderer target password and path fields cannot override protected storage', () => {
    const api = harness();
    const response = api.invoke({
        connectionId: 'connection-1',
        sessionId: 'session-1',
        ownerLabel: 'main',
        host: 'attacker.example',
        password: 'attacker-password',
        folderPath: 'C:\\private',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.host, 'stored.internal');
    assert.equal(response.body.password, 'stored-password');
    assert.equal(response.body.folderPath, undefined);
    assert.deepEqual(api.authorized.map(({ connectionId, capability }) => ({ connectionId, capability })), [
        { connectionId: 'connection-1', capability: 'use' },
    ]);
});

test('shell nonce replay is rejected before a second credential lookup', () => {
    let unused = true;
    const api = harness({
        verifyShellRequest() {
            if (!unused) return { ok: false, reason: 'replayed' };
            unused = false;
            return { ok: true };
        },
    });
    const intent = { connectionId: 'connection-1', sessionId: 'session-1', ownerLabel: 'main' };
    assert.equal(api.invoke(intent).statusCode, 200);
    assert.equal(api.invoke(intent).statusCode, 403);
    assert.equal(api.authorized.length, 1);
});

test('stored drive mapping requests fail closed and never return a path', () => {
    const api = harness({ connection: { rdpStorage: true, folderPath: 'C:\\secret' } });
    const response = api.invoke({
        connectionId: 'connection-1',
        sessionId: 'session-1',
        ownerLabel: 'main',
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'rdp_drive_mapping_disabled');
    assert.equal(JSON.stringify(response.body).includes('C:\\secret'), false);
});
