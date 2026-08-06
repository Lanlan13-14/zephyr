import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function unusedPort() {
    return 39080 + Math.floor(Math.random() * 1000);
}

test('Android server starts with built-in SQLite and without native addons', () => {
    const staged = path.join(repo, 'zephyr_one', 'zephyr-core');
    assert.ok(fs.existsSync(path.join(staged, 'server.js')), 'stage Android core before this smoke test');
    assert.ok(!fs.existsSync(path.join(staged, 'node_modules', 'better-sqlite3')));
    assert.ok(!fs.existsSync(path.join(staged, 'node_modules', 'sharp')));
    assert.ok(!fs.existsSync(path.join(staged, 'node_modules', '@img')));

    const nodeBin = process.env.ZEPHYR_ONE_SMOKE_NODE || process.execPath;
    assert.ok(fs.existsSync(nodeBin), `smoke Node not found: ${nodeBin}`);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-android-start-'));
    try {
        const child = spawnSync(
            nodeBin,
            [
                path.join(repo, 'tests', 'android-core-startup-child.cjs'),
                staged,
                path.join(temp, 'data'),
                String(unusedPort()),
            ],
            { cwd: staged, encoding: 'utf8', timeout: 35_000 },
        );
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        assert.match(child.stdout, /Zephyr AI Tool Host/);
        assert.doesNotMatch(child.stderr, /Cannot find module 'better-sqlite3'|Cannot find module 'sharp'|\.node/);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
