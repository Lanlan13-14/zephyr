import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const terminalHtml = fs.readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');

test('notes toolbar icon is fully defined for desktop and mobile', () => {
  assert.match(styleCss, /data-mobile-icon="notes"\]\s*\{\s*--terminal-toolbar-icon:/);
  assert.match(styleCss, /data-mobile-icon="notes"\]\s*\{\s*--toolbar-icon-color:\s*#6b8e9e/);
  assert.match(styleCss, /data-mobile-icon="notes"\]\s*\{\s*--mobile-icon-color:\s*#6b8e9e/);
  assert.match(styleCss, /data-mobile-icon="notes"\]::before\s*\{\s*background:\s*#6b8e9e/);
  assert.match(terminalHtml, /id="notesBtn"[^>]*data-mobile-icon="notes"/);
});

test('notes button is gated by notes.enabled and hidden when off', () => {
  assert.match(appJs, /function isNotesEnabled\(\)/);
  assert.match(appJs, /type:\s*'notes-enabled'/);
  assert.match(appJs, /broadcastNotesEnabled/);
  assert.match(terminalJs, /function applyNotesFeatureEnabled/);
  assert.match(terminalJs, /classList\.toggle\('force-hidden',\s*!notesFeatureEnabled\)/);
  assert.match(terminalJs, /type === 'notes-enabled'/);
  assert.match(terminalJs, /\/api\/me\/settings/);
});

test('stable mobile keyboard no longer shrinks the parent workspace height', () => {
  const start = appJs.indexOf('if (isStableInput && isCompact)');
  assert.ok(start > 0, 'stable-input branch missing');
  const end = appJs.indexOf('if (!keyboardOpen || !isFullscreenTerminalSurface)', start);
  const body = appJs.slice(start, end);
  assert.doesNotMatch(body, /workspace\.style\.height = isFullscreenTerminalSurface \? `\$\{usableHeight\}px`/);
  assert.doesNotMatch(body, /\busableHeight\b/);
  assert.match(body, /fullHeight/);
  assert.match(body, /parent-keyboard-stable-overlay-open/);
  assert.match(body, /--app-keyboard-shift',\s*'0px'/);
  assert.match(body, /workspace\.style\.height = `\$\{fullHeight\}px`/);
});
