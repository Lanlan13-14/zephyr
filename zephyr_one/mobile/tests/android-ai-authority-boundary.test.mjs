import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

test('bound AI stays on the main-end runtime while local mode uses the packaged runtime', () => {
  const factory = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AiRuntimeControllerFactory.kt');
  const host = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceHost.kt');

  assert.match(factory, /if \(account\.isLocalMode\) \{[\s\S]*LocalAndroidAiRuntimeController/);
  assert.match(factory, /else \{[\s\S]*AndroidAiRuntimeController/);
  assert.match(host, /AiRuntimeControllerFactory\.create/);
  assert.match(host, /localMode = account\.isLocalMode/);
  assert.match(host, /\(!localMode \|\| catalogEnabled\)/);
  assert.doesNotMatch(host, /LocalAndroidAiRuntimeController\(/);
});

test('bound AI requests carry provider identity but never provider credentials', () => {
  const controller = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AndroidAiRuntimeController.kt');
  const dto = read('android/core-network/src/main/kotlin/one/zephyr/mobile/network/AiRuntimeDtos.kt');
  const local = read('android/app/src/main/kotlin/one/zephyr/mobile/app/LocalAndroidAiRuntimeController.kt');

  assert.match(controller, /account\.aiRuntime\.startRun/);
  assert.match(controller, /providerId = provider\.id/);
  assert.doesNotMatch(dto, /apiKey/);
  assert.match(local, /providerApiKey\(provider\.id\)/);
});
