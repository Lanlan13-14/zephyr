/**
 * Phase 0: Telnet shares SSH session infrastructure
 * (attach/detach/history/detached-TTL/broadcast).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
const { TestServer } = await import('./test-server.mjs');

const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// ------------------------- source contracts -------------------------

test('telnet connect builds a session object into sshTerminalSessions', () => {
    const start = serverSrc.indexOf("if (protocol === 'TELNET') {");
    assert.ok(start > 0, 'telnet branch present');
    // Use the connect-time branch (after initialRows), not the form-normalize ones.
    const connectStart = serverSrc.indexOf('// FREEZE plan §5.6', start);
    assert.ok(connectStart > 0);
    const body = serverSrc.slice(connectStart, connectStart + 12000);
    assert.match(body, /protocol:\s*'TELNET'/);
    assert.match(body, /telnetSocket:\s*socket/);
    assert.match(body, /sshTerminalSessions\.set\(session\.id,\s*session\)/);
    assert.match(body, /terminalHistory\.open\(/);
    assert.match(body, /appendSshSessionBuffer\(session,/);
    assert.match(body, /queueSshSessionBroadcast\(session,\s*text,\s*sequence\)/);
    assert.match(body, /destroySshTerminalSession\(session,\s*'telnet-error'\)/);
    assert.match(body, /destroySshTerminalSession\(session,\s*'telnet-close'\)/);
    assert.match(body, /attachIacEngine|telnetIac/);
    assert.match(body, /createTelnetAutoLogin|telnetAutoLogin/);
    assert.match(body, /createTelnetDecoder|telnetDecoder/);
});

test('destroy closes telnetSocket owned by the session', () => {
    const start = serverSrc.indexOf('function destroySshTerminalSession');
    assert.ok(start > 0);
    const body = serverSrc.slice(start, start + 4500);
    assert.match(body, /session\.telnetSocket/);
    assert.match(body, /session\.telnetSocket\.destroy\?\.|session\.telnetSocket\.destroy/);
    assert.match(body, /classifyTerminalClose/);
    assert.match(body, /code:\s*classified\.code/);
});

test('ws-close detaches without destroying telnet TCP', () => {
    assert.match(serverSrc, /cleanup\(\{\s*destroySsh:\s*false,\s*reason:\s*'ws-close'\s*\}\)/);
    const detachStart = serverSrc.indexOf('const detachSshSession');
    assert.ok(detachStart > 0);
    const body = serverSrc.slice(detachStart, detachStart + 900);
    assert.match(body, /Keep telnet TCP alive/);
    assert.match(body, /telnetSocket\s*=\s*null/);
    // Must NOT call destroy/close on the socket during detach.
    assert.doesNotMatch(body, /telnetSocket\.destroy|closeTelnetSocket/);
});

test('attach restores telnetSocket and includes protocol on ready', () => {
    const start = serverSrc.indexOf('async function attachSshSession');
    assert.ok(start > 0);
    const body = serverSrc.slice(start, serverSrc.indexOf('function execDockerStream', start));
    assert.match(body, /telnetSocket\s*=\s*session\.telnetSocket/);
    assert.match(body, /protocol/);
    assert.match(body, /Telnet 未加密/);
    // Stats only when sshClient present (telnet has none).
    assert.match(body, /if\s*\(\s*sshClient\s*\)\s*startStatsPush/);
});

test('input and resize prefer session.telnetSocket', () => {
    assert.match(serverSrc, /attachedSshSession\?\.telnetSocket/);
    assert.match(serverSrc, /sendNaws\(liveTelnet,\s*cols,\s*rows\)/);
});

test('detached TTL GC still walks sshTerminalSessions (covers telnet)', () => {
    assert.match(serverSrc, /for \(const session of \[\.\.\.sshTerminalSessions\.values\(\)\]\)/);
    assert.match(serverSrc, /detached-ttl/);
});

// ------------------------- live integration -------------------------

let server;
let adminCookie;
let listenServer;
let listenPort;
let peerSockets = [];
let peerReceived = [];

before(async () => {
    listenServer = net.createServer((sock) => {
        peerSockets.push(sock);
        sock.write(Buffer.from('login: '));
        sock.on('data', (chunk) => {
            peerReceived.push(Buffer.from(chunk));
            // Echo printable non-IAC bytes so client sees activity.
            let out = '';
            for (let i = 0; i < chunk.length; i++) {
                if (chunk[i] === 255) {
                    const cmd = chunk[i + 1];
                    if (cmd === 250) {
                        while (i < chunk.length - 1 && !(chunk[i] === 255 && chunk[i + 1] === 240)) i++;
                        i += 1;
                    } else {
                        i += 2;
                    }
                    continue;
                }
                out += String.fromCharCode(chunk[i]);
            }
            if (out) sock.write(Buffer.from(out, 'binary'));
        });
    });
    await new Promise((r) => listenServer.listen(0, '127.0.0.1', r));
    listenPort = listenServer.address().port;

    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-telnet-phase0');
    adminCookie = boot.cookie;
});

after(async () => {
    await server.cleanup();
    for (const s of peerSockets) {
        try { s.destroy(); } catch {}
    }
    await new Promise((r) => listenServer.close(r));
});

function openWs(cookie) {
    const url = server.url('/ssh').replace(/^http/, 'ws');
    return new WebSocket(url, { headers: { Cookie: cookie } });
}

function waitFor(ws, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        const onMsg = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg.type === type) {
                clearTimeout(timer);
                ws.off('message', onMsg);
                resolve(msg);
            } else if (msg.type === 'error' && type !== 'error') {
                clearTimeout(timer);
                ws.off('message', onMsg);
                reject(new Error(msg.message || 'error'));
            }
        };
        ws.on('message', onMsg);
    });
}

function collectUntil(ws, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const bag = [];
        const timer = setTimeout(() => {
            ws.off('message', onMsg);
            reject(new Error(`timeout collect: got ${bag.map((m) => m.type).join(',')}`));
        }, timeoutMs);
        const onMsg = (raw) => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            bag.push(msg);
            if (predicate(msg, bag)) {
                clearTimeout(timer);
                ws.off('message', onMsg);
                resolve(bag);
            }
        };
        ws.on('message', onMsg);
    });
}

async function connectTelnet(ws, sessionId) {
    // Collector must be armed before send so a fast peer banner cannot race past.
    const readyP = waitFor(ws, 'ready');
    const earlyDataP = waitFor(ws, 'data').catch(() => null);
    ws.send(JSON.stringify({
        type: 'connect',
        protocol: 'TELNET',
        host: '127.0.0.1',
        port: listenPort,
        username: '',
        cols: 80,
        rows: 24,
        sessionId,
    }));
    const ready = await readyP;
    // Stash any banner that arrived with ready so callers can reuse it.
    const early = await Promise.race([
        earlyDataP,
        new Promise((r) => setTimeout(() => r(null), 50)),
    ]);
    ready._earlyData = early;
    return ready;
}

test('telnet WS close detaches; reattach replays history and keeps TCP alive', async () => {
    peerReceived = [];
    const sessionId = `telnet-resume-${Date.now()}`;

    const ws1 = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws1.once('open', resolve);
        ws1.once('error', reject);
    });
    const ready1 = await connectTelnet(ws1, sessionId);
    assert.equal(ready1.protocol, 'TELNET');
    assert.equal(ready1.sessionId, sessionId);
    assert.equal(ready1.attached, undefined); // first connect, not attach

    const loginPrompt = ready1._earlyData || await waitFor(ws1, 'data');
    assert.match(loginPrompt.data, /login:/);

    // Produce unique payload so replay can be verified.
    const marker = `phase0-marker-${Date.now()}\n`;
    ws1.send(JSON.stringify({ type: 'input', data: marker }));
    const echoed = await waitFor(ws1, 'data');
    assert.match(echoed.data, /phase0-marker-/);

    // Give history flush timer (50ms) a beat to land.
    await new Promise((r) => setTimeout(r, 120));

    // Peer sockets alive count before detach.
    const peersBefore = peerSockets.filter((s) => !s.destroyed).length;
    assert.ok(peersBefore >= 1, 'tcp peer should be up');

    // Close WS — must detach, not kill TCP.
    await new Promise((resolve) => {
        ws1.once('close', resolve);
        ws1.close();
    });
    await new Promise((r) => setTimeout(r, 80));
    const peersAfterDetach = peerSockets.filter((s) => !s.destroyed).length;
    assert.equal(peersAfterDetach, peersBefore, 'telnet TCP must survive WS close');

    // Re-attach with same sessionId.
    const ws2 = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws2.once('open', resolve);
        ws2.once('error', reject);
    });

    const msgs = collectUntil(
        ws2,
        (msg, bag) => bag.some((m) => m.type === 'ready' && m.attached === true),
        6000,
    );
    ws2.send(JSON.stringify({
        type: 'connect',
        protocol: 'TELNET',
        host: '127.0.0.1',
        port: listenPort,
        sessionId,
        cols: 80,
        rows: 24,
    }));
    const bag = await msgs;
    const ready2 = bag.find((m) => m.type === 'ready');
    assert.equal(ready2.sessionId, sessionId);
    assert.equal(ready2.attached, true);
    assert.equal(ready2.protocol, 'TELNET');
    assert.match(ready2.warning || '', /未加密/);

    // Replay must have arrived (type=data, replay=true) before or with ready.
    const replay = bag.find((m) => m.type === 'data' && m.replay === true);
    assert.ok(replay, 'attach must replay data');
    assert.match(replay.data, /login:/);
    assert.match(replay.data, /phase0-marker-/);
    assert.equal(ready2.replayed, true);

    // Live input after reattach still reaches the SAME peer.
    const afterMarker = `after-reattach-${Date.now()}\n`;
    ws2.send(JSON.stringify({ type: 'input', data: afterMarker }));
    const live = await waitFor(ws2, 'data');
    assert.match(live.data, /after-reattach-/);

    // Still one live peer for this session (not a new dial).
    const peersAfterReattach = peerSockets.filter((s) => !s.destroyed).length;
    assert.equal(peersAfterReattach, peersBefore, 'reattach must not dial a new TCP');

    ws2.close();
});

test('telnet session writes terminal history journal', async () => {
    const sessionId = `telnet-hist-${Date.now()}`;
    const ws = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    const readyH = await connectTelnet(ws, sessionId);
    if (!readyH._earlyData) await waitFor(ws, 'data'); // login:
    ws.send(JSON.stringify({ type: 'input', data: 'hist-check\n' }));
    await waitFor(ws, 'data');
    await new Promise((r) => setTimeout(r, 150));

    // HTTP history API should see records for this session.
    const res = await server.api(
        adminCookie,
        'GET',
        `/api/terminal-history/${encodeURIComponent(sessionId)}/tail?maxBytes=65536`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body?.data || '';
    assert.match(data, /login:/);
    assert.match(data, /hist-check/);
    ws.close();
});

test('existing telnet-ws smoke still green (ready + echo + NAWS)', async () => {
    peerReceived = [];
    const ws = openWs(adminCookie);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    const ready = await connectTelnet(ws, `telnet-smoke-${Date.now()}`);
    assert.equal(ready.protocol, 'TELNET');
    const loginPrompt = ready._earlyData || await waitFor(ws, 'data');
    assert.match(loginPrompt.data, /login:/);
    ws.send(JSON.stringify({ type: 'input', data: 'root\n' }));
    const echoed = await waitFor(ws, 'data');
    assert.match(echoed.data, /root/);
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 80));
    const all = Buffer.concat(peerReceived);
    assert.ok(
        all.includes(Buffer.from([255, 250, 31])) || all.includes(Buffer.from('\xff\xfa\x1f', 'binary')),
        'NAWS should be sent',
    );
    ws.close();
});
