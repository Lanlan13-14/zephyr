import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmBridge } from '../public/vendor/wterm-fork/core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cellChar(bridge, row, col) {
  const ch = bridge.getCell(row, col).char || 32;
  return String.fromCodePoint(ch >= 32 && ch <= 0x10ffff ? ch : 32);
}

test('IRM inserts characters instead of overwriting', async () => {
  const b = await WasmBridge.load();
  b.init(20, 4);
  b.writeString('ABC');
  b.writeString('\x1b[1G'); // col 1
  b.writeString('\x1b[4h'); // IRM on
  b.writeString('X');
  assert.equal(cellChar(b, 0, 0), 'X');
  assert.equal(cellChar(b, 0, 1), 'A');
  assert.equal(cellChar(b, 0, 2), 'B');
  assert.equal(cellChar(b, 0, 3), 'C');
  assert.equal(b.insertMode(), true);
  b.writeString('\x1b[4l');
  assert.equal(b.insertMode(), false);
});

test('application keypad mode is exposed and DECKPAM/DECKPNM toggle it', async () => {
  const b = await WasmBridge.load();
  b.init(20, 4);
  assert.equal(b.keypadApp(), false);
  b.writeString('\x1b=');
  assert.equal(b.keypadApp(), true);
  b.writeString('\x1b>');
  assert.equal(b.keypadApp(), false);
});

test('alt screen private modes still work after ANSI mode split', async () => {
  const b = await WasmBridge.load();
  b.init(20, 4);
  b.writeString('main');
  b.writeString('\x1b[?1049h');
  assert.equal(b.usingAltScreen(), true);
  // cell should be blank after entering alt
  assert.equal(cellChar(b, 0, 0), ' ');
  b.writeString('alt');
  b.writeString('\x1b[?1049l');
  assert.equal(cellChar(b, 0, 0), 'm');
});

test('canvas renderer is available as an opt-in backend', () => {
  const wtermTs = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');
  const indexTs = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/index.ts'), 'utf8');
  const canvas = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/canvas-renderer.ts'), 'utf8');
  assert.match(wtermTs, /renderer\?: "dom" \| "canvas"/);
  assert.match(wtermTs, /new CanvasRenderer/);
  assert.match(indexTs, /CanvasRenderer/);
  assert.match(canvas, /export class CanvasRenderer/);
  assert.match(canvas, /getContext\("2d"/);
});
