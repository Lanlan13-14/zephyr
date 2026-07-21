/**
 * Step 8 (docs): E2E scenario contracts.
 * Full Playwright on-device runs are still required on the test host; these
 * contracts lock the code paths each scenario depends on so they cannot regress
 * to dual-judge / unscoped scroll / legacy module imports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSshKeyboard, GestureKind } from '../../public/ssh-keyboard/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');

function makeKb(overrides = {}) {
    let inset = 0;
    let selection = false;
    let suppressed = false;
    let focused = null;
    const proxy = {
        tagName: 'TEXTAREA',
        classList: { contains: (c) => c === 'mobile-terminal-ime-proxy' },
        focus() { focused = proxy; },
        blur() { if (focused === proxy) focused = null; },
    };
    Object.defineProperty(globalThis, 'document', {
        value: {
            get activeElement() { return focused; },
            documentElement: {
                style: { setProperty() {}, getPropertyValue() { return ''; } },
                classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
            },
            getElementById() { return null; },
        },
        configurable: true,
    });
    const posts = [];
    const kb = createSshKeyboard({
        isTouchDevice: () => true,
        isMobileStable: () => true,
        ensureProxy: () => proxy,
        getViewportMetrics: () => ({ keyboardInset: inset }),
        hasSelection: () => selection,
        isSelectionMode: () => selection,
        isGestureSuppressed: () => suppressed,
        isEmbedded: () => true,
        getTabId: () => 'e2e',
        postToParent: (m) => posts.push(m),
        getDocument: () => globalThis.document,
        log() {},
        ...overrides,
    });
    return {
        kb,
        posts,
        setInset: (v) => { inset = v; },
        setSelection: (v) => { selection = v; },
        setSuppressed: (v) => { suppressed = v; },
        proxy,
        focused: () => focused,
    };
}

test('E2E-1 body tap opens keyboard', () => {
    const { kb } = makeKb();
    kb.handlePointerDown({ clientX: 10, clientY: 10 });
    const r = kb.handlePointerUp({ clientX: 11, clientY: 11 });
    assert.equal(r.kind, GestureKind.TAP);
    assert.equal(r.opened, true);
    assert.equal(kb.desiredOpen(), true);
});

test('E2E-2 second body tap retains (never dismisses)', () => {
    const { kb } = makeKb();
    kb.handlePointerDown({ clientX: 0, clientY: 0 });
    kb.handlePointerUp({ clientX: 0, clientY: 0 });
    kb.handlePointerDown({ clientX: 0, clientY: 0 });
    kb.handlePointerUp({ clientX: 1, clientY: 1 });
    assert.equal(kb.desiredOpen(), true);
});

test('E2E-3 pan does not open', () => {
    const { kb } = makeKb();
    kb.handlePointerDown({ clientX: 0, clientY: 0 });
    kb.handlePointerMove({ clientX: 0, clientY: 40 });
    const r = kb.handlePointerUp({ clientX: 0, clientY: 80 });
    assert.equal(r.opened, false);
    assert.equal(kb.desiredOpen(), false);
});

test('E2E-4 fling does not open', () => {
    const { kb } = makeKb();
    kb.handlePointerDown({ clientX: 0, clientY: 0, timeStamp: 1000 });
    // synthesize via internal classifier times using performance.now path is ok
    kb.handlePointerMove({ clientX: 0, clientY: 30 });
    kb.handlePointerMove({ clientX: 0, clientY: 100 });
    const r = kb.handlePointerUp({ clientX: 0, clientY: 160 });
    assert.equal(r.opened, false);
});

test('E2E-5 pinch does not open', () => {
    const { kb } = makeKb();
    kb.handlePointerDown({ clientX: 0, clientY: 0, touches: [{}, {}] });
    const r = kb.handlePointerUp({ clientX: 10, clientY: 10, touches: [] });
    assert.equal(r.opened, false);
});

test('E2E-6 longpress/selection does not open', () => {
    const env = makeKb();
    env.setSelection(true);
    env.kb.handlePointerDown({ clientX: 0, clientY: 0 });
    const r = env.kb.handlePointerUp({ clientX: 0, clientY: 0 });
    assert.equal(r.opened, false);
    assert.equal(env.kb.desiredOpen(), false);
});

test('E2E-7 button toggle closes', () => {
    const { kb } = makeKb();
    kb.buttonClick('btn');
    assert.equal(kb.desiredOpen(), true);
    kb.buttonClick('btn');
    assert.equal(kb.desiredOpen(), false);
});

test('E2E-8 system dismiss after sustained low inset', () => {
    const { kb } = makeKb();
    const t0 = Date.now();
    kb._intent.open('tap', { now: t0, focusOwner: 'terminal' });
    kb._intent.syncViewport({ inset: 300, hasEditableFocus: true, now: t0 + 50 });
    assert.equal(kb.desiredOpen(), true);
    // past openGuard (320) + dismissConfirm (480)
    kb._intent.syncViewport({ inset: 0, hasEditableFocus: true, now: t0 + 400 });
    assert.equal(kb.desiredOpen(), true); // still in guard/debounce start
    kb._intent.syncViewport({ inset: 0, hasEditableFocus: true, now: t0 + 400 + 500 });
    assert.equal(kb.desiredOpen(), false);
});

test('E2E-9 composition routes through facade; legacy module gone', () => {
    assert.match(terminalJs, /handleCompositionStart|onCompositionStart|compositionstart/);
    assert.match(terminalJs, /handleCompositionEnd|onCompositionEnd|compositionend/);
    assert.doesNotMatch(terminalJs, /createSshMobileSoftKeyboard/);
    assert.doesNotMatch(terminalJs, /ssh-mobile-keyboard\.js/);
});

test('E2E-10 parent does not invent open; only reduce child metrics', () => {
    assert.match(appJs, /must NOT invent keyboard open|Child facade is sole judge/i);
    assert.match(appJs, /reduceParentKeyboardMessage/);
    assert.doesNotMatch(appJs, /appKeyboardParentPhysicalOpen/);
});

test('E2E wiring: legacy module deleted', () => {
    assert.equal(existsSync(join(root, 'public/ssh-mobile-keyboard.js')), false);
});

test('E2E wiring: terminal pointer path is facade-only', () => {
    assert.match(terminalJs, /handlePointerDown/);
    assert.match(terminalJs, /handlePointerUp/);
    assert.doesNotMatch(terminalJs, /terminal-touch-immediate/);
    assert.doesNotMatch(terminalJs, /surface\.onTerminalTap\('terminal-touch-immediate'\)/);
});
