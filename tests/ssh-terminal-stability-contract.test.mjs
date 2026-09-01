import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const terminalSrc = fs.readFileSync(path.join(root, 'public/terminal.js'), 'utf8');
const telnetSrc = fs.readFileSync(path.join(root, 'public/telnet-terminal.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/core/src/xterm-bridge.ts'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/renderer.ts'), 'utf8');
const wtermSrc = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');

function writeTerminal(term, data) {
    return new Promise((resolve) => term.write(data, resolve));
}

test('history viewport hides the live cursor instead of painting it over old rows', async () => {
    const headless = require('@xterm/headless');
    const Terminal = headless.Terminal || headless.default?.Terminal || headless.default;
    const mod = await import(pathToFileURL(path.join(root, 'public/vendor/wterm-fork/core/xterm-bridge.js')).href);
    mod.setDefaultXtermTerminalCtor(Terminal);
    const bridge = await mod.XtermBridge.load({ cols: 20, rows: 5, scrollback: 100 });
    bridge.init(20, 5);
    for (let i = 0; i < 20; i += 1) bridge.writeString(`line-${i}\r\n`);
    assert.equal(bridge.getCursor().visible, true);
    bridge.scrollLines(-3);
    const cursor = bridge.getCursor();
    assert.equal(cursor.visible, false);
    assert.ok(cursor.row >= bridge.getRows(), `off-screen cursor row expected, got ${cursor.row}`);
    bridge.scrollToBottom();
    assert.equal(bridge.getCursor().visible, true);
    bridge.dispose();
});

test('snapshot replay restores carriage-return progress and alternate screen without a pile', async () => {
    const { createTerminalSnapshot } = require('../terminal-snapshot');
    const { Terminal } = require('@xterm/headless');
    const snapshot = createTerminalSnapshot({ cols: 24, rows: 5, scrollback: 100 });
    await snapshot.write('\x1b[?1049h\x1b[2J\x1b[Hprogress 10%');
    await snapshot.write('\rprogress 50%');
    await snapshot.write('\rprogress 90%');
    const frame = await snapshot.serialize({ scrollback: 50 });
    assert.match(frame.data, /\x1b\[\?1049h/);
    assert.doesNotMatch(frame.data, /progress 10%/);
    assert.doesNotMatch(frame.data, /progress 50%/);

    const restored = new Terminal({ cols: 24, rows: 5, scrollback: 100, allowProposedApi: true });
    await writeTerminal(restored, frame.data);
    assert.equal(restored.buffer.active.type, 'alternate');
    assert.equal(restored.buffer.active.getLine(0).translateToString(true), 'progress 90%');
    snapshot.dispose();
    restored.dispose();
});

test('desktop terminal clicks focus wterm immediately unless a live selection is being copied', () => {
    for (const [label, src] of [['ssh', terminalSrc], ['telnet', telnetSrc]]) {
        assert.match(src, /_zephyrDesktopClickFocusBound = true/, `${label}: bind once`);
        assert.match(src, /const focusFromDesktopGesture = \(event\) =>/, `${label}: gesture handler`);
        assert.match(src, /if \(usesExternalTerminalInput\(\)\) return/, `${label}: skip mobile IME`);
        assert.match(src, /event\.pointerType === 'touch' \|\| event\.pointerType === 'pen'/, `${label}: pointer type`);
        assert.match(src, /wtermWrapper\.addEventListener\('mousedown', focusFromDesktopGesture, true\)/, `${label}: mousedown capture`);
        assert.match(src, /wtermWrapper\.addEventListener\('click', focusFromDesktopGesture, true\)/, `${label}: click capture`);
        assert.match(src, /wtermWrapper\.addEventListener\('mouseleave', stopDesktopTerminalFocusIntent/, `${label}: stop on leave`);
        assert.match(src, /if \(event\.type === 'mousedown'\)/, `${label}: collapse on mousedown only`);
        assert.match(src, /steal focus during mousedown/, `${label}: no mousedown focus steal`);
        assert.match(src, /document\.addEventListener\('mousedown', \(event\) => \{/, `${label}: cancel when clicking outside`);
        assert.match(src, /function isCoarsePointer\(\) \{\n\s+return !!window\.matchMedia\?\.\('\(hover: none\) and \(pointer: coarse\)'\)\?\.matches;/, `${label}: coarse pointer`);
        assert.match(src, /function isTouchKeyboardDevice\(\) \{[\s\S]{0,420}?return isMobileViewport\(\) && isCoarsePointer\(\);/, `${label}: touch keyboard needs width`);
        assert.match(src, /function isMobileViewport\(\) \{\n\s+return !!window\.matchMedia\?\.\('\(max-width: 760px\)'\)\?\.matches;/, `${label}: mobile width`);
        assert.match(src, /function isMobileStableInputCandidate\(\)/, `${label}: candidate helper`);
        assert.match(src, /return isMobileViewport\(\) && \(/, `${label}: candidate requires width`);
        assert.match(src, /function usesExternalTerminalInput\(\) \{\n\s+return isMobileStableInputCandidate\(\);/, `${label}: external IME = mobile candidate`);
        assert.match(src, /if \(!event\.shiftKey && selection && !selection\.isCollapsed\) \{[\s\S]{0,180}?selection\.removeAllRanges\(\)/, `${label}: collapse leftover Range`);
        assert.match(src, /if \(event\.button !== 0\) return/, `${label}: primary button only`);
        assert.match(src, /event\.target\?\.closest\?\.\('a, button, input, textarea, select, \[contenteditable="true"\]'\)/, `${label}: ignore controls`);
        assert.match(src, /function armDesktopTerminalFocusIntent\(\)/, `${label}: re-focus after click`);
        assert.match(src, /const delays = \[0, 32, 80\]/, `${label}: finite re-focus window`);
        assert.match(src, /try \{ term\?\.focus\?\.\(\); \} catch \(_\) \{\}/, `${label}: native focus`);
        assert.doesNotMatch(src, /window\.setTimeout\(keepFocus, 120\)/, `${label}: no unbounded poll`);
        assert.doesNotMatch(src, /window\.setTimeout\(\(\) => \{\n\s+if \(hasLiveTerminalSelection\(\)\) return;\n\s+try \{ term\?\.focus\?\.\(\); \} catch \(_\) \{\}\n\s+\}, 0\);/, `${label}: no deferred focus-0`);
    }
    assert.match(terminalSrc, /actual gesture/);
});


test('mobile copy completion collapses native selection and explicitly resumes IME input', () => {
    for (const [label, src] of [['ssh', terminalSrc], ['telnet', telnetSrc]]) {
        assert.match(src, /function exitMobileTerminalSelectionMode/, `${label}: exit helper`);
        assert.match(src, /exitMobileTerminalSelectionMode\('copy-complete'/, `${label}: copy exit`);
        assert.match(src, /clearSelection:\s*true/, `${label}: clear selection`);
        assert.match(src, /refocus:\s*true/, `${label}: refocus`);
        assert.match(src, /selection\.removeAllRanges\(\)/, `${label}: collapse Range`);
        assert.match(src, /openTerminal\?\.\(`\$\{reason\}:resume-input`\)/, `${label}: reopen IME`);
    }
});

test('server resumes from canonical framebuffer and frame-coalesces live output', () => {
    assert.match(serverSrc, /createTerminalSnapshot/);
    assert.match(serverSrc, /terminalSnapshot:\s*createTerminalSnapshot/);
    assert.match(serverSrc, /terminalSnapshot\?\.serialize/);
    assert.match(serverSrc, /replayKind\s*=\s*'snapshot'/);
    assert.match(serverSrc, /broadcastSshOutputItems/);
    assert.match(serverSrc, /_sshOutputSequence/);
    assert.match(serverSrc, /SSH_OUTPUT_FRAME_MS/);
    for (const src of [terminalSrc, telnetSrc]) {
        assert.match(src, /writeTerminalData\(`\\x1bc\$\{msg\.data \|\| ''\}`\)/);
    }
});

test('renderer and bridge keep history scrolling incremental while re-evaluating cursor', () => {
    assert.match(bridgeSrc, /_pendingScrollDelta/);
    assert.match(bridgeSrc, /consumeViewportScrollDelta/);
    assert.match(bridgeSrc, /viewportRow = \(buf\.baseY \| 0\) \+ \(buf\.cursorY \| 0\) - \(buf\.viewportY \| 0\)/);
    assert.match(rendererSrc, /_recycleRowsForScroll/);
    assert.match(rendererSrc, /cursorNeedsPaint/);
    assert.match(wtermSrc, /One visual publication per animation frame/);
    assert.doesNotMatch(wtermSrc, /setTimeout\(\(\) => \{[\s\S]{0,240}?requestAnimationFrame/);
});
