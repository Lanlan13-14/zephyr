import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const appHtml = readFileSync(join(root, 'public/app.html'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const telnetHtml = readFileSync(join(root, 'public/telnet-terminal.html'), 'utf8');
const rdpHtml = readFileSync(join(root, 'public/rdp.html'), 'utf8');
const vncHtml = readFileSync(join(root, 'public/novnc.html'), 'utf8');

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
    assert.match(appHtml, /style\.css\?v=20260801-ai-edit-cancel1-terminal-shell3/);
    assert.match(terminalHtml, /style\.css\?v=20260731-sftp-multi-close1-mobile-ime2-shell3/);
    assert.match(telnetHtml, /style\.css\?v=20260731-sftp-multi-close1-mobile-ime2-shell3/);
    assert.match(rdpHtml, /style\.css\?v=20260804-rdp-ssh-scroll3-shell3/);
    assert.match(vncHtml, /style\.css\?v=20260801-rdp-vnc-notes-icon1-shell3/);
});

test('app cache-busts every protocol iframe after shell and input changes', () => {
    assert.match(appHtml, /app\.js\?v=20260804-notes-enabled-persist1-mobile-ime2-shell5/);
    assert.match(appJs, /rdp\.html\?embed=1[\s\S]*&v=20260804-rdp-ssh-scroll4/);
    assert.match(appJs, /novnc\.html\?embed=1[\s\S]*&v=20260804-terminal-shell3/);
    assert.match(appJs, /telnet-terminal\.html\?embed=1[\s\S]*terminal-grid-converge1-mobile-ime2/);
    assert.match(appJs, /terminal\.html\?embed=1[\s\S]*terminal-grid-converge1-mobile-ime2/);
});

test('light RDP/VNC page chrome uses the same app background as SSH/Telnet', () => {
    const lightRemote = cssRule(':root[data-theme="light"] .novnc-page.rdp-page');
    assert.match(lightRemote, /background:\s*var\(--bg\)\s*!important/);
    assert.doesNotMatch(lightRemote, /#ffffff/i);
});
