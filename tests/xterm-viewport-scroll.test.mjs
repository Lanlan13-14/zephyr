/**
 * Scroll is owned by xterm (ydisp/ybase). DOM only paints the current viewport.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

describe('xterm-owned viewport scroll', () => {
  let XtermBridge;
  let setDefaultXtermTerminalCtor;
  let Terminal;

  before(async () => {
    const headless = require('@xterm/headless');
    Terminal = headless.Terminal || headless.default?.Terminal || headless.default;
    const mod = await import(pathToFileURL(join(ROOT, 'public/vendor/wterm-fork/core/xterm-bridge.js')).href);
    XtermBridge = mod.XtermBridge;
    setDefaultXtermTerminalCtor = mod.setDefaultXtermTerminalCtor;
    setDefaultXtermTerminalCtor(Terminal);
  });

  it('getCell reads ydisp window not baseY when scrolled up', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 5, scrollback: 100 });
    bridge.init(20, 5);
    for (let i = 0; i < 20; i++) bridge.writeString(`line${String(i).padStart(2, '0')}\r\n`);
    assert.equal(bridge.isAtBottom(), true);
    const readRow0 = () => {
      let s = '';
      for (let c = 0; c < 6; c++) {
        const ch = bridge.getCell(0, c).char;
        s += ch >= 32 ? String.fromCodePoint(ch) : ' ';
      }
      return s;
    };
    const bottomFirst = readRow0();
    const yBottom = bridge.getViewportY();
    // scroll up 3 rows
    bridge.scrollLines(-3);
    assert.equal(bridge.isAtBottom(), false);
    assert.ok(bridge.getViewportY() < bridge.getBaseY());
    assert.equal(bridge.getViewportY(), yBottom - 3);
    const upFirst = readRow0();
    assert.notEqual(upFirst, bottomFirst, `viewport row0 must change after scroll up (${upFirst} vs ${bottomFirst})`);
    bridge.scrollToBottom();
    assert.equal(bridge.isAtBottom(), true);
    assert.equal(readRow0(), bottomFirst);
    bridge.dispose();
  });
 
  it('write while at bottom advances ydisp with ybase (stick bottom)', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 5, scrollback: 100 });
    bridge.init(20, 5);
    for (let i = 0; i < 10; i++) bridge.writeString(`L${i}\r\n`);
    const y0 = bridge.getViewportY();
    const b0 = bridge.getBaseY();
    assert.equal(y0, b0);
    bridge.writeString('MORE\r\n');
    assert.equal(bridge.getViewportY(), bridge.getBaseY());
    assert.ok(bridge.getBaseY() > b0);
    bridge.dispose();
  });

  it('write while scrolled up does not force stick bottom', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 5, scrollback: 100 });
    bridge.init(20, 5);
    for (let i = 0; i < 15; i++) bridge.writeString(`R${i}\r\n`);
    bridge.scrollLines(-4);
    const ydisp = bridge.getViewportY();
    const base = bridge.getBaseY();
    assert.ok(ydisp < base);
    bridge.writeString('PINNED\r\n');
    // xterm keeps ydisp when user scrolled up
    assert.equal(bridge.getViewportY(), ydisp);
    assert.ok(bridge.getBaseY() > base);
    assert.equal(bridge.isAtBottom(), false);
    bridge.dispose();
  });

  it('virtualViewport flag is set; getScrollbackCount still available for tools', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 4, scrollback: 50 });
    bridge.init(20, 4);
    for (let i = 0; i < 12; i++) bridge.writeString(`S${i}\r\n`);
    assert.equal(bridge.virtualViewport, true);
    assert.equal(bridge.kind, 'xterm');
    assert.ok(bridge.getScrollbackCount() > 0);
    bridge.dispose();
  });
});
