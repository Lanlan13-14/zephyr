import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const html = read('index.html');
const main = read('src/main.js');
const css = read('src/styles/mirror-shell.css');

test('gate operations expose live status, alert failures, and busy state', () => {
  assert.match(html, /id="operationStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  for (const id of ['lockError', 'errorText', 'securityError']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="alert"[^>]*aria-atomic="true"`));
  }
  assert.equal((html.match(/class="gate[^>]*aria-busy="false"/g) || []).length, 4);
  assert.match(main, /function createOperationStatus\(\)/);
  assert.match(main, /gate\.setAttribute\('aria-busy', String\(busy\)\)/);
  assert.match(main, /const pending = new WeakMap\(\)/);
  assert.match(main, /if \(active\) return active/);
});

test('pending controls are stable and gate navigation moves keyboard focus', () => {
  assert.match(main, /control\.disabled = true/);
  assert.match(main, /control\.disabled = false/);
  assert.match(main, /control\.textContent = pendingLabel \|\| 'Working\.\.\.'/);
  assert.match(main, /function focusGate\(gate\)/);
  assert.match(main, /requestAnimationFrame\(\(\) => target\.focus\(\{ preventScroll: true \}\)\)/);
  assert.match(main, /focusGate\(el\)/);
  assert.match(main, /startAndEnter\(\$\('#retryBootBtn'\)\)/);
  assert.match(main, /pendingLabel: 'Testing\.\.\.'/);
});

test('gate surfaces scroll in short windows and retain accessible, restrained feedback', () => {
  assert.match(css, /\.gate \{[\s\S]*height: 100dvh;[\s\S]*overflow-y: auto;/);
  assert.match(css, /\.z-btn:focus-visible/);
  assert.match(css, /\.z-btn:disabled/);
  assert.match(css, /transition: transform 140ms cubic-bezier/);
  assert.match(css, /\.z-btn:active:not\(:disabled\)[\s\S]*transform: scale\(0\.98\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
});
