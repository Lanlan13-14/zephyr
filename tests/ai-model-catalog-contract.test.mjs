import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const app = read('public/app.js');
const appHtml = read('public/app.html');
const style = read('public/style.css');
const catalog = read('ai-model-catalog.js');
const providerSvc = read('ai-provider-service.js');
const server = read('server.js');

test('model catalog module normalizes string and object entries', () => {
  assert.match(catalog, /function normalizeModels/);
  assert.match(catalog, /function mergeModelList/);
  assert.match(catalog, /function modelAcceptsImage/);
  assert.match(catalog, /input:\s*\{[\s\S]*image/);
});

test('provider service persists ModelEntry arrays and filters hidden models', () => {
  assert.match(providerSvc, /normalizeModels/);
  assert.match(providerSvc, /selectableModelIds/);
  assert.match(providerSvc, /model_hidden/);
  assert.match(providerSvc, /mergeFetchedModels|mergeModelList/);
});

test('runtime vision gate uses per-model input.image', () => {
  assert.match(server, /modelAcceptsImage/);
  assert.match(server, /当前模型未启用图片输入/);
});

test('provider UI exposes model catalog via settings subpages', () => {
  assert.match(appHtml, /id="settingsAiModelsPage"/);
  assert.match(appHtml, /id="settingsAiModelDetailPage"/);
  assert.match(appHtml, /id="aiModelDetailInputImage"/);
  assert.match(appHtml, /id="aiModelDetailInputPdf"/);
  assert.match(app, /normalizeAiModelEntries/);
  assert.match(app, /openAiModelDetailPage|openAiModelDetailModal/);
  assert.match(app, /openAiModelsPage/);
  assert.match(app, /Motion\.sheet/);
  assert.match(style, /\.settings-subpage/);
  assert.match(style, /\.ai-model-switch-row/);
});

test('fetch models merges capabilities instead of wiping them', () => {
  // Saved-provider list path names the resolved provider `saved`.
  assert.match(app, /mergeAiModelEntries\(saved\.models, uniqueNames/);
  // Modal draft path still merges into the in-memory ModelEntry draft.
  assert.match(app, /mergeAiModelEntries\(aiProviderModelEntriesDraft, uniqueNames/);
});
