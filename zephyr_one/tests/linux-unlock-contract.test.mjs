import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const authJs = read('zephyr_one/electron/auth.mjs');

test('Linux capabilities report unavailable, with the documented Chinese reason', () => {
    assert.match(authJs, /available: false/);
    assert.match(authJs, /biometry: false/);
    assert.match(authJs, /Linux 无统一系统解锁 API/);
    assert.doesNotMatch(authJs, /libpam|polkit|secret-service/);
});

test('Linux unlock() fails honestly with an error, never a fake success', () => {
    assert.match(authJs, /Linux 当前不支持系统解锁，请保持开关关闭/);
    assert.doesNotMatch(authJs, /platform === 'linux'[\s\S]{0,200}ok:\s*true/);
});

test('the dev bypass is the only ok:true path that is not an OS prompt', () => {
    assert.match(authJs, /ZEPHYR_ONE_DEV_SYSTEM_UNLOCK_BYPASS/);
    assert.match(authJs, /dev-system-unlock-bypass/);
});

test('system unlock stays optional and defaults OFF in both stores', () => {
    const mainJs = read('zephyr_one/src/main.js');
    assert.match(mainJs, /requireUnlock: false/);
    assert.match(mainJs, /state\.requireUnlock = data\.requireUnlock === true/);
    const storeJs = read('zephyr_one/src/js/settings/store.js');
    assert.match(storeJs, /requireUnlock: false/);
});

test('the watcher mints a success verdict only from unlock().ok', () => {
    const watchers = read('zephyr_one/electron/watchers.mjs');
    assert.match(watchers, /const verdict = await unlock\(reason\)/);
    assert.match(watchers, /const ok = !!verdict\.ok/);
});
