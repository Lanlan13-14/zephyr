import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const brace = source.indexOf('{', start);
  assert.notEqual(brace, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  assert.fail(`unterminated body for ${signature}`);
}

function assertStartupIsolated({ host, api, overlay }) {
  const classPrefix = host.slice(0, host.indexOf('fun ensureStarted(): Endpoint'));
  assert.doesNotMatch(classPrefix, /ServerSocket\s*\(/, 'AI host construction must not bind a socket');
  assert.doesNotMatch(classPrefix, /Executors\.newFixedThreadPool/, 'AI host construction must not spawn threads');

  const ensureStarted = methodBody(host, 'fun ensureStarted(): Endpoint');
  assert.match(ensureStarted, /ServerSocket\s*\(/, 'the on-demand path must bind the loopback host');

  assert.doesNotMatch(overlay, /LaunchedEffect\s*\(\s*Unit\s*\)\s*\{\s*controller\.refresh\s*\(\s*\)/s,
    'first composition must not boot the AI process');
  assert.match(overlay, /LaunchedEffect\s*\(\s*sheet\.isOpen\s*\)\s*\{\s*if\s*\(\s*sheet\.isOpen\s*\)\s*controller\.refresh\s*\(\s*\)/s,
    'opening the AI sheet must start or refresh the runtime');

  const runtimeCall = methodBody(api, 'private suspend fun <T> runtimeCall(');
  assert.match(api, /private suspend fun <T> runtimeCall\([\s\S]*?\): ApiResult<T>\s*=\s*withContext\s*\(\s*Dispatchers\.IO\s*\)/,
    'process, socket bind and loopback connect must run on Dispatchers.IO');
  assert.match(runtimeCall, /catch\s*\(\s*failure:\s*Exception\s*\)/,
    'runtime startup failures must become an AI failure instead of killing the app');
  assert.match(api, /suspend fun stream\([\s\S]*?\{\s*return runtimeCall\s*\(/,
    'stream must use the guarded IO boundary');
  assert.match(api, /private suspend fun <B, R> post\([\s\S]*?\): ApiResult<R>\s*=\s*runtimeCall\s*\(/,
    'post must use the guarded IO boundary');
  assert.match(api, /private suspend fun <R> get\([\s\S]*?\): ApiResult<R>\s*=\s*runtimeCall\s*\(/,
    'get must use the guarded IO boundary');
}

test('cold app startup performs no embedded-AI process or loopback I/O', () => {
  assertStartupIsolated({
    host: read('android/app/src/main/kotlin/one/zephyr/mobile/app/AndroidAiPlatformHost.kt'),
    api: read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedAiRuntimeApi.kt'),
    overlay: read('android/feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceOverlay.kt'),
  });
});

test('startup isolation guard rejects the pre18 eager-host and eager-refresh regressions', () => {
  const current = {
    host: read('android/app/src/main/kotlin/one/zephyr/mobile/app/AndroidAiPlatformHost.kt'),
    api: read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedAiRuntimeApi.kt'),
    overlay: read('android/feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceOverlay.kt'),
  };
  const eagerHost = {
    ...current,
    host: current.host.replace(
      'private val lifecycleLock = Any()',
      'private val eager = ServerSocket(0)\n    private val lifecycleLock = Any()',
    ),
  };
  assert.throws(() => assertStartupIsolated(eagerHost), /must not bind a socket/);

  const eagerRefresh = {
    ...current,
    overlay: current.overlay.replace(
      'LaunchedEffect(sheet.isOpen) { if (sheet.isOpen) controller.refresh() }',
      'LaunchedEffect(Unit) { controller.refresh() }',
    ),
  };
  assert.throws(() => assertStartupIsolated(eagerRefresh), /first composition must not boot/);

  const mainDispatcher = {
    ...current,
    api: current.api.replace('withContext(Dispatchers.IO)', 'withContext(Dispatchers.Main)'),
  };
  assert.throws(() => assertStartupIsolated(mainDispatcher), /must run on Dispatchers.IO/);
});
