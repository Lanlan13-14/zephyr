/**
 * Contract: XtermBridge implements TerminalCore against @xterm/headless,
 * with cell/flag encoding compatible with the wterm DOM renderer.
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

const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;
const DEFAULT_COLOR = 256;

describe('XtermBridge + @xterm/headless', () => {
  let XtermBridge;
  let setDefaultXtermTerminalCtor;
  let Terminal;

  before(async () => {
    const headless = require('@xterm/headless');
    Terminal = headless.Terminal || headless.default?.Terminal || headless.default;
    assert.equal(typeof Terminal, 'function', 'Terminal ctor');

    // Load the browser-vendored bridge (ESM, no @xterm import).
    const bridgeUrl = pathToFileURL(join(ROOT, 'public/vendor/wterm-fork/core/xterm-bridge.js')).href;
    const mod = await import(bridgeUrl);
    XtermBridge = mod.XtermBridge;
    setDefaultXtermTerminalCtor = mod.setDefaultXtermTerminalCtor;
    setDefaultXtermTerminalCtor(Terminal);
  });

  it('loads, writes plain text, exposes cells', async () => {
    const bridge = await XtermBridge.load({ cols: 40, rows: 10, scrollback: 200 });
    bridge.init(40, 10);
    bridge.writeString('hello');
    const c0 = bridge.getCell(0, 0);
    assert.equal(String.fromCodePoint(c0.char), 'h');
    const c4 = bridge.getCell(0, 4);
    assert.equal(String.fromCodePoint(c4.char), 'o');
    assert.equal(bridge.getCols(), 40);
    assert.equal(bridge.getRows(), 10);
    const cursor = bridge.getCursor();
    assert.equal(cursor.col, 5);
    assert.equal(cursor.row, 0);
    assert.equal(cursor.visible, true);
    bridge.dispose();
  });

  it('maps SGR bold/red palette colors to wterm flags', async () => {
    const bridge = await XtermBridge.load({ cols: 40, rows: 5, scrollback: 50 });
    bridge.init(40, 5);
    bridge.writeString('\x1b[1;31mX\x1b[0m');
    const cell = bridge.getCell(0, 0);
    assert.equal(String.fromCodePoint(cell.char), 'X');
    assert.ok(cell.flags & FLAG_BOLD, 'bold flag');
    assert.equal(cell.fg, 1, 'ANSI red palette index');
    assert.equal(cell.fgRgb, undefined);
    bridge.dispose();
  });

  it('maps truecolor RGB', async () => {
    const bridge = await XtermBridge.load({ cols: 40, rows: 5 });
    bridge.init(40, 5);
    bridge.writeString('\x1b[38;2;10;20;30mZ\x1b[0m');
    const cell = bridge.getCell(0, 0);
    assert.equal(String.fromCodePoint(cell.char), 'Z');
    assert.equal(cell.fgRgb, (10 << 16) | (20 << 8) | 30);
    assert.equal(cell.fg, DEFAULT_COLOR);
    bridge.dispose();
  });

  it('resize reflows without throwing and keeps content', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 6, scrollback: 100 });
    bridge.init(20, 6);
    bridge.writeString('abcdefghijklmnopqrstuvwxyz');
    bridge.resize(10, 6);
    assert.equal(bridge.getCols(), 10);
    assert.equal(bridge.getRows(), 6);
    // After reflow, first cell should still be 'a'
    const c0 = bridge.getCell(0, 0);
    assert.equal(String.fromCodePoint(c0.char), 'a');
    bridge.dispose();
  });

  it('tracks scrollback above the live viewport', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 4, scrollback: 100 });
    bridge.init(20, 4);
    for (let i = 0; i < 12; i++) {
      bridge.writeString(`line${i}\r\n`);
    }
    const sb = bridge.getScrollbackCount();
    assert.ok(sb > 0, `expected scrollback, got ${sb}`);
    // offset 0 = newest scrollback line (just above viewport)
    const newest = bridge.getScrollbackCell(0, 0);
    // We don't assert exact line text (depends on wrap), just non-empty or space
    assert.ok(typeof newest.char === 'number');
    bridge.dispose();
  });

  it('marks dirty rows and clears them', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 4 });
    bridge.init(20, 4);
    bridge.writeString('x');
    assert.equal(bridge.isDirtyRow(0), true);
    bridge.clearDirty();
    assert.equal(bridge.isDirtyRow(0), false);
    bridge.writeString('y');
    assert.equal(bridge.isDirtyRow(0), true);
    bridge.dispose();
  });

  it('reports modes after DECSET', async () => {
    const bridge = await XtermBridge.load({ cols: 20, rows: 4 });
    bridge.init(20, 4);
    assert.equal(bridge.cursorKeysApp(), false);
    bridge.writeString('\x1b[?1h'); // application cursor keys
    assert.equal(bridge.cursorKeysApp(), true);
    bridge.writeString('\x1b[?2004h');
    assert.equal(bridge.bracketedPaste(), true);
    bridge.writeString('\x1b[?1049h'); // alt screen
    assert.equal(bridge.usingAltScreen(), true);
    bridge.writeString('\x1b[?1049l');
    assert.equal(bridge.usingAltScreen(), false);
    bridge.dispose();
  });

  it('kind is xterm', async () => {
    const bridge = await XtermBridge.load({ cols: 10, rows: 4 });
    assert.equal(bridge.kind, 'xterm');
    bridge.dispose();
  });
});
