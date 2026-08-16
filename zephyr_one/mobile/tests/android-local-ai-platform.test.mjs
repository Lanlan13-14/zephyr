import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const repo = path.resolve(mobile, '..', '..');
const read = (p) => fs.readFileSync(path.join(mobile, p), 'utf8');

test('Android AI owns a complete local catalog and keystore-separated secrets', () => {
  const repository = read('android/core-data/src/main/kotlin/one/zephyr/mobile/data/repository/LocalAiRepository.kt');
  assert.match(repository, /data class LocalAiCatalog/);
  for (const symbol of ['LocalAiProvider','LocalAiModel','LocalAiMcpServer','LocalAiEnvironment','LocalAiMemory','LocalAiSkill','LocalAiSandbox','LocalAiPermissions','LocalAiPermissionRules']) {
    assert.match(repository, new RegExp(`data class ${symbol}`));
  }
  assert.match(repository, /SecretRef\.of\(type, id, field\)/);
  assert.match(repository, /secrets\.put\(/);
  assert.doesNotMatch(repository, /apiKey: String/);
  assert.doesNotMatch(repository, /value: String = .*environment/i);
});

test('Android packages and launches the exact Go agent loop locally', () => {
  const app = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedAiRuntimeProcess.kt');
  const client = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedAiRuntimeApi.kt');
  const host = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AiWorkspaceHost.kt');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const build = read('android/app/build.gradle.kts');
  const goEntry = fs.readFileSync(path.join(repo, 'zephyr-ai/cmd/zephyr-ai-android/main.go'), 'utf8');
  const binary = path.join(mobile, 'android/app/src/main/jniLibs/arm64-v8a/libzephyr_ai_runtime.so');
  assert.ok(fs.statSync(binary).size > 5_000_000);
  assert.match(manifest, /extractNativeLibs="true"/);
  assert.match(build, /jniLibs\.useLegacyPackaging = true/);
  assert.match(app, /applicationInfo\.nativeLibraryDir/);
  assert.match(app, /127\.0\.0\.1/);
  assert.match(goEntry, /server\.New\(cfg, store, log\)/);
  assert.match(client, /\/admin\/runs/);
  assert.match(client, /text\/event-stream/);
  assert.match(host, /LocalAndroidAiRuntimeController/);
  assert.doesNotMatch(host, /\bAndroidAiRuntimeController\(/);
});

test('local AI runtime has platform tools and a fail-closed L2 sandbox', () => {
  const platform = read('android/app/src/main/kotlin/one/zephyr/mobile/app/AndroidAiPlatformHost.kt');
  const sandbox = read('android/app/src/main/kotlin/one/zephyr/mobile/app/LocalAiWorkspace.kt');
  for (const tool of ['connection_list_v1','remote_execute','workspace_list_v1','workspace_read_v1','workspace_write_v1','session_sandbox_status_v1','session_exec_v1']) {
    assert.match(platform, new RegExp(tool));
  }
  assert.match(platform, /isLoopbackAddress/);
  assert.match(platform, /x-ai-host-admin/);
  assert.match(sandbox, /!File\(path\)\.isAbsolute/);
  assert.match(sandbox, /!path\.split\('\/'\)\.contains\("\.\."\)/);
  assert.match(sandbox, /ProcessBuilder\(listOf\(binary\.absolutePath\) \+ safeArgs\)/);
  assert.doesNotMatch(sandbox, /sh -c|bash -c|Runtime\.getRuntime/);
  assert.match(sandbox, /process\.waitFor\(timeout\.toLong\(\), TimeUnit\.SECONDS\)/);
});

test('full mobile AI settings mirror main-end functional categories', () => {
  const ui = read('android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/FullAiSettings.kt');
  for (const text of ['模型供应商','工具与权限','MCP 服务器','AI 环境变量','长期 Memory','Skills 能力包','本机沙箱','系统提示词','上下文窗口 Tokens','任务规划器','供应商原生额外参数 JSON','并行工具调用']) {
    assert.match(ui, new RegExp(text));
  }
  assert.match(ui, /ZephyrMotionTokens\.easeOut/);
  assert.match(ui, /tween\(220/);
  assert.match(ui, /主端同步始终是可选项|主端.*可选/);
});
