import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/rdp-mobile-keyboard.js', import.meta.url), 'utf8');
const { RdpMobileKeyboard, planTextInput } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function classList() {
    const values = new Set();
    return { toggle(name, on) { if (on) values.add(name); else values.delete(name); }, contains(name) { return values.has(name); } };
}

function fixture(overrides = {}) {
    const document = { activeElement: null, documentElement: { classList: classList() } };
    const listeners = new Map();
    const host = {
        value: '', ownerDocument: document, classList: classList(),
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        focus() { document.activeElement = host; },
        blur() { document.activeElement = null; },
    };
    const button = {
        classList: classList(),
        addEventListener() {}, removeEventListener() {}, setAttribute() {},
    };
    const calls = [];
    const keyboard = new RdpMobileKeyboard({
        host, button, keyHoldMs: 0,
        sendKeyDown: (code) => calls.push(['down', code]),
        sendKeyUp: (code) => calls.push(['up', code]),
        sendUnicodeText: (text) => { calls.push(['unicode', text]); return true; },
        sendClipboardText: (text) => calls.push(['clipboard', text]),
        ...overrides,
    });
    return { keyboard, host, calls, listeners };
}

function inputEvent(fields) {
    return { isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
}

test('text planner keeps multilingual text and emoji in one Unicode batch', () => {
    assert.deepEqual(planTextInput('Ab中文😀！'), [{ type: 'unicode', text: 'Ab中文😀！' }]);
    assert.deepEqual(planTextInput('甲\r\n乙\t丙'), [
        { type: 'unicode', text: '甲' },
        { type: 'keys', steps: [{ code: 'Enter', shift: false }] },
        { type: 'unicode', text: '乙' },
        { type: 'keys', steps: [{ code: 'Tab', shift: false }] },
        { type: 'unicode', text: '丙' },
    ]);
});

test('rapid text commits are serialized and never use clipboard', async () => {
    const calls = [];
    let active = 0;
    const { keyboard } = fixture({
        sendUnicodeText: async (text) => {
            assert.equal(active, 0);
            active++;
            await new Promise((resolve) => setTimeout(resolve, 2));
            calls.push(text);
            active--;
            return true;
        },
        sendClipboardText: () => assert.fail('clipboard fallback should not run'),
    });
    await Promise.all([keyboard.dispatchText('中文'), keyboard.dispatchText('日本語'), keyboard.dispatchText('😀')]);
    assert.deepEqual(calls, ['中文', '日本語', '😀']);
});

test('compositionend consumes the following input echo exactly once', async () => {
    const { keyboard, calls } = fixture();
    keyboard._onCompositionStart();
    keyboard._onCompositionEnd(inputEvent({ data: '输入法😀' }));
    keyboard._onInput(inputEvent({ data: '输入法😀' }));
    await keyboard._inputQueue;
    assert.deepEqual(calls, [['unicode', '输入法😀']]);
});

test('keydown plus beforeinput emits one control key tap', async () => {
    const { keyboard, calls } = fixture();
    keyboard._onKeyDown(inputEvent({ key: 'Backspace' }));
    keyboard._onBeforeInput(inputEvent({ inputType: 'deleteContentBackward' }));
    await keyboard._inputQueue;
    assert.deepEqual(calls, [['down', 'Backspace'], ['up', 'Backspace']]);
});

test('Unicode failure falls back to clipboard within the same input queue', async () => {
    const { keyboard, calls } = fixture({ sendUnicodeText: () => false });
    await keyboard.dispatchText('兼容');
    assert.deepEqual(calls, [['clipboard', '兼容']]);
});
