import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAssetVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const appHtml = readFileSync(join(root, 'public/app.html'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const telnetHtml = readFileSync(join(root, 'public/telnet-terminal.html'), 'utf8');
const rdpHtml = readFileSync(join(root, 'public/rdp.html'), 'utf8');
const vncHtml = readFileSync(join(root, 'public/novnc.html'), 'utf8');
const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');

function cssRule(selector, { last = false } = {}) {
    const start = last ? styleCss.lastIndexOf(selector) : styleCss.indexOf(selector);
    assert.ok(start >= 0, `${selector} missing`);
    const end = styleCss.indexOf('}', start);
    return styleCss.slice(start, end + 1);
}

test('terminal window base shell always starts with the shared radius and surface', () => {
    const base = cssRule('.terminal-window {');
    assert.match(base, /border-radius:\s*var\(--radius-lg\)/);
    assert.match(base, /background:\s*var\(--surface\)/);

    const invariant = cssRule('.terminal-workspace:not(.custom-fullscreen) .terminal-window:not(:fullscreen):not(.minimized-keepalive)');
    assert.match(invariant, /border-radius:\s*var\(--radius-lg\)\s*!important/);
    assert.match(invariant, /background:\s*var\(--surface\)\s*!important/);
    assert.match(invariant, /overflow:\s*hidden\s*!important/);
});

test('active and background terminal windows share the same base fill', () => {
    const active = cssRule('.terminal-window.active,', { last: true });
    assert.match(active, /background:\s*var\(--surface\)\s*!important/);
    assert.doesNotMatch(active, /accent-soft-bg/);
    assert.match(active, /border-color:\s*var\(--accent-soft-border\)/);
});

test('dock activation animation ends at the shared radius instead of zero', () => {
    const start = appJs.indexOf('function animateWindowFromDock');
    const end = appJs.indexOf('function activateTerminalFromDock', start);
    const body = appJs.slice(start, end);
    assert.match(body, /const shellRadius =/);
    assert.match(body, /borderRadius:\s*shellRadius/);
    assert.doesNotMatch(body, /borderRadius:\s*'0px'/);
});

test('only fullscreen terminal shells are square', () => {
    const fullscreen = cssRule('.terminal-window:fullscreen,');
    assert.match(fullscreen, /\.terminal-workspace\.custom-fullscreen \.terminal-window/);
    assert.match(fullscreen, /border-radius:\s*0\s*!important/);
});

test('SSH, Telnet, RDP and VNC load the same refreshed shell stylesheet', () => {
    const styleVersion = singleAssetVersion(appHtml, 'style.css', 'app shell style');
    assertAssetVersion(terminalHtml, 'style.css', styleVersion, 'SSH page style');
    assertAssetVersion(telnetHtml, 'style.css', styleVersion, 'Telnet page style');
    assertAssetVersion(rdpHtml, 'style.css', styleVersion, 'RDP page style');
    assertAssetVersion(vncHtml, 'style.css', styleVersion, 'VNC page style');
    assertAssetVersion(sw, 'style.css', styleVersion, 'service worker style');
});

test('app cache-busts every protocol iframe after shell and input changes', () => {
    singleAssetVersion(appHtml, 'app.js', 'app shell app.js references');
    singleAssetVersion(appJs, 'rdp.html', 'RDP iframe');
    singleAssetVersion(appJs, 'novnc.html', 'VNC iframe');
    const terminalVersion = singleAssetVersion(terminalHtml, 'terminal.js', 'SSH page script');
    const telnetVersion = singleAssetVersion(telnetHtml, 'telnet-terminal.js', 'Telnet page script');
    assertAssetVersion(appJs, 'terminal.html', terminalVersion, 'SSH iframe');
    assertAssetVersion(appJs, 'telnet-terminal.html', telnetVersion, 'Telnet iframe');
});

test('light RDP/VNC page chrome uses the same app background as SSH/Telnet', () => {
    const lightRemote = cssRule(':root[data-theme="light"] .novnc-page.rdp-page');
    assert.match(lightRemote, /background:\s*var\(--bg\)\s*!important/);
    assert.doesNotMatch(lightRemote, /#ffffff/i);
});
