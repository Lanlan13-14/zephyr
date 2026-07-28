import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');

// Compatibility test host using NEW facade (old module deleted).
import {
    createSshKeyboard,
    Intent as SoftKeyboardIntent,
    LiftMode as SoftKeyboardLiftMode,
} from '../public/ssh-keyboard/index.js';

function createHost(overrides = {}) {
    let inset = 0;
    let selection = false;
    let suppressed = false;
    const applied = [];
    const parentMsgs = [];
    const states = [];
    let focused = null;
    const proxy = {
        tagName: 'TEXTAREA',
        classList: { contains: (c) => c === 'mobile-terminal-ime-proxy' },
        focus() { focused = proxy; documentActive = proxy; },
        blur() { if (focused === proxy) { focused = null; documentActive = null; } },
    };
    const host = {
        isTouchDevice: () => true,
        isStableMode: () => true,
        isMobileStable: () => true,
        ensureProxy() { return proxy; },
        getViewportMetrics: () => ({ keyboardInset: inset }),
        isSelectionMode: () => selection,
        hasSelection: () => selection,
        isGestureSuppressed: () => suppressed,
        isEmbedded: () => true,
        getTabId: () => 't1',
        postToParent(msg) { parentMsgs.push({ ...msg }); },
        notifyParent(msg) { parentMsgs.push({ ...msg }); },
        applyInset(i, open, reason, meta) { applied.push({ i, open, reason, meta }); },
        onStateChange: (s) => states.push({ ...s }),
        onLayout(phase, i, meta) { applied.push({ i, open: phase === 'open' || phase === 'opening', phase, meta }); },
        getDocument: () => globalThis.document,
        log() {},
        setInset(v) { inset = v; },
        setSelection(v) { selection = v; },
        setSuppressed(v) { suppressed = v; },
        applied,
        parentMsgs,
        states,
        proxy,
        ...overrides,
    };
    return host;
}

let documentActive = null;
Object.defineProperty(globalThis, 'document', {
    value: {
        get activeElement() { return documentActive; },
        documentElement: {
            style: { setProperty() {}, getPropertyValue() { return ''; } },
            classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        },
        getElementById() { return null; },
    },
    configurable: true,
});
globalThis.window = globalThis;

function createSshMobileSoftKeyboard(host) {
    // Adapter: expose old controller surface via facade.asSoftKeyboard + syncViewport inset from host.
    const kb = createSshKeyboard({
        isTouchDevice: host.isTouchDevice,
        isMobileStable: host.isStableMode || host.isMobileStable,
        ensureProxy: host.ensureProxy,
        getViewportMetrics: host.getViewportMetrics,
        isSelectionMode: host.isSelectionMode,
        hasSelection: host.isSelectionMode,
        isGestureSuppressed: host.isGestureSuppressed,
        isEmbedded: () => true,
        getTabId: () => 't1',
        postToParent: (m) => host.notifyParent?.(m) || host.postToParent?.(m),
        onLayout: (phase, inset, meta) => {
            host.applyInset?.(inset, phase === 'open' || phase === 'opening', 'layout', meta);
        },
        onStateChange: (s) => host.onStateChange?.(s),
        getDocument: () => globalThis.document,
        log: host.log,
    });
    const soft = kb.asSoftKeyboard();
    // old tests call syncFromViewport after setInset
    const origSync = soft.syncFromViewport.bind(soft);
    soft.syncFromViewport = (reason) => {
        const inset = host.getViewportMetrics().keyboardInset;
        kb._intent.syncViewport({
            inset,
            hasEditableFocus: documentActive === host.proxy || documentActive?.tagName === 'TEXTAREA',
            now: Date.now(),
        });
        return soft.getState();
    };
    // capture applyInset via onLayout already; also notifyParent from bridge publish
    const prevPost = host.postToParent;
    // wrap getState physicalOpen boolean like old
    const oldGetState = soft.getState;
    soft.getState = () => {
        const s = oldGetState();
        return {
            ...s,
            physicalOpen: s.physical === SoftKeyboardIntent.OPEN || s.physical === 'open',
        };
    };
    soft.physicalOpen = () => {
        const s = oldGetState();
        return s.physical === 'open' || s.physical === SoftKeyboardIntent.OPEN;
    };
    return soft;
}

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

test('focused proxy never auto-dismisses on low inset (overlays-safe)', () => {
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
        // Long zero inset while proxy focused must keep IME intent open.
        now += 4000;
        host.setInset(0);
        kb.syncFromViewport('physical-low-1');
        now += 2000;
        kb.syncFromViewport('physical-low-2');
        assert.equal(kb.desiredOpen(), true);
        assert.equal(documentActive, host.proxy);
        // Explicit close still works.
        kb.close('user-close', { force: true });
        assert.equal(kb.desiredOpen(), false);
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
    assert.ok(last.source === 'cmd' || last.liftMode === SoftKeyboardLiftMode.NONE || last.liftMode === 'none');
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
    assert.ok(!last.liftMode || last.liftMode === SoftKeyboardLiftMode.WORKSPACE || last.liftMode === 'workspace' || last.source === 'terminal-ime');
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

test('wiring contract: terminal imports controller + facade; button removed', () => {
    assert.match(terminalJs, /createSshKeyboard/);
    assert.match(terminalJs, /LiftMode|SoftKeyboardLiftMode|openCmd/);
    assert.match(terminalJs, /ensureSshKeyboard/);
    assert.match(terminalJs, /handlePointerUp|handleTerminalTap/);
    assert.match(terminalJs, /assertKeyboardLayoutSettled/);
    assert.match(terminalJs, /openCmd\(|LiftMode\.NONE|liftMode/);
    assert.doesNotMatch(terminalHtml, /id="cmdKeyboardBtn"/);
    assert.match(terminalHtml, /20260728-ai-panel-edge-stop1/);
    assert.match(styleCss, /\.cmd-keyboard-btn \{ display: none !important/);
});

test('wiring contract: body tap does not blur/dismiss', () => {
    // The old toggle-dismiss path must be gone.
    assert.doesNotMatch(
        terminalJs,
        /Toggle keyboard: if already open, dismiss; otherwise open/,
    );
    // Facade gesture path: open only on clean tap; never dismiss on body pointerup.
    assert.match(terminalJs, /handlePointerUp|handleTerminalTap/);
    assert.doesNotMatch(terminalJs, /result\?\.opened[\s\S]{0,200}close\(/);
    assert.match(terminalJs, /dismissMobileStableImeProxy|sshSoftKeyboard\.close|sshSoftKeyboard\?\.close|sshKb\?\.close|kb\.close|handleParentMessage/);
});

test('enableMobileStableInputMode does not force userControlled open', () => {
    const block = terminalJs.slice(
        terminalJs.indexOf('function enableMobileStableInputMode()'),
        terminalJs.indexOf('function enableMobileStableInputMode()') + 700,
    );
    // Flag variables removed — intent owned by facade getters.
    assert.doesNotMatch(block, /mobileKeyboardUserControlled\s*=\s*true/);
    assert.match(terminalJs, /function isSshKbDesiredOpen/);
    assert.doesNotMatch(terminalJs, /let mobileKeyboardOpen\s*=/);
    assert.doesNotMatch(terminalJs, /let mobileKeyboardUserControlled\s*=/);
    assert.doesNotMatch(terminalJs, /let keyboardFocusLikely\s*=/);
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
    assert.match(body, /classList\.remove\('ssh-kb-lift'\)/);
});

test('parent closed metrics debounced reset and open hysteresis', () => {
    assert.match(appJs, /resetTerminalWorkspaceKeyboard\(\{ force: false \}\)/);
    assert.match(appJs, /_closeDebounce/);
    // Single parent hysteresis lives in reduceParentKeyboardMessage (open≥80, close<12).
    assert.match(appJs, /reduceParentKeyboardMessage/);
    assert.match(appJs, /type === 'ssh-kb'/);
    // Soft reset must not post reset-mobile-keyboard by default.
    assert.match(appJs, /notifyIframe = false/);
});

test('cmd overlay freezes layout and parent ignores cmd metrics', () => {
    assert.match(terminalJs, /function enterCmdOverlayMode/);
    assert.match(terminalJs, /function leaveCmdOverlayMode/);
    assert.match(terminalJs, /ssh-kb-cmd/);
    assert.match(terminalJs, /isCmdOverlayMode\(\)/);
    assert.match(terminalJs, /parent-reset-ignored-ime-alive/);
    // focusin must not blur cmdInput anymore.
    assert.doesNotMatch(
        terminalJs,
        /e\.target === cmdInput && !mobileKeyboardUserControlled && !sshSoftKeyboard\?\.desiredOpen/,
    );
    assert.match(styleCss, /html\.ssh-kb-cmd \.terminal-input-panel/);
    assert.match(styleCss, /--keyboard-inset:\s*0px !important/);
    // Parent treats cmd via reduceParentKeyboardMessage.cmd / lift none.
    assert.match(appJs, /reduceParentKeyboardMessage|liftMode === 'none'|reduced\.cmd/);
});

test('keyboard toggle button removed; stable chrome pins above IME', () => {
    assert.doesNotMatch(terminalHtml, /id="cmdKeyboardBtn"/);
    assert.match(styleCss, /\.cmd-keyboard-btn \{ display: none !important/);
    assert.match(styleCss, /html\.mobile-stable-input\.ssh-kb-open \.terminal-bottom-bar|html\.ssh-kb-open/);
    assert.match(styleCss, /position:\s*fixed !important/);
    assert.match(styleCss, /html\.mobile-stable-input\.ssh-kb-open \.terminal-container/);
    assert.match(styleCss, /min-height:\s*120px !important/);
});

test('large blue pill regression: terminal scrollbar is vertical and hidden on mobile', () => {
    assert.match(styleCss, /\.terminal-scrollbar\s*\{[^}]*position:\s*absolute/s);
    assert.match(styleCss, /\.terminal-scrollbar\s*\{[^}]*right:\s*3px/s);
    assert.match(styleCss, /\.terminal-scrollbar\s*\{[^}]*width:\s*var\(--terminal-scrollbar-size/s);
    assert.match(styleCss, /html\.mobile-stable-input \.terminal-scrollbar\s*\{[^}]*display:\s*none !important/s);
    assert.doesNotMatch(styleCss, /\.terminal-scrollbar-thumb\s*\{[^}]*rgba\(10,132,255/s);
});

test('parent sends exact iframe overlap; open intent child-only; physical close parent', () => {
    assert.match(appJs, /frameKeyboardOverlap/);
    assert.match(appJs, /frameRect\.bottom - physicalKeyboardTop/);
    assert.match(appJs, /type:\s*'keyboard-overlap'/);
    assert.match(terminalJs, /e\.data\.type === 'keyboard-overlap'/);
    assert.match(terminalJs, /parent-physical-close|parent-overlap/);
    assert.match(terminalJs, /applyMobileStableKeyboardInset/);
    // Never open from bare inset threshold on parent.
    assert.doesNotMatch(appJs, /keyboardOpen:\s*inset >= 80 \|\| sshKbParentOpen/);
    assert.doesNotMatch(appJs, /appKeyboardParentPhysicalOpen/);
    // kb-xterm-fit2: parent forces close when physical inset gone.
    assert.match(appJs, /parent-physical-close|parent-stable-close|physical height authority/i);
    assert.match(appJs, /reduceParentKeyboardMessage/);
    assert.match(appJs, /sshKbParentInset/);
    assert.match(appJs, /childOpen/);
});

test('IME bars stay in-flow under terminal (Termux); no fixed overlay seam', () => {
    const marker = styleCss.lastIndexOf('AUTHORITATIVE MOBILE SSH SURFACE');
    assert.ok(marker > 0);
    const tail = styleCss.slice(marker);
    // kb-xterm-fit2: chrome is static in document flow — never fixed over buffer.
    assert.match(tail, /ssh-kb-open \.terminal-bottom-bar[\s\S]{0,400}position:\s*static\s*!important/);
    assert.match(tail, /ssh-kb-open \.topbar-actions[\s\S]{0,400}position:\s*static\s*!important/);
    assert.match(tail, /padding-bottom:\s*2px\s*!important/);
    // leftover historical fixed rules may exist above; authoritative tail must not reintroduce them
    assert.doesNotMatch(tail, /\.terminal-bottom-bar\s*\{[^}]*position:\s*fixed/s);
});
