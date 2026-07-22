import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('IME host is plain invisible textarea (no custom compose UI)', () => {
  assert.match(terminalJs, /No custom compose UI|plain browser textarea|system IME owns/i);
  assert.match(styleCss, /opacity:\s*0/);
  // No visible custom compose paint
  assert.equal(styleCss.includes('.mobile-terminal-ime-proxy.composing'), false);
});

test('keydown leaves composition keys to OS IME', () => {
  assert.match(terminalJs, /if \(isImeCompositionActive\(e\)\) \{[\s\S]*?return; \/\/ system IME handles candidate confirm/);
});

test('beforeinput never steals insertText (拼音 stays in field)', () => {
  assert.match(terminalJs, /Do NOT preventDefault insertText|browser keeps the text|insertCompositionText/);
  assert.match(terminalJs, /type === 'insertText'/);
});

test('compositionend is the only CJK commit path', () => {
  assert.match(terminalJs, /commitComposedImeText\(text, 'mobile-ime-composition'\)/);
  assert.match(terminalJs, /\(e && e\.data != null\) \? String\(e\.data\) : ''/);
});

test('composition commit sends before arming suppress (no self-drop)', () => {
  // Regression: setting mobileImeLastComposedText BEFORE sendData made the
  // first 你好 disappear (dedup ate the real commit).
  assert.match(terminalJs, /send FIRST, then arm suppress|forceImmediate: true/);
  assert.match(terminalJs, /sendMobileStableImeText\(payload, source, \{ forceImmediate: true \}\)/);
});

test('compositionupdate does not write proxy.value', () => {
  assert.equal(/compositionupdate[\s\S]{0,300}proxy\.value\s*=/.test(terminalJs), false);
});

test('fontSize 16px host for OS IME', () => {
  assert.match(terminalJs, /fontSize = '16px'/);
  assert.match(styleCss, /font-size:\s*16px\s*!important/);
});
