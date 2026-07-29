import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../ai-agent-service.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../ai-runtime-bridge.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../zephyr-ai/internal/session/store.go', import.meta.url), 'utf8');
const goServer = readFileSync(new URL('../zephyr-ai/internal/server/server.go', import.meta.url), 'utf8');

test('usage popover reads persisted runtime tokens instead of character estimates', () => {
  assert.match(app, /\/api\/ai\/runtime\/sessions\/\$\{encodeURIComponent\(currentSession\.runtimeSessionId\)\}\/usage/);
  assert.match(app, /usage\.inputTokens/);
  assert.match(app, /usage\.outputTokens/);
  assert.match(app, /usage\.latestContextTokens/);
  const start = app.indexOf('async function openAiUsageSheet');
  const end = app.indexOf('\nfunction ', start + 20);
  const body = app.slice(start, end);
  assert.doesNotMatch(body, /\/api\/ai\/metrics|inputChars|\/ 2\.4|输出<\/span><b>—/);
  assert.match(bridge, /async getSessionUsage/);
  assert.match(server, /sessions\/:id\/usage/);
  assert.match(store, /func \(s \*Store\) SessionUsage/);
  assert.match(goServer, /handleSessionUsage/);
});

test('custom Anthropic-compatible endpoints never receive fabricated Claude catalogs', () => {
  assert.match(agent, /function isOfficialAnthropicBase/);
  assert.match(agent, /if \(!official\) return \[\]/);
  assert.match(agent, /preserveExisting: models\.length === 0/);
  assert.match(app, /data\.preserveExisting/);
  assert.match(app, /已保留现有模型配置/);
});

test('model picker displays configured ModelEntry labels, not inferred vendor names', () => {
  assert.match(app, /function aiModelDisplayName/);
  assert.match(app, /entry\?\.label \|\| entry\?\.id/);
  assert.match(app, /label: m\.label \|\| m\.id/);
  assert.match(app, /aiModelDisplayName\(p, value\)/);
  assert.match(app, /label: model\.name \|\| model\.display_name \|\| model\.id/);
  assert.match(app, /mergeAiModelEntries\(saved\.models, remoteEntries/);
});
