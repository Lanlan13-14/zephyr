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

test('panel pin keeps the exact tgl-pin geometry and motion contract', () => {
    for (const fragment of [
        '.tgl.panel-pin-btn', '--s: 18px', 'width: 8px;', 'height: 8px;',
        'cubic-bezier(.34, 1.56, .64, 1)', 'transform: scale(.85)',
    ]) assert.ok(css.includes(fragment), fragment);
    assert.match(pin, /button\.className = `tgl panel-pin-btn \$\{side\}`/);
});

test('panel pin colors follow the active Zephyr theme instead of demo dark constants', () => {
    for (const fragment of [
        'color-mix(in srgb, var(--text) 27%, var(--border))',
        'background: color-mix(in srgb, var(--surface) 88%, var(--bg))',
        'background: var(--accent)',
        'border-color: color-mix(in srgb, var(--accent) 72%, var(--border))',
        'background: color-mix(in srgb, var(--accent) 14%, var(--surface))',
    ]) assert.ok(css.includes(fragment), fragment);
    assert.doesNotMatch(css, /border: 1\.5px solid #4a4f5a/);
    assert.doesNotMatch(css, /background: #1e2025/);
    assert.doesNotMatch(css, /background: #dfe3ea/);
    assert.doesNotMatch(css, /border-color: #9aa2b1/);
    assert.doesNotMatch(css, /background: #262932/);
});

test('pinned panels remove floating drop shadow and traffic chrome resets after release', () => {
    assert.match(css, /box-shadow: none !important;/);
    assert.match(pin, /button\.classList\.remove\('active-layout'\)/);
    assert.match(pin, /button\.style\.removeProperty\('opacity'\)/);
    assert.match(pin, /syncChrome\(panel\);\n            owner && applyInsets\(owner\);/);
});

test('panel pins are desktop-only and mobile cannot receive controls', () => {
    assert.match(pin, /\(hover: hover\) and \(pointer: fine\)/);
    assert.match(pin, /Math\.min\(window\.innerWidth \|\| 0, window\.innerHeight \|\| 0\) > 700/);
    assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{ \.panel-pin-btn \{ display: none !important; \} \}/);
});

test('side pins are one quarter wide and cover full page chrome', () => {
    assert.match(pin, /Math\.round\(scope\.width \/ 4\)/);
    assert.match(pin, /top: `\$\{scope\.top\}px`/);
    assert.match(pin, /height: `\$\{fullHeight\}px`/);
    assert.match(pin, /Side pins cover the whole page chrome/);
});

test('pinned traffic menu retains specified full and global lower-half semantics', () => {
    assert.match(pin, /全屏<span>保留顶部栏，以下完整覆盖<\/span>/);
    assert.match(pin, /下 1\/2<span>整个页面的下半部分<\/span>/);
    assert.match(pin, /top: `\$\{scope\.top \+ scope\.topbarHeight\}px`/);
    assert.match(pin, /const top = scope\.top \+ Math\.round\(fullHeight \/ 2\)/);
    assert.match(pin, /width: `\$\{scope\.width\}px`/);
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
        assert.match(source, /panel-pin\.js\?v=20260830-desktop-panel-pin2/);
        assert.doesNotMatch(source, /panel-pin-demo/);
    }
    for (const name of ['fileManager', 'infoModal', 'dockerPanel', 'snippetPanel', 'shortcutPanel']) assert.ok(terminal.includes(name));
    for (const name of ['clipboardPanel', 'filesPanel', 'shortcutsPanel', 'joystickPanel']) assert.ok(rdp.includes(name));
    assert.match(app, /attachDesktopPanelPin\(document\.querySelector\('\.app-shell'\), panel/);
    assert.doesNotMatch(pin, /panel-pin-demo/);
});

test('pinning uses complete geometry and surface transitions', () => {
    for (const fragment of [
        'left .52s var(--ios-open)', 'top .52s var(--ios-open)',
        'width .52s var(--ios-open)', 'height .52s var(--ios-open)',
        'animation: panel-pin-settle .52s var(--ios-open)',
        'padding-left .5s var(--ios-open)', 'padding-right .5s var(--ios-open)',
    ]) assert.ok(css.includes(fragment), fragment);
});

test('all shipped pages load pin styling without demo artifact', () => {
    for (const file of ['public/terminal.html', 'public/telnet-terminal.html', 'public/rdp.html', 'public/novnc.html', 'public/app.html']) {
        const html = read(file);
        assert.match(html, /panel-pin\.css\?v=20260830-desktop-panel-pin2/);
        assert.doesNotMatch(html, /panel-pin-demo/);
    }
    assert.equal(fs.existsSync(path.join(root, 'public/panel-pin-demo.html')), false);
});

test('service worker rotates and precaches both panel-pin assets', () => {
    const sw = read('public/sw.js');
    assert.match(sw, /zephyr-static-20260830-desktop-panel-pin2/);
    assert.match(sw, /\/panel-pin\.js\?v=20260830-desktop-panel-pin2/);
    assert.match(sw, /\/panel-pin\.css\?v=20260830-desktop-panel-pin2/);
});
