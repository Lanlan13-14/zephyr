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

function listen(server, host = '127.0.0.1') {
    return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function openWs(cookieValue) {
    return new WebSocket(server.url('/ssh').replace(/^http/, 'ws'), { headers: { Cookie: cookieValue } });
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
        socket.on('error', () => {});
        socket.write('proxy-login: ');
        socket.on('data', (chunk) => {
            const printable = [...chunk].filter((byte) => byte !== 255).map((byte) => String.fromCharCode(byte)).join('');
            if (printable.trim()) socket.write(printable);
        });
    });
    telnetPort = await listen(telnetServer);

    proxyServer = net.createServer((client) => {
        client.on('error', () => {});
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
                const upstream = net.createConnection(port, host, () => {
                    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
                    client.pipe(upstream);
                    upstream.pipe(client);
                });
                upstream.on('error', () => client.destroy());
            });
            if (hello.length > 3) client.unshift(hello.subarray(3));
        });
    });
    proxyPort = await listen(proxyServer);

    sshPrivateKey = sshUtils.generateKeyPairSync('ed25519').private;
    sshServer = new SshServer({ hostKeys: [sshPrivateKey] }, (client) => {
        client.on('authentication', (ctx) => {
            if (ctx.method === 'password' && ctx.username === 'jump' && ctx.password === 'jump-pass') ctx.accept();
            else ctx.reject();
        });
        client.on('ready', () => {
            client.on('tcpip', (accept, reject, info) => {
                const upstream = net.createConnection(info.destPort, info.destIP, () => {
                    const channel = accept();
                    channel.on('error', () => {});
                    upstream.on('error', () => {});
                    channel.pipe(upstream);
                    upstream.pipe(channel);
                });
                upstream.on('error', () => reject());
            });
        });
    });
    sshPort = await listen(sshServer);

    server = new TestServer();
    await server.start();
    cookie = (await server.bootstrapAdmin('admin-pass-telnet-route')).cookie;
});

after(async () => {
    await server.cleanup();
    await new Promise((resolve) => sshServer.close(resolve));
    await new Promise((resolve) => proxyServer.close(resolve));
    await new Promise((resolve) => telnetServer.close(resolve));
});

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

    const ws = openWs(cookie);
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
    ws.close();
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

    const ws = openWs(cookie);
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
    ws.close();
});
