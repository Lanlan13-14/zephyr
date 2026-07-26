import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');
const surfacePath = join(root, 'public/terminal-surface-controller.js');
const surfaceSrc = readFileSync(surfacePath, 'utf8');

const {
    createTerminalSurfaceController,
} = await import(pathToFileURL(surfacePath).href);

test('contract: terminal.js imports and calls ensureTerminalSurface', () => {
    assert.match(terminalJs, /createTerminalSurfaceController/);
    assert.match(terminalJs, /function ensureTerminalSurface\(/);
    // Must be invoked from real boot/event paths — not dead code.
    assert.match(terminalJs, /ensureTerminalSurface\(\)/);
    assert.match(terminalJs, /setupMobileKeyboardAvoidance[\s\S]{0,400}ensureTerminalSurface/);
    assert.match(terminalJs, /attachTerm\?\.\(['"]term-created['"]\)|attachTerm\(['"]term-created['"]\)/);
});

test('contract: soft keyboard owned by SshKeyboard facade; surface reuses inject', () => {
    assert.match(terminalJs, /function ensureSshKeyboard\(/);
    assert.match(terminalJs, /createSshKeyboard\(/);
    const ensureStart = terminalJs.indexOf('function ensureSshSoftKeyboard()');
    assert.ok(ensureStart > 0);
    const block = terminalJs.slice(ensureStart, ensureStart + 600);
    assert.match(block, /ensureSshKeyboard/);
    assert.match(block, /asSoftKeyboard/);
    // Must NOT rebuild a second createSshMobileSoftKeyboard host here.
    assert.doesNotMatch(block, /createSshMobileSoftKeyboard/);
    assert.doesNotMatch(surfaceSrc, /createSshMobileSoftKeyboard/);
    assert.match(surfaceSrc, /ssh-keyboard\/index/);
    assert.match(surfaceSrc, /missing-inject|getSoftKeyboard/);
    assert.match(surfaceSrc, /host\.getSoftKeyboard/);
    assert.match(terminalJs, /getSoftKeyboard:\s*\(\)\s*=>/);
});

test('contract: IME/tap/output/composition route through facade + surface', () => {
    assert.match(terminalJs, /surface\.onUserInputCommitted|onUserInputCommitted\(/);
    assert.match(terminalJs, /surface\.onEnterCommitted|onEnterCommitted\(/);
    // Tap open is owned by ssh-keyboard facade gesture path (single authority).
    assert.match(terminalJs, /handlePointerUp|handlePointerDown/);
    assert.match(terminalJs, /ensureSshKeyboard\(\)/);
    assert.match(terminalJs, /surface\.onOutput|onOutput\(/);
    assert.match(terminalJs, /onCompositionStart|handleCompositionStart/);
    assert.match(terminalJs, /onCompositionEnd|handleCompositionEnd/);
    assert.match(terminalJs, /surface\.onCmdFocus|onCmdFocus\(|openCmd\(/);
    assert.match(terminalJs, /handleViewportChange|surface\.onViewport|onViewport\(/);
});

test('contract: host pinScroll is single writer wiring', () => {
    assert.match(terminalJs, /pinScroll:\s*\(reason,\s*opts\s*=\s*\{\}\)\s*=>\s*applyCursorAboveChromeScroll/);
    assert.match(surfaceSrc, /host\.pinScroll/);
});

test('contract: mobile fork uses xterm FitAddon 1:1 (native scrollToBottom, no private patch)', () => {
    assert.match(terminalJs, /wterm-xterm-fit\.js/);
    assert.match(terminalJs, /xtermFitWTerm|xterm-fit-applied/);
    assert.match(terminalJs, /lockBottom|followBottom/);
    assert.match(terminalJs, /resizeWTermSafely/);
    const forkPathStart = terminalJs.indexOf("term.viewport && typeof term.viewport.follow === 'function'");
    const forkPathEnd = terminalJs.indexOf('// Legacy path:', forkPathStart);
    assert.ok(forkPathStart > 0 && forkPathEnd > forkPathStart);
    const body = terminalJs.slice(forkPathStart, forkPathEnd);
    assert.doesNotMatch(body, /term\._scrollToBottom\s*=/);
    assert.doesNotMatch(body, /term\._doRender\s*=/);
    assert.doesNotMatch(body, /term\.scrollToBottom\s*=/);
});

test('contract: terminal assets use current cache-bust', () => {
    assert.match(terminalHtml, /20260726-ai-context1/);
});

test('surface: pinScroll host is called; no direct scroll without host', () => {
    const pins = [];
    let scrollTop = 0;
    const el = {
        get scrollTop() { return scrollTop; },
        set scrollTop(v) { scrollTop = v; },
        clientHeight: 400,
        scrollHeight: 900,
    };
    const surface = createTerminalSurfaceController({
        isTouchDevice: () => true,
        isMobileStable: () => true,
        getTerm: () => null,
        getScrollElement: () => el,
        getWtermRoot: () => ({ classList: { toggle() {}, add() {} } }),
        ensureImeProxy: () => null,
        getViewportMetrics: () => ({ keyboardInset: 0 }),
        isSelectionMode: () => false,
        isGestureSuppressed: () => false,
        getChromeHeight: () => 90,
        getCursorMetrics: () => ({
            cursorTopInViewport: 180,
            cursorBottomInViewport: 200,
            lineHeight: 20,
        }),
        getMaxScroll: () => 500,
        pinScroll: (reason, opts) => {
            pins.push({ reason, ...opts });
            // Simulate single writer no-op when visible
            return false;
        },
        applyChromeLayout() {},
        onScrollbar() {},
        log() {},
    });
    surface.setFollowEnabled(true, 'test');
    surface.pinCursorAboveChrome('unit', { force: true });
    assert.equal(pins.length, 1);
    assert.equal(pins[0].reason, 'unit');
    assert.equal(pins[0].force, true);
});

test('surface: composing blocks pin even with force false', () => {
    const pins = [];
    const surface = createTerminalSurfaceController({
        isTouchDevice: () => true,
        isMobileStable: () => true,
        getTerm: () => null,
        getScrollElement: () => ({ scrollTop: 0, clientHeight: 400, scrollHeight: 800 }),
        getWtermRoot: () => ({ classList: { toggle() {}, add() {} } }),
        ensureImeProxy: () => null,
        getViewportMetrics: () => ({ keyboardInset: 0 }),
        isSelectionMode: () => false,
        isGestureSuppressed: () => false,
        getChromeHeight: () => 90,
        getCursorMetrics: () => ({ cursorBottomInViewport: 350, cursorTopInViewport: 330, lineHeight: 20 }),
        getMaxScroll: () => 500,
        pinScroll: (reason) => { pins.push(reason); return true; },
        applyChromeLayout() {},
        onScrollbar() {},
        log() {},
    });
    surface.onCompositionStart();
    const did = surface.pinCursorAboveChrome('during-comp', { force: false });
    assert.equal(did, false);
    assert.equal(pins.length, 0);
    surface.onCompositionEnd();
});
