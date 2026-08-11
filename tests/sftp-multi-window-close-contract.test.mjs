import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAssetVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const terminal = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnet = readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');
const telnetHtml = readFileSync(new URL('../public/telnet-terminal.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function multiWindowFactory(src) {
  const start = src.indexOf('function createFileManagerWindow');
  const end = src.indexOf('function handleExtraFileManagerListMessage', start);
  assert.ok(start >= 0 && end > start, 'SFTP multi-window factory exists');
  return src.slice(start, end);
}

test('primary SFTP markup keeps legacy button as a hidden compatibility hook', () => {
  assert.match(html, /class="tool-btn fm-close-btn" id="fmCloseBtn"/);
  assert.match(style, /#fmCloseBtn,\s*\.fm-close-btn,[\s\S]*?display:\s*none\s*!important/);
});

test('SSH SFTP clones remove legacy toolbar X and close through window menu', () => {
  const factory = multiWindowFactory(terminal);
  assert.match(factory, /panel\.querySelector\('\.fm-close-btn'\)\?\.remove\(\)/);
  assert.doesNotMatch(factory, /const closeBtn = panel\.querySelector\('\.fm-close-btn'\)/);
  assert.doesNotMatch(factory, /closeBtn\?\.addEventListener\('click', close\)/);
  assert.match(terminal, /panel\?\.classList\?\.contains\('file-manager'\)[\s\S]*owner\?\.close/);
});

test('Telnet clone path mirrors SFTP close-control removal', () => {
  const factory = multiWindowFactory(telnet);
  assert.match(factory, /panel\.querySelector\('\.fm-close-btn'\)\?\.remove\(\)/);
  assert.doesNotMatch(factory, /const closeBtn = panel\.querySelector\('\.fm-close-btn'\)/);
  assert.doesNotMatch(factory, /closeBtn\?\.addEventListener\('click', close\)/);
});

test('SFTP multi-window fix is cache-busted through shell and embedded pages', () => {
  const terminalVersion = singleAssetVersion(html, 'terminal.js', 'terminal page script');
  const telnetVersion = singleAssetVersion(telnetHtml, 'telnet-terminal.js', 'telnet page script');
  const terminalStyleVersion = singleAssetVersion(html, 'style.css', 'terminal page style');
  assertAssetVersion(telnetHtml, 'style.css', terminalStyleVersion, 'telnet page style');
  assertAssetVersion(app, 'terminal.html', terminalVersion, 'app terminal embed');
  assertAssetVersion(app, 'telnet-terminal.html', telnetVersion, 'app telnet embed');
  assertAssetVersion(sw, 'terminal.js', terminalVersion, 'service worker terminal.js');
  assertAssetVersion(sw, 'telnet-terminal.js', telnetVersion, 'service worker telnet-terminal.js');
});
