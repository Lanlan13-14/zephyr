// Emits the ZSL/2 key-schedule vectors. Only the deterministic part is vectorized:
// given a master key, what send/recv/exporter keys does the Node reference derive?
// Frame sealing uses a random IV by design and is covered by the live round-trip
// tests, not by a reproducibility-asserted file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const b64 = (b) => Buffer.from(b).toString('base64');
const salt = () => crypto.createHash('sha256').update('zephyr-zsl2-v1', 'utf8').digest();
const hkdf = (ikm, info, len = 32) =>
    Buffer.from(crypto.hkdfSync('sha256', ikm, salt(), Buffer.from(info, 'utf8'), len));

const master = crypto.createHash('sha256').update('zephyr-zsl2-interop-master-v1', 'utf8').digest();

const vectors = ['initiator', 'responder'].map((role) => ({
    master: b64(master),
    role,
    sendKey: b64(hkdf(master, role === 'initiator' ? 'zsl2-send-i' : 'zsl2-send-r')),
    recvKey: b64(hkdf(master, role === 'initiator' ? 'zsl2-send-r' : 'zsl2-send-i')),
    exporter: b64(hkdf(master, 'zsl2-exporter')),
}));

const out = path.join(repo, 'zephyr-link', 'internal', 'zsl', 'testdata', 'keyschedule.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(vectors, null, 2));
// The old frame-vector file is superseded by the deterministic key schedule.
fs.rmSync(path.join(repo, 'zephyr-link', 'internal', 'zsl', 'testdata', 'interop.json'), { force: true });
console.log('wrote', out, vectors.length, 'key-schedule vectors');
