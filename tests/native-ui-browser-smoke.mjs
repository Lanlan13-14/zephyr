/* Real Chromium proof, not a source-only contract. Requires Playwright and
 * CHROMIUM_BIN or an installed Playwright Chromium; no production dependency.
 * Run: node tests/native-ui-browser-smoke.mjs */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { throw new Error('Install Playwright in the test environment before running this real-browser smoke test.'); }
const executablePath = process.env.CHROMIUM_BIN || undefined;
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html' };
const fixture = `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/public/style.css"><link rel="stylesheet" href="/public/native-ui.css"></head><body><input id="field" value="abcdef"><select id="choice"><option value="a">A</option><option value="b">B</option></select><div id="wtermWrapper"></div><output id="events"></output><script src="/public/native-ui.js"></script><script src="/public/native-select.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
  const file = path.join(root, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root + path.sep) || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.end(require('node:fs').readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  const colors = await page.evaluate(() => ['--bg', '--accent'].map((key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim()));
  if (colors.join(',') !== '#101114,#2483eb') throw new Error(`Theme mismatch: ${colors}`);
  const input = page.locator('#field');
  await input.focus(); await input.evaluate((el) => el.setSelectionRange(1, 4));
  await input.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制 Ctrl+C' }).click();
  await page.waitForFunction(() => navigator.clipboard.readText().then((text) => text === 'bcd'));
  await input.evaluate((el) => { el.focus(); el.setSelectionRange(6, 6); });
  await input.click({ button: 'right' }); await page.getByRole('menuitem', { name: '粘贴 Ctrl+V' }).click();
  await page.waitForFunction(() => document.getElementById('field').value === 'abcdefbcd');
  await page.locator('#choiceToggleTrigger').click();
  await page.locator('.ui-toggle-select.open .ui-toggle-select-option').nth(1).click();
  if (await page.locator('#choice').inputValue() !== 'b') throw new Error('Select did not emit its value');
  const prompt = page.evaluate(() => window.ZephyrNativeUI.prompt('Name', 'old'));
  await page.locator('.zephyr-native-dialog > input').fill('new-name');
  await page.locator('.zephyr-native-dialog > input').press('Enter');
  if (await prompt !== 'new-name') throw new Error('Prompt result mismatch');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS native-ui Chromium smoke: shared theme, copy/paste, custom select, async prompt; zero page errors');
} finally {
  await browser?.close();
  server.close();
}
