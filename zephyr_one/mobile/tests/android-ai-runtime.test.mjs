import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const mobile = path.join(repo, 'zephyr_one', 'mobile');
const read = (file) => fs.readFileSync(path.join(mobile, file), 'utf8');

test('Android AI uses the real server runtime and never the offline demo send', () => {
  const host = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceHost.kt');
  const controller = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AndroidAiRuntimeController.kt');
  const overlay = read('android/feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceOverlay.kt');
  assert.match(host, /AndroidAiRuntimeController/);
  assert.match(controller, /account\.aiRuntime\.startRun/);
  assert.match(controller, /account\.aiRuntime\.stream/);
  assert.match(controller, /"text\.delta"/);
  assert.match(controller, /"permission\.ask"/);
  assert.match(controller, /"tool\.result"/);
  assert.match(controller, /account\.aiRuntime\.decide/);
  assert.match(controller, /account\.aiRuntime\.abort/);
  assert.match(overlay, /controller\.send/);
  assert.doesNotMatch(overlay, /sendNotice\(/);
});

test('Android AI attachment flow is system picker to bounded multipart upload', () => {
  const overlay = read('android/feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceOverlay.kt');
  const api = read('android/core-network/src/main/kotlin/one/zephyr/mobile/network/AiRuntimeApi.kt');
  assert.match(overlay, /ActivityResultContracts\.OpenDocument/);
  assert.match(overlay, /resolver\.openInputStream/);
  assert.match(overlay, /12 \* 1024 \* 1024/);
  assert.match(overlay, /controller\.upload/);
  assert.match(api, /HttpUrl\.Companion\.toHttpUrl/);
  assert.match(api, /MultipartBody\.Builder/);
  assert.match(api, /addFormDataPart\("sessionId"/);
  assert.match(api, /addFormDataPart\("file"/);
  assert.match(api, /MAX_ATTACHMENT_BYTES = 12 \* 1024 \* 1024/);
  assert.match(api, /wire\.fill\(0\)/);
});

test('Android AI exposes Docker-equivalent run controls and real provider models', () => {
  const models = read('android/feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceModels.kt');
  const overlay = read('android/feature-ai/src/main/kotlin/one/zephyr/mobile/feature/ai/AiWorkspaceOverlay.kt');
  assert.match(models, /standard", "plan", "goal/);
  assert.match(models, /economy", "balanced", "delivery/);
  assert.match(models, /ask", "auto", "yolo/);
  assert.match(models, /PROVIDER/);
  assert.match(models, /RUN_PROFILE/);
  assert.match(overlay, /AiPicker\.PROVIDER/);
  assert.match(overlay, /AiPicker\.MODEL/);
  assert.match(overlay, /PermissionCard/);
  assert.match(overlay, /controller\.setPlanEnabled/);
});

test('AI HTTP routes accept native device access without exposing provider secrets', () => {
  const server = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
  assert.match(server, /function requireAiUser/);
  assert.match(server, /mobileV1Api\?\.requireDeviceAccess/);
  assert.match(server, /registerAiHistoryRoutes\(app, \{\s*requireUser: requireAiUser/);
  assert.match(server, /registerAiRoutes\(app, \{\s*requireUser: requireAiUser/);
  const agent = fs.readFileSync(path.join(repo, 'ai-agent-service.js'), 'utf8');
  assert.match(agent, /app\.post\('\/api\/ai\/attachments', requireUser/);
  assert.doesNotMatch(read('android/core-network/src/main/kotlin/one/zephyr/mobile/network/AiRuntimeDtos.kt'), /apiKey/);
});
