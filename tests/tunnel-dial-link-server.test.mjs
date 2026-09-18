import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GoLinkProcess, stopLinkV2Go, linkTunnelDial, linkTunnelAttach } = require('../link-v2-go-proxy.js');

function buildGo() {
    const output = path.join(os.tmpdir(), `zephyr-link-dial-${process.pid}`);
    const go = fs.existsSync('/tmp/go124/bin/go') ? '/tmp/go124/bin/go' : 'go';
    const built = spawnSync(go, ['build', '-trimpath', '-o', output, './cmd/zephyr-link-server'], {
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

test('linkTunnelDial against a live Go server no longer throws Parse Error', async () => {
    const bin = buildGo();
    process.env.ZEPHYR_LINK_GO_BIN = bin;
    try {
        // A missing session must fail as a structured tunnel error, never as
        // Node's HTTP parser screaming "Parse Error: Expected HTTP/".
        await assert.rejects(
            () => linkTunnelDial('no-such-session', '127.0.0.1', 22, 3000),
            (err) => {
                const msg = String(err?.message || err);
                assert.doesNotMatch(msg, /Parse Error/);
                assert.doesNotMatch(msg, /Expected HTTP/);
                return true;
            },
        );
    } finally {
        try { stopLinkV2Go(); } catch {}
        try { fs.rmSync(bin, { force: true }); } catch {}
        delete process.env.ZEPHYR_LINK_GO_BIN;
    }
});

test('Go source and Node client agree on the 101 upgrade', () => {
    const go = fs.readFileSync(path.join(repo, 'zephyr-link/cmd/zephyr-link-server/main.go'), 'utf8');
    const js = fs.readFileSync(path.join(repo, 'link-v2-go-proxy.js'), 'utf8');
    assert.match(go, /func writeTunnelUpgrade\(/);
    assert.match(go, /HTTP\/1\.1 101 Switching Protocols/);
    assert.match(go, /Upgrade: tcp/);
    assert.match(js, /Connection: 'Upgrade'/);
    assert.match(js, /Upgrade: 'tcp'/);
    assert.match(js, /req\.on\('upgrade'/);
});
