import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('Node capture route forwards asset id and records frame metadata', () => {
  assert.match(serverSource, /captureAssetId: req\.body\?\.captureAssetId \|\| ''/);
  assert.match(serverSource, /const data = await aiRuntimeBridge\.submitCapture[\s\S]*?rememberCapture\(\{/);
  assert.match(serverSource, /result: captureResult/);
});

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function withRuntime(handler, fn) {
  const requests = [];
  const handlerErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      await handler(req, res, body);
    } catch (error) {
      handlerErrors.push(error);
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const oldUrl = process.env.ZEPHYR_AI_URL;
  const oldToken = process.env.ZEPHYR_AI_ADMIN_TOKEN;
  process.env.ZEPHYR_AI_URL = `http://127.0.0.1:${port}`;
  process.env.ZEPHYR_AI_ADMIN_TOKEN = 'test-admin';
  try {
    delete require.cache[require.resolve('../ai-runtime-bridge.js')];
    const { AiRuntimeBridge } = require('../ai-runtime-bridge.js');
    await fn(new AiRuntimeBridge(), requests);
    if (handlerErrors.length) throw handlerErrors[0];
  } finally {
    if (oldUrl === undefined) delete process.env.ZEPHYR_AI_URL; else process.env.ZEPHYR_AI_URL = oldUrl;
    if (oldToken === undefined) delete process.env.ZEPHYR_AI_ADMIN_TOKEN; else process.env.ZEPHYR_AI_ADMIN_TOKEN = oldToken;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('runtime bridge preserves binary upload and capture asset binding', { concurrency: false }, async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
  await withRuntime((req, res, body) => {
    if (req.url === '/admin/runs') {
      const payload = JSON.parse(body.toString('utf8'));
      assert.equal(payload.userId, 'u1');
      assert.ok(payload.databaseGeneration);
      assert.ok(payload.runNonce);
      return json(res, 200, { ok: true, runId: 'run-1', ticket: 'ticket-1' });
    }
    if (req.url === '/admin/runs/run-1/capture-image?userId=u1&callId=call-1') {
      assert.equal(req.headers['content-type'], 'image/png');
      assert.deepEqual(body, png);
      return json(res, 200, { ok: true, captureAssetId: 'asset-1' });
    }
    if (req.url === '/admin/runs/run-1/capture') {
      const payload = JSON.parse(body.toString('utf8'));
      assert.equal(payload.userId, 'u1');
      assert.equal(payload.callId, 'call-1');
      assert.equal(payload.captureAssetId, 'asset-1');
      assert.deepEqual(payload.result, { captureId: 'frame-1' });
      return json(res, 200, { ok: true, resumed: true });
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  }, async (bridge, requests) => {
    await bridge.startRun({ userId: 'u1' }, { sessionId: 'session-1' });
    const uploaded = await bridge.uploadCaptureImage({ userId: 'u1' }, 'run-1', 'call-1', png, 'image/png');
    assert.equal(uploaded.captureAssetId, 'asset-1');
    await bridge.submitCapture({ userId: 'u1' }, 'run-1', {
      userId: 'u1',
      callId: 'call-1',
      captureAssetId: uploaded.captureAssetId,
      result: { captureId: 'frame-1' },
    });
    assert.equal(requests.length, 3);
  });
});
