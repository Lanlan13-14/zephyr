import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

test('no settle thrash machinery (rolled back)', () => {
  assert.equal(appJs.includes('shouldApplyShellKeyboardTop'), false);
  assert.equal(appJs.includes('isShellKeyboardAnimating'), false);
  assert.equal(appJs.includes('SSH_KB_TOP_SETTLE_MS'), false);
});

test('still no provisional 0.32 crop', () => {
  assert.equal(appJs.includes('layoutHeight * 0.32'), false);
  assert.equal(appJs.includes("heightSource = 'provisional'"), false);
  assert.match(appJs, /await-physical/);
});

test('align loop uses mild 12px/100ms re-crop gate', () => {
  assert.match(appJs, /delta >= 12/);
  assert.match(appJs, /_sshKbAlignLastPost >= 100/);
});

test('close confirm is 280ms not 100ms', () => {
  assert.match(appJs, /sshKbParentLowSince >= 280/);
});

test('child ignores parent close while proxy focused', () => {
  assert.match(terminalJs, /awaitingPhysical \|\| \(kb\?\.desiredOpen\?\.\(\) && proxyFocused\)/);
});
