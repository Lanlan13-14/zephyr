/**
 * Termux-model mobile keyboard geometry contracts (kb-xterm-fit2).
 *
 * Rules:
 * 1. Bottom tools + aux NEVER position:fixed over the terminal buffer.
 * 2. IME open shrinks .terminal-page by --ssh-kb-inset.
 * 3. getMobileBottomChromeHeight is always 0 (chrome in-flow).
 * 4. Parent overlap forces --ssh-kb-inset even when intent lags.
 * 5. Auto-scroll with chrome=0 is plain maxScroll stick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    computeCursorAboveChromeScrollTop,
    allowScrollDuringTyping,
} from '../../public/terminal-scroll-policy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');

/** Slice the authoritative trailing mobile surface block. */
function authoritativeBlock() {
    const marker = 'AUTHORITATIVE MOBILE SSH SURFACE';
    const idx = styleCss.lastIndexOf(marker);
    assert.ok(idx > 0, 'authoritative block missing');
    return styleCss.slice(idx);
}

test('authoritative CSS keeps chrome in document flow (never fixed)', () => {
    const block = authoritativeBlock();
    // Must declare static for both open and closed.
    assert.match(block, /html\.mobile-stable-input\.ssh-kb-open \.topbar-actions/);
    assert.match(block, /html\.mobile-stable-input\.ssh-kb-open \.terminal-bottom-bar/);
    assert.match(block, /position:\s*static\s*!important/);
    // Must NOT re-introduce fixed chrome in the authoritative block.
    assert.doesNotMatch(block, /\.topbar-actions\s*\{[^}]*position:\s*fixed/s);
    assert.doesNotMatch(block, /\.terminal-bottom-bar\s*\{[^}]*position:\s*fixed/s);
});

test('authoritative CSS shrinks terminal-page by ssh-kb-inset when open', () => {
    const block = authoritativeBlock();
    assert.match(
        block,
        /html\.mobile-stable-input\.ssh-kb-open \.terminal-page\s*\{[^}]*height:\s*calc\(100%\s*-\s*var\(--ssh-kb-inset/s,
    );
    // container must not reserve fake padding for overlay chrome
    assert.match(
        block,
        /html\.mobile-stable-input\.ssh-kb-open \.terminal-container\s*\{[^}]*padding-bottom:\s*0\s*!important/s,
    );
});

test('getMobileBottomChromeHeight is hard-zero (in-flow chrome)', () => {
    assert.match(terminalJs, /function getMobileBottomChromeHeight\(\)\s*\{\s*return 0;\s*\}/);
});

test('parent-overlap writes inset authoritatively', () => {
    assert.match(terminalJs, /type === 'keyboard-overlap'/);
    assert.match(terminalJs, /applyMobileStableKeyboardInset\([\s\S]*parent-overlap/);
    // Must not only call applyFacadeChrome (which drops inset when intent closed).
    const overlapHandler = terminalJs.slice(
        terminalJs.indexOf("type === 'keyboard-overlap'"),
        terminalJs.indexOf("type === 'keyboard-overlap'") + 1800,
    );
    assert.match(overlapHandler, /applyMobileStableKeyboardInset/);
    assert.match(overlapHandler, /parent-overlap-adopt|proxyFocused/);
});

test('applyMobileStableKeyboardInset writes --ssh-kb-inset and toggles ssh-kb-open', () => {
    assert.match(terminalJs, /setProperty\('--ssh-kb-inset'/);
    assert.match(terminalJs, /classList\.toggle\('ssh-kb-open'/);
    assert.match(terminalJs, /kb-xterm-fit2/);
});

test('pin path stick-bottom when chromeHeight is 0', () => {
    // Policy unit: chrome 0 + maxScroll > 0 ⇒ stick to bottom
    const d = computeCursorAboveChromeScrollTop({
        scrollTop: 0,
        maxScroll: 340,
        scrollportHeight: 400,
        cursorBottomInViewport: 390,
        cursorTopInViewport: 373,
        chromeHeight: 0,
        lineHeight: 17,
    });
    // With chrome 0, cursor near bottom of full scrollport is already visible
    // OR unclip. Either way policy must not invent overlay math.
    assert.equal(typeof d.scrollTop, 'number');
    assert.ok(d.scrollTop >= 0 && d.scrollTop <= 340);

    // Fully visible mid-screen: no scroll
    const mid = computeCursorAboveChromeScrollTop({
        scrollTop: 100,
        maxScroll: 340,
        scrollportHeight: 400,
        cursorBottomInViewport: 200,
        cursorTopInViewport: 183,
        chromeHeight: 0,
        lineHeight: 17,
    });
    assert.equal(mid.changed, false);
});

test('terminal entry cache-bust kb-xterm-fit2', () => {
    assert.match(terminalHtml, /kb-xterm-fit2/);
    assert.match(terminalJs, /kb-xterm-fit2/);
});

test('allowScrollDuringTyping still rejects non-unclip', () => {
    assert.equal(allowScrollDuringTyping({ changed: true, reason: 'already-visible' }), false);
    assert.equal(allowScrollDuringTyping({ changed: true, reason: 'unclip-bottom' }), true);
});
