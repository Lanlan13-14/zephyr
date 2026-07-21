import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = join(root, 'public/terminal-scroll-policy.js');
const terminalCssSrc = join(root, 'wterm/packages/@wterm/dom/src/terminal.css');
const terminalCssVendor = join(root, 'public/vendor/wterm-fork/terminal.css');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');

const {
    hasPrintableTerminalInput,
    shouldScrollOnTerminalInput,
    shouldScrollOnTerminalOutput,
    shouldScrollOnTerminalPaste,
    isTerminalScrollAtBottom,
    scrollTerminalToBottomIfNeeded,
    scrollTerminalToBottomAfterInputIfEnabled,
    scrollTerminalToBottomAfterOutputIfEnabled,
    shouldScrollForInputReason,
    scrollSettlePhases,
    computeCursorAboveChromeScrollTop,
    allowScrollDuringTyping,
    DEFAULT_TERMINAL_SCROLL_SETTINGS,
} = await import(pathToFileURL(policyPath).href);

function mockTerm({ atBottom = true, baseY, viewportY } = {}) {
    let scrollCalls = 0;
    const term = {
        buffer: (Number.isFinite(baseY) && Number.isFinite(viewportY))
            ? { active: { baseY, viewportY } }
            : undefined,
        isAtBottom: () => atBottom,
        scrollToBottom() { scrollCalls += 1; },
        get scrollCalls() { return scrollCalls; },
    };
    return term;
}

test('defaults match Netcatty: input on, output off, keyPress off, paste on', () => {
    assert.equal(DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnInput, true);
    assert.equal(DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnOutput, false);
    assert.equal(DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnKeyPress, false);
    assert.equal(DEFAULT_TERMINAL_SCROLL_SETTINGS.scrollOnPaste, true);
});

test('hasPrintableTerminalInput: ascii and CJK yes, ESC/control no', () => {
    assert.equal(hasPrintableTerminalInput('f'), true);
    assert.equal(hasPrintableTerminalInput('你好'), true);
    assert.equal(hasPrintableTerminalInput(' '), true);
    assert.equal(hasPrintableTerminalInput('\r'), false);
    assert.equal(hasPrintableTerminalInput('\x7f'), false);
    assert.equal(hasPrintableTerminalInput('\x1b[A'), false);
    assert.equal(hasPrintableTerminalInput(''), false);
});

test('shouldScrollOnTerminalInput: printable uses scrollOnInput', () => {
    assert.equal(shouldScrollOnTerminalInput({ scrollOnInput: true }, 'a'), true);
    assert.equal(shouldScrollOnTerminalInput({ scrollOnInput: false }, 'a'), false);
    assert.equal(shouldScrollOnTerminalInput({ scrollOnInput: true, scrollOnKeyPress: false }, '\r'), false);
    assert.equal(shouldScrollOnTerminalInput({ scrollOnInput: false, scrollOnKeyPress: true }, '\r'), true);
});

test('shouldScrollOnTerminalOutput defaults false', () => {
    assert.equal(shouldScrollOnTerminalOutput(undefined), false);
    assert.equal(shouldScrollOnTerminalOutput({}), false);
    assert.equal(shouldScrollOnTerminalOutput({ scrollOnOutput: true }), true);
});

test('shouldScrollOnTerminalPaste defaults true', () => {
    assert.equal(shouldScrollOnTerminalPaste(undefined), true);
    assert.equal(shouldScrollOnTerminalPaste({ scrollOnPaste: false }), false);
});

test('does not request another scroll when already at bottom (Netcatty)', () => {
    const term = mockTerm({ atBottom: true });
    const did = scrollTerminalToBottomIfNeeded(term);
    assert.equal(did, false);
    assert.equal(term.scrollCalls, 0);
});

test('scrolls once when viewing earlier output (Netcatty)', () => {
    const term = mockTerm({ atBottom: false });
    const did = scrollTerminalToBottomIfNeeded(term);
    assert.equal(did, true);
    assert.equal(term.scrollCalls, 1);
});

test('buffer baseY/viewportY: viewportY >= baseY means at bottom', () => {
    const at = mockTerm({ baseY: 10000, viewportY: 10000, atBottom: false });
    assert.equal(isTerminalScrollAtBottom(at), true);
    assert.equal(scrollTerminalToBottomIfNeeded(at), false);
    assert.equal(at.scrollCalls, 0);

    const away = mockTerm({ baseY: 10000, viewportY: 9900, atBottom: true });
    assert.equal(isTerminalScrollAtBottom(away), false);
    assert.equal(scrollTerminalToBottomIfNeeded(away), true);
    assert.equal(away.scrollCalls, 1);
});

test('printable input does not scroll when already at bottom', () => {
    const term = mockTerm({ atBottom: true });
    const did = scrollTerminalToBottomAfterInputIfEnabled(term, { scrollOnInput: true }, 'f');
    assert.equal(did, false);
    assert.equal(term.scrollCalls, 0);
});

test('printable input scrolls when not at bottom', () => {
    const term = mockTerm({ atBottom: false });
    const did = scrollTerminalToBottomAfterInputIfEnabled(term, { scrollOnInput: true }, 'f');
    assert.equal(did, true);
    assert.equal(term.scrollCalls, 1);
});

test('output path does not scroll by default', () => {
    const term = mockTerm({ atBottom: false });
    const did = scrollTerminalToBottomAfterOutputIfEnabled(term, undefined);
    assert.equal(did, false);
    assert.equal(term.scrollCalls, 0);
});

test('composition reasons never scroll', () => {
    assert.equal(shouldScrollForInputReason('compositionupdate', { composing: false }), false);
    assert.equal(shouldScrollForInputReason('mobile-ime-beforeinput', { composing: true }), false);
    assert.equal(shouldScrollForInputReason('mobile-ime-composition', { composing: false }), true);
});

test('settle phases never multi-fire for layout; input is single', () => {
    assert.deepEqual(scrollSettlePhases('layout'), []);
    assert.deepEqual(scrollSettlePhases('input'), [0]);
    assert.ok(scrollSettlePhases('paste').length <= 2);
    assert.ok(scrollSettlePhases('enter').length <= 2);
});

test('contract: terminal.js imports scroll policy', () => {
    assert.match(terminalJs, /terminal-scroll-policy\.js/);
    assert.match(terminalJs, /scrollTerminalToBottomAfterInputIfEnabled|scrollTerminalToBottomIfNeeded/);
});

test('contract: default write-follow does not multi-phase schedule', () => {
    // After fix: write-follow must not use long phase arrays
    assert.doesNotMatch(
        terminalJs,
        /scheduleTerminalBottomFollow\('write-follow',\s*\{\s*force:\s*true\s*\}\)/,
    );
    // Must not keep the old 7-phase default as the only path for input
    assert.doesNotMatch(
        terminalJs,
        /phases:\s*\[\s*0,\s*32,\s*80,\s*160,\s*280,\s*420,\s*680\s*\]/,
    );
});

test('contract: ime-active cursor CSS exists in wterm source and vendor', () => {
    const src = readFileSync(terminalCssSrc, 'utf8');
    const vendor = readFileSync(terminalCssVendor, 'utf8');
    for (const css of [src, vendor]) {
        assert.match(css, /\.wterm\.ime-active\s+\.term-cursor-overlay/);
        assert.match(css, /\.wterm\.ime-active\.cursor-blink/);
    }
});

test('contract: keyboard-open padding does not double-count keyboard-inset', () => {
    // bars are position:fixed above IME; padding only reserves tools+aux height
    const block = styleCss.match(
        /html\.mobile-stable-input\.keyboard-open\s+\.terminal-container\s*\{[\s\S]*?padding-bottom\s*:\s*calc\(([\s\S]*?)\)\s*!important/,
    );
    assert.ok(block, 'keyboard-open terminal-container padding-bottom calc missing');
    assert.doesNotMatch(block[1], /keyboard-inset/);
    assert.match(block[1], /mobile-bottom-actions-height/);
    assert.match(block[1], /mobile-aux-keys-height/);
});

test('contract: active-line rect prefers bridge cursor / overlay class', () => {
    assert.match(terminalJs, /term-cursor-overlay|bridge\.getCursor|getCursor\(/);
    assert.match(terminalJs, /ime-active/);
});

test('sparse content: maxScroll 0 forces scrollTop 0 (no black void)', () => {
    const d = computeCursorAboveChromeScrollTop({
        scrollTop: 40,
        maxScroll: 0,
        scrollportHeight: 400,
        cursorBottomInViewport: 80,
        chromeHeight: 90,
        lineHeight: 20,
    });
    assert.equal(d.scrollTop, 0);
    assert.equal(d.changed, true);
    assert.equal(d.reason, 'sparse-zero-max');
});

test('cursor already above chrome: same-line typing does not scroll', () => {
    // viewport 400, chrome 90 → visible ~310; cursor bottom at 200 in viewport
    const d = computeCursorAboveChromeScrollTop({
        scrollTop: 0,
        maxScroll: 500,
        scrollportHeight: 400,
        cursorBottomInViewport: 200,
        cursorTopInViewport: 180,
        chromeHeight: 90,
        lineHeight: 20,
        sameLineInput: true,
    });
    assert.equal(d.changed, false);
    assert.equal(d.reason, 'same-line-visible');
    assert.equal(allowScrollDuringTyping(d), false);
});

test('viewport-relative clip: scroll by delta only (no feedback loop)', () => {
    // scrollport 400, chrome 100, visibleBottom = 296; cursor bottom in viewport = 350
    // delta = 350-296 = 54 → scrollTop 100+54=154 → align 140 (lh 20)
    const d = computeCursorAboveChromeScrollTop({
        scrollTop: 100,
        maxScroll: 800,
        scrollportHeight: 400,
        cursorBottomInViewport: 350,
        cursorTopInViewport: 330,
        chromeHeight: 100,
        lineHeight: 20,
        padPx: 4,
        sameLineInput: true,
    });
    assert.equal(d.changed, true);
    assert.ok(d.scrollTop > 100, `expected scroll down, got ${d.scrollTop}`);
    assert.ok(d.scrollTop <= 160, `must only unclip, got ${d.scrollTop}`);
    // Critical: applying again with same viewport cursor at new scroll must not
    // keep growing — simulate post-scroll viewport cursor moved up by delta.
    const movedUp = 350 - (d.scrollTop - 100);
    const d2 = computeCursorAboveChromeScrollTop({
        scrollTop: d.scrollTop,
        maxScroll: 800,
        scrollportHeight: 400,
        cursorBottomInViewport: movedUp,
        cursorTopInViewport: movedUp - 20,
        chromeHeight: 100,
        lineHeight: 20,
        padPx: 4,
        sameLineInput: true,
    });
    assert.equal(d2.changed, false, 'second pin must be no-op (no fly)');
    assert.equal(allowScrollDuringTyping(d), true);
});

test('never jump toward maxScroll when cursor only slightly clipped', () => {
    const d = computeCursorAboveChromeScrollTop({
        scrollTop: 0,
        maxScroll: 2000,
        scrollportHeight: 400,
        cursorBottomInViewport: 360,
        cursorTopInViewport: 340,
        chromeHeight: 90,
        lineHeight: 20,
        padPx: 4,
        force: true,
    });
    assert.equal(d.changed, true);
    assert.ok(d.scrollTop < 120, `must not approach maxScroll, got ${d.scrollTop}`);
});

test('force does not move scroll when cursor already fully visible', () => {
    const d = computeCursorAboveChromeScrollTop({
        scrollTop: 0,
        maxScroll: 500,
        scrollportHeight: 400,
        cursorBottomInViewport: 200,
        cursorTopInViewport: 180,
        chromeHeight: 90,
        lineHeight: 20,
        force: true,
    });
    assert.equal(d.changed, false);
    assert.equal(d.scrollTop, 0);
});

test('forged contentY=scrollTop+row would fly — viewport path must not', () => {
    // Bug reproduction: if we had used contentY = scrollTop + row*lh, each pin
    // increases scrollTop and contentY, chasing forever. Viewport path is immune.
    let scrollTop = 0;
    for (let i = 0; i < 5; i += 1) {
        // cursor fixed at viewport row 10 * 20 = 200 (bridge semantics)
        const d = computeCursorAboveChromeScrollTop({
            scrollTop,
            maxScroll: 5000,
            scrollportHeight: 400,
            cursorBottomInViewport: 200,
            cursorTopInViewport: 180,
            chromeHeight: 90,
            lineHeight: 20,
            force: true,
        });
        assert.equal(d.changed, false, `iteration ${i} must not scroll`);
        scrollTop = d.scrollTop;
    }
});

test('contract: external mobile input prevents WTerm IME and self-scroll bypass', () => {
    const source = readFileSync(join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');
    const vendor = readFileSync(join(root, 'public/vendor/wterm-fork/wterm.js'), 'utf8');
    const terminal = readFileSync(join(root, 'public/terminal.js'), 'utf8');
    for (const code of [source, vendor]) {
        assert.match(code, /inputMode/);
        assert.match(code, /onExternalInputRequest/);
        assert.match(code, /this\._inputMode === ["']external["']/);
        assert.match(code, /this\._inputMode === ["']native["']\) this\._scrollToBottom/);
    }
    assert.match(terminal, /inputMode:\s*isTouchKeyboardDevice\(\) \? 'external' : 'native'/);
    assert.match(terminal, /onExternalInputRequest/);
    assert.match(terminal, /command-input:resize-only/);
    assert.doesNotMatch(terminal, /command-input:preserve-after/);
    assert.doesNotMatch(terminal, /\[80, 180, 360\]\.forEach\(\(delay\) => \{[\s\S]{0,500}scrollTop/);
});

test('contract: authoritative mobile CSS overrides historical grid/static chrome', () => {
    const css = readFileSync(join(root, 'public/style.css'), 'utf8');
    const marker = css.lastIndexOf('AUTHORITATIVE MOBILE SSH SURFACE');
    assert.ok(marker > 0, 'last authoritative surface block missing');
    const tail = css.slice(marker);
    assert.match(tail, /terminal-page\s*\{[\s\S]{0,400}display:\s*flex\s*!important/);
    assert.match(tail, /keyboard-open \.topbar-actions\s*\{[\s\S]{0,300}position:\s*fixed\s*!important/);
    assert.match(tail, /keyboard-open \.terminal-bottom-bar\s*\{[\s\S]{0,300}position:\s*fixed\s*!important/);
    assert.doesNotMatch(tail, /grid-template-areas/);
});
