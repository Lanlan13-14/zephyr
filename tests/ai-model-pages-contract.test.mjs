import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const app = read('public/app.js');
const html = read('public/app.html');
const css = read('public/style.css');

test('settings host L2 models page and L3 detail page', () => {
  assert.match(html, /id="settingsAiModelsPage"/);
  assert.match(html, /id="settingsAiModelDetailPage"/);
  assert.match(html, /id="aiModelsListCard"/);
  assert.match(html, /id="aiModelDetailForm"/);
  assert.match(html, /id="aiModelDetailInputImage"/);
  assert.match(html, /id="aiModelDetailQuickTestBtn"/);
  assert.doesNotMatch(html, /id="aiModelDetailModal"/);
});

test('navigation uses motion sheet and provider opens models page', () => {
  assert.match(app, /function openAiModelsPage/);
  assert.match(app, /function openAiModelDetailPage/);
  assert.match(app, /Motion\.sheet\(/);
  assert.match(app, /data-ai-open-models/);
  assert.match(app, /edge:\s*'right'/);
  assert.match(app, /quickTestAiModel/);
});

test('switch rows use connection-share-switch track not dark catalog panel', () => {
  assert.match(css, /\.ai-model-switch-row/);
  assert.match(css, /\.settings-subpage/);
  assert.match(css, /\.ai-models-list-row/);
  assert.match(css, /\.connection-share-switch > span/);
  assert.doesNotMatch(css, /#10141c/);
  assert.doesNotMatch(css, /#aiModelDetailModal\.show/);
});

test('provider form no longer claims inline modality editors', () => {
  assert.match(html, /供应商级图片开关仅作为新建模型默认值/);
  assert.match(html, /模型列表中配置每模型模态/);
});
