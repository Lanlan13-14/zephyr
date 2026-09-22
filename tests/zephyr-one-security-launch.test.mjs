import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const AUTH = read('zephyr_one/electron/auth.mjs');
const MAIN = read('zephyr_one/electron/main.mjs');
const PRELOAD = read('zephyr_one/electron/preload.cjs');
const WATCHERS = read('zephyr_one/electron/watchers.mjs');
const RUNTIME = read('zephyr_one/electron/runtime.mjs');
const SHELL = read('zephyr_one/src/main.js');
const HTML = read('zephyr_one/index.html');
const UI = read('zephyr-one-security-ui.js');
const HELLO = read('zephyr_one/electron/windows-hello.ps1');

test('auth_unlock unwraps the renderer { reason } payload', () => {
    assert.match(AUTH, /export function unlockReason\(payload/);
    assert.match(AUTH, /payload\.reason/);
    assert.match(MAIN, /unlock\(unlockReason\(payload\)\)/);
    assert.match(SHELL, /safeInvoke\('auth_unlock', \{ reason:/);
});

test('Windows Hello uses a STA helper file instead of an inline -Command script', () => {
    assert.equal(existsSync(path.join(root, 'zephyr_one/electron/windows-hello.ps1')), true);
    assert.match(AUTH, /windows-hello\.ps1/);
    assert.match(AUTH, /'-STA'/);
    assert.match(AUTH, /'-File', WINDOWS_HELLO_SCRIPT/);
    assert.match(HELLO, /CheckAvailabilityAsync/);
    assert.match(HELLO, /RequestVerificationAsync/);
    assert.match(HELLO, /exit 0/);
    assert.match(HELLO, /exit 2/);
    assert.doesNotMatch(AUTH, /\$asTaskGeneric = \(\[System\.WindowsRuntimeSystemExtensions\]/);
});

test('capabilities publish retries until the core accepts the MAC', () => {
    assert.match(WATCHERS, /published = response\.status === 200/);
    assert.match(WATCHERS, /tick\(\)\.catch\(\(\) => \{\}\);/);
    assert.match(WATCHERS, /if \(!base\) \{\s*published = false;/);
});

test('the boot window shows the launch overlay before Node is ready', () => {
    assert.match(HTML, /id="launchStage"/);
    assert.match(HTML, /id="iconSquircle"/);
    assert.match(HTML, /id="progressFill"/);
    assert.match(HTML, /launch-overlay\.css/);
    assert.match(SHELL, /createLaunchOverlay/);
    assert.match(SHELL, /listenRuntimeProgress/);
    assert.match(SHELL, /applyLaunchAppearance/);
    assert.match(SHELL, /await launch\.ready\(\)/);
    assert.match(PRELOAD, /runtime_progress/);
    assert.match(MAIN, /webContents\.send\('runtime_progress'/);
    assert.match(RUNTIME, /onProgress/);
    assert.match(RUNTIME, /readLaunchAppearance/);
    assert.match(RUNTIME, /writeLaunchAppearance/);
});

test('launch appearance follows palette, theme and window size', () => {
    const overlay = read('zephyr_one/src/js/shell/launch-overlay.js');
    for (const palette of ['frost', 'lava', 'asagi', 'cyber']) {
        assert.match(overlay, new RegExp(palette));
        assert.match(read('zephyr_one/src/styles/launch-overlay.css'), new RegExp(`data-palette="${palette}"`));
    }
    assert.match(overlay, /sizeForWindow/);
    assert.match(overlay, /prefers-reduced-motion/);
    assert.match(WATCHERS, /persistAppearance/);
    assert.match(WATCHERS, /nativeTheme\.shouldUseDarkColors/);
});

test('launch overlay CSS never transitions all and never uses display:none for motion', () => {
    const css = read('zephyr_one/src/styles/launch-overlay.css');
    assert.doesNotMatch(css, /transition:\s*all/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /transition: width/);
});

test('read/write launch appearance round-trips palette and theme', async () => {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(path.join(root, 'zephyr_one/electron/runtime.mjs')).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launch-'));
    const saved = mod.writeLaunchAppearance(dir, { palette: 'lava', theme: 'light', autoTheme: false });
    assert.deepEqual(saved, { palette: 'lava', theme: 'light', autoTheme: false });
    assert.deepEqual(mod.readLaunchAppearance(dir), saved);
    assert.equal(mod.normalizeLaunchAppearance({ palette: 'nope' }).palette, 'frost');
});

test('the One security switch stays enabled so a broken authenticator can be turned off', () => {
    assert.match(UI, /toggle\.disabled = false/);
    assert.doesNotMatch(UI, /toggle\.disabled = caps\.known === true && caps\.available !== true/);
});
