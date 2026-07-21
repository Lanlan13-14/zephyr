import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const indexJs = readFileSync(join(root, 'public/ssh-keyboard/index.js'), 'utf8');

function sliceFn(name) {
    const start = terminalJs.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} missing`);
    // Find the opening brace of the function body (skip default-param object braces).
    let i = start;
    let paren = 0;
    let seenParen = false;
    for (; i < terminalJs.length; i++) {
        const c = terminalJs[i];
        if (c === '(') { paren++; seenParen = true; }
        else if (c === ')') paren--;
        else if (c === '{' && seenParen && paren === 0) break;
    }
    assert.ok(i < terminalJs.length, `${name} body missing`);
    let depth = 0;
    for (; i < terminalJs.length; i++) {
        if (terminalJs[i] === '{') depth++;
        else if (terminalJs[i] === '}') {
            depth--;
            if (depth === 0) return terminalJs.slice(start, i + 1);
        }
    }
    throw new Error(`unclosed ${name}`);
}

test('updateViewportInsets has no independent open hysteresis', () => {
    const body = sliceFn('updateViewportInsets');
    assert.match(body, /ensureSshKeyboard|handleViewportChange|syncLegacyKeyboardMirrorFromFacade/);
    assert.doesNotMatch(body, /keyboardWantsAvoidance/);
    assert.doesNotMatch(body, /controllerDesired/);
    assert.doesNotMatch(body, /controllerPhysical/);
    // Only fallback path may use raw inset threshold when facade missing.
    assert.match(body, /const kb = ensureSshKeyboard\(\)/);
});

test('finalizeKeyboardClose delegates to facade close', () => {
    const body = sliceFn('finalizeKeyboardClose');
    assert.match(body, /kb\.close|ensureSshKeyboard/);
    assert.match(body, /syncLegacyKeyboardMirrorFromFacade/);
});

test('focusMobileStableImeProxy opens only via facade openTerminal', () => {
    const body = sliceFn('focusMobileStableImeProxy');
    assert.match(body, /openTerminal/);
    assert.doesNotMatch(body, /surface\.openKeyboard/);
    assert.doesNotMatch(body, /sshSoftKeyboard\.open\(/);
});

test('single facade→DOM mirror exists', () => {
    assert.match(terminalJs, /function syncLegacyKeyboardMirrorFromFacade/);
    const body = sliceFn('syncLegacyKeyboardMirrorFromFacade');
    assert.match(body, /applyMobileStableKeyboardInset/);
    assert.match(body, /mobileKeyboardOpen = /);
});

test('layout gate mirrorLegacy disabled so terminal owns chrome CSS', () => {
    assert.match(indexJs, /mirrorLegacy:\s*false/);
});

test('parent notify redirects terminal-ime to bridge when facade present', () => {
    const body = sliceFn('notifyParentKeyboardMetrics');
    assert.match(body, /legacy-notify-redirect|sshKb && !force/);
    assert.match(body, /_bridge\?\.publish|forceNotify/);
});

test('layout-stabilize feeds facade not applyInset first', () => {
    const idx = terminalJs.indexOf("if (e.data.type === 'layout-stabilize')");
    assert.ok(idx > 0);
    const body = terminalJs.slice(idx, idx + 1800);
    assert.match(body, /syncViewport/);
    assert.match(body, /syncLegacyKeyboardMirrorFromFacade/);
    // Must not set mobileKeyboardOpen = true before facade path
    assert.doesNotMatch(body, /mobileKeyboardOpen = true;\s*\n\s*mobileKeyboardInset = parentInset;\s*\n\s*applyMobileStableKeyboardInset/);
});

test('viewport listeners do not double-call independent judges', () => {
    // setup onViewport should only call updateViewportInsets (which is facade-only)
    const idx = terminalJs.indexOf('const onViewport = (reason)');
    assert.ok(idx > 0);
    const body = terminalJs.slice(idx, idx + 350);
    assert.match(body, /updateViewportInsets\(\)/);
    assert.doesNotMatch(body, /handleViewportChange\(reason\);\s*\n\s*.*updateViewportInsets/);
});
