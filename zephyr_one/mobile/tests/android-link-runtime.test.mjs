import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const mobile = path.join(repo, 'zephyr_one', 'mobile');
const read = (file) => fs.readFileSync(path.join(mobile, file), 'utf8');
const readRepo = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

test('Android ships and drives the embedded Go Link core instead of re-implementing ZSL', () => {
  // The Go Link binary must be packaged next to the AI runtime.
  const so = path.join(mobile, 'android/app/src/main/jniLibs/arm64-v8a/libzephyr_link.so');
  assert.ok(fs.existsSync(so), 'libzephyr_link.so must be packaged');
  assert.ok(fs.statSync(so).size > 1024 * 1024, 'Link runtime binary is suspiciously small');

  // Kotlin owns only the process lifecycle and the loopback client — never the protocol.
  const proc = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkProcess.kt');
  assert.match(proc, /libzephyr_link\.so/);
  assert.match(proc, /nativeLibraryDir/);
  assert.ok(proc.includes('127.0.0.1'), 'loopback readiness parse');
  const api = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkApi.kt');
  assert.match(api, /\/link\/dial/);
  // The Kotlin side must not contain any ZSL/KEM primitive — that lives in Go only.
  // It may name the loopback /link/mlkem/* routes, but never the crypto primitives.
  assert.doesNotMatch(api, /x25519|X25519|hkdf|Hkdf|mlkem\.Encapsulate|mlkem\.Decapsulate|mlkem\.GenerateKey/i);

  // The container exposes the embedded Link core and client.
  const container = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt');
  assert.match(container, /EmbeddedLinkProcess/);
  assert.match(container, /EmbeddedLinkApi/);
});

test('Kotlin drives device-identity ML-KEM through the Go core loopback routes', () => {
  const api = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkApi.kt');
  assert.match(api, /mlkemGenerate/);
  assert.match(api, /mlkemEncapsulate/);
  assert.match(api, /mlkemDecapsulate/);
  assert.match(api, /\/link\/mlkem\/generate/);
  assert.match(api, /\/link\/mlkem\/encapsulate/);
  assert.match(api, /\/link\/mlkem\/decapsulate/);

  const node = readRepo('zephyr-link/internal/link/node.go');
  assert.match(node, /\/link\/mlkem\/generate/);
  assert.match(node, /\/link\/mlkem\/encapsulate/);
  assert.match(node, /\/link\/mlkem\/decapsulate/);
  assert.match(node, /GenerateMLKEM768/);
  assert.match(node, /EncapsulateMLKEM768/);
  assert.match(node, /DecapsulateMLKEM768/);
});

test('Go Link core exposes the embedded dial route the Kotlin client calls', () => {
  const node = readRepo('zephyr-link/internal/link/node.go');
  assert.match(node, /\/link\/dial/);
  assert.match(node, /HandshakeInitiator/);
  // The Android entrypoint is a loopback process with a stdout readiness line.
  const main = readRepo('zephyr-link/cmd/zephyr-link-android/main.go');
  assert.match(main, /127\.0\.0\.1:0/);
  assert.match(main, /os\.Stdin\.Read/);
});

test('Android publishes local-to-bound account replacement atomically', () => {
  const coordinator = read('android/app/src/main/kotlin/one/zephyr/mobile/app/binding/BindingCoordinator.kt');
  const container = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt');
  const screen = read('android/app/src/main/kotlin/one/zephyr/mobile/app/BindingScreen.kt');
  assert.match(coordinator, /fun replaceGraph\(expected: ManagedBindingGraph, next: ManagedBindingGraph\)/);
  assert.match(coordinator, /host\.replaceGraph\(previous, next\)/);
  assert.match(container, /override fun replaceGraph\(expected: ManagedBindingGraph, next: ManagedBindingGraph\)/);
  assert.match(container, /accountState\.value = account/);
  assert.match(coordinator, /identity::commit/);
  assert.match(coordinator, /onOwnershipCommitted\(\)/);
  assert.match(container, /private val committed = AtomicBoolean\(false\)/);
  assert.match(container, /if \(!committed\.get\(\)\) identity\.wipe\(\)/);
  assert.match(screen, /prepared\?\.identity\?\.wipe\(\)/);
});

test('Android Link channel injects every sync op before sealing', () => {
  const container = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AccountContainer.kt');
  const transport = read('android/core-sync/src/main/kotlin/one/zephyr/mobile/sync/LinkSyncTransport.kt');
  assert.match(transport, /private fun wireBody\(op: String, body: JsonObject\)/);
  assert.match(transport, /put\("op", JsonPrimitive\(op\)\)/);
  assert.match(transport, /channel\.syncOp\("bootstrap", wireBody\("bootstrap", body\)\)/);
  assert.match(transport, /channel\.syncOp\("changes", wireBody\("changes", body\)\)/);
  assert.match(transport, /channel\.syncOp\("push", wireBody\("push", body\)\)/);
  assert.match(transport, /channel\.syncOp\("ack", wireBody\("ack", body\)\)/);
  assert.match(transport, /private fun requireSuccessAck/);
  assert.match(transport, /LinkChannelException\(message, code, retryable, details\)/);
  assert.match(transport, /SerializationException/);
  assert.match(transport, /CancellationException/);
  assert.match(container, /kind = LinkKinds\.SYNC_OP,[\s\S]*body = body/);
  assert.match(container, /spkiPins = linkSpkiPins/);
  assert.match(container, /CoroutineExceptionHandler/);
  const api = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkApi.kt');
  assert.match(api, /is JsonObject -> ackElement/);
  const codec = readRepo('zephyr-link/internal/codec/codec.go');
  assert.match(codec, /DefaultMapType/);
  const node = readRepo('zephyr-link/internal/link/node.go');
  assert.match(node, /normalizeCBORForJSON\(ackBody\)/);
  assert.match(node, /json\.Marshal\(v\)/);
});

test('Link server strips the transport op before strict canonical push validation', () => {
  const bridge = readRepo('link-v2-sync-bridge.js');
  const routes = readRepo('mobile-v1-routes.js');
  assert.match(bridge, /const \{ op: _op, \.\.\.request \} = b/);
  assert.match(bridge, /executePushForDevice\(auth, request\)/);
  assert.match(routes, /executeBootstrapForDevice/);
  assert.match(routes, /executePushForDevice[\s\S]*validatePushRequest\(body\)/);
  assert.match(routes, /registry_mismatch/);
});

test('root recovers an absent account instead of drawing a permanent blank frame', () => {
  const root = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  assert.match(root, /if \(account == null\)/);
  assert.match(root, /withContext\(Dispatchers\.IO\).*container\.ensureLocalWorkspace\(\)\.activate\(\)/s);
  assert.match(root, /CircularProgressIndicator/);
  assert.match(root, /工作区恢复失败/);
  assert.match(root, /recoveryAttempt \+= 1/);
  assert.doesNotMatch(root, /account == null -> Box\(Modifier\.fillMaxSize\(\)\)/);
});

test('startup sync recovery resets incomplete generations and avoids duplicate rounds', () => {
  const account = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AccountContainer.kt');
  const coordinator = read('android/app/src/main/kotlin/one/zephyr/mobile/app/binding/BindingCoordinator.kt');
  const engine = read('android/core-sync/src/main/kotlin/one/zephyr/mobile/sync/SyncEngine.kt');
  assert.match(account, /accountDatabaseRequiresBootstrap\(\)/);
  assert.match(account, /BindingState\.BOUND_NEEDS_BOOTSTRAP/);
  assert.match(coordinator, /if \(graph\.accountDatabaseRequiresBootstrap\(\)\)/);
  assert.match(coordinator, /graph\.runForegroundRound\(\)/);
  assert.doesNotMatch(engine, /scope\.launch \{ run\(SyncTrigger\.FOREGROUND_START/);
  assert.match(engine, /suspend fun onForegroundStart\(\)/);
});

test('server never caches a failed Go device registration', () => {
  const proxy = readRepo('link-v2-go-proxy.js');
  assert.match(proxy, /throw failure/);
  assert.match(proxy, /await registerDevice\(deviceId\);\s*registered\.add\(deviceId\)/s);
  assert.doesNotMatch(proxy, /ensureDevice\(deviceId\)\s*\.catch\(\(\) => \{\}\)\s*\.finally/s);
  assert.match(proxy, /link_device_registration_failed/);
});

test('embedded Link runtime has a CI freshness gate like the AI runtime', () => {
  const workflow = readRepo('.github/workflows/zephyr-one-mobile.yml');
  assert.match(workflow, /libzephyr_link\.so/);
  assert.match(workflow, /zephyr-link/);
  assert.match(workflow, /cmd\/zephyr-link-android/);
});
