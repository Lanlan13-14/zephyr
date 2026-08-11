import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import ssh2 from 'ssh2';
import { TestServer } from './test-server.mjs';

const { Server: SshServer, utils: sshUtils } = ssh2;

let server;
let cookie;
let telnetServer;
let telnetPort;
let proxyServer;
let proxyPort;
let sshServer;
let sshPort;
let sshPrivateKey;
let proxyTargetMode = 'connect';
let proxyTargetDelayMs = 0;
let proxyTargetRequestCount = 0;
let jumpTargetMode = 'connect';
let jumpTargetDelayMs = 0;
let jumpTargetRequestCount = 0;
let jumpAuthenticationMode = 'accept';
const telnetSockets = new Set();
const proxySockets = new Set();
const jumpClients = new Set();
const jumpChannels = new Set();
const jumpSockets = new Set();
const telnetPeersByMarker = new Map();
let nextTelnetPeerMarker = 0;

function trackSocket(collection, socket) {
    collection.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => collection.delete(socket));
    return socket;
}

function trackCloseable(collection, resource) {
    collection.add(resource);
    resource.on?.('error', () => {});
    resource.once?.('close', () => collection.delete(resource));
    return resource;
}

function destroyTracked(collection) {
    for (const resource of collection) {
        try { resource.end?.(); } catch {}
        try { resource.close?.(); } catch {}
        try { resource.destroy?.(); } catch {}
    }
    collection.clear();
}

function waitForClose(resource, label, timeoutMs = 5000) {
    if (!resource || resource.destroyed || resource.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const done = (error) => {
            clearTimeout(timer);
            resource.off?.('close', onClose);
            if (error) reject(error);
            else resolve();
        };
        const onClose = () => done();
        const timer = setTimeout(() => done(new Error(`timeout waiting for ${label} close`)), timeoutMs);
        resource.once('close', onClose);
    });
}

function targetPeerFromBanner(data) {
    const marker = String(data || '').match(/proxy-login:(\d+):/)?.[1];
    assert.ok(marker, 'TELNET banner should identify its target peer');
    const peer = telnetPeersByMarker.get(Number(marker));
    assert.ok(peer, 'TELNET target peer should still be active');
    return peer;
}

async function disconnectAndWait(ws, targetPeer) {
    assert.ok(targetPeer, 'TELNET target peer should be accepted');
    const closed = Promise.all([
        waitForClose(ws, 'websocket'),
        waitForClose(targetPeer, 'TELNET target peer'),
    ]);
    try {
        await new Promise((resolve, reject) => {
            ws.send(JSON.stringify({ type: 'disconnect' }), (error) => error ? reject(error) : resolve());
        });
        await closed;
    } catch (error) {
        closed.catch(() => {});
        throw error;
    }
}

async function forceCloseWebSocket(ws) {
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const closed = waitForClose(ws, 'forced websocket', 1000).catch(() => {});
    try { ws.terminate(); } catch {}
    await closed;
}

function closeServerBounded(targetServer, label, timeoutMs = 3000) {
    if (!targetServer) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            try { targetServer.closeAllConnections?.(); } catch {}
            finish(new Error(`timeout closing ${label}`));
        }, timeoutMs);
        try { targetServer.close(finish); } catch (error) { finish(error); }
    });
}

function listen(server, host = '127.0.0.1') {
    return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, label, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert.ok(predicate(), `timeout waiting for ${label}`);
}

function openWs(cookieValue) {
    return new WebSocket(server.url('/ssh').replace(/^http/, 'ws'), { headers: { Cookie: cookieValue } });
}

function waitForOpen(ws, timeoutMs = 3000) {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const finish = (error) => {
            clearTimeout(timer);
            ws.off('open', onOpen);
            ws.off('error', onError);
            if (error) reject(error);
            else resolve();
        };
        const onOpen = () => finish();
        const onError = (error) => finish(error);
        const timer = setTimeout(() => finish(new Error('timeout waiting for websocket open')), timeoutMs);
        ws.once('open', onOpen);
        ws.once('error', onError);
    });
}

function waitFor(ws, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        const onMessage = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === 'error' && type !== 'error') {
                clearTimeout(timer);
                ws.off('message', onMessage);
                reject(new Error(msg.message || 'websocket error'));
                return;
            }
            if (msg.type !== type) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(msg);
        };
        ws.on('message', onMessage);
    });
}

before(async () => {
    telnetServer = net.createServer((socket) => {
        const marker = ++nextTelnetPeerMarker;
        telnetPeersByMarker.set(marker, socket);
        socket.once('close', () => telnetPeersByMarker.delete(marker));
        trackSocket(telnetSockets, socket);
        socket.write(`proxy-login:${marker}: `);
        socket.on('data', (chunk) => {
            const printable = [...chunk].filter((byte) => byte !== 255).map((byte) => String.fromCharCode(byte)).join('');
            if (printable.trim()) socket.write(printable);
        });
    });
    telnetPort = await listen(telnetServer);

    proxyServer = net.createServer((client) => {
        trackSocket(proxySockets, client);
        let buffer = Buffer.alloc(0);
        client.once('data', (hello) => {
            if (hello[0] !== 0x05) return client.destroy();
            client.write(Buffer.from([0x05, 0x00]));
            client.once('data', (request) => {
                buffer = Buffer.concat([buffer, request]);
                if (buffer[0] !== 0x05 || buffer[1] !== 0x01) return client.destroy();
                let offset = 4;
                let host = '';
                if (buffer[3] === 0x01) {
                    host = [...buffer.subarray(offset, offset + 4)].join('.');
                    offset += 4;
                } else if (buffer[3] === 0x03) {
                    const length = buffer[offset++];
                    host = buffer.subarray(offset, offset + length).toString();
                    offset += length;
                } else return client.destroy();
                const port = buffer.readUInt16BE(offset);
                const targetMode = proxyTargetMode;
                const targetDelayMs = proxyTargetDelayMs;
                proxyTargetRequestCount += 1;
                const openTarget = () => {
                    if (client.destroyed || targetMode === 'timeout') return;
                    if (targetMode === 'reject') {
                        client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
                        return;
                    }
                    const successReply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]);
                    const upstream = trackSocket(proxySockets, net.createConnection(port, host, () => {
                        const pipe = () => {
                            client.pipe(upstream);
                            upstream.pipe(client);
                        };
                        if (targetMode === 'fragment') {
                            client.write(successReply.subarray(0, 2));
                            setTimeout(() => {
                                if (client.destroyed || upstream.destroyed) return;
                                client.write(successReply.subarray(2));
                                pipe();
                            }, 120);
                            return;
                        }
                        if (targetMode === 'coalesce-banner') {
                            upstream.once('data', (banner) => {
                                if (client.destroyed) return;
                                client.write(Buffer.concat([successReply, banner]));
                                pipe();
                            });
                            return;
                        }
                        client.write(successReply);
                        pipe();
                    }));
                    upstream.on('error', () => client.destroy());
                    client.once('close', () => upstream.destroy());
                    upstream.once('close', () => client.destroy());
                };
                if (targetDelayMs > 0) setTimeout(openTarget, targetDelayMs);
                else openTarget();
            });
            if (hello.length > 3) client.unshift(hello.subarray(3));
        });
    });
    proxyPort = await listen(proxyServer);

    sshPrivateKey = sshUtils.generateKeyPairSync('ed25519').private;
    sshServer = new SshServer({ hostKeys: [sshPrivateKey] }, (client) => {
        let clientClosed = false;
        trackCloseable(jumpClients, client);
        client.once('close', () => { clientClosed = true; });
        client.on('authentication', (ctx) => {
            if (jumpAuthenticationMode === 'timeout') return;
            if (ctx.method === 'password' && ctx.username === 'jump' && ctx.password === 'jump-pass') ctx.accept();
            else ctx.reject();
        });
        client.on('ready', () => {
            client.on('tcpip', (accept, reject, info) => {
                const targetMode = jumpTargetMode;
                const targetDelayMs = jumpTargetDelayMs;
                jumpTargetRequestCount += 1;
                const openTarget = () => {
                    if (clientClosed || targetMode === 'timeout') return;
                    if (targetMode === 'reject') {
                        reject();
                        return;
                    }
                    const upstream = trackSocket(jumpSockets, net.createConnection(info.destPort, info.destIP, () => {
                        if (clientClosed) {
                            upstream.destroy();
                            return;
                        }
                        let accepted = null;
                        try { accepted = accept(); } catch {}
                        if (!accepted) {
                            upstream.destroy();
                            return;
                        }
                        const channel = trackCloseable(jumpChannels, accepted);
                        channel.once('close', () => upstream.destroy());
                        upstream.once('close', () => channel.destroy());
                        channel.pipe(upstream);
                        upstream.pipe(channel);
                    }));
                    upstream.on('error', () => reject());
                };
                if (targetDelayMs > 0) setTimeout(openTarget, targetDelayMs);
                else openTarget();
            });
        });
    });
    sshPort = await listen(sshServer);

    server = new TestServer();
    const previousRouteTimeout = process.env.ZEPHYR_TELNET_ROUTE_TIMEOUT_MS;
    process.env.ZEPHYR_TELNET_ROUTE_TIMEOUT_MS = '700';
    try {
        await server.start();
    } finally {
        if (previousRouteTimeout === undefined) delete process.env.ZEPHYR_TELNET_ROUTE_TIMEOUT_MS;
        else process.env.ZEPHYR_TELNET_ROUTE_TIMEOUT_MS = previousRouteTimeout;
    }
    cookie = (await server.bootstrapAdmin('admin-pass-telnet-route')).cookie;
});

after(async () => {
    const failures = [];
    destroyTracked(jumpChannels);
    destroyTracked(jumpClients);
    destroyTracked(jumpSockets);
    destroyTracked(proxySockets);
    destroyTracked(telnetSockets);
    try { await server?.cleanup(); } catch (error) { failures.push(error); }
    for (const [target, label] of [
        [sshServer, 'SSH jump server'],
        [proxyServer, 'SOCKS proxy server'],
        [telnetServer, 'TELNET server'],
    ]) {
        try { await closeServerBounded(target, label); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'telnet route fixture cleanup failed');
});

async function createSocksTelnet(name) {
    const proxy = await server.api(cookie, 'POST', '/api/proxies', {
        name: `${name}-socks`, type: 'socks5', host: '127.0.0.1', port: proxyPort,
    });
    assert.equal(proxy.status, 200, JSON.stringify(proxy.body));
    const created = await server.api(cookie, 'POST', '/api/connections', {
        name, protocol: 'TELNET', host: '127.0.0.1', port: telnetPort,
        connectionMode: 'proxy', proxyId: proxy.body.proxy.id,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.connection;
}

async function createJumpTelnet(name) {
    const jumpConnection = await server.api(cookie, 'POST', '/api/connections', {
        name: `${name}-ssh`, protocol: 'SSH', host: '127.0.0.1', port: sshPort,
        username: 'jump', password: 'jump-pass', connectionMode: 'direct',
    });
    assert.equal(jumpConnection.status, 200, JSON.stringify(jumpConnection.body));
    const jumpHost = await server.api(cookie, 'POST', '/api/jump-hosts', {
        name: `${name}-jump`, connectionId: jumpConnection.body.connection.id,
    });
    assert.equal(jumpHost.status, 200, JSON.stringify(jumpHost.body));
    const created = await server.api(cookie, 'POST', '/api/connections', {
        name, protocol: 'TELNET', host: '127.0.0.1', port: telnetPort,
        connectionMode: 'jump', jumpHostId: jumpHost.body.jumpHost.id,
        jumpHostIds: [jumpHost.body.jumpHost.id],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.connection;
}

async function createCredentiallessProxiedJumpTelnet(name) {
    const proxy = await server.api(cookie, 'POST', '/api/proxies', {
        name: `${name}-socks`, type: 'socks5', host: '127.0.0.1', port: proxyPort,
    });
    assert.equal(proxy.status, 200, JSON.stringify(proxy.body));
    const jumpConnection = await server.api(cookie, 'POST', '/api/connections', {
        name: `${name}-ssh`, protocol: 'SSH', host: '127.0.0.1', port: sshPort,
        username: 'jump', connectionMode: 'proxy', proxyId: proxy.body.proxy.id,
    });
    assert.equal(jumpConnection.status, 200, JSON.stringify(jumpConnection.body));
    const jumpHost = await server.api(cookie, 'POST', '/api/jump-hosts', {
        name: `${name}-jump`, connectionId: jumpConnection.body.connection.id,
    });
    assert.equal(jumpHost.status, 200, JSON.stringify(jumpHost.body));
    const created = await server.api(cookie, 'POST', '/api/connections', {
        name, protocol: 'TELNET', host: '127.0.0.1', port: telnetPort,
        connectionMode: 'jump', jumpHostId: jumpHost.body.jumpHost.id,
        jumpHostIds: [jumpHost.body.jumpHost.id],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.connection;
}

async function assertRequestPending(promise, waitMs = 75) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await delay(waitMs);
    assert.equal(settled, false, 'connection test must wait for the routed upstream handshake');
}

async function assertCollectionDrained(collection, label, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (collection.size && Date.now() < deadline) await delay(20);
    assert.equal(collection.size, 0, `${label} should be closed after the connection probe`);
}

function observeMessageTypes(ws) {
    const types = [];
    const onMessage = (raw) => {
        try { types.push(JSON.parse(String(raw)).type); } catch {}
    };
    ws.on('message', onMessage);
    return { types, stop: () => ws.off('message', onMessage) };
}

function sendTelnetConnect(ws, connection, sessionId) {
    ws.send(JSON.stringify({
        type: 'connect',
        connectionId: connection.id,
        sessionId,
        cols: 80,
        rows: 24,
    }));
}

async function assertJumpResourcesDrained() {
    await assertCollectionDrained(jumpChannels, 'SSH jump channels');
    await assertCollectionDrained(jumpSockets, 'SSH jump target sockets');
    await assertCollectionDrained(jumpClients, 'SSH jump clients');
}

test('saved TELNET connection tests and opens through SOCKS5 proxy', async () => {
    const proxy = await server.api(cookie, 'POST', '/api/proxies', {
        name: 'local-socks', type: 'socks5', host: '127.0.0.1', port: proxyPort,
    });
    assert.equal(proxy.status, 200, JSON.stringify(proxy.body));

    const created = await server.api(cookie, 'POST', '/api/connections', {
        name: 'proxied-telnet', protocol: 'TELNET', host: '127.0.0.1', port: telnetPort,
        connectionMode: 'proxy', proxyId: proxy.body.proxy.id,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.connection.connectionMode, 'proxy');
    assert.equal(created.body.connection.proxyId, proxy.body.proxy.id);

    const tested = await server.api(cookie, 'POST', '/api/connections/test', {
        connectionId: created.body.connection.id, timeoutSeconds: 3,
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, true);
    assert.match(tested.body.message, /代理|local-socks/);

    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        const readyPromise = waitFor(ws, 'ready');
        const dataPromise = waitFor(ws, 'data');
        ws.send(JSON.stringify({
            type: 'connect', connectionId: created.body.connection.id,
            sessionId: `telnet-proxy-${Date.now()}`, cols: 80, rows: 24,
        }));
        const ready = await readyPromise;
        assert.equal(ready.protocol, 'TELNET');
        const data = await dataPromise;
        assert.match(data.data, /proxy-login:/);
        targetPeer = targetPeerFromBanner(data.data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
    }
});


test('saved TELNET connection tests and opens through SSH jump host', async () => {
    const jumpConnection = await server.api(cookie, 'POST', '/api/connections', {
        name: 'local-ssh-jump', protocol: 'SSH', host: '127.0.0.1', port: sshPort,
        username: 'jump', password: 'jump-pass', connectionMode: 'direct',
    });
    assert.equal(jumpConnection.status, 200, JSON.stringify(jumpConnection.body));

    const jumpHost = await server.api(cookie, 'POST', '/api/jump-hosts', {
        name: 'local-jump', connectionId: jumpConnection.body.connection.id,
    });
    assert.equal(jumpHost.status, 200, JSON.stringify(jumpHost.body));

    const created = await server.api(cookie, 'POST', '/api/connections', {
        name: 'jumped-telnet', protocol: 'TELNET', host: '127.0.0.1', port: telnetPort,
        connectionMode: 'jump', jumpHostId: jumpHost.body.jumpHost.id,
        jumpHostIds: [jumpHost.body.jumpHost.id],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.connection.connectionMode, 'jump');
    assert.deepEqual(created.body.connection.jumpHostIds, [jumpHost.body.jumpHost.id]);

    const tested = await server.api(cookie, 'POST', '/api/connections/test', {
        connectionId: created.body.connection.id, timeoutSeconds: 3,
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, true);
    assert.match(tested.body.message, /local-jump/);

    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        const readyPromise = waitFor(ws, 'ready');
        const dataPromise = waitFor(ws, 'data');
        ws.send(JSON.stringify({
            type: 'connect', connectionId: created.body.connection.id,
            sessionId: `telnet-jump-${Date.now()}`, cols: 80, rows: 24,
        }));
        const ready = await readyPromise;
        assert.equal(ready.protocol, 'TELNET');
        const data = await dataPromise;
        assert.match(data.data, /proxy-login:/);
        targetPeer = targetPeerFromBanner(data.data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
    }
});

test('TELNET probe waits for a delayed SOCKS target handshake', async () => {
    const connection = await createSocksTelnet('delayed-socks-telnet');
    proxyTargetMode = 'connect';
    proxyTargetDelayMs = 250;
    try {
        const started = Date.now();
        const pending = server.api(cookie, 'POST', '/api/connections/test', {
            connectionId: connection.id, timeoutSeconds: 2,
        });
        await assertRequestPending(pending);
        const tested = await pending;
        assert.equal(tested.status, 200, JSON.stringify(tested.body));
        assert.equal(tested.body.ok, true);
        assert.ok(Date.now() - started >= 200, 'probe should resolve after SOCKS confirms its target stream');
    } finally {
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
    }
});

test('TELNET probe reports a rejected SOCKS target instead of local-forward success', async () => {
    const connection = await createSocksTelnet('rejected-socks-telnet');
    proxyTargetMode = 'reject';
    proxyTargetDelayMs = 150;
    try {
        const pending = server.api(cookie, 'POST', '/api/connections/test', {
            connectionId: connection.id, timeoutSeconds: 2,
        });
        await assertRequestPending(pending);
        const tested = await pending;
        assert.equal(tested.status, 400, JSON.stringify(tested.body));
        assert.equal(tested.body.ok, false);
        assert.equal(tested.body.code, 'connect_failed');
        assert.match(tested.body.message, /SOCKS5|状态 5/i);
    } finally {
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
    }
});

test('TELNET probe bounds a silent SOCKS target handshake', async () => {
    const connection = await createSocksTelnet('timeout-socks-telnet');
    proxyTargetMode = 'timeout';
    try {
        const tested = await server.api(cookie, 'POST', '/api/connections/test', {
            connectionId: connection.id, timeoutSeconds: 1,
        });
        assert.equal(tested.status, 400, JSON.stringify(tested.body));
        assert.equal(tested.body.ok, false);
        assert.equal(tested.body.code, 'timeout');
        assert.ok(tested.body.durationMs >= 800, `timeout returned too early (${tested.body.durationMs}ms)`);
        assert.ok(tested.body.durationMs < 3000, `timeout exceeded its bound (${tested.body.durationMs}ms)`);
    } finally {
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
    }
});

test('TELNET probe waits for a delayed SSH jump target stream', async () => {
    const connection = await createJumpTelnet('delayed-jump-telnet');
    jumpTargetMode = 'connect';
    jumpTargetDelayMs = 250;
    try {
        const started = Date.now();
        const pending = server.api(cookie, 'POST', '/api/connections/test', {
            connectionId: connection.id, timeoutSeconds: 2,
        });
        await assertRequestPending(pending);
        const tested = await pending;
        assert.equal(tested.status, 200, JSON.stringify(tested.body));
        assert.equal(tested.body.ok, true);
        assert.ok(Date.now() - started >= 200, 'probe should resolve after SSH confirms its target stream');
    } finally {
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await assertCollectionDrained(jumpChannels, 'SSH jump channels');
        await assertCollectionDrained(jumpSockets, 'SSH jump target sockets');
        await assertCollectionDrained(jumpClients, 'SSH jump clients');
    }
});

test('TELNET probe reports a rejected SSH jump target instead of local-forward success', async () => {
    const connection = await createJumpTelnet('rejected-jump-telnet');
    jumpTargetMode = 'reject';
    jumpTargetDelayMs = 150;
    try {
        const pending = server.api(cookie, 'POST', '/api/connections/test', {
            connectionId: connection.id, timeoutSeconds: 2,
        });
        await assertRequestPending(pending);
        const tested = await pending;
        assert.equal(tested.status, 400, JSON.stringify(tested.body));
        assert.equal(tested.body.ok, false);
        assert.equal(tested.body.code, 'connect_failed');
    } finally {
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await assertCollectionDrained(jumpChannels, 'SSH jump channels');
        await assertCollectionDrained(jumpSockets, 'SSH jump target sockets');
        await assertCollectionDrained(jumpClients, 'SSH jump clients');
    }
});

test('TELNET probe bounds a silent SSH jump target request', async () => {
    const connection = await createJumpTelnet('timeout-jump-telnet');
    jumpTargetMode = 'timeout';
    try {
        const tested = await server.api(cookie, 'POST', '/api/connections/test', {
            connectionId: connection.id, timeoutSeconds: 1,
        });
        assert.equal(tested.status, 400, JSON.stringify(tested.body));
        assert.equal(tested.body.ok, false);
        assert.equal(tested.body.code, 'timeout');
        assert.ok(tested.body.durationMs >= 800, `timeout returned too early (${tested.body.durationMs}ms)`);
        assert.ok(tested.body.durationMs < 3000, `timeout exceeded its bound (${tested.body.durationMs}ms)`);
    } finally {
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await assertCollectionDrained(jumpChannels, 'SSH jump channels');
        await assertCollectionDrained(jumpSockets, 'SSH jump target sockets');
        await assertCollectionDrained(jumpClients, 'SSH jump clients');
    }
});

test('live TELNET waits for delayed SOCKS CONNECT before ready', async () => {
    const connection = await createSocksTelnet('live-delayed-socks-telnet');
    proxyTargetMode = 'connect';
    proxyTargetDelayMs = 250;
    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        const readyPending = waitFor(ws, 'ready');
        const dataPending = waitFor(ws, 'data');
        const started = Date.now();
        sendTelnetConnect(ws, connection, `live-delayed-socks-${Date.now()}`);
        await assertRequestPending(readyPending);
        const ready = await readyPending;
        assert.equal(ready.protocol, 'TELNET');
        assert.ok(Date.now() - started >= 200, 'ready must wait for SOCKS CONNECT success');
        const data = await dataPending;
        targetPeer = targetPeerFromBanner(data.data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
    }
});

test('live TELNET waits for the complete fragmented SOCKS CONNECT frame', async () => {
    const connection = await createSocksTelnet('live-fragmented-socks-telnet');
    proxyTargetMode = 'fragment';
    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        const readyPending = waitFor(ws, 'ready');
        const dataPending = waitFor(ws, 'data');
        sendTelnetConnect(ws, connection, `live-fragmented-socks-${Date.now()}`);
        await assertRequestPending(readyPending);
        assert.equal((await readyPending).protocol, 'TELNET');
        targetPeer = targetPeerFromBanner((await dataPending).data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        proxyTargetMode = 'connect';
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
    }
});

test('live TELNET preserves a banner coalesced with the SOCKS CONNECT frame', async () => {
    const connection = await createSocksTelnet('live-coalesced-socks-telnet');
    proxyTargetMode = 'coalesce-banner';
    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        const readyPending = waitFor(ws, 'ready');
        const dataPending = waitFor(ws, 'data');
        sendTelnetConnect(ws, connection, `live-coalesced-socks-${Date.now()}`);
        assert.equal((await readyPending).protocol, 'TELNET');
        const data = await dataPending;
        assert.match(data.data, /proxy-login:/);
        targetPeer = targetPeerFromBanner(data.data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        proxyTargetMode = 'connect';
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
    }
});

test('live TELNET reports delayed SOCKS rejection without ready', async () => {
    const connection = await createSocksTelnet('live-rejected-socks-telnet');
    proxyTargetMode = 'reject';
    proxyTargetDelayMs = 150;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        const errorPending = waitFor(ws, 'error');
        sendTelnetConnect(ws, connection, `live-rejected-socks-${Date.now()}`);
        await assertRequestPending(errorPending);
        const error = await errorPending;
        assert.match(error.message, /SOCKS5|Telnet/i);
        assert.equal(observed.types.includes('ready'), false, 'rejected route must never emit ready');
    } finally {
        observed?.stop();
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});

test('live TELNET bounds a silent SOCKS CONNECT without ready', async () => {
    const connection = await createSocksTelnet('live-timeout-socks-telnet');
    proxyTargetMode = 'timeout';
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        const errorPending = waitFor(ws, 'error', 2500);
        const started = Date.now();
        sendTelnetConnect(ws, connection, `live-timeout-socks-${Date.now()}`);
        const error = await errorPending;
        const elapsed = Date.now() - started;
        assert.match(error.message, /超时|timeout|Telnet/i);
        assert.ok(elapsed >= 550, `silent SOCKS route failed too early (${elapsed}ms)`);
        assert.ok(elapsed < 1800, `silent SOCKS route exceeded its bound (${elapsed}ms)`);
        assert.equal(observed.types.includes('ready'), false, 'timed-out route must never emit ready');
    } finally {
        observed?.stop();
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});

test('live TELNET waits for delayed SSH direct-tcpip before ready', async () => {
    const connection = await createJumpTelnet('live-delayed-jump-telnet');
    jumpTargetMode = 'connect';
    jumpTargetDelayMs = 250;
    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        const readyPending = waitFor(ws, 'ready');
        const dataPending = waitFor(ws, 'data');
        const started = Date.now();
        sendTelnetConnect(ws, connection, `live-delayed-jump-${Date.now()}`);
        await assertRequestPending(readyPending);
        const ready = await readyPending;
        assert.equal(ready.protocol, 'TELNET');
        assert.ok(Date.now() - started >= 200, 'ready must wait for SSH direct-tcpip success');
        const data = await dataPending;
        targetPeer = targetPeerFromBanner(data.data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
        await assertJumpResourcesDrained();
    }
});

test('live TELNET reports delayed SSH direct-tcpip rejection without ready', async () => {
    const connection = await createJumpTelnet('live-rejected-jump-telnet');
    jumpTargetMode = 'reject';
    jumpTargetDelayMs = 150;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        const errorPending = waitFor(ws, 'error');
        sendTelnetConnect(ws, connection, `live-rejected-jump-${Date.now()}`);
        await assertRequestPending(errorPending);
        const error = await errorPending;
        assert.match(error.message, /Telnet|forward|SSH/i);
        assert.equal(observed.types.includes('ready'), false, 'rejected route must never emit ready');
    } finally {
        observed?.stop();
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
        await assertJumpResourcesDrained();
    }
});

test('live TELNET bounds a silent SSH direct-tcpip request without ready', async () => {
    const connection = await createJumpTelnet('live-timeout-jump-telnet');
    jumpTargetMode = 'timeout';
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        const errorPending = waitFor(ws, 'error', 2500);
        const started = Date.now();
        sendTelnetConnect(ws, connection, `live-timeout-jump-${Date.now()}`);
        const error = await errorPending;
        const elapsed = Date.now() - started;
        assert.match(error.message, /timeout|Telnet|forward/i);
        assert.ok(elapsed >= 550, `silent SSH route failed too early (${elapsed}ms)`);
        assert.ok(elapsed < 1800, `silent SSH route exceeded its bound (${elapsed}ms)`);
        assert.equal(observed.types.includes('ready'), false, 'timed-out route must never emit ready');
    } finally {
        observed?.stop();
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
        await assertJumpResourcesDrained();
    }
});

test('live SOCKS TELNET disconnect aborts a pending target open', async () => {
    const connection = await createSocksTelnet('live-disconnect-socks-telnet');
    proxyTargetMode = 'connect';
    proxyTargetDelayMs = 400;
    const requestBaseline = proxyTargetRequestCount;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        sendTelnetConnect(ws, connection, `live-disconnect-socks-${Date.now()}`);
        await waitUntil(() => proxyTargetRequestCount > requestBaseline, 'pending SOCKS target request');
        const closed = waitForClose(ws, 'websocket after pending SOCKS disconnect');
        ws.send(JSON.stringify({ type: 'disconnect' }));
        await closed;
        await delay(500);
        assert.equal(observed.types.includes('ready'), false, 'disconnect during SOCKS open must not emit ready');
    } finally {
        observed?.stop();
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});

test('live routed TELNET websocket close aborts a pending target open', async () => {
    const connection = await createSocksTelnet('live-close-socks-telnet');
    proxyTargetMode = 'connect';
    proxyTargetDelayMs = 400;
    const requestBaseline = proxyTargetRequestCount;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        sendTelnetConnect(ws, connection, `live-close-socks-${Date.now()}`);
        await waitUntil(() => proxyTargetRequestCount > requestBaseline, 'pending SOCKS target request');
        const closed = waitForClose(ws, 'websocket closed during pending SOCKS open');
        ws.close();
        await closed;
        await delay(500);
        assert.equal(observed.types.includes('ready'), false, 'websocket close during route open must not emit ready');
    } finally {
        observed?.stop();
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});

test('live routed TELNET websocket close aborts first-hop SSH authentication', async () => {
    const connection = await createJumpTelnet('live-auth-pending-jump-telnet');
    jumpAuthenticationMode = 'timeout';
    const clientBaseline = jumpClients.size;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        sendTelnetConnect(ws, connection, `live-auth-pending-jump-${Date.now()}`);
        await waitUntil(() => jumpClients.size > clientBaseline, 'pending SSH authentication');
        const closed = waitForClose(ws, 'websocket closed during SSH authentication');
        ws.close();
        await closed;
        assert.equal(observed.types.includes('ready'), false, 'closed first-hop authentication must not emit ready');
    } finally {
        observed?.stop();
        jumpAuthenticationMode = 'accept';
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
        await assertJumpResourcesDrained();
    }
});

test('invalid first-hop SSH config closes its already-open SOCKS tunnel', async () => {
    const connection = await createCredentiallessProxiedJumpTelnet('live-invalid-first-hop-telnet');
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        const errorPending = waitFor(ws, 'error');
        sendTelnetConnect(ws, connection, `live-invalid-first-hop-${Date.now()}`);
        const error = await errorPending;
        assert.match(error.message, /认证凭据|credential|password|privateKey|Telnet/i);
        assert.equal(observed.types.includes('ready'), false, 'invalid first-hop config must not emit ready');
    } finally {
        observed?.stop();
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(jumpClients, 'SSH jump clients');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});

test('live SSH TELNET disconnect destroys a late target stream', async () => {
    const connection = await createJumpTelnet('live-disconnect-jump-telnet');
    jumpTargetMode = 'connect';
    jumpTargetDelayMs = 400;
    const requestBaseline = jumpTargetRequestCount;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        sendTelnetConnect(ws, connection, `live-disconnect-jump-${Date.now()}`);
        await waitUntil(() => jumpTargetRequestCount > requestBaseline, 'pending SSH target request');
        const closed = waitForClose(ws, 'websocket after pending SSH disconnect');
        ws.send(JSON.stringify({ type: 'disconnect' }));
        await closed;
        await delay(500);
        assert.equal(observed.types.includes('ready'), false, 'disconnect during SSH open must not emit ready');
    } finally {
        observed?.stop();
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
        await assertJumpResourcesDrained();
    }
});

test('late SSH target success after the live timeout leaves no resources', async () => {
    const connection = await createJumpTelnet('live-late-jump-telnet');
    jumpTargetMode = 'connect';
    jumpTargetDelayMs = 950;
    let ws;
    let observed;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        observed = observeMessageTypes(ws);
        const errorPending = waitFor(ws, 'error', 2500);
        sendTelnetConnect(ws, connection, `live-late-jump-${Date.now()}`);
        await errorPending;
        assert.equal(observed.types.includes('ready'), false, 'late SSH success must not emit ready');
        await delay(450);
    } finally {
        observed?.stop();
        jumpTargetMode = 'connect';
        jumpTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
        await assertJumpResourcesDrained();
    }
});

test('routed TELNET survives websocket detach and reattaches', async () => {
    const connection = await createSocksTelnet('live-reattach-socks-telnet');
    const sessionId = `live-reattach-socks-${Date.now()}`;
    let firstWs;
    let secondWs;
    let targetPeer;
    try {
        firstWs = openWs(cookie);
        await waitForOpen(firstWs);
        const firstReady = waitFor(firstWs, 'ready');
        const firstData = waitFor(firstWs, 'data');
        sendTelnetConnect(firstWs, connection, sessionId);
        assert.equal((await firstReady).protocol, 'TELNET');
        targetPeer = targetPeerFromBanner((await firstData).data);

        const firstClosed = waitForClose(firstWs, 'detached websocket');
        firstWs.close();
        await firstClosed;
        await delay(100);
        assert.equal(targetPeer.destroyed, false, 'routed target must survive websocket detach');

        secondWs = openWs(cookie);
        await waitForOpen(secondWs);
        const attachedReady = waitFor(secondWs, 'ready');
        sendTelnetConnect(secondWs, connection, sessionId);
        const ready = await attachedReady;
        assert.equal(ready.protocol, 'TELNET');
        assert.equal(ready.attached, true);
        const echoed = waitFor(secondWs, 'data');
        secondWs.send(JSON.stringify({ type: 'input', data: 'reattached\n' }));
        assert.match((await echoed).data, /reattached/);
        await disconnectAndWait(secondWs, targetPeer);
    } finally {
        await forceCloseWebSocket(firstWs);
        await forceCloseWebSocket(secondWs);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});

test('a stale routed TELNET connect cannot cancel a newer connect', async () => {
    const staleConnection = await createSocksTelnet('live-stale-connect-telnet');
    const currentConnection = await createSocksTelnet('live-current-connect-telnet');
    proxyTargetMode = 'connect';
    proxyTargetDelayMs = 400;
    const requestBaseline = proxyTargetRequestCount;
    let ws;
    let targetPeer;
    try {
        ws = openWs(cookie);
        await waitForOpen(ws);
        sendTelnetConnect(ws, staleConnection, `live-stale-connect-${Date.now()}`);
        await waitUntil(() => proxyTargetRequestCount > requestBaseline, 'stale SOCKS target request');

        proxyTargetDelayMs = 0;
        const readyPending = waitFor(ws, 'ready');
        const dataPending = waitFor(ws, 'data');
        sendTelnetConnect(ws, currentConnection, `live-current-connect-${Date.now()}`);
        const ready = await readyPending;
        assert.equal(ready.protocol, 'TELNET');
        targetPeer = targetPeerFromBanner((await dataPending).data);
        await disconnectAndWait(ws, targetPeer);
    } finally {
        proxyTargetMode = 'connect';
        proxyTargetDelayMs = 0;
        await forceCloseWebSocket(ws);
        if (targetPeer && !targetPeer.destroyed) targetPeer.destroy();
        await assertCollectionDrained(proxySockets, 'SOCKS sockets');
        await assertCollectionDrained(telnetSockets, 'TELNET target sockets');
    }
});
