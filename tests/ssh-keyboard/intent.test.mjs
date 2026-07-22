import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createKeyboardIntentStore,
    Intent,
    FocusOwner,
    LiftMode,
} from '../../public/ssh-keyboard/intent.js';

function makeHost() {
    let focused = null;
    const proxy = {
        focus() { focused = proxy; },
        blur() { if (focused === proxy) focused = null; },
        classList: { contains: (c) => c === 'mobile-terminal-ime-proxy' },
        tagName: 'TEXTAREA',
    };
    Object.defineProperty(globalThis, 'document', {
        value: { get activeElement() { return focused; } },
        configurable: true,
    });
    return {
        proxy,
        focused: () => focused,
        ensureProxy: () => proxy,
        log() {},
    };
}

test('starts closed', () => {
    const store = createKeyboardIntentStore(makeHost());
    assert.equal(store.getState().intent, Intent.CLOSED);
    assert.equal(store.physicalOpen(), false);
});

test('open sets intent and focuses proxy for terminal', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.open('tap', { now: 1000 });
    assert.equal(store.desiredOpen(), true);
    assert.equal(store.getFocusOwner(), FocusOwner.TERMINAL);
    assert.equal(store.getLiftMode(), LiftMode.WORKSPACE);
    assert.equal(host.focused(), host.proxy);
});

test('cmd open does not focus proxy and uses lift none', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.open('cmd', { focusOwner: FocusOwner.CMD, liftMode: LiftMode.NONE, now: 1000 });
    assert.equal(store.getLiftMode(), LiftMode.NONE);
    assert.equal(store.getFocusOwner(), FocusOwner.CMD);
    assert.equal(host.focused(), null);
});

test('terminal tap retains when already open — never dismisses', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.open('tap', { now: 1000 });
    store.handleTerminalTap('again', { now: 1100 });
    assert.equal(store.desiredOpen(), true);
    assert.equal(store.getState().lastReason, 'again:retain');
});

test('toggle closes then opens', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.toggle('btn', { now: 1000 });
    assert.equal(store.desiredOpen(), true);
    store.toggle('btn', { now: 1200 });
    assert.equal(store.desiredOpen(), false);
});

test('syncViewport opens physical without changing intent when closed', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.syncViewport({ inset: 300, hasEditableFocus: false, now: 2000 });
    assert.equal(store.desiredOpen(), false);
});

test('system dismiss via low inset only after physical was confirmed (F4: embedded-safe)', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host, { openGuardMs: 160, dismissConfirmMs: 160, openTimeoutMs: 99999 });
    store.open('tap', { now: 1000 });
    // Embedded mode: child VV stays 0. Must NOT dismiss just because inset=0.
    store.syncViewport({ inset: 0, hasEditableFocus: false, now: 1200 });
    store.syncViewport({ inset: 0, hasEditableFocus: false, now: 2000 });
    assert.equal(store.desiredOpen(), true, 'must stay open while physical never confirmed');
    // Parent overlap confirms real height
    store.syncViewport({ inset: 280, hasEditableFocus: false, now: 2100 });
    assert.equal(store.physicalOpen(), true);
    // Now physical goes low - standalone dismiss proceeds
    store.syncViewport({ inset: 0, hasEditableFocus: true, now: 2200 });
    store.syncViewport({ inset: 0, hasEditableFocus: true, now: 2400 });
    assert.equal(store.desiredOpen(), false, 'must close after physical confirm + low inset');
});

test('blur alone does not close', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.open('tap', { now: 1000 });
    store.onImeBlur('blur');
    assert.equal(store.desiredOpen(), true);
});

test('unsolicited ime focus does not open intent', () => {
    const host = makeHost();
    const store = createKeyboardIntentStore(host);
    store.onImeFocus('random-focus');
    assert.equal(store.desiredOpen(), false);
});
