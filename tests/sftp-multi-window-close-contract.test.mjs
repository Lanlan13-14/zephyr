import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const terminal = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const telnet = readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');
const telnetHtml = readFileSync(new URL('../public/telnet-terminal.html', import.meta.url), 'utf8');
const appHtml = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const CACHE = '20260731-sftp-multi-close1';

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
  assert.match(html, new RegExp(`terminal\\.js\\?v=${CACHE}`));
  assert.match(html, new RegExp(`style\\.css\\?v=${CACHE}`));
  assert.match(telnetHtml, new RegExp(`telnet-terminal\\.js\\?v=${CACHE}`));
  assert.match(telnetHtml, new RegExp(`style\\.css\\?v=${CACHE}`));
  assert.match(appHtml, new RegExp(`app\\.js\\?v=${CACHE}`));
  assert.match(appHtml, new RegExp(`style\\.css\\?v=${CACHE}`));
  assert.match(app, new RegExp(`terminal\\.html\\?embed=1[^\u0060]*v=${CACHE}`));
  assert.match(app, new RegExp(`telnet-terminal\\.html\\?embed=1[^\u0060]*v=${CACHE}`));
  assert.match(sw, new RegExp(`CACHE_NAME = 'zephyr-static-${CACHE}'`));
  assert.match(sw, new RegExp(`/terminal\\.js\\?v=${CACHE}`));
});
