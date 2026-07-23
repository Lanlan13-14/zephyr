/**
 * History scroll must NOT markAllDirty every line — only edge rows after recycle.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

const bridgeSrc = fs.readFileSync(join(ROOT, 'public/vendor/wterm-fork/core/xterm-bridge.js'), 'utf8');
const rendererSrc = fs.readFileSync(join(ROOT, 'public/vendor/wterm-fork/renderer.js'), 'utf8');
const terminalSrc = fs.readFileSync(join(ROOT, 'public/terminal.js'), 'utf8');

describe('history scroll perf contract', () => {
  let XtermBridge;
  let Terminal;

  before(async () => {
    const headless = require('@xterm/headless');
    Terminal = headless.Terminal || headless.default?.Terminal || headless.default;
    const mod = await import(pathToFileURL(join(ROOT, 'public/vendor/wterm-fork/core/xterm-bridge.js')).href);
    XtermBridge = mod.XtermBridge;
    mod.setDefaultXtermTerminalCtor(Terminal);
  });

  it('source: scroll path uses pending delta not markAllDirty-only', () => {
    assert.match(bridgeSrc, /_pendingScrollDelta/);
    assert.match(bridgeSrc, /_noteViewportScroll/);
    assert.match(bridgeSrc, /consumeViewportScrollDelta/);
    assert.match(bridgeSrc, /_scrollSuppressDirty/);
    // onScroll must not always markAllDirty
    assert.match(bridgeSrc, /if \(this\._scrollSuppressDirty\) return/);
    assert.match(rendererSrc, /_recycleRowsForScroll/);
    assert.match(terminalSrc, /_historyScrollUiRaf|_flushHistoryScrollUi/);
  });

  it('scrollLines(-1) does not mark every row dirty; pending delta is -1', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 8, scrollback: 200 });
    bridge.init(20, 8);
    for (let i = 0; i < 30; i++) bridge.writeString(`line${String(i).padStart(2, '0')}\r\n`);
    bridge.clearDirty();
    assert.equal(bridge.isDirtyRow(0), false);
    bridge.scrollLines(-1);
    assert.equal(bridge.isAtBottom(), false);
    // Full markAllDirty would make every row dirty; edge-only keeps middle clean
    // after a single-line history step (pending delta absorbed into edge dirty).
    const dirtyCount = [];
    for (let r = 0; r < 8; r++) if (bridge.isDirtyRow(r)) dirtyCount.push(r);
    assert.ok(dirtyCount.length < 8, `expected edge dirty only, got ${dirtyCount}`);
    assert.ok(dirtyCount.includes(0), 'top edge dirty when scrolling into history');
    assert.equal(bridge.consumeViewportScrollDelta(), -1);
    // Second consume is 0
    assert.equal(bridge.consumeViewportScrollDelta(), 0);
    bridge.dispose();
  });

  it('getCell returns live object fields usable for successive columns', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 4, scrollback: 50 });
    bridge.init(20, 4);
    bridge.writeString('abcd');
    // Capture fields immediately (zero-copy contract)
    const a = bridge.getCell(0, 0).char;
    const b = bridge.getCell(0, 1).char;
    const c = bridge.getCell(0, 2).char;
    assert.equal(String.fromCodePoint(a), 'a');
    assert.equal(String.fromCodePoint(b), 'b');
    assert.equal(String.fromCodePoint(c), 'c');
    bridge.dispose();
  });

  it('host does not double-drive wheel when event is inside .wterm', () => {
    assert.match(terminalSrc, /fromWtermEl/);
    assert.match(terminalSrc, /do not double-scroll|wterm owns this path/i);
  });

  it('touch pan prefers single pointer path', () => {
    assert.match(terminalSrc, /usePointer/);
    assert.match(terminalSrc, /Prefer PointerEvent|dual touch\+pointer/i);
  });
});
