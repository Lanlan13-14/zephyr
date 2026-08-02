import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnetJs = fs.readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const rdpJs = fs.readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const novncJs = fs.readFileSync(new URL('../public/novnc.js', import.meta.url), 'utf8');
const styleCss = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const terminalHtml = fs.readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');
const telnetHtml = fs.readFileSync(new URL('../public/telnet-terminal.html', import.meta.url), 'utf8');
const rdpHtml = fs.readFileSync(new URL('../public/rdp.html', import.meta.url), 'utf8');
const novncHtml = fs.readFileSync(new URL('../public/novnc.html', import.meta.url), 'utf8');

const NOTES_ICON_SVG = "M5 3h10l4 4v14H5V3zm9 1.5V8h3.5L14 4.5zM7 6h5v2H7V6zm0 4h10v2H7v-2zm0 4h10v2H7v-2zm0 4h7v2H7v-2z";

test('notes toolbar icon is fully defined for desktop and mobile', () => {
  assert.match(styleCss, /data-mobile-icon="notes"\]\s*\{\s*--terminal-toolbar-icon:/);
  assert.match(styleCss, /data-mobile-icon="notes"\]\s*\{\s*--toolbar-icon-color:\s*#6b8e9e/);
  assert.match(styleCss, /data-mobile-icon="notes"\]\s*\{\s*--mobile-icon-color:\s*#6b8e9e/);
  assert.match(styleCss, /data-mobile-icon="notes"\]::before\s*\{\s*background:\s*#6b8e9e/);
  assert.match(terminalHtml, /id="notesBtn"[^>]*data-mobile-icon="notes"/);
  assert.match(telnetHtml, /id="notesBtn"[^>]*data-mobile-icon="notes"/);
  assert.match(styleCss, new RegExp(NOTES_ICON_SVG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('RDP and VNC notes buttons use the same document icon as SSH/Telnet', () => {
  assert.match(rdpHtml, /id="notesBtn"[^>]*data-rdp-icon="notes"/);
  assert.match(novncHtml, /id="notesBtn"[^>]*data-vnc-icon="notes"/);
  assert.match(
    styleCss,
    /data-rdp-icon="notes"\]\s*\{\s*--rdp-toolbar-icon-color:\s*#6b8e9e;\s*--rdp-toolbar-icon:\s*url\("data:image\/svg\+xml,%3Csvg[^"]*M5 3h10l4 4v14H5V3/
  );
  assert.match(
    styleCss,
    /data-vnc-icon="notes"\]\s*\{\s*--vnc-toolbar-icon-color:\s*#6b8e9e;\s*--vnc-toolbar-icon:\s*url\("data:image\/svg\+xml,%3Csvg[^"]*M5 3h10l4 4v14H5V3/
  );
  // Same glyph as SSH terminal notes icon.
  const sshNotesIcon = styleCss.match(/data-mobile-icon="notes"\]\s*\{\s*--terminal-toolbar-icon:\s*url\("([^"]+)"\)/);
  const rdpNotesIcon = styleCss.match(/data-rdp-icon="notes"\]\s*\{\s*--rdp-toolbar-icon-color:\s*#6b8e9e;\s*--rdp-toolbar-icon:\s*url\("([^"]+)"\)/);
  const vncNotesIcon = styleCss.match(/data-vnc-icon="notes"\]\s*\{\s*--vnc-toolbar-icon-color:\s*#6b8e9e;\s*--vnc-toolbar-icon:\s*url\("([^"]+)"\)/);
  assert.ok(sshNotesIcon?.[1], 'ssh notes icon missing');
  assert.equal(rdpNotesIcon?.[1], sshNotesIcon[1], 'RDP notes icon must match SSH');
  assert.equal(vncNotesIcon?.[1], sshNotesIcon[1], 'VNC notes icon must match SSH');
});

test('notes button is gated by notes.enabled and hidden when off', () => {
  assert.match(appJs, /function isNotesEnabled\(\)/);
  assert.match(appJs, /type:\s*'notes-enabled'/);
  assert.match(appJs, /broadcastNotesEnabled/);
  for (const [name, src] of [
    ['ssh', terminalJs],
    ['telnet', telnetJs],
    ['rdp', rdpJs],
    ['vnc', novncJs],
  ]) {
    assert.match(src, /function applyNotesFeatureEnabled/, `${name} applyNotesFeatureEnabled`);
    assert.match(src, /classList\.toggle\('force-hidden',\s*!notesFeatureEnabled\)/, `${name} force-hidden gate`);
    assert.match(src, /type === 'notes-enabled'|type === "notes-enabled"|msg\.type === 'notes-enabled'|event\.data\.type === 'notes-enabled'/, `${name} notes-enabled handler`);
    assert.match(src, /\/api\/me\/settings/, `${name} settings fetch`);
    assert.match(src, /if \(!notesFeatureEnabled\)/, `${name} click gate`);
    assert.match(src, /type:\s*'open-notes-for-connection'/, `${name} open notes message`);
    assert.match(src, /source:\s*'zephyr-terminal'/, `${name} message source`);
    assert.match(src, /笔记面板需要在应用主界面打开/, `${name} non-embed feedback`);
  }
});

test('RDP and VNC script cache includes their latest notes-compatible revision', () => {
  assert.match(rdpHtml, /rdp-wasm-client\.js\?v=20260802-rdp-input-render20/);
  assert.match(novncHtml, /novnc\.js\?v=20260801-rdp-vnc-notes-align1/);
});

test('stable mobile keyboard uses parent overlay without workspace clip', () => {
  const start = appJs.indexOf('if (isStableInput && isCompact)');
  assert.ok(start > 0, 'stable-input branch missing');
  const end = appJs.indexOf('if (!keyboardOpen || !isFullscreenTerminalSurface)', start);
  const body = appJs.slice(start, end);
  assert.match(body, /stable-overlay/);
  assert.match(body, /--app-keyboard-shift',\s*'0px'/);
  assert.doesNotMatch(body, /\busableHeight\b/);
  assert.doesNotMatch(body, /workspace\.style\.height = `\$\{usableHeight\}px`/);
});
