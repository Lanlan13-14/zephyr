// Generates Go<->Node ZSL/2 interop vectors. A fixed master key is fed to the
// Node reference session, which seals frames; the Go test replays open() and
// must accept them. This proves the two implementations share the key schedule
// and wire format byte-for-byte — the precondition for three clients on one
// protocol.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const zsl = require(path.join(repo, 'link-v2-zsl.js'));

const b64 = (b) => Buffer.from(b).toString('base64');

function sealFromMaster(master, role, plaintext, seq) {
    // openSession is not exported; build a session the same way it does.
    const sendLabel = role === 'initiator' ? 'zsl2-send-i' : 'zsl2-send-r';
    const exporter = crypto.hkdfSync('sha256', master, crypto.createHash('sha256').update('zephyr-zsl2-v1', 'utf8').digest(), Buffer.from('zsl2-exporter', 'utf8'), 32);
    const sendKey = crypto.hkdfSync('sha256', master, crypto.createHash('sha256').update('zephyr-zsl2-v1', 'utf8').digest(), Buffer.from(sendLabel, 'utf8'), 32);
    const recvKey = crypto.hkdfSync('sha256', master, crypto.createHash('sha256').update('zephyr-zsl2-v1', 'utf8').digest(), Buffer.from(role === 'initiator' ? 'zsl2-send-r' : 'zsl2-send-i', 'utf8'), 32);
    const sess = new zsl.Zsl2Session({ role, sendKey: Buffer.from(sendKey), recvKey: Buffer.from(recvKey), exporter: Buffer.from(exporter) });
    // Force the sequence to the requested value for a deterministic vector.
    sess.sendSeq = BigInt(seq);
    return sess.seal(Buffer.from(plaintext, 'utf8'));
}

const master = crypto.randomBytes(32);
const vectors = [];
for (const [i, role] of ['initiator', 'responder'].entries()) {
    for (let seq = 0; seq < 3; seq += 1) {
        const pt = `interop-${role}-${seq}`;
        const f = sealFromMaster(master, role, pt, seq);
        vectors.push({
            master: b64(master),
            role,
            plaintext: pt,
            seq: Number(f.seq),
            iv: b64(f.iv),
            ct: b64(f.ct),
            tag: b64(f.tag),
            expectOpenOk: true,
        });
    }
    void i;
}
// One tampered vector must fail to open.
const bad = vectors[0];
vectors.push({ ...bad, tag: b64(Buffer.from(bad.tag, 'base64').map((b, idx) => (idx === 0 ? b ^ 0xff : b))), expectOpenOk: false });

const out = path.join(repo, 'zephyr-link', 'internal', 'zsl', 'testdata', 'interop.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(vectors, null, 2));
console.log('wrote', out, vectors.length, 'vectors');
