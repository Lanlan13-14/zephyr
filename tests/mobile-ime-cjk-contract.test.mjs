import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('composition active helper exists', () => {
  assert.match(terminalJs, /function isImeCompositionActive/);
  assert.match(terminalJs, /keyCode === 229|key === 'Process'/);
});

test('keydown does not intercept controls while composing', () => {
  assert.match(terminalJs, /if \(isImeCompositionActive\(e\)\) \{\s*armImeComposeWatchdog\(\);\s*return;/);
});

test('beforeinput lets composition-owned types through', () => {
  assert.match(terminalJs, /insertCompositionText/);
  assert.match(terminalJs, /deleteCompositionText/);
});

test('compositionend commits e.data only (not leftover pinyin)', () => {
  assert.match(terminalJs, /commitComposedImeText\(text, 'mobile-ime-composition'\)/);
  assert.match(terminalJs, /\(e && e\.data != null\) \? String\(e\.data\) : ''/);
});

test('compositionupdate does not overwrite proxy.value', () => {
  // Writing value mid-compose kills Android 选词栏.
  assert.equal(/compositionupdate[\s\S]{0,400}proxy\.value\s*=/.test(terminalJs), false);
});

test('proxy host is large enough for CJK candidates', () => {
  assert.match(terminalJs, /fontSize = '16px'/);
  assert.match(terminalJs, /imeProxyComposeFreeze/);
  assert.match(styleCss, /font-size:\s*16px\s*!important/);
  assert.match(styleCss, /\.mobile-terminal-ime-proxy\.composing/);
  assert.match(styleCss, /min-width:\s*120px\s*!important/);
});

test('watchdog re-arms while focused (never kills 选词)', () => {
  assert.match(terminalJs, /Still focused — user may still be picking candidates/);
  assert.match(terminalJs, /8000/);
});
