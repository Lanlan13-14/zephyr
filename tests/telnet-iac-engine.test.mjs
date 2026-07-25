/**
 * Phase 1: TelnetIacEngine — cross-packet IAC, option replies, TTYPE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IAC, DO, DONT, WILL, WONT, SB, SE, NOP,
    OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS, OPT_BINARY,
    TTYPE_IS, TTYPE_SEND,
    filterIac,
    TelnetIacEngine,
    sendNaws,
    classifyTerminalClose,
} from '../telnet-transport.js';


function collectWrites() {
    const written = [];
    return {
        written,
        write: (buf) => written.push(Buffer.from(buf)),
        flat: () => Buffer.concat(written),
    };
}

test('legacy filterIac still strips options and keeps payload', () => {
    const input = Buffer.from([
        0x68, 0x69,
        IAC, DO, OPT_ECHO,
        0x21,
        IAC, IAC,
        0x78,
    ]);
    assert.deepEqual([...filterIac(input)], [0x68, 0x69, 0x21, 0xff, 0x78]);
});

test('engine buffers incomplete IAC across chunks (no data loss)', () => {
    const eng = new TelnetIacEngine({ respond: false });
    // Split mid-sequence: "A" + IAC | DO ECHO + "B"
    const a = eng.feed(Buffer.from([0x41, IAC]));
    assert.deepEqual([...a], [0x41]);
    assert.equal(eng.pending.length, 1);
    const b = eng.feed(Buffer.from([DO, OPT_ECHO, 0x42]));
    assert.deepEqual([...b], [0x42]);
    assert.equal(eng.pending.length, 0);
});

test('engine buffers incomplete SB across chunks', () => {
    const eng = new TelnetIacEngine({ respond: false });
    // IAC SB TTYPE  split before SE
    const a = eng.feed(Buffer.from([0x41, IAC, SB, OPT_TTYPE, TTYPE_SEND]));
    assert.deepEqual([...a], [0x41]);
    assert.ok(eng.pending.length > 0);
    const b = eng.feed(Buffer.from([IAC, SE, 0x42]));
    assert.deepEqual([...b], [0x42]);
});

test('engine answers TTYPE SEND with xterm-256color', () => {
    const w = collectWrites();
    const eng = new TelnetIacEngine({ write: w.write, termType: 'xterm-256color' });
    // Peer: IAC SB TTYPE SEND IAC SE + payload "hi"
    const chunk = Buffer.from([
        IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE,
        0x68, 0x69,
    ]);
    const out = eng.feed(chunk);
    assert.deepEqual([...out], [0x68, 0x69]);
    const flat = w.flat();
    // IAC SB TTYPE IS "xterm-256color" IAC SE
    const expected = Buffer.from([
        IAC, SB, OPT_TTYPE, TTYPE_IS,
        ...Buffer.from('xterm-256color', 'ascii'),
        IAC, SE,
    ]);
    assert.ok(flat.equals(expected) || flat.includes(expected), `got ${flat.toString('hex')}`);
    assert.deepEqual([...flat], [...expected]);
});

test('engine replies WILL to DO NAWS (wanted) and WONT to DO STATUS (unwanted)', () => {
    const w = collectWrites();
    const eng = new TelnetIacEngine({ write: w.write });
    // DO NAWS — we want it and already seeded us=true from constructor, so no re-WILL.
    // Force us off first to exercise the reply path.
    eng.us.set(OPT_NAWS, false);
    eng.feed(Buffer.from([IAC, DO, OPT_NAWS]));
    assert.equal(eng.us.get(OPT_NAWS), true);
    assert.ok(w.flat().includes(Buffer.from([IAC, WILL, OPT_NAWS])));

    w.written.length = 0;
    eng.feed(Buffer.from([IAC, DO, 5 /* STATUS */]));
    assert.ok(w.flat().includes(Buffer.from([IAC, WONT, 5])));
});

test('engine accepts WILL ECHO/SGA and rejects WILL of unknown option', () => {
    const w = collectWrites();
    const eng = new TelnetIacEngine({ write: w.write });
    eng.feed(Buffer.from([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA]));
    assert.equal(eng.him.get(OPT_ECHO), true);
    assert.equal(eng.him.get(OPT_SGA), true);
    const flat = w.flat();
    assert.ok(flat.includes(Buffer.from([IAC, DO, OPT_ECHO])));
    assert.ok(flat.includes(Buffer.from([IAC, DO, OPT_SGA])));

    w.written.length = 0;
    eng.feed(Buffer.from([IAC, WILL, 99]));
    assert.ok(w.flat().includes(Buffer.from([IAC, DONT, 99])));
});

test('engine does not loop: repeated DO of already-enabled option is silent', () => {
    const w = collectWrites();
    const eng = new TelnetIacEngine({ write: w.write });
    eng.us.set(OPT_TTYPE, true);
    eng.feed(Buffer.from([IAC, DO, OPT_TTYPE]));
    assert.equal(w.written.length, 0);
});

test('engine strips NOP/GA and keeps escaped 0xFF', () => {
    const eng = new TelnetIacEngine({ respond: false });
    const out = eng.feed(Buffer.from([
        0x41,
        IAC, NOP,
        IAC, IAC,
        0x42,
    ]));
    assert.deepEqual([...out], [0x41, 0xff, 0x42]);
});

test('engine TTYPE reply survives split SEND body', () => {
    const w = collectWrites();
    const eng = new TelnetIacEngine({ write: w.write, termType: 'vt100' });
    eng.feed(Buffer.from([IAC, SB, OPT_TTYPE]));
    eng.feed(Buffer.from([TTYPE_SEND, IAC]));
    eng.feed(Buffer.from([SE]));
    const flat = w.flat();
    const expected = Buffer.from([
        IAC, SB, OPT_TTYPE, TTYPE_IS,
        ...Buffer.from('vt100', 'ascii'),
        IAC, SE,
    ]);
    assert.deepEqual([...flat], [...expected]);
});

test('keepalive emits IAC NOP and stopKeepalive ends it', async () => {
    const w = collectWrites();
    const eng = new TelnetIacEngine({ write: w.write });
    eng.startKeepalive(15);
    // Wait long enough for at least one interval tick under load.
    for (let i = 0; i < 20 && w.written.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
    eng.stopKeepalive();
    const nops = w.written.filter((b) => b.length === 2 && b[0] === IAC && b[1] === NOP);
    assert.ok(nops.length >= 1, `expected ≥1 NOP, got ${nops.length}`);
    const countAfterStop = w.written.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.written.length, countAfterStop, 'no more NOPs after stop');
    eng.destroy();
});

test('sendNaws still RFC 1073', () => {
    const w = collectWrites();
    sendNaws({ write: w.write }, 120, 40);
    assert.deepEqual([...w.written[0]], [
        IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE,
    ]);
});

test('engine normalizes CR NUL to CR when peer is not BINARY', () => {
    const eng = new TelnetIacEngine({ respond: false });
    const out = eng.feed(Buffer.from([0x41, 0x0d, 0x00, 0x42]));
    assert.deepEqual([...out], [0x41, 0x0d, 0x42]);
});

test('engine holds lone CR across chunks then applies CR NUL rule', () => {
    const eng = new TelnetIacEngine({ respond: false });
    const a = eng.feed(Buffer.from([0x41, 0x0d]));
    assert.deepEqual([...a], [0x41]);
    const b = eng.feed(Buffer.from([0x00, 0x42]));
    assert.deepEqual([...b], [0x0d, 0x42]);
});

test('engine does not strip CR NUL when peer WILL BINARY accepted', () => {
    const eng = new TelnetIacEngine({ write: () => {}, respond: true });
    eng.feed(Buffer.from([IAC, WILL, OPT_BINARY])); // him BINARY on
    assert.equal(eng.him.get(OPT_BINARY), true);
    const out = eng.feed(Buffer.from([0x0d, 0x00, 0x42]));
    assert.deepEqual([...out], [0x0d, 0x00, 0x42]);
});

test('classifyTerminalClose maps reasons', () => {
    assert.equal(classifyTerminalClose('telnet-close', 'TELNET').code, 'remote_close');
    assert.equal(classifyTerminalClose('telnet-error', 'TELNET').code, 'remote_error');
    assert.equal(classifyTerminalClose('detached-ttl', 'TELNET').code, 'detached_ttl');
    assert.equal(classifyTerminalClose('client-disconnect', 'SSH').code, 'client_disconnect');
    assert.match(classifyTerminalClose('telnet-close', 'TELNET').message, /对端|Telnet/);
});

