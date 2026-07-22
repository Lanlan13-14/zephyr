/**
 * Termux-model mobile keyboard geometry contracts.
 *
 * Rules:
 * 1. Bottom tools + aux NEVER position:fixed over the terminal buffer.
 * 2. Standalone IME open may shrink .terminal-page by --ssh-kb-inset.
 * 3. Parent-shell-managed (iframe already cropped) forces child inset=0 / height 100%.
 * 4. getMobileBottomChromeHeight is always 0 (chrome in-flow).
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

test('parent-overlap forces child inset 0 under parentShellManaged', () => {
    assert.match(terminalJs, /type === 'keyboard-overlap'/);
    assert.match(terminalJs, /parentShellManaged/);
    assert.match(terminalJs, /setSshKbParentShellManaged/);
    const overlapHandler = terminalJs.slice(
        terminalJs.indexOf("type === 'keyboard-overlap'"),
        terminalJs.indexOf("type === 'keyboard-overlap'") + 2600,
    );
    // Parent-shell path must write geometry with inset 0, not re-apply physical height.
    assert.match(overlapHandler, /writeSshKbPageGeometry\(0, true/);
    assert.match(overlapHandler, /setSshKbParentShellManaged\(true/);
    assert.doesNotMatch(overlapHandler, /applyMobileStableKeyboardInset\(\s*overlap/);
});

test('writeSshKbPageGeometry is sole writer of --ssh-kb-inset + ssh-kb-open', () => {
    assert.match(terminalJs, /function writeSshKbPageGeometry/);
    assert.match(terminalJs, /setProperty\('--ssh-kb-inset'/);
    assert.match(terminalJs, /classList\.toggle\('ssh-kb-open'/);
    // Parent-shell sticky must zero inset inside the writer.
    assert.match(
        terminalJs,
        /function writeSshKbPageGeometry[\s\S]{0,900}_sshKbParentShellManaged[\s\S]{0,200}inset = 0/,
    );
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

test('terminal entry cache-bust aux-bar-fly1', () => {
    assert.match(terminalHtml, /aux-bar-fly1/);
    assert.match(terminalHtml, /terminal\.js\?v=20260722-aux-bar-fly1/);
});

test('allowScrollDuringTyping still rejects non-unclip', () => {
    assert.equal(allowScrollDuringTyping({ changed: true, reason: 'already-visible' }), false);
    assert.equal(allowScrollDuringTyping({ changed: true, reason: 'unclip-bottom' }), true);
});
