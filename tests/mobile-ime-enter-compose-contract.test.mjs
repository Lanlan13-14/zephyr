import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

test('mobile IME enter + composition contract', async (t) => {
  await t.test('composition helpers present', () => {
    assert.match(terminalJs, /function clearStuckImeComposition/);
    assert.match(terminalJs, /function commitComposedImeText/);
    assert.match(terminalJs, /function isImeCompositionActive/);
  });
  await t.test('Enter flushes leftover only when not composing', () => {
    assert.match(terminalJs, /mobile-ime-enter-flush/);
    assert.match(terminalJs, /isImeCompositionActive\(e\)/);
  });
  await t.test('dedup after compositionend', () => {
    assert.match(terminalJs, /mobileImeComposeSuppressUntil/);
    assert.match(terminalJs, /mobileImeLastComposedText/);
  });
  await t.test('no custom composing paint class required', () => {
    assert.equal(terminalJs.includes("proxy.classList.add('composing')"), false);
  });
});
