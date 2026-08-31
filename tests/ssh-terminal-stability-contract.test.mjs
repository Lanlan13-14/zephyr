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
    assert.match(terminalSrc, /_zephyrDesktopClickFocusBound = true/);
    assert.match(terminalSrc, /const focusFromDesktopGesture = \(event\) =>/);
    assert.match(terminalSrc, /event\.pointerType === 'touch' \|\| event\.pointerType === 'pen'/);
    assert.match(terminalSrc, /wtermWrapper\.addEventListener\('mousedown', focusFromDesktopGesture, true\)/);
    assert.match(terminalSrc, /function isTouchKeyboardDevice\(\) \{\n\s+return !!window\.matchMedia\?\.\('\(hover: none\) and \(pointer: coarse\)'\)\?\.matches;/);
    assert.match(terminalSrc, /function isMobileStableInputCandidate\(\)/);
    assert.match(terminalSrc, /function usesExternalTerminalInput\(\)/);
    assert.match(terminalSrc, /if \(hasLiveTerminalSelection\(\)\) \{[\s\S]{0,180}?window\.getSelection\?\.\(\)\?\.removeAllRanges\?\.\(\)/);
    assert.match(terminalSrc, /event\.target\?\.closest\?\.\('a, button, input, textarea, select, \[contenteditable="true"\]'\)/);
    assert.match(terminalSrc, /actual gesture/);
    assert.doesNotMatch(terminalSrc, /window\.setTimeout\(\(\) => \{\n\s+if \(hasLiveTerminalSelection\(\)\) return;\n\s+try \{ term\?\.focus\?\.\(\); \} catch \(_\) \{\}\n\s+\}, 0\);/);
    assert.match(terminalSrc, /try \{ term\?\.focus\?\.\(\); \} catch \(_\) \{\}/);
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
