import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buildEmbed() {
    const output = path.join(os.tmpdir(), `zephyr-link-embed-${process.pid}`);
    const go = fs.existsSync('/tmp/go124/bin/go') ? '/tmp/go124/bin/go' : 'go';
    const built = spawnSync(go, ['build', '-trimpath', '-o', output, './cmd/zephyr-link-embed'], {
        cwd: path.join(repo, 'zephyr-link'),
        encoding: 'utf8',
        env: {
            ...process.env,
            GOTOOLCHAIN: 'local',
            GOTMPDIR: '/tmp',
            GOCACHE: '/tmp/gocache',
            GOMODCACHE: '/tmp/gomod',
            TMPDIR: '/tmp',
            PATH: `/tmp/go124/bin:${process.env.PATH}`,
        },
    });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    return output;
}

function startEmbed(bin, identityDir) {
    const child = spawn(bin, [], {
        env: { ...process.env, ZEPHYR_LINK_IDENTITY_DIR: identityDir },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (c) => {
            buf += c.toString();
            const nl = buf.indexOf('\n');
            if (nl !== -1) {
                child.stdout.off('data', onData);
                resolve({ child, addr: buf.slice(0, nl).trim() });
            }
        };
        child.stdout.on('data', onData);
        child.on('exit', (code) => reject(new Error(`embed exited ${code}`)));
        setTimeout(() => reject(new Error('embed start timeout')), 8000).unref();
    });
}

function post(addr, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port: Number(addr.split(':')[1]),
            path: pathname,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch {}
                resolve({ status: res.statusCode, json, text });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

test('zephyr-link-embed prints a loopback addr and serves identity + mlkem', async () => {
    const bin = buildEmbed();
    const identity = fs.mkdtempSync(path.join(os.tmpdir(), 'link-id-'));
    const { child, addr } = await startEmbed(bin, identity);
    try {
        assert.match(addr, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/);
        const jwk = await post(addr, '/link/identity/jwk', { deviceId: 'dev-embed' });
        assert.equal(jwk.status, 200, jwk.text);
        assert.equal(jwk.json.ok, true);
        assert.equal(jwk.json.jwk.kty, 'EC');
        assert.equal(jwk.json.jwk.crv, 'P-256');

        const kem = await post(addr, '/link/mlkem/generate', {});
        assert.equal(kem.status, 200, kem.text);
        assert.ok(kem.json.publicKey);
        assert.ok(kem.json.seed);

        const proof = await post(addr, '/link/identity/enrollment-proof', {
            bindId: 'bind', deviceId: 'dev-embed', userCode: 'ab12', sas: 'sas',
            enrollmentSecret: 'secret', serverId: 'srv',
        });
        assert.equal(proof.status, 200, proof.text);
        assert.ok(proof.json.proof);
        assert.equal(Buffer.from(proof.json.proof, 'base64').length, 64);
    } finally {
        try { child.stdin.end(); } catch {}
        try { child.kill('SIGTERM'); } catch {}
        try { fs.rmSync(bin, { force: true }); } catch {}
        try { fs.rmSync(identity, { recursive: true, force: true }); } catch {}
    }
});
