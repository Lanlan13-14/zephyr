import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('desktop One dials an Agent bastion through the embedded Link child, like Android', () => {
    const embed = read('zephyr-one-link-embed.js');
    assert.match(embed, /\/link\/dial/);
    assert.match(embed, /\/link\/dial\/finish/);
    assert.match(embed, /\/link\/tunnel\/initiator\/start/);
    assert.match(embed, /\/link\/tunnel\/initiator\/dial/);
    assert.match(embed, /zephyr-zsl2-handshake-v1/);
    assert.match(embed, /initiator stream is not started/);
    const server = read('server.js');
    assert.match(server, /oneLinkInitiator\.dial/);
    assert.match(server, /ZEPHYR_ONE_EMBEDDED && oneLinkInitiator/);
});

test('the desktop package stages zephyr-link-embed next to the bundled Node', () => {
    const stage = read('zephyr_one/scripts/stage-desktop-runtime.mjs');
    assert.match(stage, /zephyr-link-embed/);
    assert.match(stage, /cmd\/zephyr-link-embed/);
    const runtime = read('zephyr_one/electron/runtime.mjs');
    assert.match(runtime, /resolveLinkEmbedBin/);
    assert.match(runtime, /ZEPHYR_LINK_EMBED_BIN/);
    const workflow = read('.github/workflows/zephyr-one.yml');
    assert.match(workflow, /setup-go/);
});

test('handshake proof matches the Go prefix and P1363 encoding', async () => {
    const { handshakeProof } = await import(path.join(root, 'zephyr-one-link-embed.js'));
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const transcript = Buffer.from('transcript-bytes');
    const proof = handshakeProof(pem, 'device-1', transcript);
    const raw = Buffer.from(proof, 'base64');
    assert.equal(raw.length, 64);
    const payload = Buffer.concat([
        Buffer.from('zephyr-zsl2-handshake-v1'),
        Buffer.from([0]),
        Buffer.from('device-1'),
        Buffer.from([0]),
        transcript,
    ]);
    assert.equal(crypto.verify('sha256', payload, { key: pem, dsaEncoding: 'ieee-p1363' }, raw), true);
});
