import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const appJs = readFileSync(join(root, 'public/app.js'), 'utf8');
const indexJs = readFileSync(join(root, 'public/ssh-keyboard/index.js'), 'utf8');
const bridgeJs = readFileSync(join(root, 'public/ssh-keyboard/bridge.js'), 'utf8');
const styleCss = readFileSync(join(root, 'public/style.css'), 'utf8');
const terminalHtml = readFileSync(join(root, 'public/terminal.html'), 'utf8');

function sliceFn(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} missing`);
    let i = start;
    let paren = 0;
    let seenParen = false;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '(') { paren++; seenParen = true; }
        else if (c === ')') paren--;
        else if (c === '{' && seenParen && paren === 0) break;
    }
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unclosed ${name}`);
}

test('DoD1: no mobileKeyboardOpen/UserControlled/FocusLikely identifiers in terminal.js', () => {
    assert.doesNotMatch(terminalJs, /\bmobileKeyboardOpen\b/);
    assert.doesNotMatch(terminalJs, /\bmobileKeyboardUserControlled\b/);
    assert.doesNotMatch(terminalJs, /\bkeyboardFocusLikely\b/);
    assert.doesNotMatch(terminalJs, /\bmobileKeyboardInset\b/);
    assert.match(terminalJs, /function isSshKbDesiredOpen/);
    assert.match(terminalJs, /function isSshKbLayoutOpen/);
    assert.match(terminalJs, /function getSshKbInset/);
});

test('DoD2: proxy focus only in intent.js', () => {
    assert.doesNotMatch(terminalJs, /mobileImeProxy\.focus/);
    const intentJs = readFileSync(join(root, 'public/ssh-keyboard/intent.js'), 'utf8');
    assert.match(intentJs, /proxy\.focus/);
});

test('DoD3: non-pin scrollTop goes through writeTerminalScrollTop gate', () => {
    assert.match(terminalJs, /function writeTerminalScrollTop/);
    assert.match(terminalJs, /allowNonPinScroll/);
    // maxScroll chase sites must call writeTerminalScrollTop or pin path
    assert.match(terminalJs, /writeTerminalScrollTop\(el, maxScroll/);
    assert.match(terminalJs, /scroll:blocked-ssh-kb-gate|allowNonPinScroll/);
});

test('DoD4: parent never invents OPEN; physical CLOSE height is parent-authoritative', () => {
    assert.doesNotMatch(appJs, /appKeyboardParentPhysicalOpen/);
    // kb-xterm-fit2: child owns open INTENT; parent owns physical height / close.
    assert.match(appJs, /OPEN intent: child facade only|childOpen|physical height authority|parent-physical-close/i);
    assert.match(appJs, /reduceParentKeyboardMessage/);
    assert.doesNotMatch(appJs, /keyboardOpen:\s*inset\s*>=\s*80\s*\|\|\s*sshKbParentOpen/);
    assert.match(bridgeJs, /emitLegacyMetrics === true|emitLegacyMetrics: false/);
    assert.match(indexJs, /emitLegacyMetrics:\s*false/);
});

test('DoD5/CSS: --keyboard-inset falls back to --ssh-kb-inset', () => {
    assert.match(styleCss, /--keyboard-inset:\s*var\(--ssh-kb-inset/);
    assert.match(styleCss, /--ssh-kb-inset/);
    assert.match(terminalJs, /setProperty\('--ssh-kb-inset'/);
});

test('updateViewportInsets has no independent open hysteresis', () => {
    const body = sliceFn(terminalJs, 'updateViewportInsets');
    assert.match(body, /ensureSshKeyboard|handleViewportChange|applyFacadeChrome/);
    assert.doesNotMatch(body, /keyboardWantsAvoidance/);
    assert.doesNotMatch(body, /controllerDesired/);
});

test('finalizeKeyboardClose delegates to facade close', () => {
    const body = sliceFn(terminalJs, 'finalizeKeyboardClose');
    assert.match(body, /kb\.close|ensureSshKeyboard/);
});

test('cache bust terminal-grid-converge1', () => {
    assert.match(terminalHtml, /terminal-grid-converge1/);
});

test('no bare inset open thresholds in terminal.js', () => {
    // kb-xterm-fit2: >=80 is allowed only as IME noise floor (geometry), never as
    // a solo open judge like `keyboardOpen = inset >= 80`.
    assert.doesNotMatch(terminalJs, /keyboardInset\s*>=\s*80/);
    assert.doesNotMatch(terminalJs, /keyboardInset\s*>=\s*100/);
    assert.doesNotMatch(terminalJs, /keyboardOpen\s*=\s*[^;]*inset\s*>=\s*80/);
    assert.doesNotMatch(terminalJs, /updateMobileKeyboardButtonUi/);
    assert.doesNotMatch(terminalJs, /setupMobileKeyboardButton/);
    assert.match(terminalJs, /function applyFacadeChrome/);
});

test('updateViewportInsets has no non-facade open branch', () => {
    const body = sliceFn(terminalJs, 'updateViewportInsets');
    assert.doesNotMatch(body, /keyboard-open-fallback/);
    assert.doesNotMatch(body, /const open = /);
    assert.match(body, /handleViewportChange/);
    assert.match(body, /applyFacadeChrome/);
});

test('applyFacadeChrome does not invent open from inset alone', () => {
    const body = sliceFn(terminalJs, 'applyFacadeChrome');
    // Open still requires phase/desired/proxy — inset>=80 is only a retain/noise gate.
    assert.match(body, /getPhase|desiredOpen|physicalOpen/);
    assert.match(body, /desired|phase|proxyFocused/);
    assert.doesNotMatch(body, /const open\s*=\s*inset\s*>=\s*80/);
    assert.doesNotMatch(body, /const open\s*=\s*\(?\s*inset\s*>/);
});

test('parent never invents open from inset thresholds', () => {
    assert.doesNotMatch(appJs, /keyboardOpen:\s*inset\s*>=/);
    assert.doesNotMatch(appJs, /parentInset\s*>=\s*100/);
    assert.doesNotMatch(appJs, /inset\s*>=\s*16\s*\|\|\s*sshKbParentOpen/);
    assert.doesNotMatch(appJs, /const keyboardOpen = \(!\!metrics\.keyboardOpen \|\| parentInset/);
    assert.match(appJs, /OPEN intent: child facade only|childOpen|metrics\.intent === 'open'/);
});

test('terminal notifyParent never posts keyboard-metrics', () => {
    const body = sliceFn(terminalJs, 'notifyParentKeyboardMetrics');
    assert.doesNotMatch(body, /type:\s*'keyboard-metrics'/);
    assert.match(body, /type:\s*'ssh-kb'|SSH_KB_MSG|_bridge\.publish|publish\(/);
});

test('keepMobileAuxImeFocused is single-retain no multi-phase', () => {
    const body = sliceFn(terminalJs, 'keepMobileAuxImeFocused');
    assert.match(body, /retainFocus/);
    assert.doesNotMatch(body, /requestAnimationFrame/);
    assert.doesNotMatch(body, /setTimeout/);
});
