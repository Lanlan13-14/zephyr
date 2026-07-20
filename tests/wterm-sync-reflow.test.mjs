import { test } from 'node:test';
import assert from 'node:assert/strict';

const { WasmBridge } = await import(
  new URL('../public/vendor/wterm-fork/core/index.js', import.meta.url)
);

function gridLines(bridge) {
  const lines = [];
  for (let row = 0; row < bridge.getRows(); row++) {
    let text = '';
    for (let col = 0; col < bridge.getCols(); col++) {
      const cell = bridge.getCell(row, col);
      if (cell.wide === 2) continue;
      text += cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
    }
    lines.push(text.trimEnd());
  }
  return lines;
}

test('DECSET 2026 exposes synchronized output state', async () => {
  const bridge = await WasmBridge.load();
  bridge.init(80, 24);
  assert.equal(bridge.syncOutput(), false);
  bridge.writeString('\x1b[?2026h');
  assert.equal(bridge.syncOutput(), true);
  bridge.writeString('buffered frame');
  assert.equal(bridge.getCell(0, 0).char, 'b'.codePointAt(0));
  bridge.writeString('\x1b[?2026l');
  assert.equal(bridge.syncOutput(), false);
});

test('width shrink and grow reflows automatic wraps bidirectionally', async () => {
  const bridge = await WasmBridge.load();
  bridge.init(10, 4);
  bridge.writeString('ABCDEFGHIJKLMNO');
  assert.deepEqual(gridLines(bridge).slice(0, 2), ['ABCDEFGHIJ', 'KLMNO']);
  bridge.resize(5, 4);
  assert.deepEqual(gridLines(bridge).slice(0, 2), ['FGHIJ', 'KLMNO']);
  assert.equal(String.fromCodePoint(bridge.getScrollbackCell(0, 0).char), 'A');
  bridge.resize(10, 4);
  assert.deepEqual(gridLines(bridge).slice(0, 2), ['ABCDEFGHIJ', 'KLMNO']);
  assert.deepEqual(bridge.getCursor(), { row: 1, col: 5, visible: true, style: 0 });
});

test('width reflow preserves explicit CRLF boundaries', async () => {
  const bridge = await WasmBridge.load();
  bridge.init(5, 4);
  bridge.writeString('ABCDE\r\nFGHIJ');
  bridge.resize(10, 4);
  assert.deepEqual(gridLines(bridge).slice(0, 2), ['ABCDE', 'FGHIJ']);
});

test('width reflow preserves CJK lead/continuation pairs', async () => {
  const bridge = await WasmBridge.load();
  bridge.init(8, 4);
  bridge.writeString('甲乙丙丁戊');
  bridge.resize(4, 4);
  bridge.resize(8, 4);
  assert.deepEqual(gridLines(bridge).slice(0, 2), ['甲乙丙丁', '戊']);
  for (let row = 0; row < bridge.getRows(); row++) {
    for (let col = 0; col < bridge.getCols(); col++) {
      const cell = bridge.getCell(row, col);
      if (cell.wide === 1) {
        assert.ok(col + 1 < bridge.getCols());
        assert.equal(bridge.getCell(row, col + 1).wide, 2);
      }
    }
  }
});
