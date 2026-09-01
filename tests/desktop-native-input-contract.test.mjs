import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const terminalSrc = fs.readFileSync(path.join(root, 'public/terminal.js'), 'utf8');
const telnetSrc = fs.readFileSync(path.join(root, 'public/telnet-terminal.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const CACHE = '20260901-terminal-native-input2';

function extractHelpers(src) {
    const start = src.indexOf('function isMobileViewport()');
    const end = src.indexOf('function getKeyboardBaselineHeight()');
    assert.ok(start >= 0 && end > start, 'helper block missing');
    return src.slice(start, end);
}

function extractIntent(src) {
    const start = src.indexOf('function stopDesktopTerminalFocusIntent()');
    const end = src.indexOf('function decodeOsc52Base64');
    assert.ok(start >= 0 && end > start, 'intent block missing');
    return src.slice(start, end);
}

function extractHandler(src) {
    const start = src.indexOf('const focusFromDesktopGesture = (event) => {');
    const end = src.indexOf("wtermWrapper.addEventListener('mousedown', focusFromDesktopGesture, true)");
    assert.ok(start >= 0 && end > start, 'gesture handler missing');
    return src.slice(start, end);
}

function runHelpers({ hoverNone = false, coarse = false, maxWidth760 = false, maxTouchPoints = 0 } = {}) {
    const queries = {
        '(hover: none) and (pointer: coarse)': hoverNone && coarse,
        '(max-width: 760px)': maxWidth760,
        '(max-width: 700px)': maxWidth760,
    };
    const sandbox = {
        navigator: { maxTouchPoints },
        window: {
            matchMedia(query) {
                return { matches: !!queries[query] };
            },
        },
    };
    const code = `${extractHelpers(terminalSrc)}
        JSON.stringify({
            isTouchKeyboardDevice: isTouchKeyboardDevice(),
            isMobileViewport: isMobileViewport(),
            isMobileStableInputCandidate: isMobileStableInputCandidate(),
            usesExternalTerminalInput: usesExternalTerminalInput(),
        });`;
    return JSON.parse(vm.runInNewContext(code, sandbox));
}

class FakeTimers {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.queue = [];
    }

    setTimeout(fn, ms) {
        const id = this.nextId++;
        this.queue.push({ id, at: this.now + (ms || 0), fn });
        this.queue.sort((a, b) => a.at - b.at);
        return id;
    }

    clearTimeout(id) {
        this.queue = this.queue.filter((job) => job.id !== id);
    }

    runTo(ms) {
        this.now = ms;
        while (this.queue.length && this.queue[0].at <= this.now) {
            const job = this.queue.shift();
            job.fn();
        }
    }
}

function loadDesktopFocus(src, { external = false } = {}) {
    const timers = new FakeTimers();
    const textarea = { isConnected: true };
    const state = {
        active: null,
        focusCalls: 0,
        selection: {
            isCollapsed: true,
            removeAllRanges() {
                this.isCollapsed = true;
                this.removed = true;
            },
        },
        timers,
        textarea,
    };
    const term = {
        input: { textarea },
        focus() {
            state.focusCalls += 1;
            state.active = textarea;
        },
    };
    const sandbox = {
        term,
        desktopTerminalFocusIntent: false,
        desktopTerminalFocusTimer: 0,
        usesExternalTerminalInput: () => external,
        document: {
            hasFocus: () => true,
            get activeElement() {
                return state.active;
            },
        },
        window: {
            getSelection: () => state.selection,
            setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
            clearTimeout: (id) => timers.clearTimeout(id),
        },
    };
    const exported = vm.runInNewContext(
        `${extractIntent(src)}
         ${extractHandler(src)}
         ({
            stopDesktopTerminalFocusIntent,
            armDesktopTerminalFocusIntent,
            focusDesktopTerminalNow,
            focusFromDesktopGesture,
         });`,
        sandbox,
    );
    return { ...exported, state, term, sandbox };
}

function mouseEvent(type, extra = {}) {
    return {
        type,
        button: 0,
        pointerType: 'mouse',
        target: { closest: () => null },
        ...extra,
    };
}

test('desktop / hybrid / phone input-mode matrix stays native except real mobile', () => {
    assert.deepEqual(runHelpers({
        hoverNone: false, coarse: false, maxWidth760: false, maxTouchPoints: 0,
    }), {
        isTouchKeyboardDevice: false,
        isMobileViewport: false,
        isMobileStableInputCandidate: false,
        usesExternalTerminalInput: false,
    });

    // Hybrid laptop / remote Chrome: touch points or coarse pointer, desktop width.
    assert.deepEqual(runHelpers({
        hoverNone: true, coarse: true, maxWidth760: false, maxTouchPoints: 10,
    }), {
        isTouchKeyboardDevice: false,
        isMobileViewport: false,
        isMobileStableInputCandidate: false,
        usesExternalTerminalInput: false,
    });
    assert.equal(runHelpers({
        hoverNone: false, coarse: false, maxWidth760: false, maxTouchPoints: 5,
    }).usesExternalTerminalInput, false);

    // Phone: mobile width + coarse pointer.
    assert.deepEqual(runHelpers({
        hoverNone: true, coarse: true, maxWidth760: true, maxTouchPoints: 5,
    }), {
        isTouchKeyboardDevice: true,
        isMobileViewport: true,
        isMobileStableInputCandidate: true,
        usesExternalTerminalInput: true,
    });

    // Narrow viewport with touch points but a fine pointer (some emulators).
    assert.equal(runHelpers({
        hoverNone: false, coarse: false, maxWidth760: true, maxTouchPoints: 1,
    }).usesExternalTerminalInput, true);

    // Narrow viewport, no touch, fine pointer → keep native (desktop windowed).
    assert.equal(runHelpers({
        hoverNone: false, coarse: false, maxWidth760: true, maxTouchPoints: 0,
    }).usesExternalTerminalInput, false);
});

test('SSH and Telnet ship the same desktop native-input helpers and gesture handler', () => {
    assert.equal(extractHelpers(terminalSrc), extractHelpers(telnetSrc));
    assert.equal(extractIntent(terminalSrc), extractIntent(telnetSrc));
    assert.equal(extractHandler(terminalSrc), extractHandler(telnetSrc));
});

test('mousedown collapses leftover Range without stealing focus; click restores it', () => {
    for (const [label, src] of [['ssh', terminalSrc], ['telnet', telnetSrc]]) {
        const api = loadDesktopFocus(src);
        api.state.selection.isCollapsed = false;

        api.focusFromDesktopGesture(mouseEvent('mousedown'));
        assert.equal(api.state.selection.isCollapsed, true, `${label}: leftover Range collapsed`);
        assert.equal(api.state.selection.removed, true, `${label}: removeAllRanges`);
        assert.equal(api.state.focusCalls, 0, `${label}: mousedown does not focus`);

        const shift = loadDesktopFocus(src);
        shift.state.selection.isCollapsed = false;
        shift.focusFromDesktopGesture(mouseEvent('mousedown', { shiftKey: true }));
        assert.equal(shift.state.selection.isCollapsed, false, `${label}: shift-click keeps Range`);
        assert.equal(shift.state.focusCalls, 0, `${label}: shift mousedown does not focus`);
        shift.focusFromDesktopGesture(mouseEvent('click', { shiftKey: true }));
        assert.equal(shift.state.focusCalls, 0, `${label}: shift-click does not steal focus`);

        api.focusFromDesktopGesture(mouseEvent('click'));
        assert.equal(api.state.focusCalls, 1, `${label}: click focuses immediately`);
        assert.equal(api.state.active, api.state.textarea, `${label}: textarea is active`);

        api.state.active = { other: true };
        api.state.timers.runTo(32);
        assert.equal(api.state.focusCalls, 2, `${label}: retry at 32ms`);
        api.state.active = { other: true };
        api.state.timers.runTo(32 + 80);
        assert.equal(api.state.focusCalls, 3, `${label}: retry at 80ms`);
        api.state.active = { other: true };
        api.state.timers.runTo(1000);
        assert.equal(api.state.focusCalls, 3, `${label}: no unbounded poll`);
        assert.equal(api.state.timers.queue.length, 0, `${label}: timers drained`);
    }
});

test('live drag-select, mobile IME, touch, and chrome clicks do not steal native focus', () => {
    const api = loadDesktopFocus(terminalSrc);
    api.state.selection.isCollapsed = false;
    api.focusFromDesktopGesture(mouseEvent('click'));
    assert.equal(api.state.focusCalls, 0, 'click with live selection');

    const mobile = loadDesktopFocus(terminalSrc, { external: true });
    mobile.state.selection.isCollapsed = false;
    mobile.focusFromDesktopGesture(mouseEvent('mousedown'));
    assert.equal(mobile.state.selection.removed, undefined, 'mobile IME does not collapse');
    mobile.focusFromDesktopGesture(mouseEvent('click'));
    assert.equal(mobile.state.focusCalls, 0, 'mobile IME does not native-focus');

    const touch = loadDesktopFocus(terminalSrc);
    touch.focusFromDesktopGesture(mouseEvent('click', { pointerType: 'touch' }));
    assert.equal(touch.state.focusCalls, 0, 'touch pointer');

    const right = loadDesktopFocus(terminalSrc);
    right.focusFromDesktopGesture(mouseEvent('mousedown', { button: 2 }));
    right.focusFromDesktopGesture(mouseEvent('click', { button: 2 }));
    assert.equal(right.state.focusCalls, 0, 'non-primary button');

    const chrome = loadDesktopFocus(terminalSrc);
    chrome.focusFromDesktopGesture(mouseEvent('click', {
        target: { closest: () => ({ tag: 'button' }) },
    }));
    assert.equal(chrome.state.focusCalls, 0, 'toolbar control');
});

test('mouseleave and a stolen selection cancel the finite re-focus window', () => {
    const api = loadDesktopFocus(terminalSrc);
    api.focusFromDesktopGesture(mouseEvent('click'));
    assert.equal(api.state.focusCalls, 1);
    api.state.active = null;
    api.state.selection.isCollapsed = false;
    api.state.timers.runTo(32);
    assert.equal(api.state.focusCalls, 1, 'live selection cancels retry');
    assert.equal(api.state.timers.queue.length, 0);

    const leave = loadDesktopFocus(terminalSrc);
    leave.focusFromDesktopGesture(mouseEvent('click'));
    leave.stopDesktopTerminalFocusIntent();
    leave.state.active = null;
    leave.state.timers.runTo(200);
    assert.equal(leave.state.focusCalls, 1, 'mouseleave cancels retry');
});

test('embedded terminal iframe and SW cache rotate together', () => {
    assert.match(appJs, new RegExp(`/terminal\\.html\\?embed=1&tabId=\\$\\{encodeURIComponent\\(session\\.id\\)\\}&v=${CACHE}`));
    assert.match(appJs, new RegExp(`/telnet-terminal\\.html\\?embed=1&tabId=\\$\\{encodeURIComponent\\(session\\.id\\)\\}&v=${CACHE}`));
    assert.match(swSrc, new RegExp(`CACHE_NAME = 'zephyr-static-${CACHE}'`));
    assert.match(swSrc, new RegExp(`/terminal\\.js\\?v=${CACHE}`));
    assert.match(swSrc, new RegExp(`/telnet-terminal\\.js\\?v=${CACHE}`));
    assert.doesNotMatch(appJs, /v=20260831-terminal-native-input1/);
    assert.doesNotMatch(swSrc, /20260831-terminal-native-input1/);
});
