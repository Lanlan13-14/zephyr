/**
 * Parent must never invent provisional keyboard crop heights.
 * Fake 32%/260–360 crop caused tools to fly up ~1s then drop to real height.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const terminalJs = fs.readFileSync(path.join(root, 'public/terminal.js'), 'utf8');

test('parent has no provisional 0.32 / 260–360 invent path', () => {
  assert.equal(appJs.includes("heightSource = 'provisional'"), false);
  assert.equal(appJs.includes('layoutHeight * 0.32'), false);
  assert.equal(appJs.includes('Math.max(260, layoutHeight'), false);
  assert.match(appJs, /await-physical/);
  assert.match(appJs, /sshKbParentAwaiting/);
});

test('parent crop threshold is 80 not 64 for open', () => {
  // keyboardOpen requires real height
  assert.match(appJs, /childOpen && effectiveInset >= 80/);
});

test('child getEstimatedKeyboardInset does not invent 0.33 ratio', () => {
  assert.equal(terminalJs.includes('baseline * 0.33'), false);
  assert.equal(terminalJs.includes('base * 0.34'), false);
  assert.match(terminalJs, /return 0;/);
});

test('child keyboard-overlap does not fall back to fake keyboard height', () => {
  // Only check keyboard-related fallbacks (not menuWidth || 260 etc.).
  assert.equal(/parentInset\)\s*\|\|\s*280\b/.test(terminalJs), false);
  assert.equal(/shellH\)\s*\|\|\s*280\b/.test(terminalJs), false);
  assert.equal(/Number\(e\.data\.shellH\)\s*\|\|\s*280\b/.test(terminalJs), false);
  assert.match(terminalJs, /awaitingPhysical|await-physical/);
  assert.match(terminalJs, /no fake physical height|never invent|await-physical/);
});

test('child parent-layout does not re-apply parentInset as page height', () => {
  // The dangerous pattern: applyMobileStableKeyboardInset(parentInset, true, `parent-layout
  assert.equal(
    /applyMobileStableKeyboardInset\(parentInset,\s*true/.test(terminalJs),
    false,
  );
});
