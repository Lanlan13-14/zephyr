/**
 * Parent-shell-managed IME crop must never double-apply --ssh-kb-inset in the
 * child page. That double crop is what makes the bottom aux bar "fly" up when
 * the user taps ↑ / Ctrl after the keyboard is already open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const terminalJs = fs.readFileSync(path.join(root, 'public/terminal.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

test('sticky parent-shell flag exists and is set on parent-overlap open', () => {
  assert.match(terminalJs, /_sshKbParentShellManaged/);
  assert.match(terminalJs, /setSshKbParentShellManaged/);
  assert.match(terminalJs, /ssh-kb-parent-shell/);
  assert.match(
    terminalJs,
    /parentShellManaged[\s\S]{0,400}setSshKbParentShellManaged\(true/,
  );
});

test('writeSshKbPageGeometry forces inset 0 under parent shell', () => {
  assert.match(
    terminalJs,
    /function writeSshKbPageGeometry[\s\S]{0,900}_sshKbParentShellManaged[\s\S]{0,200}inset = 0/,
  );
});

test('applyFacadeChrome prefers sticky parent-shell over intent inset', () => {
  assert.match(
    terminalJs,
    /function applyFacadeChrome[\s\S]{0,2500}_sshKbParentShellManaged[\s\S]{0,400}writeSshKbPageGeometry\(0, true/,
  );
});

test('aux-key focus retain re-asserts parent-shell inset 0', () => {
  assert.match(
    terminalJs,
    /function keepMobileAuxImeFocused[\s\S]{0,900}_sshKbParentShellManaged[\s\S]{0,300}writeSshKbPageGeometry\(0, true/,
  );
});

test('CSS final lock keeps height 100% when parent-shell class is on', () => {
  assert.match(
    styleCss,
    /ssh-kb-parent-shell[\s\S]{0,200}height:\s*100%\s*!important/,
  );
});
