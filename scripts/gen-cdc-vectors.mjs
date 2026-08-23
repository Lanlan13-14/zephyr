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

const vectors = [];
for (const size of [0, 4096, 100 * 1024, 300 * 1024]) {
    const body = crypto.randomBytes(size);
    const accountKey = crypto.randomBytes(32);
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
