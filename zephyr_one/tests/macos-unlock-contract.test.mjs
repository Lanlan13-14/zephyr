import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const authJs = read('zephyr_one/electron/auth.mjs');

test('macOS unlock uses LocalAuthentication DeviceOwnerAuthentication', () => {
    assert.match(authJs, /LocalAuthentication/);
    assert.match(authJs, /LAPolicyDeviceOwnerAuthentication/);
    assert.match(authJs, /osascript/);
    assert.match(authJs, /method: 'localauthentication'/);
});

test('macOS capabilities are reported as available with biometry', () => {
    const macAt = authJs.indexOf("process.platform === 'darwin'");
    assert.ok(macAt > 0);
    const block = authJs.slice(macAt, macAt + 350);
    assert.match(block, /available: true/);
    assert.match(block, /biometry: true/);
    assert.match(block, /Touch ID/);
});
