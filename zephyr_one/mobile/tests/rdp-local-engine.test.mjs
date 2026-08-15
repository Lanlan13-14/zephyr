import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('missing RDP engine is not shown as a main-end incompatibility', () => {
  const vm = read(path.join(ROOT, 'android/feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RdpViewModel.kt'));
  assert.match(vm, /error\.code != AndroidRdpEngine\.ENGINE_UNAVAILABLE/);
  assert.match(vm, /UnavailableRdpEngine\.ENGINE_UNAVAILABLE/);
  const scaffold = read(path.join(ROOT, 'android/core-ui/src/main/kotlin/one/zephyr/mobile/ui/state/PageStateScaffold.kt'));
  assert.match(scaffold, /state\.error\.message/);
  const zh = read(path.join(ROOT, 'android/core-ui/src/main/res/values/strings.xml'));
  assert.doesNotMatch(zh, /主端版本与本应用不兼容/);
});

test('connection test is a local TCP handshake, not a main-end or engine call', () => {
  const root = read(path.join(ROOT, 'android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'));
  assert.match(root, /TcpReachabilityTester\(/);
  assert.match(root, /fallback = TcpReachabilityTester\(/);
  assert.match(root, /ProtocolConnectionTester\(/);
  assert.match(root, /onTestConnection = testConnection/);
  const tester = read(path.join(ROOT, 'android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/TcpReachabilityTester.kt'));
  assert.match(tester, /Socket\(\)/);
  assert.doesNotMatch(tester, /UnavailableConnectionTester/);
});

test('CI packages the Android FreeRDP JNI library into the APK', () => {
  const workflow = read(path.join(ROOT, '../../.github/workflows/zephyr-one-mobile.yml'));
  assert.match(workflow, /build-freerdp-android\.sh arm64-v8a/);
  assert.match(workflow, /ZEPHYR_ANDROID_FREERDP_ROOT/);
  assert.match(workflow, /lib\/arm64-v8a\/libzephyr_rdp_android\.so/);
});
