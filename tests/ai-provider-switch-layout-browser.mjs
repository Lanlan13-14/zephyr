import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const html = `<!doctype html><html><head><link rel="stylesheet" href="/public/style.css"></head><body><form class="ai-provider-modal">
<div class="form-group ai-provider-share-box"><label class="settings-switch-option" for="aiProviderShareUsers"><span class="settings-switch-copy"><span class="settings-switch-label">共享给所有用户</span></span><span class="connection-share-switch"><input type="checkbox" id="aiProviderShareUsers"><span></span></span></label>
<label class="settings-switch-option" for="aiProviderShareAdmins"><span class="settings-switch-copy"><span class="settings-switch-label">共享给所有管理员</span></span><span class="connection-share-switch"><input type="checkbox" id="aiProviderShareAdmins"><span></span></span></label></div>
<div class="form-group ai-provider-switch-group"><label class="settings-switch-option" for="aiProviderVision"><span class="settings-switch-copy"><span class="settings-switch-label">支持图片输入（RDP/VNC AI 必需）</span></span><span class="connection-share-switch"><input type="checkbox" id="aiProviderVision"><span></span></span></label></div>
<div class="form-group ai-provider-switch-group"><label class="settings-switch-option" for="aiProviderUsePreviousResponse"><span class="settings-switch-copy"><span class="settings-switch-label">OpenAI Responses 使用 previous_response_id（兼容接口慎开）</span></span><span class="connection-share-switch"><input type="checkbox" id="aiProviderUsePreviousResponse"><span></span></span></label></div>
</form></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  try { res.setHeader('content-type', 'text/css'); res.end(await readFile(path.join(root, req.url))); }
  catch { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, protocolTimeout: 180000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 760, height: 600 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle0' });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.settings-switch-option')].map((row) => {
    const label = row.querySelector('.settings-switch-label');
    const toggle = row.querySelector('.connection-share-switch');
    const rr = row.getBoundingClientRect(), lr = label.getBoundingClientRect(), tr = toggle.getBoundingClientRect();
    return { display: getComputedStyle(row).display, weight: getComputedStyle(label).fontWeight, rowRight: rr.right, labelRight: lr.right, toggleLeft: tr.left, toggleRight: tr.right, rowTop: rr.top, toggleTop: tr.top, rowBottom: rr.bottom, toggleBottom: tr.bottom };
  }));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.display, 'flex');
    assert.equal(row.weight, '400');
    assert.ok(row.toggleLeft > row.labelRight, 'toggle must be to the right of text');
    assert.ok(Math.abs(row.rowRight - row.toggleRight) < 18, 'toggle must align to right edge');
    assert.ok(row.toggleTop >= row.rowTop && row.toggleBottom <= row.rowBottom + 1, 'toggle must stay in the same row');
  }
  console.log(JSON.stringify({ ok: true, rows }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
