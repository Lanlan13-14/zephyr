// Emits Node-codec frames so the Go codec can prove it unpacks them identically.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const codec = require(path.join(repo, 'link-v2-codec.js'));

const b64 = (b) => Buffer.from(b).toString('base64');

const bodies = [
    { kind: codec.KIND.SYNC_OP, body: { op: 'upsert', entity: 'note', id: 'n1', rev: 3 }, secret: false },
    { kind: codec.KIND.SYNC_ACK, body: { cursor: 42, ok: true }, secret: false },
    { kind: codec.KIND.BLOB_MANIFEST, body: { size: 1024, root: b64(crypto.randomBytes(32)) }, secret: false },
    // Large, incompressible body -> stays under the ratio guard but exercises ZSTD flag path off.
    { kind: codec.KIND.BLOB_CHUNK, body: { data: b64(crypto.randomBytes(2048)) }, secret: false },
    // Repetitive large body -> zstd compresses; Go must inflate it back.
    { kind: codec.KIND.SYNC_OP, body: { pad: 'ab'.repeat(2000) }, secret: false },
    // Secret frame: never compressed regardless of size.
    { kind: codec.KIND.SYNC_OP, body: { pad: 'cd'.repeat(2000), token: 's3cr3t' }, secret: true },
];

const vectors = bodies.map(({ kind, body, secret }) => ({
    kind,
    secret,
    packed: b64(codec.pack({ kind, body, secret })),
    // What Go should recover as the unpacked body, re-encoded canonically for comparison.
    body: b64(codec.unpack(codec.pack({ kind, body, secret })).body === undefined
        ? Buffer.from(JSON.stringify(body))
        : (() => { const u = codec.unpack(codec.pack({ kind, body, secret })); return require(path.join(repo, 'link-v2-cbor.js')).encode(u.body); })()),
}));

const out = path.join(repo, 'zephyr-link', 'internal', 'codec', 'testdata', 'interop.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(vectors, null, 2));
console.log('wrote', out, vectors.length, 'codec vectors');
