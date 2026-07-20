import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const controllerPath = join(root, 'public/ssh-mobile-keyboard.js');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');

function createHost(overrides = {}) {
    let inset = 0;
    let selection = false;
    let suppressed = false;
    const applied = [];
    const states = [];
    const host = {
        isTouchDevice: () => true,
        isStableMode: () => true,
        proxy: {
            focus() { documentActive = this; },
            blur() { if (documentActive === this) documentActive = null; },
        },
        ensureProxy() { return host.proxy; },
        getViewportMetrics: () => ({ keyboardInset: inset }),
        isSelectionMode: () => selection,
        isGestureSuppressed: () => suppressed,
        onStateChange: (s) => states.push({ ...s }),
        applyInset: (i, open, reason) => applied.push({ i, open, reason }),
        notifyParent() {},
        onOpenCommitted() {},
        onCloseCommitted() {},
        log() {},
        setInset(v) { inset = v; },
        setSelection(v) { selection = v; },
        setSuppressed(v) { suppressed = v; },
        applied,
        states,
        ...overrides,
    };
    return host;
}

// Minimal activeElement shim for focus tracking inside controller.
let documentActive = null;
Object.defineProperty(globalThis, 'document', {
    value: {
        get activeElement() { return documentActive; },
    },
    configurable: true,
});
globalThis.window = globalThis;

const { createSshMobileSoftKeyboard, SoftKeyboardIntent } = await import(pathToFileURL(controllerPath).href);

test('controller starts closed and open requires intent', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    assert.equal(kb.getState().intent, SoftKeyboardIntent.CLOSED);
    assert.equal(kb.physicalOpen(), false);
    kb.open('tap');
    assert.equal(kb.desiredOpen(), true);
    host.setInset(280);
    kb.syncFromViewport('vv');
    assert.equal(kb.physicalOpen(), true);
    assert.ok(host.applied.some((a) => a.open && a.i === 280));
});

test('terminal body tap never dismisses once open', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.handleTerminalTap('body');
    host.setInset(300);
    kb.syncFromViewport('open');
    assert.equal(kb.physicalOpen(), true);
    kb.handleTerminalTap('body-again');
    assert.equal(kb.desiredOpen(), true);
    assert.equal(kb.physicalOpen(), true);
});

test('toggle button closes and opens', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.toggle('btn');
    assert.equal(kb.desiredOpen(), true);
    host.setInset(260);
    kb.syncFromViewport('open');
    kb.toggle('btn');
    assert.equal(kb.desiredOpen(), false);
    assert.equal(kb.physicalOpen(), false);
});

test('system dismiss while intent open flips to closed', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.open('tap');
    host.setInset(300);
    kb.syncFromViewport('open');
    assert.equal(kb.physicalOpen(), true);
    host.setInset(0);
    kb.syncFromViewport('back');
    assert.equal(kb.desiredOpen(), false);
    assert.equal(kb.physicalOpen(), false);
});

test('selection mode blocks open', () => {
    const host = createHost();
    host.setSelection(true);
    const kb = createSshMobileSoftKeyboard(host);
    const ok = kb.open('selecting');
    assert.equal(ok, false);
    assert.equal(kb.desiredOpen(), false);
});

test('scroll suppression blocks gesture open', () => {
    const host = createHost();
    host.setSuppressed(true);
    const kb = createSshMobileSoftKeyboard(host);
    const ok = kb.handleTerminalTap('scroll');
    assert.equal(ok, false);
    assert.equal(kb.desiredOpen(), false);
});

test('hysteresis keeps open through small inset jitter', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.open('tap');
    host.setInset(300);
    kb.syncFromViewport('open');
    host.setInset(40); // above close threshold 12, below open 80
    kb.syncFromViewport('jitter');
    assert.equal(kb.physicalOpen(), true);
    host.setInset(0);
    kb.syncFromViewport('close');
    assert.equal(kb.physicalOpen(), false);
});

test('wiring contract: terminal imports controller and exposes button', () => {
    assert.match(terminalJs, /createSshMobileSoftKeyboard/);
    assert.match(terminalJs, /ensureSshSoftKeyboard/);
    assert.match(terminalJs, /setupMobileKeyboardButton/);
    assert.match(terminalJs, /handleTerminalTap/);
    assert.match(terminalJs, /updateMobileKeyboardButtonUi/);
    assert.match(terminalHtml, /id="cmdKeyboardBtn"/);
    assert.match(terminalHtml, /ssh-kb1/);
    assert.match(styleCss, /cmd-keyboard-btn/);
    // Must not hard-hide the button forever.
    assert.doesNotMatch(styleCss, /\.cmd-keyboard-btn,\s*\.mobile-secure-keyboard-proxy \{ display: none !important; \}/);
});

test('wiring contract: body tap does not blur/dismiss', () => {
    // The old toggle-dismiss path must be gone.
    assert.doesNotMatch(
        terminalJs,
        /Toggle keyboard: if already open, dismiss; otherwise open/,
    );
    assert.match(terminalJs, /Never dismisses/);
    assert.match(terminalJs, /dismissMobileStableImeProxy|sshSoftKeyboard\.close|sshSoftKeyboard\?\.close/);
});

test('enableMobileStableInputMode does not force userControlled open', () => {
    const block = terminalJs.slice(
        terminalJs.indexOf('function enableMobileStableInputMode()'),
        terminalJs.indexOf('function enableMobileStableInputMode()') + 500,
    );
    assert.match(block, /mobileKeyboardUserControlled = false/);
    assert.doesNotMatch(block, /mobileKeyboardUserControlled = true/);
});
