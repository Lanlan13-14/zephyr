import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const wtermJs = readFileSync(join(root, 'public/vendor/wterm-fork/wterm.js'), 'utf8');
const rendererJs = readFileSync(join(root, 'public/vendor/wterm-fork/renderer.js'), 'utf8');

describe('in-grid local draft + scroll sync', () => {
  it('draft is painted via setLocalDraft in wterm grid', () => {
    assert.match(terminalJs, /paintMobileLocalDraft/);
    assert.match(terminalJs, /setLocalDraft/);
    assert.match(wtermJs, /setLocalDraft/);
    assert.match(rendererJs, /_buildDraftOverlay|setLocalDraft/);
    assert.match(rendererJs, /_localDraft/);
    // no external bar activation as primary path
    assert.equal(terminalJs.includes("el.className = 'mobile-local-draft'"), false);
  });
  it('enter flushes draft once; multi-line paste into draft', () => {
    assert.match(terminalJs, /flushMobileLocalDraft\(source, \{ enter: true \}\)/);
    assert.match(terminalJs, /paste-draft/);
  });
  it('wheel goes to xterm ydisp only', () => {
    assert.match(wtermJs, /_wheelAccum/);
    assert.match(terminalJs, /virtualViewport/);
    assert.match(terminalJs, /bridge\.scrollLines/);
  });
});
