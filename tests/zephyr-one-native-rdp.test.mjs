import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const WORKFLOW = read('.github/workflows/zephyr-one.yml');
const STAGE = read('zephyr_one/scripts/stage-zephyr-core.sh');
const SERVER = read('server.js');
const PKG = read('zephyr_one/package.json');

test('desktop One keeps the Web WASM RDP client', () => {
    assert.match(STAGE, /WASM RDP/);
    assert.doesNotMatch(STAGE, /stage-native-rdp\.mjs/);
    assert.match(SERVER, /pathname === '\/rdp-proxy'/);
    assert.doesNotMatch(SERVER, /ZEPHYR_ONE_EMBEDDED && pathname === '\/rdp-proxy'/);
    assert.ok(fs.existsSync(path.join(root, 'public/rdp.html')));
    assert.ok(fs.existsSync(path.join(root, 'public/rdp-wasm-client.js')));
});

test('the Electron workflow does not compile FreeRDP', () => {
    assert.doesNotMatch(WORKFLOW, /build-freerdp\.sh/);
    assert.doesNotMatch(WORKFLOW, /cargo test --lib/);
    assert.doesNotMatch(WORKFLOW, /dtolnay\/rust-toolchain/);
    assert.match(WORKFLOW, /electron-builder/);
    assert.match(PKG, /"electron":/);
});

test('native FreeRDP commands are no longer the desktop RDP engine', () => {
    const electronMain = read('zephyr_one/electron/main.mjs');
    assert.doesNotMatch(electronMain, /rdp_native_connect/);
    assert.doesNotMatch(read('zephyr_one/src/main.js'), /createNativeRdpShellController/);
});
