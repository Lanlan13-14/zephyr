import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
    IAC, DO, DONT, WILL, WONT, SB, SE,
    OPT_NAWS, OPT_TTYPE, OPT_ECHO, OPT_SGA,
    defaultPort, filterIac, sendNaws, dialTelnet,
} from '../telnet-transport.js';

test('defaultPort maps known protocols', () => {
    assert.equal(defaultPort('SSH'), 22);
    assert.equal(defaultPort('TELNET'), 23);
    assert.equal(defaultPort('RDP'), 3389);
    assert.equal(defaultPort('VNC'), 5900);
    assert.equal(defaultPort('unknown'), 22);
});

test('filterIac strips option negotiations and keeps payload', () => {
    // "hi" + IAC DO ECHO + "!" + IAC IAC (literal 0xFF) + "x"
    const input = Buffer.from([
        0x68, 0x69,
        IAC, DO, OPT_ECHO,
        0x21,
        IAC, IAC,
        0x78,
    ]);
    const out = filterIac(input);
    assert.deepEqual([...out], [0x68, 0x69, 0x21, 0xff, 0x78]);
});

test('filterIac strips subnegotiation blocks', () => {
    const input = Buffer.from([
        0x41,
        IAC, SB, OPT_TTYPE, 0x00, 0x78, 0x74, IAC, SE,
        0x42,
        IAC, WILL, OPT_SGA,
        0x43,
    ]);
    const out = filterIac(input);
    assert.deepEqual([...out], [0x41, 0x42, 0x43]);
});

test('filterIac drops truncated trailing IAC', () => {
    const out = filterIac(Buffer.from([0x41, IAC]));
    assert.deepEqual([...out], [0x41]);
});

test('sendNaws writes RFC 1073 window-size SB', () => {
    const written = [];
    const fake = { write: (buf) => written.push(Buffer.from(buf)) };
    sendNaws(fake, 120, 40);
    assert.equal(written.length, 1);
    assert.deepEqual([...written[0]], [
        IAC, SB, OPT_NAWS,
        0, 120,
        0, 40,
        IAC, SE,
    ]);
});

test('dialTelnet negotiates and resolves on TCP connect', async () => {
    const received = [];
    const server = net.createServer((sock) => {
        sock.on('data', (chunk) => received.push(Buffer.from(chunk)));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const socket = await dialTelnet({ host: '127.0.0.1', port }, { timeout: 3000, cols: 80, rows: 24 });
        // give the server a moment to receive negotiate packets
        await new Promise((r) => setTimeout(r, 50));
        socket.destroy();
        const all = Buffer.concat(received);
        // Expect WILL NAWS, WILL TTYPE, DO SGA, DO ECHO, then NAWS SB
        assert.ok(all.includes(Buffer.from([IAC, WILL, OPT_NAWS])), 'WILL NAWS');
        assert.ok(all.includes(Buffer.from([IAC, WILL, OPT_TTYPE])), 'WILL TTYPE');
        assert.ok(all.includes(Buffer.from([IAC, DO, OPT_SGA])), 'DO SGA');
        assert.ok(all.includes(Buffer.from([IAC, DO, OPT_ECHO])), 'DO ECHO');
        assert.ok(all.includes(Buffer.from([IAC, SB, OPT_NAWS])), 'NAWS SB');
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('dialTelnet rejects missing host and unreachable port', async () => {
    await assert.rejects(() => dialTelnet({ host: '', port: 23 }), /主机/);
    await assert.rejects(
        () => dialTelnet({ host: '127.0.0.1', port: 1 }, { timeout: 500 }),
        /ECONNREFUSED|Telnet|connect|refused/i,
    );
});
