import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const css = readFileSync(join(root, 'public/style.css'), 'utf8');
describe('xterm history scroll (no black slab)', () => {
  it('uses ydisp metrics not DOM scrollTop', () => {
    assert.match(js, /getXtermHistoryMetrics/);
    assert.match(js, /scrollTerminalHistoryLines/);
    assert.match(js, /touch-pan/);
    assert.match(js, /ybase - ydisp|rowsAbove/);
  });
  it('does not flex-end black void on mobile xterm viewport', () => {
    // the bad rule must not apply to xterm-viewport
    assert.ok(!/html\.mobile-stable-input \.wterm\.xterm-viewport[\s\S]{0,200}justify-content:\s*flex-end/.test(css));
    assert.match(css, /touch-action:\s*none/);
  });
  it('clears active-line shift while reading history', () => {
    assert.match(js, /Reading history \(ydisp < ybase\): NEVER lift/);
  });
});
