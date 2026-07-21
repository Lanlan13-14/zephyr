import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createKeyboardLayoutGate,
    LayoutPhase,
    SSH_KB_INSET_VAR,
    SSH_KB_OPEN_CLASS,
} from '../../public/ssh-keyboard/layout.js';
import {
    createParentBridge,
    reduceParentKeyboardMessage,
    SSH_KB_MSG,
} from '../../public/ssh-keyboard/bridge.js';
import { createSshKeyboard } from '../../public/ssh-keyboard/index.js';

function fakeDoc() {
    const styles = new Map();
    const classes = new Set();
    const terminalContainer = {
        classList: {
            toggle(name, on) { if (on) classes.add(`tc:${name}`); else classes.delete(`tc:${name}`); },
            contains(name) { return classes.has(`tc:${name}`); },
        },
    };
    const documentElement = {
        style: {
            setProperty(k, v) { styles.set(k, v); },
            getPropertyValue(k) { return styles.get(k) || ''; },
        },
        classList: {
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); },
        },
    };
    return {
        documentElement,
        getElementById: (id) => (id === 'terminalContainer' ? terminalContainer : null),
        styles,
        classes,
    };
}

test('layout gate blocks resize while open', () => {
    const d = fakeDoc();
    const gate = createKeyboardLayoutGate({ getDocument: () => d, mirrorLegacy: true });
    assert.equal(gate.allowResize(), true);
    gate.applyIntentState({ intent: 'open', physical: 'closed', inset: 0, liftMode: 'workspace' }, 'open');
    assert.equal(gate.getPhase(), LayoutPhase.OPENING);
    assert.equal(gate.allowResize('fit'), false);
    let ran = false;
    gate.runOrQueueResize(() => { ran = true; }, 'fit');
    assert.equal(ran, false);
    gate.applyIntentState({ intent: 'open', physical: 'open', inset: 300, liftMode: 'workspace' }, 'phys');
    assert.equal(gate.getPhase(), LayoutPhase.OPEN);
    assert.equal(d.styles.get(SSH_KB_INSET_VAR), '300px');
    assert.equal(d.classes.has(SSH_KB_OPEN_CLASS), true);
    gate.applyIntentState({ intent: 'closed', physical: 'closed', inset: 0, liftMode: 'workspace' }, 'close');
    assert.equal(gate.getPhase(), LayoutPhase.CLOSED);
    assert.equal(ran, true); // queued resize flushed
    assert.equal(d.styles.get(SSH_KB_INSET_VAR), '0px');
});

test('layout cmd lift=none never opens phase', () => {
    const d = fakeDoc();
    const gate = createKeyboardLayoutGate({ getDocument: () => d });
    gate.applyIntentState({ intent: 'open', physical: 'open', inset: 280, liftMode: 'none' }, 'cmd');
    assert.equal(gate.getPhase(), LayoutPhase.CLOSED);
    assert.equal(gate.getInset(), 0);
    assert.equal(gate.allowResize(), true);
});

test('bridge dedupes and emits ssh-kb + legacy', () => {
    const posts = [];
    const bridge = createParentBridge({
        isEmbedded: () => true,
        getTabId: () => 't1',
        postToParent: (m) => posts.push(m),
        emitLegacyMetrics: true, // test still wants legacy path

    });
    assert.equal(bridge.publish({ phase: 'open', intent: 'open', inset: 300, liftMode: 'workspace' }), true);
    assert.equal(bridge.publish({ phase: 'open', intent: 'open', inset: 301, liftMode: 'workspace' }), false); // same 4px bucket
    assert.equal(bridge.publish({ phase: 'open', intent: 'open', inset: 320, liftMode: 'workspace' }), true);
    const types = posts.map((p) => p.type);
    assert.ok(types.includes(SSH_KB_MSG));
    assert.ok(types.includes('keyboard-metrics'));
    assert.equal(posts.find((p) => p.type === SSH_KB_MSG).tabId, 't1');
});

test('bridge cmd lift reports closed layout to parent', () => {
    const posts = [];
    const bridge = createParentBridge({
        isEmbedded: () => true,
        getTabId: () => 't1',
        postToParent: (m) => posts.push(m),
        emitLegacyMetrics: true,
    });
    bridge.publish({ phase: 'closed', intent: 'open', inset: 280, liftMode: 'none' });
    const legacy = posts.find((p) => p.type === 'keyboard-metrics');
    assert.equal(legacy.keyboardOpen, false);
    assert.equal(legacy.keyboardInset, 0);
    assert.equal(legacy.liftMode, 'none');
});

test('reduceParentKeyboardMessage single hysteresis', () => {
    let s = { open: false, inset: 0 };
    s = reduceParentKeyboardMessage({ type: 'ssh-kb', intent: 'open', inset: 300, phase: 'open' }, s);
    assert.equal(s.open, true);
    assert.equal(s.inset, 300);
    // jitter low but intent still open + phase opening keeps? intent closed path
    s = reduceParentKeyboardMessage({ type: 'ssh-kb', intent: 'closed', inset: 40, phase: 'closing' }, s);
    // inset 40 > 12 and was open — stay open until <12
    assert.equal(s.open, true);
    s = reduceParentKeyboardMessage({ type: 'ssh-kb', intent: 'closed', inset: 0, phase: 'closed' }, s);
    assert.equal(s.open, false);
    assert.equal(s.inset, 0);
});

test('facade: tap opens, pan does not; resize blocked while open', () => {
    let focused = null;
    const proxy = {
        focus() { focused = proxy; },
        blur() { focused = null; },
        classList: { contains: (c) => c === 'mobile-terminal-ime-proxy' },
        tagName: 'TEXTAREA',
    };
    Object.defineProperty(globalThis, 'document', {
        value: {
            get activeElement() { return focused; },
            documentElement: fakeDoc().documentElement,
            getElementById: fakeDoc().getElementById,
        },
        configurable: true,
    });
    // fix doc shared
    const d = fakeDoc();
    Object.defineProperty(globalThis, 'document', {
        value: {
            get activeElement() { return focused; },
            documentElement: d.documentElement,
            getElementById: (id) => d.getElementById(id),
        },
        configurable: true,
    });

    const posts = [];
    const kb = createSshKeyboard({
        isTouchDevice: () => true,
        ensureProxy: () => proxy,
        getViewportMetrics: () => ({ keyboardInset: 0 }),
        hasSelection: () => false,
        isSelectionMode: () => false,
        isEmbedded: () => true,
        getTabId: () => 'tab',
        postToParent: (m) => posts.push(m),
        getDocument: () => globalThis.document,
        log() {},
    });

    kb.handlePointerDown({ clientX: 0, clientY: 0 });
    kb.handlePointerUp({ clientX: 1, clientY: 1 });
    assert.equal(kb.desiredOpen(), true);
    assert.equal(kb.allowResize(), false);

    // physical height arrives
    kb._intent.syncViewport({ inset: 300, hasEditableFocus: true, now: Date.now() });
    // re-apply via handleViewportChange path
    kb.handleViewportChange('vv');
    // force metrics
    const kb2Inset = () => {
        // manually drive intent physical
        kb._intent.syncViewport({ inset: 300, hasEditableFocus: true, now: Date.now() + 10 });
    };
    kb2Inset();
    assert.equal(kb.getPhase() === 'open' || kb.getPhase() === 'opening', true);

    // pan must not dismiss
    kb.handlePointerDown({ clientX: 0, clientY: 0 });
    kb.handlePointerMove({ clientX: 0, clientY: 40 });
    kb.handlePointerUp({ clientX: 0, clientY: 80 });
    assert.equal(kb.desiredOpen(), true);

    kb.buttonClick('btn');
    assert.equal(kb.desiredOpen(), false);
    assert.equal(kb.allowResize(), true);
});

test('facade softKeyboard compat surface', () => {
    const proxy = {
        focus() {},
        blur() {},
        classList: { contains: () => true },
        tagName: 'TEXTAREA',
    };
    const kb = createSshKeyboard({
        isTouchDevice: () => true,
        ensureProxy: () => proxy,
        getViewportMetrics: () => ({ keyboardInset: 0 }),
        isEmbedded: () => false,
        log() {},
    });
    const soft = kb.asSoftKeyboard();
    soft.open('x');
    assert.equal(soft.desiredOpen(), true);
    soft.handleTerminalTap('t');
    assert.equal(soft.desiredOpen(), true);
    soft.close('c', { force: true });
    assert.equal(soft.desiredOpen(), false);
});
