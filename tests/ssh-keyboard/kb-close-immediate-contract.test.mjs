import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const intentJs = readFileSync(join(root, 'public/ssh-keyboard/intent.js'), 'utf8');
describe('keyboard close collapses shell immediately', () => {
  it('has force-clear and does not ignore parent close when focus sticky', () => {
    assert.match(terminalJs, /function forceClearSshKbShell/);
    assert.match(terminalJs, /facade-physical-zero/);
    assert.match(terminalJs, /parent-physical-close/);
    assert.equal(terminalJs.includes('parent-layout-close-ignored-ime-alive'), false);
    // close path must not be blocked by 400ms parent-fresh hold
    assert.equal(/Ignore non-parent closes for 400ms/.test(terminalJs), false);
  });
  it('faster system-dismiss confirm', () => {
    assert.match(intentJs, /dismissConfirmMs:\s*220/);
  });
  it('finalize always clears shell', () => {
    assert.match(terminalJs, /forceClearSshKbShell\(force \? 'finalize-force' : 'finalize'\)/);
  });
});
