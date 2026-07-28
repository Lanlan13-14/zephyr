import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyImageBudget, resolveBudget } from '../ai-image-budget.js';
import { ocrConfigured, isOcrAvailableSync } from '../ai-ocr-service.js';
import { listProfiles, getProfile, runSubagentTask, runParallelReadonly, globalLocks } from '../ai-subagent-service.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

test('S4 image budget elides older frames over total bytes', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(10000); // ~7.5KB each
  const messages = [
    { role: 'user', name: 'zephyr.visual_observation', parts: [{ type: 'image_url', imageUrl: big }] },
    { role: 'user', name: 'zephyr.visual_observation', parts: [{ type: 'image_url', imageUrl: big }] },
    { role: 'user', name: 'zephyr.visual_observation', parts: [{ type: 'image_url', imageUrl: big }] },
  ];
  const { stats, messages: out } = applyImageBudget(messages, {
    modelEntry: { maxImagesPerRequest: 2, maxImageBytes: 50 * 1024 * 1024 },
    maxRequestImageBytes: 20 * 1024,
    pinRecentVisualFrames: 2,
  });
  assert.ok(stats.elided >= 1);
  const remainingImages = out.reduce((n, m) => n + (m.parts || []).filter((p) => p.type === 'image_url').length, 0);
  assert.ok(remainingImages <= 2);
  assert.equal(resolveBudget({}).maxImageBytes, 5 * 1024 * 1024);
});

test('S4 OCR module fails closed when unconfigured', () => {
  const prev = process.env.ZEPHYR_OCR_URL;
  delete process.env.ZEPHYR_OCR_URL;
  delete process.env.ZEPHYR_OCR_COMMAND;
  assert.equal(ocrConfigured(), null);
  // may still detect system tesseract — isOcrAvailableSync only checks env
  assert.equal(isOcrAvailableSync(), false);
  if (prev) process.env.ZEPHYR_OCR_URL = prev;
});

test('S6 subagent profiles and parallel readonly', async () => {
  const profiles = listProfiles();
  assert.ok(profiles.some((p) => p.id === 'readonly-scout'));
  assert.equal(getProfile('log-analyst').readOnly, true);
  const single = await runSubagentTask({
    profileId: 'readonly-scout',
    prompt: '列出连接',
    executeTool: async () => ({ ok: true }),
  });
  assert.equal(single.ok, true);
  assert.match(single.final, /readonly-scout|子代理/);

  const parallel = await runParallelReadonly({
    tasks: [{ prompt: 'A' }, { prompt: 'B' }],
    executeTool: async () => ({ ok: true }),
  });
  assert.equal(parallel.count, 2);
  assert.ok(parallel.summary.length > 0);
});

test('S6 resource lock conflicts on write overlap', () => {
  const release = globalLocks.acquire([{ kind: 'connection', id: 'c1', mode: 'write' }], 'owner-a');
  assert.throws(() => {
    globalLocks.preflight([{ kind: 'connection', id: 'c1', mode: 'write' }], 'owner-b');
  }, /resource_lock_conflict/);
  release();
});

test('S6/S7 tools registered in agent service', () => {
  const agent = read('ai-agent-service.js');
  for (const name of [
    'subagent_list_profiles_v1',
    'subagent_task_v1',
    'subagent_parallel_v1',
    'subagent_fleet_v1',
  ]) {
    assert.match(agent, new RegExp(`name: '${name}'`));
    assert.match(agent, new RegExp(`case '${name}'`));
  }
});

test('S8 run profile UI and mode filter exist', () => {
  const html = read('public/app.html');
  const app = read('public/app.js');
  const mode = read('zephyr-ai/internal/agent/mode.go');
  assert.match(html, /id="aiRunProfile"/);
  assert.match(html, /data-value="economy"/);
  assert.match(app, /effectiveMode/);
  assert.match(app, /runProfile/);
  assert.match(mode, /filterEconomy|economy/);
  assert.match(mode, /delivery/);
  assert.match(read('docs/agent/L2_RESTRICTED_EXEC_RFC.md'), /威胁模型/);
});

test('S5 compact ratios aligned', () => {
  const compact = read('zephyr-ai/internal/compact/compact.go');
  assert.match(compact, /PruneRatio:\s+0\.80/);
  assert.match(compact, /CompactRatio:\s+0\.90/);
});
