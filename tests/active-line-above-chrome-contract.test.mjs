import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(root,'public/terminal.js'),'utf8');
const css = readFileSync(join(root,'public/style.css'),'utf8');
describe('last content line stays above tools', () => {
  it('anchors on last content-bearing row', () => {
    assert.match(js, /getLastContentLineBottomY/);
    assert.match(js, /last-content-above-tools/);
    assert.match(js, /term-row:not\(\.term-scrollback-row\)/);
    assert.match(js, /ensureActiveLineAboveChrome/);
    assert.match(js, /--term-active-line-shift/);
  });
  it('css bottom-aligns clipped grid', () => {
    assert.match(css, /justify-content:\s*flex-end/);
    assert.match(css, /--term-active-line-shift/);
  });
});
