import { test } from 'node:test';
import assert from 'node:assert/strict';

/* P1-1 regression test: resize must push TOP rows (not bottom) into scrollback.
 * Before the fix, shrinking pushed the bottom rows, leaving stale content
 * visible and corrupting scrollback order. This loads the built WASM directly
 * and verifies the reflow semantics. */

// The WASM bridge uses fetch/atob/WebAssembly which exist in Node 20.
// We import from the built vendor output.
const { WasmBridge } = await import(
    new URL('../public/vendor/wterm-fork/core/index.js', import.meta.url)
);

function rowText(bridge, row) {
    const cols = bridge.getCols();
    let s = '';
    for (let c = 0; c < cols; c++) {
        const cp = bridge.getCell(row, c).char;
        s += cp >= 32 ? String.fromCodePoint(cp) : ' ';
    }
    return s.trimEnd();
}

test('resize shrink pushes top rows into scrollback, keeps bottom visible', async () => {
    const bridge = await WasmBridge.load();
    bridge.init(4, 3); // 4 cols, 3 rows
    bridge.writeString('AAAA\r\nBBBB\r\nCCCC\r\nDDDD'); // 4 lines into 3-row terminal
    // After write: scrollback=[AAAA,BBBB], visible=[CCCC,DDDD,blank] -- wait,
    // 4 lines into 3 rows: AAAA pushed to scrollback, BBBB/CCCC/DDDD visible? No:
    // Line 1 AAAA -> row0, Line 2 BBBB -> row1, Line 3 CCCC -> row2,
    // Line 4 DDDD -> causes scroll: AAAA -> scrollback, BBBB->row0, CCCC->row1, DDDD->row2
    // So: scrollback=[AAAA], visible row0=BBBB, row1=CCCC, row2=DDDD
    assert.equal(bridge.getScrollbackCount(), 1);
    assert.equal(rowText(bridge, 0), 'BBBB');
    assert.equal(rowText(bridge, 1), 'CCCC');
    assert.equal(rowText(bridge, 2), 'DDDD');

    // Shrink to 2 rows: BBBB (top) should go to scrollback, CCCC/DDDD stay visible
    bridge.resize(4, 2);
    assert.equal(bridge.getScrollbackCount(), 2);
    assert.equal(rowText(bridge, 0), 'CCCC', 'row0 after shrink should be CCCC (was row1)');
    assert.equal(rowText(bridge, 1), 'DDDD', 'row1 after shrink should be DDDD (was row2, bottom stays)');

    // scrollback[0] = most recent = BBBB (the row that just scrolled out)
    const sb0 = bridge.getScrollbackCell(0, 0);
    assert.equal(String.fromCodePoint(sb0.char), 'B', 'scrollback[0] should be BBBB (most recently scrolled out)');
    // scrollback[1] = older = AAAA
    const sb1 = bridge.getScrollbackCell(1, 0);
    assert.equal(String.fromCodePoint(sb1.char), 'A', 'scrollback[1] should be AAAA (older)');
});

test('resize grow exposes new blank rows at the bottom', async () => {
    const bridge = await WasmBridge.load();
    bridge.init(4, 2);
    bridge.writeString('AAAA\r\nBBBB');
    assert.equal(rowText(bridge, 0), 'AAAA');
    assert.equal(rowText(bridge, 1), 'BBBB');

    // Grow to 4 rows: existing content stays, new rows are blank
    bridge.resize(4, 4);
    assert.equal(bridge.getRows(), 4);
    assert.equal(rowText(bridge, 0), 'AAAA');
    assert.equal(rowText(bridge, 1), 'BBBB');
    assert.equal(rowText(bridge, 2), '', 'new row 2 should be blank');
    assert.equal(rowText(bridge, 3), '', 'new row 3 should be blank');
});

test('resize does not corrupt scrollback when growing', async () => {
    const bridge = await WasmBridge.load();
    bridge.init(4, 2);
    bridge.writeString('AAAA\r\nBBBB\r\nCCCC\r\nDDDD');
    // scrollback=[AAAA,BBBB], visible=[CCCC,DDDD]
    assert.equal(bridge.getScrollbackCount(), 2);

    // Grow to 4 rows: scrollback should be unaffected
    bridge.resize(4, 4);
    assert.equal(bridge.getScrollbackCount(), 2, 'scrollback count unchanged on grow');
    assert.equal(rowText(bridge, 0), 'CCCC');
    assert.equal(rowText(bridge, 1), 'DDDD');
});
