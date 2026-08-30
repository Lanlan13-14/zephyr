import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pin = read('public/panel-pin.js');
const css = read('public/panel-pin.css');
const terminal = read('public/terminal.js');
const telnet = read('public/telnet-terminal.js');
const rdp = read('public/rdp-wasm-client.js');
const vnc = read('public/novnc.js');
const app = read('public/app.js');
const sw = read('public/sw.js');

test('panel pin uses the exact tgl-pin released visual and motion contract', () => {
    for (const fragment of [
        '.tgl.panel-pin-btn', '--s: 18px', 'border: 1.5px solid #4a4f5a',
        'background: #1e2025', 'background: #dfe3ea', 'border-color: #5d6372',
        'cubic-bezier(.34, 1.56, .64, 1)', 'transform: scale(.85)',
    ]) assert.ok(css.includes(fragment), fragment);
    assert.match(pin, /button\.className = `tgl panel-pin-btn \$\{side\}`/);
});

test('the pinned ON state is also byte-identical to the demo', () => {
    for (const fragment of [
        'border-color: #9aa2b1',
        'background: #262932',
        'box-shadow: 0 0 6px rgba(223, 227, 234, .35)',
    ]) assert.ok(css.includes(fragment), fragment);
    assert.doesNotMatch(css, /\.panel-pin-btn\.on[^}]*var\(--accent/s);
});

test('pinned panels remove floating shadow/transform and traffic chrome resets after release', () => {
    for (const fragment of ['box-shadow: none !important;', 'transform: none !important;', 'filter: none !important;']) assert.ok(css.includes(fragment), fragment);
    assert.match(pin, /button\.classList\.remove\('active-layout'\)/);
    assert.match(pin, /button\.style\.removeProperty\('opacity'\)/);
    assert.match(pin, /syncChrome\(panel\);\n            panelGroup\(owner\)\.forEach/);
});

test('panel pins are desktop-only and mobile cannot receive controls', () => {
    assert.match(pin, /\(hover: hover\) and \(pointer: fine\)/);
    assert.match(pin, /Math\.min\(window\.innerWidth \|\| 0, window\.innerHeight \|\| 0\) > 700/);
    assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{ \.panel-pin-btn \{ display: none !important; \} \}/);
});

test('side rails stay above bottom dock while bottom dock owns the full lower row', () => {
    assert.match(pin, /function halfInset\(page\)/);
    assert.match(pin, /const height = fullHeight - halfInset\(page\)/);
    assert.match(pin, /left: `\$\{scope\.left\}px`, top: `\$\{scope\.top \+ fullHeight - height\}px`, width: `\$\{scope\.width\}px`, height: `\$\{height\}px`/);
    assert.match(css, /pin-has-bottom/);
    assert.match(css, /var\(--pin-inset-bottom, 0px\)/);
});

test('bottom dock locks both pin buttons and supports top-handle vertical resize', () => {
    assert.match(pin, /mode === 'half' \|\| button\.dataset\.pinSide === side/);
    assert.match(pin, /if \(panel\.dataset\.pinMode === 'half'\) return;/);
    assert.match(pin, /function bindPinnedVerticalDrag\(panel, handle\)/);
    assert.match(pin, /startHeight \+ \(startY - ev\.clientY\)/);
    assert.match(pin, /panelGroup\(page\)\.forEach\(\(other\) => other !== panel && place\(other\)\);\n            applyInsets\(page\);/);
});

test('pinned traffic menu reuses the exact unpinned island host and icon contract', () => {
    assert.match(pin, /menu\.className = 'panel-layout-menu panel-pin-menu'/);
    for (const icon of ['full', 'half', 'left', 'right', 'unpin', 'close']) {
        assert.match(pin, new RegExp(`<span class="panel-layout-icon ${icon}"></span>`), icon);
    }
    assert.match(pin, /menu\.classList\.add\('island-open'\)/);
    assert.match(pin, /menu\.classList\.add\('island-closing', 'island-animating'\)/);
    assert.match(css, /\.panel-pin-menu \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/);
    assert.doesNotMatch(css, /\.panel-pin-menu button \{[^}]*flex-direction: column/s);
});

test('unpinned traffic click preserves original panel menu behavior', () => {
    assert.match(pin, /if \(!panel\.dataset\.pinSide\) return;/);
    assert.match(pin, /Capture phase preserves ordinary original three-dot behavior exactly/);
});

test('nested cloned panels are explicitly reset to ordinary floating windows', () => {
    for (const source of [terminal, telnet]) {
        assert.match(source, /delete panel\.dataset\.desktopPinWired/);
        assert.match(source, /delete panel\.dataset\.pinSide/);
        assert.match(source, /panel\.classList\.remove\('pinned', 'pin-animating'\)/);
        assert.match(source, /panel\.querySelectorAll\('\.panel-pin-btn'\)\.forEach\(\(button\) => button\.remove\(\)\)/);
    }
});

test('all desktop top-level panel surfaces are wired; demo is not referenced', () => {
    for (const source of [terminal, telnet, rdp, vnc, app]) {
        assert.match(source, /attachDesktopPanelPin/);
        assert.match(source, /panel-pin\.js\?v=20260830-desktop-panel-pin4/);
        assert.doesNotMatch(source, /panel-pin-demo/);
    }
    for (const name of ['fileManager', 'infoModal', 'dockerPanel', 'snippetPanel', 'shortcutPanel']) assert.ok(terminal.includes(name));
    for (const name of ['clipboardPanel', 'filesPanel', 'shortcutsPanel', 'joystickPanel']) assert.ok(rdp.includes(name));
    assert.match(app, /attachDesktopPanelPin\(document\.querySelector\('\.app-shell'\), panel/);
    assert.doesNotMatch(pin, /panel-pin-demo/);
});

test('pinning uses complete geometry and surface transitions without a flash animation', () => {
    for (const fragment of [
        'left .52s var(--ios-open) !important', 'top .52s var(--ios-open) !important',
        'width .52s var(--ios-open) !important', 'height .52s var(--ios-open) !important',
        'padding-left .5s var(--ios-open)', 'padding-right .5s var(--ios-open)', 'padding-bottom .5s var(--ios-open)',
    ]) assert.ok(css.includes(fragment), fragment);
    assert.doesNotMatch(css, /panel-pin-settle/);
});

test('all shipped pages load pin styling without demo artifact', () => {
    for (const file of ['public/terminal.html', 'public/telnet-terminal.html', 'public/rdp.html', 'public/novnc.html', 'public/app.html']) {
        const html = read(file);
        assert.match(html, /panel-pin\.css\?v=20260830-desktop-panel-pin4/);
        assert.doesNotMatch(html, /panel-pin-demo/);
    }
    assert.equal(fs.existsSync(path.join(root, 'public/panel-pin-demo.html')), false);
});

test('service worker rotates and precaches both panel-pin assets', () => {
    assert.match(sw, /zephyr-static-20260830-desktop-panel-pin4/);
    assert.match(sw, /\/panel-pin\.js\?v=20260830-desktop-panel-pin4/);
    assert.match(sw, /\/panel-pin\.css\?v=20260830-desktop-panel-pin4/);
});
