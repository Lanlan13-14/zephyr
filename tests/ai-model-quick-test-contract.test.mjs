import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const app = read('public/app.js');
const html = read('public/app.html');
const css = read('public/style.css');
const agent = read('ai-agent-service.js');

test('quick-test hits dedicated API not toast-only chat probe', () => {
  assert.match(agent, /app\.post\('\/api\/ai\/models\/quick-test'/);
  assert.match(agent, /Say a brief friendly hello/);
  assert.match(agent, /modality:\s*'text'/);
  assert.match(app, /\/api\/ai\/models\/quick-test/);
  assert.match(app, /function quickTestAiModel/);
  assert.match(app, /function renderQuickTestResults/);
  assert.doesNotMatch(app, /Quick test: reply with the single word OK/);
});

test('quick-test result sheet markup matches product sheet', () => {
  assert.match(html, /id="settingsAiQuickTestPage"/);
  assert.match(html, /id="aiQuickTestResults"/);
  assert.match(html, /id="aiQuickTestDoneBtn"/);
  assert.match(html, /id="aiQuickTestRerunBtn"/);
  assert.match(html, /id="aiQuickTestModelLabel"/);
  assert.match(css, /\.ai-quick-test-page/);
  assert.match(css, /\.ai-quick-test-status\.is-ok/);
  assert.match(app, /openAiQuickTestPage/);
  assert.match(app, /formatQuickTestDuration/);
});
