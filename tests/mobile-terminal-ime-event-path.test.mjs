import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const telnetJs = readFileSync(join(root, 'public/telnet-terminal.js'), 'utf8');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');

function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} missing`);
    const openParen = source.indexOf('(', start);
    let parenDepth = 0;
    let brace = -1;
    for (let i = openParen; i < source.length; i++) {
        if (source[i] === '(') parenDepth += 1;
        if (source[i] === ')') parenDepth -= 1;
        if (parenDepth === 0 && source[i] === '{') {
            brace = i;
            break;
        }
    }
    assert.ok(brace >= 0, `${name} body missing`);
    let depth = 0;
    for (let i = brace; i < source.length; i++) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`${name} incomplete`);
}

const fallbackNames = [
    'cancelMobileImeBeforeInputFallback',
    'flushMobileImeBeforeInputFallback',
    'scheduleMobileImeBeforeInputFallback',
];

function createFallbackHarness(source = terminalJs) {
    const helpers = fallbackNames.map((name) => functionSource(source, name)).join('\n');
    const context = { setTimeout, clearTimeout, performance };
    vm.runInNewContext(`
        const window = { setTimeout, clearTimeout };
        let mobileImeBeforeInputFallbackTimer = 0;
        let mobileImeBeforeInputFallbackToken = 0;
        let mobileImeBeforeInputFallback = null;
        let mobileImeProxy = { value: '' };
        let mobileImeComposing = false;
        const sent = [];
        const commits = [];
        const delivered = new Set();
        const logTerminalLayoutDiagnostics = () => {};
        function imeTextAlreadySent(text) { return delivered.has(String(text)); }
        function sendMobileStableImeText(text, source) {
            const payload = String(text || '');
            if (!payload || delivered.has(payload)) return false;
            delivered.add(payload);
            sent.push({ text: payload, source });
            return true;
        }
        function commitComposedImeText(text, source) {
            const payload = String(text || '');
            if (!payload || delivered.has(payload)) return false;
            delivered.add(payload);
            mobileImeComposing = false;
            mobileImeProxy.value = '';
            commits.push({ text: payload, source });
            return true;
        }
        ${helpers}
        globalThis.api = {
            schedule: scheduleMobileImeBeforeInputFallback,
            cancel: cancelMobileImeBeforeInputFallback,
            flush: flushMobileImeBeforeInputFallback,
            sent,
            commits,
            setProxyValue: (value) => { mobileImeProxy.value = value; },
            setComposing: (value) => { mobileImeComposing = !!value; },
            pending: () => mobileImeBeforeInputFallback,
        };
    `, context);
    return context.api;
}

test('SSH and Telnet use the same beforeinput fallback implementation', () => {
    for (const name of fallbackNames) {
        assert.equal(functionSource(terminalJs, name), functionSource(telnetJs, name));
    }
});

test('beforeinput-only insertText is delivered when input never follows', async () => {
    const api = createFallbackHarness();
    api.schedule('insertText', 'direct-mobile-text');
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].text, 'direct-mobile-text');
    assert.equal(api.pending(), null);
});

test('normal input cancels the fallback so text cannot be sent twice', async () => {
    const api = createFallbackHarness();
    api.schedule('insertReplacementText', 'replacement');
    api.cancel('input');
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(api.sent.length, 0);
    assert.equal(api.commits.length, 0);
});

test('beforeinput-only insertFromComposition commits final CJK text', async () => {
    const api = createFallbackHarness();
    api.setComposing(true);
    api.schedule('insertFromComposition', '移动输入', { compositionCommit: true });
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(api.commits.length, 1);
    assert.equal(api.commits[0].text, '移动输入');
    assert.equal(api.sent.length, 0);
});

test('pending beforeinput text can be flushed synchronously before Enter', () => {
    const api = createFallbackHarness();
    api.schedule('insertText', 'ordered');
    assert.equal(api.flush('pre-enter'), true);
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].text, 'ordered');
});

test('real proxy event wiring covers replacement text and cancels on authoritative events', () => {
    for (const source of [terminalJs, telnetJs]) {
        const beforeInput = source.slice(
            source.indexOf("proxy.addEventListener('beforeinput'"),
            source.indexOf("proxy.addEventListener('input'"),
        );
        assert.match(beforeInput, /type === 'insertReplacementText'/);
        assert.match(beforeInput, /scheduleMobileImeBeforeInputFallback\(type, e\.data \|\| ''\)/);
        assert.match(beforeInput, /insertFromComposition[\s\S]*compositionCommit: true/);
        assert.match(source, /proxy\.addEventListener\('input',[\s\S]*cancelMobileImeBeforeInputFallback\('input'\)/);
        assert.match(source, /proxy\.addEventListener\('compositionend',[\s\S]*cancelMobileImeBeforeInputFallback\('compositionend'\)/);
        assert.match(source, /function flushMobileImeEnter[\s\S]*flushMobileImeBeforeInputFallback/);
    }
});

test('clean terminal click reasserts proxy focus after pointerup', () => {
    const helper = functionSource(terminalJs, 'retainMobileImeFocusAfterTerminalClick');
    assert.equal(helper, functionSource(telnetJs, 'retainMobileImeFocusAfterTerminalClick'));
    const context = { performance };
    vm.runInNewContext(`
        let mobileTerminalSelectionMode = false;
        let terminalTouchMoved = false;
        let mobileStableLastFocusGestureAt = performance.now();
        let retained = 0;
        let anchored = 0;
        const kb = {
            desiredOpen: () => true,
            physicalOpen: () => false,
            retainFocus: () => { retained += 1; },
        };
        function isMobileStableInputMode() { return true; }
        function hasLiveTerminalSelection() { return false; }
        function ensureSshKeyboard() { return kb; }
        function scheduleImeProxyCursorAnchor() { anchored += 1; }
        ${helper}
        globalThis.api = {
            run: retainMobileImeFocusAfterTerminalClick,
            counts: () => ({ retained, anchored }),
            makeStale: () => { mobileStableLastFocusGestureAt = performance.now() - 901; },
        };
    `, context);
    let prevented = 0;
    const event = {
        target: { closest: () => null },
        preventDefault: () => { prevented += 1; },
    };
    assert.equal(context.api.run(event), true);
    assert.equal(context.api.counts().retained, 1);
    assert.equal(context.api.counts().anchored, 1);
    assert.equal(prevented, 1);
    context.api.makeStale();
    assert.equal(context.api.run(event), false);
    assert.equal(prevented, 1);
});

test('one pointer family is registered and the IME proxy remains rendered', () => {
    for (const source of [terminalJs, telnetJs]) {
        assert.match(source, /const terminalPrimaryPointerEvents = window\.PointerEvent/);
        assert.match(source, /wtermWrapper\.addEventListener\('click', retainMobileImeFocusAfterTerminalClick, \{ passive: false \}\)/);
        assert.match(source, /s\.opacity = '0\.01'/);
    }
    const proxyCss = styleCss.match(/html\.mobile-stable-input \.mobile-terminal-ime-proxy \{[\s\S]*?\n\s*\}/)?.[0] || '';
    assert.match(proxyCss, /opacity:\s*0\.01/);
    assert.match(proxyCss, /pointer-events:\s*none/);
});
