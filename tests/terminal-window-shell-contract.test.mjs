import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAssetVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const specCss = readFileSync(join(root, 'public/zephyr-terminal-spec.css'), 'utf8');
const motionJs = readFileSync(join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const appHtml = readFileSync(join(root, 'public/app.html'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const telnetHtml = readFileSync(join(root, 'public/telnet-terminal.html'), 'utf8');
const rdpHtml = readFileSync(join(root, 'public/rdp.html'), 'utf8');
const vncHtml = readFileSync(join(root, 'public/novnc.html'), 'utf8');
const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');

function cssRule(selector, { last = false, source = styleCss } = {}) {
    const start = last ? source.lastIndexOf(selector) : source.indexOf(selector);
    assert.ok(start >= 0, `${selector} missing`);
    const end = source.indexOf('}', start);
    return source.slice(start, end + 1);
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

test('dock activation delegates its rounded endpoint and cleanup to the shared morph', () => {
    const start = appJs.indexOf('function animateWindowFromDock(');
    const end = appJs.indexOf('function activateTerminalFromDock(', start);
    assert.ok(start >= 0 && end > start, 'Dock activation adapter must exist');
    const body = appJs.slice(start, end);
    assert.match(body, /window\.Motion\?\.terminalWindowReplaceMorph/);
    assert.match(body, /window\.Motion\.terminalWindowReplaceMorph\(win, sourceRect \|\| smartbarRect, toRect, \{/);
    assert.match(body, /outgoingRect:\s*swap \? outgoingRect : null/);
    assert.doesNotMatch(body, /borderRadius:\s*['"]0(?:px)?['"]/);

    const morphStart = motionJs.indexOf('async terminalWindowReplaceMorph(');
    const morphEnd = motionJs.indexOf('async terminalWindowAvoidance(', morphStart);
    assert.ok(morphStart >= 0 && morphEnd > morphStart, 'shared replacement morph must exist');
    const morph = motionJs.slice(morphStart, morphEnd);
    assert.match(morph, /newWin\.classList\.add\('terminal-window-morphing'\)/);
    // The incoming endpoint is a positive radius consumed by shared CSS, not
    // an inline shellRadius in the app adapter. Cleanup restores the normal
    // --radius-lg invariant asserted above; fullscreen is square only in CSS.
    const endpointRadius = /'--z-morph-h': Math\.round\(toRect\.height\),\s*'--z-morph-r':\s*([\d.]+)/.exec(morph);
    assert.ok(endpointRadius && Number(endpointRadius[1]) > 0, 'incoming morph endpoint must stay rounded');
    const morphCss = cssRule('#terminalWorkspace > .terminal-window.terminal-window-morphing {',
        { last: true, source: specCss });
    const cssRadius = /border-radius:\s*var\(--z-morph-r,\s*([\d.]+)px\)\s*!important/.exec(morphCss);
    assert.ok(cssRadius, 'shared CSS must paint the morph radius channel');
    assert.equal(Number(endpointRadius[1]), Number(cssRadius[1]), 'shared CSS and morph endpoint radius agree');
    assert.match(morph, /newWin\.classList\.remove\('terminal-window-morphing'\)/);
    assert.match(morph, /\['--z-morph-l'[^\n]*'--z-morph-r'[^\n]*\]\.forEach\(\(k\) => \{\s*newWin\.style\.removeProperty\(k\)/);
    assert.match(morph, /withSettleSafetyGuard\(newWin,\s*540,\s*cleanup\)/);
    assert.match(morph, /finally\s*\{\s*guard\(\);\s*cleanup\(\);/);
});

test('only fullscreen terminal shells are square', () => {
    const fullscreen = cssRule('.terminal-window:fullscreen,');
    assert.match(fullscreen, /\.terminal-workspace\.custom-fullscreen \.terminal-window/);
    assert.match(fullscreen, /border-radius:\s*0\s*!important/);
});

test('SSH, Telnet, RDP and VNC load the same refreshed shell and spec stylesheets', () => {
    const appVersion = singleAssetVersion(appHtml, 'app.js', 'app shell app.js');
    assert.equal(appVersion, '20261102-ui39', 'terminal shell release revision');
    for (const [label, source] of [
        ['app shell', appHtml], ['SSH page', terminalHtml], ['Telnet page', telnetHtml],
        ['RDP page', rdpHtml], ['VNC page', vncHtml], ['service worker', sw],
    ]) {
        assertAssetVersion(source, 'style.css', appVersion, `${label} style`);
        assertAssetVersion(source, 'zephyr-terminal-spec.css', appVersion, `${label} terminal spec`);
    }
});

test('protocol iframe revisions follow the shell while terminal scripts keep independent revisions', () => {
    const appVersion = singleAssetVersion(appHtml, 'app.js', 'app shell app.js references');
    assert.equal(appVersion, '20261102-ui39', 'protocol iframe release revision');
    for (const page of ['terminal.html', 'telnet-terminal.html', 'rdp.html', 'novnc.html']) {
        // Includes both the regular SSH iframe and the lite/preview iframe.
        assertAssetVersion(appJs, page, appVersion, `${page} iframe references`);
    }
    const terminalVersion = singleAssetVersion(terminalHtml, 'terminal.js', 'SSH preload and script');
    const telnetVersion = singleAssetVersion(telnetHtml, 'telnet-terminal.js', 'Telnet preload and script');
    assert.equal(terminalVersion, '20261101-shortcuts28', 'SSH shortcut protocol retains its independent revision');
    assert.notEqual(terminalVersion, appVersion, 'SSH script must not inherit the shell-only revision');
    assertAssetVersion(sw, 'terminal.js', terminalVersion, 'service worker SSH script');
    assertAssetVersion(sw, 'telnet-terminal.js', telnetVersion, 'service worker Telnet script');
});

test('light RDP/VNC page chrome uses the same app background as SSH/Telnet', () => {
    const lightRemote = cssRule(':root[data-theme="light"] .novnc-page.rdp-page');
    assert.match(lightRemote, /background:\s*var\(--bg\)\s*!important/);
    assert.doesNotMatch(lightRemote, /#ffffff/i);
});
