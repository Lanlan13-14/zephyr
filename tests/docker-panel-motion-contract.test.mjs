import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* Docker panel motion contract: panel tab switches, table rows, the create
 * block, and toolbar buttons reuse the existing zephyr-motion engine
 * (Motion.morph / Motion.to / Motion.press), never a new dependency. All
 * hooks must degrade gracefully when the engine fails to load. */

const root = path.resolve(import.meta.dirname, '..');
const terminalJs = fs.readFileSync(path.join(root, 'public', 'terminal.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const terminalHtml = fs.readFileSync(path.join(root, 'public', 'terminal.html'), 'utf8');

test('docker panel reuses the existing zephyr-motion engine (no new dependency)', () => {
    assert.ok(/import\('\.\/vendor\/zephyr-motion\/index\.js/.test(terminalJs), 'lazy-imports existing engine');
    assert.ok(!/animejs|gsap|framer-motion|lottie/.test(terminalJs), 'must not add a third-party animation lib');
});

test('dockerMotion exposes rows / tabPanel / expandIn / pressAll with graceful degradation', () => {
    const idx = terminalJs.indexOf('const dockerMotion = {');
    assert.ok(idx > 0, 'dockerMotion adapter exists');
    const body = terminalJs.slice(idx, idx + 2600);
    assert.ok(/rows\(tbody\)/.test(body), 'rows hook');
    assert.ok(/tabPanel\(el\)/.test(body), 'tab entry hook');
    assert.ok(/expandIn\(el\)/.test(body), 'create-block expand hook');
    assert.ok(/pressAll\(selector\)/.test(body), 'button press hook');
    assert.ok(/\.catch\(\(\) =>/.test(body), 'engine failure degrades gracefully');
    assert.ok(/reducedMotion/.test(body), 'respects reduced-motion');
});

test('tab switching plays an entry animation, NOT a FLIP morph from a display:none rect', () => {
    const idx = terminalJs.indexOf("document.querySelectorAll('[data-docker-tab]')");
    assert.ok(idx > 0);
    const body = terminalJs.slice(idx, idx + 900);
    assert.ok(/dockerMotion\.tabPanel\(target\)/.test(body), 'animates the incoming panel');
    // Regression: morph() from a display:none panel divides by a zero rect
    // and blanks the content. The handler must not read the old panel rect.
    assert.ok(!/getBoundingClientRect/.test(body), 'must not read the hidden outgoing rect');
    const adapterIdx = terminalJs.indexOf('const dockerMotion = {');
    const adapter = terminalJs.slice(adapterIdx, adapterIdx + 2600);
    assert.ok(/M\.set\(el, \{ y: 8, opacity: 0 \}\)/.test(adapter), 'entry sets a safe initial pose');
    assert.ok(!/M\.morph\(/.test(adapter), 'tab panels must not use FLIP morph');
});

test('table renderers stream rows through dockerMotion.rows', () => {
    for (const fn of ['renderDockerContainers', 'renderDockerImages', 'renderDockerNetworks', 'renderDockerVolumes']) {
        const idx = terminalJs.indexOf(`function ${fn}(`);
        assert.ok(idx > 0, `${fn} exists`);
        const end = terminalJs.indexOf('\nfunction ', idx + 10);
        const body = terminalJs.slice(idx, end > idx ? end : idx + 6000);
        assert.ok(/dockerMotion\.rows\(/.test(body), `${fn} streams rows`);
    }
});

test('create block toggle springs the inner grid', () => {
    assert.ok(/\('#dockerCreateBlock'\)\?\.addEventListener\('toggle'/.test(terminalJs), 'toggle listener');
    assert.ok(/dockerMotion\.expandIn\(/.test(terminalJs), 'grid expand');
});

test('motion initial values are set in JS, not CSS (no FOUC when engine is down)', () => {
    assert.ok(/M\.set\(tr, \{ y: 10, opacity: 0 \}\)/.test(terminalJs), 'row initial set in JS');
    assert.ok(/M\.set\(el, \{ y: -6, opacity: 0 \}\)/.test(terminalJs), 'grid initial set in JS');
    assert.ok(!/\.docker-motion-ready .*\{\s*opacity:\s*0/.test(styleCss), 'CSS must not hide rows by default');
});

test('panel open pre-warms the engine via armDockerMotion', () => {
    const idx = terminalJs.indexOf('function showDockerPanel()');
    assert.ok(idx > 0);
    const body = terminalJs.slice(idx, idx + 700);
    assert.ok(/armDockerMotion\(\)/.test(body), 'pre-warms engine on open');
});
