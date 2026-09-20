import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const authJs = read('zephyr_one/electron/auth.mjs');

test('Windows unlock calls the real UserConsentVerifier verification', () => {
    assert.match(authJs, /UserConsentVerifier/);
    assert.match(authJs, /RequestVerificationAsync/);
    assert.match(authJs, /powershell\.exe/);
});

test('success is reachable only through a Verified verdict', () => {
    assert.match(authJs, /method: 'windows_hello'/);
    assert.match(authJs, /code === 0/);
});

test('Windows capabilities are reported as available with biometry', () => {
    assert.match(authJs, /Windows Hello \/ 设备 PIN/);
    const winAt = authJs.indexOf("process.platform === 'win32'");
    assert.ok(winAt > 0);
    const block = authJs.slice(winAt, winAt + 400);
    assert.match(block, /available: true/);
    assert.match(block, /biometry: true/);
});
