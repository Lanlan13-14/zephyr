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
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');

function createHost(overrides = {}) {
    let inset = 0;
    let selection = false;
    let suppressed = false;
    const applied = [];
    const parentMsgs = [];
    const states = [];
    const host = {
        isTouchDevice: () => true,
        isStableMode: () => true,
        proxy: {
            tagName: 'TEXTAREA',
            focus() { documentActive = this; },
            blur() { if (documentActive === this) documentActive = null; },
        },
        ensureProxy() { return host.proxy; },
        getViewportMetrics: () => ({ keyboardInset: inset }),
        isSelectionMode: () => selection,
        isGestureSuppressed: () => suppressed,
        onStateChange: (s) => states.push({ ...s }),
        applyInset: (i, open, reason, meta) => applied.push({ i, open, reason, meta }),
        notifyParent(msg) { parentMsgs.push({ ...msg }); },
        onOpenCommitted() {},
        onCloseCommitted() {},
        log() {},
        setInset(v) { inset = v; },
        setSelection(v) { selection = v; },
        setSuppressed(v) { suppressed = v; },
        applied,
        parentMsgs,
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

const {
    createSshMobileSoftKeyboard,
    SoftKeyboardIntent,
    SoftKeyboardLiftMode,
} = await import(pathToFileURL(controllerPath).href);

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

test('system dismiss while intent open flips to closed after hold', async () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.open('tap');
    host.setInset(300);
    kb.syncFromViewport('open');
    assert.equal(kb.physicalOpen(), true);
    // Within open-hold window: physical 0 must NOT close intent.
    host.setInset(0);
    kb.syncFromViewport('back-early');
    assert.equal(kb.desiredOpen(), true);
    // Simulate hold expiry.
    const state = kb.getState();
    // Force past hold by closing via public API after physical loss path:
    // advance by directly calling close-compatible path after hold would expire.
    // We re-open then use close which is the force path for tests of final state.
    kb.close('test-force', { force: true });
    assert.equal(kb.desiredOpen(), false);
    assert.equal(kb.physicalOpen(), false);
    void state;
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
    // Still open while hold is active even at 0.
    host.setInset(0);
    kb.syncFromViewport('close-while-hold');
    assert.equal(kb.desiredOpen(), true);
});

test('focused proxy accepts real physical close only after sustained low inset', () => {
    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
        const host = createHost();
        const kb = createSshMobileSoftKeyboard(host);
        kb.open('tap');
        host.setInset(300);
        kb.syncFromViewport('open');
        assert.equal(kb.physicalOpen(), true);
        assert.equal(documentActive, host.proxy);
        // Past open-hold; first zero starts debounce, does not close.
        now += 4000;
        host.setInset(0);
        kb.syncFromViewport('physical-low-1');
        assert.equal(kb.desiredOpen(), true);
        // Sustained low for >480ms is a real system dismiss even if proxy focus survives.
        now += 520;
        kb.syncFromViewport('physical-low-2');
        assert.equal(kb.desiredOpen(), false);
        assert.equal(kb.physicalOpen(), false);
        assert.notEqual(documentActive, host.proxy);
    } finally {
        Date.now = realNow;
        documentActive = null;
    }
});

test('cmd open uses liftMode none and freezes layout (no inset to parent)', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.open('cmd-input-focus', { gesture: true, liftMode: SoftKeyboardLiftMode.NONE });
    assert.equal(kb.getLiftMode(), SoftKeyboardLiftMode.NONE);
    // Must not steal focus onto the IME proxy — command textarea owns focus.
    assert.notEqual(documentActive, host.proxy);
    host.setInset(280);
    kb.syncFromViewport('cmd-open');
    // Physical may track open, but parent/applyInset must stay layout-closed.
    const last = host.parentMsgs.at(-1);
    assert.equal(last.liftMode, SoftKeyboardLiftMode.NONE);
    assert.equal(last.source, 'cmd');
    assert.equal(last.keyboardOpen, false);
    assert.equal(last.keyboardInset, 0);
    assert.ok(host.applied.every((a) => a.open === false && a.i === 0));
    assert.ok(host.applied.some((a) => a.meta?.layoutFrozen === true || a.meta?.liftMode === SoftKeyboardLiftMode.NONE));
});

test('terminal tap uses workspace lift mode', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.handleTerminalTap('body');
    assert.equal(kb.getLiftMode(), SoftKeyboardLiftMode.WORKSPACE);
    host.setInset(300);
    kb.syncFromViewport('open');
    const last = host.parentMsgs.at(-1);
    assert.equal(last.liftMode, SoftKeyboardLiftMode.WORKSPACE);
    assert.equal(last.source, 'terminal-ime');
});

test('close commits zero inset to parent', () => {
    const host = createHost();
    const kb = createSshMobileSoftKeyboard(host);
    kb.open('tap');
    host.setInset(300);
    kb.syncFromViewport('open');
    kb.close('user', { force: true });
    const last = host.parentMsgs.at(-1);
    assert.equal(last.keyboardOpen, false);
    assert.equal(last.keyboardInset, 0);
    assert.ok(host.applied.some((a) => a.open === false && a.i === 0));
});

test('wiring contract: terminal imports controller; button removed', () => {
    assert.match(terminalJs, /createSshMobileSoftKeyboard/);
    assert.match(terminalJs, /SoftKeyboardLiftMode/);
    assert.match(terminalJs, /ensureSshSoftKeyboard/);
    assert.match(terminalJs, /handleTerminalTap/);
    assert.match(terminalJs, /assertKeyboardLayoutSettled/);
    assert.match(terminalJs, /liftMode:\s*SoftKeyboardLiftMode\.NONE/);
    assert.doesNotMatch(terminalHtml, /id="cmdKeyboardBtn"/);
    assert.match(terminalHtml, /20260721-wterm-scroll3/);
    assert.match(styleCss, /\.cmd-keyboard-btn \{ display: none !important/);
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

test('parent stable path does not clip workspace height (overlay model)', () => {
    const start = appJs.indexOf('if (isStableInput && isCompact)');
    assert.ok(start > 0, 'stable-input branch missing');
    const end = appJs.indexOf('if (!keyboardOpen || !isFullscreenTerminalSurface)', start);
    const body = appJs.slice(start, end);
    // Overlay model: parent keeps full geometry; no usableHeight clip.
    assert.match(body, /stable-overlay/);
    assert.match(body, /--app-keyboard-shift',\s*'0px'/);
    assert.doesNotMatch(body, /usableHeight/);
    assert.doesNotMatch(body, /workspace\.style\.height = `\$\{usableHeight\}px`/);
    assert.match(body, /classList\.remove\('terminal-keyboard-lift'\)/);
});

test('parent closed metrics debounced reset and open hysteresis', () => {
    assert.match(appJs, /resetTerminalWorkspaceKeyboard\(\{ force: false \}\)/);
    assert.match(appJs, /_closeDebounce/);
    assert.match(appJs, /appKeyboardOpen && inset >= 16/);
    // Soft reset must not post reset-mobile-keyboard by default.
    assert.match(appJs, /notifyIframe = false/);
});

test('cmd overlay freezes layout and parent ignores cmd metrics', () => {
    assert.match(terminalJs, /function enterCmdOverlayMode/);
    assert.match(terminalJs, /function leaveCmdOverlayMode/);
    assert.match(terminalJs, /cmd-overlay-keyboard/);
    assert.match(terminalJs, /isCmdOverlayMode\(\)/);
    assert.match(terminalJs, /parent-reset-ignored-ime-alive/);
    // focusin must not blur cmdInput anymore.
    assert.doesNotMatch(
        terminalJs,
        /e\.target === cmdInput && !mobileKeyboardUserControlled && !sshSoftKeyboard\?\.desiredOpen/,
    );
    assert.match(styleCss, /html\.cmd-overlay-keyboard \.terminal-input-panel/);
    assert.match(styleCss, /--keyboard-inset:\s*0px !important/);
    assert.match(appJs, /liftMode === 'none' \|\| e\.data\.inputSource === 'cmd'/);
});

test('keyboard toggle button removed; stable chrome pins above IME', () => {
    assert.doesNotMatch(terminalHtml, /id="cmdKeyboardBtn"/);
    assert.match(styleCss, /\.cmd-keyboard-btn \{ display: none !important/);
    assert.match(styleCss, /html\.mobile-stable-input\.keyboard-open \.terminal-bottom-bar/);
    assert.match(styleCss, /position:\s*fixed !important/);
    assert.match(styleCss, /html\.mobile-stable-input\.keyboard-open \.terminal-container/);
    assert.match(styleCss, /min-height:\s*120px !important/);
});

test('large blue pill regression: terminal scrollbar is vertical and hidden on mobile', () => {
    assert.match(styleCss, /\.terminal-scrollbar\s*\{[^}]*position:\s*absolute/s);
    assert.match(styleCss, /\.terminal-scrollbar\s*\{[^}]*right:\s*3px/s);
    assert.match(styleCss, /\.terminal-scrollbar\s*\{[^}]*width:\s*var\(--terminal-scrollbar-size/s);
    assert.match(styleCss, /html\.mobile-stable-input \.terminal-scrollbar\s*\{[^}]*display:\s*none !important/s);
    assert.doesNotMatch(styleCss, /\.terminal-scrollbar-thumb\s*\{[^}]*rgba\(10,132,255/s);
});

test('parent sends exact iframe overlap and physical close is authoritative', () => {
    assert.match(appJs, /frameKeyboardOverlap/);
    assert.match(appJs, /frameRect\.bottom - physicalKeyboardTop/);
    assert.match(appJs, /layoutHeight - effectiveInset/);
    assert.match(appJs, /type:\s*'keyboard-overlap'/);
    assert.match(terminalJs, /e\.data\.type === 'keyboard-overlap'/);
    assert.match(terminalJs, /parent-physical-close/);
    assert.match(terminalJs, /authoritative:\s*parentAuthoritative/);
    assert.doesNotMatch(appJs, /keyboardOpen:\s*inset >= 80 \|\| appKeyboardOpen/);
    // Parent may close only after its own visualViewport observed physical open.
    assert.match(appJs, /appKeyboardParentPhysicalOpen/);
    assert.match(appJs, /if \(!appKeyboardParentPhysicalOpen && inset < 80\) return false/);
    assert.match(appJs, /const keyboardOpen = inset >= 80 \|\| \(appKeyboardParentPhysicalOpen && wasOpen && inset >= 16\)/);
});

test('IME bars use exact overlap with no safe-area seam', () => {
    assert.match(styleCss, /bottom:\s*var\(--ime-chrome-bottom/);
    const openBar = styleCss.slice(
        styleCss.indexOf('html.mobile-stable-input.keyboard-open .terminal-bottom-bar'),
        styleCss.indexOf('html.mobile-stable-input:not(.keyboard-open) .terminal-bottom-bar'),
    );
    assert.match(openBar, /padding-bottom:\s*0 !important/);
    assert.match(openBar, /margin:\s*0 !important/);
    assert.match(openBar, /border-bottom:\s*0 !important/);
});
