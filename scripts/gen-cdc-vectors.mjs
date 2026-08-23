// Emits Node-CDC manifests so the Go CDC can prove identical chunking, hashing
// and Merkle folding — the precondition for account-wide blob dedup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cdc = require(path.join(repo, 'link-v2-cdc.js'));

const b64 = (b) => Buffer.from(b).toString('base64');
// Deterministic bodies/keys so the vectors are reproducible in CI.
const fill = (label, n) => {
    const out = [];
    let i = 0;
    while (Buffer.concat(out).length < n) { out.push(crypto.createHash('sha256').update(label + ':' + i, 'utf8').digest()); i += 1; }
    return Buffer.concat(out).subarray(0, n);
};

const vectors = [];
for (const size of [0, 4096, 100 * 1024, 300 * 1024]) {
    const body = fill('cdc-body-' + size, size);
    const accountKey = fill('cdc-key-' + size, 32);
    const m = cdc.buildManifest(body, { accountKey });
    vectors.push({
        body: b64(body),
        accountKey: b64(accountKey),
        sha256: m.sha256,
        merkle: m.merkle,
        chunkCount: m.chunks.length,
        firstKeyed: m.chunks.length ? m.chunks[0].keyedId : '',
    });
}

const out = path.join(repo, 'zephyr-link', 'internal', 'cdc', 'testdata', 'interop.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(vectors, null, 2));
console.log('wrote', out, vectors.length, 'cdc vectors');
