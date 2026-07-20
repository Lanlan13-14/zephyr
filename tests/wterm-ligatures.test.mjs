import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ligatures are opt-in via WTerm API and CSS class', () => {
  const wtermTs = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/wterm.ts'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'wterm/packages/@wterm/dom/src/terminal.css'), 'utf8');
  const terminalJs = fs.readFileSync(path.join(root, 'public/terminal.js'), 'utf8');
  const appHtml = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
  const storage = fs.readFileSync(path.join(root, 'storage.js'), 'utf8');

  assert.match(wtermTs, /allowLigatures\?: boolean/);
  assert.match(wtermTs, /setLigatures\(enabled: boolean\): void/);
  assert.match(wtermTs, /classList\.toggle\("allow-ligatures"/);

  assert.match(css, /font-variant-ligatures:\s*none/);
  assert.match(css, /\.wterm\.allow-ligatures/);
  assert.match(css, /font-feature-settings:\s*"liga" 1/);

  assert.match(terminalJs, /allowLigatures:\s*getTerminalAllowLigatures\(\)/);
  assert.match(terminalJs, /function applyTerminalLigatures/);
  assert.match(terminalJs, /type === 'terminal-settings'/);

  assert.match(appHtml, /id="terminalAllowLigatures"/);
  assert.match(storage, /allowLigatures:\s*false/);
});
