import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('the product window drops the OS frame except on macOS', () => {
    const main = read('zephyr_one/electron/main.mjs');
    const start = main.indexOf('function createProductWindow()');
    const end = main.indexOf('async function startRuntime()');
    const body = main.slice(start, end);
    assert.match(body, /frame: mac/);
    assert.match(body, /titleBarStyle: mac \? 'hiddenInset'/);
    assert.match(body, /trafficLightPosition: mac \? \{ x: 14, y: 14 \}/);
    // The launch window keeps its frame; only the product window changes.
    const launch = main.slice(main.indexOf('function createMainWindow()'), start);
    assert.doesNotMatch(launch, /frame:/);
});

test('window control IPC is scoped to the requesting window', () => {
    const main = read('zephyr_one/electron/main.mjs');
    for (const channel of ['window_minimize', 'window_toggle_maximize', 'window_close']) {
        assert.match(main, new RegExp(`ipcMain.handle\\('${channel}'`));
    }
    assert.match(main, /BrowserWindow\.fromWebContents\(event\.sender\)/);
    assert.match(main, /windowControls: process\.platform === 'darwin' \? 'native' : 'overlay'/);
});

test('the embedded surface injects the window controls exactly once', async () => {
    const { applyEmbeddedSurface } = await import('../zephyr-one-embed-surface.js');
    const html = read('public/app.html');
    assert.doesNotMatch(html, /one-window-controls/, 'app.html must not ship window buttons');

    const first = applyEmbeddedSurface(html);
    assert.ok(first.applied.includes('add-window-controls'));
    assert.equal(first.html.match(/class="one-window-controls"/g).length, 1);
    assert.match(first.html, /zephyr-one-window-chrome\.js/);
    // Buttons sit inside the nav actions, at the right edge of the header.
    const nav = first.html.indexOf('<div class="nav-actions">');
    const controls = first.html.indexOf('class="one-window-controls"');
    const navEnd = first.html.indexOf('</header>', nav);
    assert.ok(nav < controls && controls < navEnd);

    const second = applyEmbeddedSurface(first.html);
    assert.equal(second.html.match(/class="one-window-controls"/g).length, 1);
    assert.ok(second.skipped.includes('add-window-controls'));
});

test('overlay controls are hidden unless the shell opts in', () => {
    const css = read('zephyr-one-embed.css');
    assert.match(css, /\.one-window-controls \{\s*display: none;/);
    assert.match(css, /\[data-zephyr-window-controls="overlay"\] \.one-window-controls \{\s*display: flex;/);
    assert.match(css, /-webkit-app-region: drag;/);
    assert.match(css, /-webkit-app-region: no-drag;/);
    assert.match(css, /\[data-zephyr-window-controls="native"\] \.main-nav/);
});

test('the chrome script never shows buttons without an overlay shell', () => {
    const script = read('zephyr-one-window-chrome.js');
    assert.match(script, /mode !== 'overlay' && mode !== 'native'/);
    assert.match(script, /controls\.hidden = false/);
    assert.match(script, /if \(!bridge \|\| typeof bridge\.invoke !== 'function'\) return;/);
    // macOS gets the inset marker but never the drawn buttons.
    assert.match(script, /mode === 'overlay'/);
});
