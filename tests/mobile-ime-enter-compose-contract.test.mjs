import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

test('mobile IME enter + stuck composition', async (t) => {
  await t.test('has stuck-composition clear + long CJK-safe watchdog', () => {
    assert.match(terminalJs, /function clearStuckImeComposition/);
    assert.match(terminalJs, /function armImeComposeWatchdog/);
    assert.match(terminalJs, /5000/);
    assert.match(terminalJs, /compose-watchdog-empty/);
  });

  await t.test('Enter does not steal keys during real composition', () => {
    assert.match(terminalJs, /isImeCompositionActive\(e\)/);
    // keydown returns early while composing
    assert.match(terminalJs, /if \(isImeCompositionActive\(e\)\) \{\s*armImeComposeWatchdog\(\);\s*return;/);
  });

  await t.test('composition commit is single-path with suppress (no kimikimi)', () => {
    assert.match(terminalJs, /function commitComposedImeText/);
    assert.match(terminalJs, /mobileImeComposeSuppressUntil/);
    assert.match(terminalJs, /mobileImeLastComposedText/);
    assert.match(terminalJs, /commitComposedImeText\(text, 'mobile-ime-composition'\)/);
    assert.match(terminalJs, /payload\.length > 1 \? 320 : 100/);
  });

  await t.test('composing proxy is visible via CSS', () => {
    assert.match(styleCss, /\.mobile-terminal-ime-proxy\.composing/);
  });

  await t.test('watchdog never auto-sends leftover pinyin', () => {
    assert.equal(terminalJs.includes("sendMobileStableImeText(leftover, 'mobile-ime-compose-watchdog')"), false);
  });
});
