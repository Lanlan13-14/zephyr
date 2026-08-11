import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { TestServer } from './test-server.mjs';

const PASSWORD = 'backup-import-multipart-pass';
const IMPORT_GRANT_HEADER = 'x-zephyr-backup-import-grant';
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

async function startAuthenticatedServer(t) {
    const server = new TestServer();
    await server.start();
    t.after(async () => { await server.cleanup(); });
    const auth = await server.bootstrapAdmin(PASSWORD);
    return { server, cookie: auth.cookie };
}

async function readResponse(response) {
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { response, status: response.status, text, body };
}

async function issueGrant(server, cookie, password = PASSWORD) {
    const result = await readResponse(await fetch(server.url('/api/data/import/grant'), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            cookie,
            origin: server.url(''),
        },
        body: JSON.stringify({ password }),
    }));
    assert.equal(result.status, 200, result.text);
    assert.match(String(result.body?.grant || ''), /^[A-Za-z0-9_-]{43}$/);
    return result.body.grant;
}

function multipart(parts) {
    const boundary = `----zephyr-${crypto.randomBytes(12).toString('hex')}`;
    const chunks = [];
    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        let disposition = `Content-Disposition: form-data; name="${part.name}"`;
        if (part.filename !== undefined) disposition += `; filename="${part.filename}"`;
        chunks.push(Buffer.from(`${disposition}\r\n`));
        if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
        chunks.push(Buffer.from('\r\n'));
        chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { boundary, body: Buffer.concat(chunks) };
}

async function postMultipart(server, cookie, payload, grant = '') {
    return readResponse(await fetch(server.url('/api/data/import'), {
        method: 'POST',
        headers: {
            cookie,
            origin: server.url(''),
            'content-type': `multipart/form-data; boundary=${payload.boundary}`,
            ...(grant ? { [IMPORT_GRANT_HEADER]: grant } : {}),
        },
        body: payload.body,
    }));
}

async function abortMultipartUpload(server, cookie, grant) {
    const boundary = `----zephyr-abort-${crypto.randomBytes(12).toString('hex')}`;
    const base = new URL(server.url('/api/data/import'));
    const request = http.request({
        hostname: base.hostname,
        port: base.port,
        path: base.pathname,
        method: 'POST',
        headers: {
            cookie,
            origin: server.url(''),
            [IMPORT_GRANT_HEADER]: grant,
            'content-type': `multipart/form-data; boundary=${boundary}`,
        },
    });
    const closed = new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        request.once('error', done);
        request.once('close', done);
    });
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="aborted.enc"\r\n\r\n`);
    request.write(Buffer.alloc(256 * 1024));
    try {
        await waitFor(() => uploadArtifacts(server).length === 1, 10_000, 'upload directory was not created');
    } finally {
        request.destroy();
        await closed;
    }
}

function uploadArtifacts(server) {
    return fs.readdirSync(server.dir)
        .filter((name) => name.startsWith('.zephyr-import-upload-'));
}

function assertNoUploadArtifacts(server, label = '') {
    const artifacts = uploadArtifacts(server);
    assert.deepEqual(artifacts, [], `${label}: orphaned import uploads: ${artifacts.join(', ')}`);
}

async function waitFor(predicate, timeoutMs, timeoutMessage) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(timeoutMessage);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function postMultipartWhenAvailable(server, cookie, payload, grant, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const result = await postMultipart(server, cookie, payload, grant);
        if (result.status !== 429 || result.body?.code !== 'backup_import_busy') return result;
        if (Date.now() >= deadline) throw new Error('backup import slot was not released after upload cleanup');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function basicFileParts(extra = []) {
    return [
        { name: 'backup', filename: 'backup.enc', contentType: 'application/octet-stream', value: Buffer.from('not-an-archive') },
        ...extra,
    ];
}

test('backup import grants fail uniformly before multipart parsing and cannot replay', { timeout: 120_000 }, async (t) => {
    const { server, cookie } = await startAuthenticatedServer(t);
    const missingPassword = await readResponse(await fetch(server.url('/api/data/import/grant'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: server.url('') },
        body: JSON.stringify({}),
    }));
    const wrongPassword = await readResponse(await fetch(server.url('/api/data/import/grant'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: server.url('') },
        body: JSON.stringify({ password: 'not-the-password' }),
    }));
    assert.equal(missingPassword.status, 403);
    assert.deepEqual(missingPassword.body, wrongPassword.body, 'password failures must not form an oracle');

    const malformed = { boundary: 'malformed', body: Buffer.from('not-a-multipart-body') };
    const noGrant = await postMultipart(server, cookie, malformed);
    const badGrant = await postMultipart(server, cookie, malformed, crypto.randomBytes(32).toString('base64url'));
    assert.equal(noGrant.status, 403, noGrant.text);
    assert.deepEqual(noGrant.body, badGrant.body, 'missing and malformed grants must be indistinguishable');
    assertNoUploadArtifacts(server);

    const grant = await issueGrant(server, cookie);
    const parsed = await postMultipart(server, cookie, multipart(basicFileParts([
        { name: 'backupPassword', value: 'wrong-backup-password' },
    ])), grant);
    assert.equal(parsed.status, 400, parsed.text);
    const replay = await postMultipart(server, cookie, malformed, grant);
    assert.equal(replay.status, 403, replay.text);
    assert.deepEqual(replay.body, noGrant.body, 'consumed grants must be indistinguishable from absent grants');
    assertNoUploadArtifacts(server);
    assert.equal((await fetch(server.url('/healthz'))).status, 200);
});

test('backup import multipart parser rejects deep, repeated, flooded, old-password, and extra-file payloads', { timeout: 120_000 }, async (t) => {
    const { server, cookie } = await startAuthenticatedServer(t);
    const rejected = async (label, parts, expectedStatus) => {
        const result = await postMultipart(server, cookie, multipart(parts), await issueGrant(server, cookie));
        assert.equal(result.status, expectedStatus, `${label}: ${result.text}`);
        assert.equal(result.body?.code,
            expectedStatus === 413 ? 'backup_import_payload_too_large' : 'invalid_backup_import_multipart');
        assert.doesNotMatch(String(result.body?.error || ''), /too many|field name|unexpected field/i,
            'Multer internals must not reach the client');
        assertNoUploadArtifacts(server, label);
    };

    await rejected('old password', basicFileParts([{ name: 'loginPassword', value: PASSWORD }]), 400);
    await rejected('deep field', basicFileParts([{ name: 'backupPassword[a][b][c][d][e]', value: 'x' }]), 400);
    await rejected('repeated password', basicFileParts([
        { name: 'backupPassword', value: 'first' },
        { name: 'backupPassword', value: 'second' },
    ]), 413);
    await rejected('field flood', basicFileParts(Array.from({ length: 8 }, (_, index) => ({ name: `field${index}`, value: 'x' }))), 413);
    await rejected('extra file', [
        { name: 'backup', filename: 'one.enc', value: Buffer.from('one') },
        { name: 'backup', filename: 'two.enc', value: Buffer.from('two') },
    ], 400);
    assert.equal((await fetch(server.url('/healthz'))).status, 200);
});

test('backup import rejects an actual oversized file through the bounded disk parser', { timeout: 120_000 }, async (t) => {
    const { server, cookie } = await startAuthenticatedServer(t);
    const grant = await issueGrant(server, cookie);
    const payload = multipart([{
        name: 'backup',
        filename: 'oversized.enc',
        contentType: 'application/octet-stream',
        value: Buffer.alloc(MAX_IMPORT_BYTES + 1),
    }]);
    const result = await postMultipart(server, cookie, payload, grant);
    assert.equal(result.status, 413, result.text);
    assert.equal(result.body?.code, 'backup_import_payload_too_large');
    assertNoUploadArtifacts(server);
    assert.equal((await fetch(server.url('/healthz'))).status, 200);
});

test('an aborted multipart upload releases its slot and removes its private directory', { timeout: 120_000 }, async (t) => {
    const { server, cookie } = await startAuthenticatedServer(t);
    await abortMultipartUpload(server, cookie, await issueGrant(server, cookie));

    const next = await postMultipartWhenAvailable(server, cookie, multipart(basicFileParts([
        { name: 'loginPassword', value: PASSWORD },
    ])), await issueGrant(server, cookie));
    assert.equal(next.status, 400, next.text);
    assert.equal(next.body?.code, 'invalid_backup_import_multipart');
    assertNoUploadArtifacts(server);
});
