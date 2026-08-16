import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('Android installs filesDir as HOME before FreeRDP create', () => {
  const runtime = read(path.join(ROOT, 'android/protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/RdpAndroidRuntime.kt'));
  assert.match(runtime, /android\.system\.Os/);
  assert.match(runtime, /setenv/);
  assert.match(runtime, /HOME/);
  const application = read(path.join(ROOT, 'android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneApplication.kt'));
  assert.match(application, /RdpAndroidRuntime\.installHome\(filesDir\)/);
  const container = read(path.join(ROOT, 'android/app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt'));
  assert.match(container, /AndroidRdpEngine\(context\.filesDir\)/);
  assert.doesNotMatch(container, /AndroidRdpEngine\(\)/);
});

test('JNI create fails closed when HOME is missing and surfaces the certificate fingerprint', () => {
  const engine = read(path.join(ROOT, 'android/protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/AndroidRdpEngine.kt'));
  assert.match(engine, /SESSION_CREATE_FAILED/);
  assert.match(engine, /CertificateReview/);
  assert.match(engine, /ignoreCertificate/);
  assert.match(engine, /stored != null && stored == presented/);
  const jni = read(path.join(ROOT, 'android/protocol-rdp/src/main/cpp/zephyr_rdp_jni.c'));
  assert.match(jni, /ignoreCertificate/);
  assert.match(jni, /ZEPHYR_RDP_EV_LOG/);
  assert.match(jni, /onCertificateFingerprint/);
});

test('create/HOME replica rejects a missing HOME install and unknown-cert auto-accept', () => {
  const replica = path.join(ROOT, 'tests/rdp-android-create-replica.py');
  const result = spawnSync('python3', [replica], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('engine replica keeps the password across a stored-fingerprint retry', () => {
  const replica = path.join(ROOT, 'tests/rdp-android-engine-replica.py');
  const result = spawnSync('python3', [replica], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Android FreeRDP drops the TlsAlloc sign assertion for bionic pthread_key_t', () => {
  const patch = read(path.join(ROOT, '../../zephyr_one/native/freerdp-core/patches/freerdp-3.30.0-tlsalloc-bionic-assert.patch'));
  assert.match(patch, /winpr\/libwinpr\/thread\/tls\.c/);
  assert.match(patch, /^\+\s*return \(DWORD\)key/m);
  assert.doesNotMatch(patch, /^\+\s*return WINPR_ASSERTING_INT_CAST\(DWORD, key\)/m);
  const script = read(path.join(ROOT, '../../zephyr_one/native/freerdp-core/scripts/build-freerdp-android.sh'));
  assert.match(script, /TLS_PATCH_FILE=.*tlsalloc-bionic-assert\.patch/);
  assert.match(script, /tlsalloc-bionic-v1/);
  const workflow = read(path.join(ROOT, '../../.github/workflows/zephyr-one-mobile.yml'));
  assert.match(workflow, /tlsalloc-bionic-v1/);
});

test('Android FreeRDP uses built-in NTLM crypto instead of an unavailable OpenSSL provider', () => {
  const script = read(path.join(ROOT, '../../zephyr_one/native/freerdp-core/scripts/build-freerdp-android.sh'));
  for (const primitive of ['MD4', 'RC4', 'MD5']) {
    assert.match(script, new RegExp(`-DWITH_INTERNAL_${primitive}=ON`));
    assert.match(script, new RegExp(`\\^#define WITH_INTERNAL_${primitive}`));
  }
  assert.match(script, /ntlm-internal-crypto-v1/);

  const cmake = read(path.join(ROOT, 'android/protocol-rdp/src/main/cpp/CMakeLists.txt'));
  assert.match(cmake, /ntlm-internal-crypto-v1/);

  const workflow = read(path.join(ROOT, '../../.github/workflows/zephyr-one-mobile.yml'));
  for (const primitive of ['MD4', 'RC4', 'MD5']) {
    assert.match(workflow, new RegExp(`WITH_INTERNAL_${primitive}`));
  }
  assert.match(workflow, /ntlm-internal-crypto-v1/);
});

test('Android CI reuses release classes and bounds every unit-test module', () => {
  const workflow = read(path.join(ROOT, '../../.github/workflows/zephyr-one-mobile.yml'));
  const rootBuild = read(path.join(ROOT, 'android/build.gradle.kts'));
  // `--no-daemon testDebugUnitTest` after assemblePrerelease recompiled the tree as debug.
  // Parallel test tasks also let a leaked module hide an earlier assertion until job timeout.
  assert.doesNotMatch(workflow, /gradle --no-daemon/);
  assert.match(workflow, /:app:assemblePrerelease/);
  assert.match(workflow, /testReleaseUnitTest/);
  assert.match(workflow, /-x :app:testReleaseUnitTest/);
  assert.match(workflow, /:app:testPrereleaseUnitTest/);
  assert.doesNotMatch(workflow, /gradle[^\n]*testDebugUnitTest/);
  assert.match(workflow, /--no-parallel --max-workers=2/);
  assert.match(workflow, /-Pzephyr\.unitTestTimeoutSeconds=90/);
  assert.match(workflow, /timeout-minutes: 6/);
  assert.match(rootBuild, /tasks\.withType<Test>\(\)\.configureEach/);
  assert.match(rootBuild, /failFast = true/);
  assert.match(rootBuild, /timeout\.set\(Duration\.ofSeconds\(seconds\)\)/);
});
