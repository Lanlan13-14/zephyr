import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WasmBridge } from '../public/vendor/wterm-fork/core/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DECCOLM toggles 132 columns and homes cursor', async () => {
  const b = await WasmBridge.load();
  b.init(80, 24);
  b.writeString('hello');
  b.writeString('\x1b[?3h');
  assert.equal(b.getCols(), 132);
  assert.equal(b.column132(), true);
  assert.equal(b.getCursor().row, 0);
  assert.equal(b.getCursor().col, 0);
  // cleared
  assert.equal(b.getCell(0, 0).char, 32);
  b.writeString('\x1b[?3l');
  assert.equal(b.column132(), false);
  assert.equal(b.getCols(), 80);
});

test('reverse-wraparound allows backspace onto previous line', async () => {
  const b = await WasmBridge.load();
  b.init(5, 4);
  b.writeString('\x1b[?7h\x1b[?45h');
  b.writeString('ABCDE'); // wrap pending at end of first line
  b.writeString('F'); // goes to next line
  assert.equal(b.getCursor().row, 1);
  assert.equal(b.getCursor().col, 1);
  b.writeString('\x08\x08'); // reverse wrap back onto previous line
  assert.equal(b.getCursor().row, 0);
  assert.equal(b.getCursor().col, 4);
  assert.equal(b.reverseWrap(), true);
});

test('mouse alt-scroll and OSC 12 are exposed', async () => {
  const b = await WasmBridge.load();
  b.init(80, 24);
  b.writeString('\x1b[?1007h');
  assert.equal(b.mouseAltScroll(), true);
  b.writeString('\x1b[?1007l');
  assert.equal(b.mouseAltScroll(), false);
  b.writeString('\x1b]12;#ff0000\x07');
  const changes = b.takeColorChanges();
  assert.ok(changes.some((c) => c.kind === 12 && c.value.toLowerCase() === '#ff0000'));
});

test('selection and search APIs exist on WTerm', () => {
  const src = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');
  assert.match(src, /getSelectionText\(\): string/);
  assert.match(src, /selectAll\(\): void/);
  assert.match(src, /findMatches\(/);
  assert.match(src, /selectMatch\(/);
  assert.match(src, /clearSelection\(\): void/);
});
