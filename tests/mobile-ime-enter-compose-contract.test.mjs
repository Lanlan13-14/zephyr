import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

test('mobile IME enter + composition contract', async (t) => {
  await t.test('composition helpers present', () => {
    assert.match(terminalJs, /function clearStuckImeComposition/);
    assert.match(terminalJs, /function commitComposedImeText/);
    assert.match(terminalJs, /function isImeCompositionActive/);
    assert.match(terminalJs, /function flushMobileImeEnter/);
    assert.match(terminalJs, /function imeTextAlreadySent/);
    assert.match(terminalJs, /function imeTextEqual/);
  });

  await t.test('stuck compose Enter unsticks and sends CR', () => {
    // keydown while composing must handle Enter (not only return).
    assert.match(
      terminalJs,
      /if \(isImeCompositionActive\(e\)\) \{[\s\S]*?e\.key === 'Enter'[\s\S]*?flushMobileImeEnter/,
    );
    assert.match(terminalJs, /flushMobileImeEnter\('mobile-ime-key:Enter'\)/);
    // Must not steal live 选词 Enter (isComposing / 229 / Process).
    assert.match(terminalJs, /liveCompose/);
    assert.match(
      terminalJs,
      /mobileImeComposing && !liveCompose/,
    );
  });

  await t.test('Enter flush is quiet (no chrome / bar fly)', () => {
    // clear on Enter path must be quiet so handleCompositionEnd is NOT published.
    assert.match(terminalJs, /clearStuckImeComposition\([^)]*quiet:\s*true/);
    assert.match(terminalJs, /quiet=true: clear local flags only|quiet clear|Quiet clear/i);
    // flush must NOT call handleCompositionEnd / applyFacadeChrome (comments ok).
    const flushBody = terminalJs.match(
      /function flushMobileImeEnter[\s\S]*?^function\s+\w+/m,
    )?.[0] || '';
    assert.ok(flushBody, 'flushMobileImeEnter body extractable');
    const withoutComments = flushBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.equal(withoutComments.includes('handleCompositionEnd'), false);
    assert.equal(withoutComments.includes('applyFacadeChrome'), false);
    // Must use quiet clear only.
    assert.match(flushBody, /quiet:\s*true/);
  });

  await t.test('case-insensitive dedup prevents kimikimi', () => {
    assert.match(terminalJs, /toLowerCase\(\)/);
    assert.match(terminalJs, /imeTextEqual/);
    assert.match(terminalJs, /imeTextAlreadySent/);
    // compositionend after Enter is swallowed for a window.
    assert.match(terminalJs, /mobileImeEnterSuppressCompositionEndUntil/);
    assert.match(terminalJs, /post-enter-suppress|ime-compose-end-swallowed/);
    // Progressive English first-word: lineAcc + leftover delta (not full re-send).
    assert.match(terminalJs, /mobileImeLineAcc/);
    assert.match(terminalJs, /function imeLeftoverDelta/);
    assert.match(terminalJs, /function imeLineAccNoteSent/);
  });

  await t.test('beforeinput insertLineBreak uses same flush path', () => {
    assert.match(
      terminalJs,
      /insertLineBreak[\s\S]{0,200}flushMobileImeEnter/,
    );
  });

  await t.test('no custom composing paint class required', () => {
    assert.equal(terminalJs.includes("proxy.classList.add('composing')"), false);
  });
});
