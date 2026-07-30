import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');
function fn(name) {
  const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, `${name} missing`);
  const sigEnd = js.indexOf(') {', i); const b = js.indexOf('{', sigEnd); let d = 0;
  for (let j = b; j < js.length; j++) {
    if (js[j] === '{') d++;
    else if (js[j] === '}' && !--d) return js.slice(i, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
test('open uses engine springs: morph geometry + rotor rotateY -180', () => {
  const open = fn('playTerminalCardFlipOpen');
  assert.match(open, /Motion\.morph\(surface/);
  assert.match(open, /radiusCompensate:\s*true/);
  assert.match(open, /Motion\.to\(rotor, \{ rotateY:\s*-180 \}, \{ standard: S\.iosCardFlipOpen \}\)/);
  assert.match(open, /Motion\.set\(surface/);
  assert.doesNotMatch(open, /surface\.style\.transition\s*=\s*'transform\s*\.7s/);
  assert.doesNotMatch(open, /Motion\.iosCardOpen\(/);
});
test('close shrinks about center holding rotateY -180', () => {
  const close = fn('playTerminalCardFlipClose');
  assert.match(close, /sEnd\s*=\s*0\.01/);
  assert.match(close, /rotateY:\s*-180/);
  assert.match(close, /iosCardGeometryClose/);
  assert.doesNotMatch(close, /Motion\.iosCardClose\(/);
  assert.doesNotMatch(close, /rotateY:\s*0(?!\d)/);
});
test('true dual-face DOM/CSS: rotor + back rotateY(180deg) + backface-hidden', () => {
  assert.match(html, /data-terminal-card-rotor/);
  assert.match(html, /data-terminal-card-front/);
  assert.match(html, /data-terminal-card-back/);
  assert.match(css, /terminal-card-flip-back[\s\S]*transform:\s*rotateY\(180deg\)/);
  assert.match(css, /backface-visibility:\s*hidden/);
  assert.match(css, /perspective:\s*1400px/);
});
test('connect path uses openConnectionWithCardFlip + switchView close path', () => {
  assert.match(js, /async function openConnectionWithCardFlip/);
  assert.match(fn('openConnectionWithCardFlip'), /playTerminalCardFlipOpen/);
  assert.match(fn('openConnectionWithCardFlip'), /finishTerminalCardFlipOpenHandoff/);
  assert.match(fn('switchView'), /playTerminalCardFlipOpen/);
  assert.match(fn('switchView'), /playTerminalCardFlipClose/);
});
