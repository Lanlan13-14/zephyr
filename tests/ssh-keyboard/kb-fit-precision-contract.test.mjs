import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const app = readFileSync(join(root,'public/app.js'),'utf8');
const term = readFileSync(join(root,'public/terminal.js'),'utf8');
describe('keyboard height precision + close', () => {
  it('parent prefers live VV height not sticky invent', () => {
    assert.match(app, /sshKbParentLastGoodInset/);
    assert.match(app, /parent-vv-prefer|heightSource/);
    assert.match(app, /parentInset >= 80/);
    // no permanent baseline*0.34 as only height when VV is live
    assert.match(app, /provisional/);
  });
  it('child quantizes to 4px and force-clears on close', () => {
    assert.match(term, /pinInset \/ 4/);
    assert.match(term, /forceClearSshKbShell/);
    assert.match(term, /parent-overlap:\$\{e\.data\.reason/);
  });
});
