import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Agent bastion advertisement is explicit and disabled by default', () => {
  const state = read('zephyr_agent/lib/agent/agent_state.dart');
  const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
  const manager = read('file-agent-manager.js');
  const ui = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(state, /bastionEnabled = false/);
  assert.match(state, /json\['bastionEnabled'\] as bool\? \?\? false/);
  assert.match(controller, /'bastion': _config\.bastionEnabled/);
  assert.match(manager, /'bastion'/);
  assert.match(manager, /listBastionAgentsForUser/);
  assert.match(manager, /GET \/api\/rdp\/agent-bastions/);
  assert.match(ui, /作为跳板机/);
});

test('bastion candidate listing remains owner-scoped and online-only', () => {
  const manager = read('file-agent-manager.js');
  assert.match(manager, /listAgentsForUser\(ownerId\)\.filter/);
  assert.match(manager, /agent\.capabilities\?\.bastion === true/);
  assert.match(manager, /agent\.bastionEnabled === true/);
});

test('Link dial forwards the agent certificate-trust setting', () => {
  const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
  const runtime = read('zephyr_agent/lib/agent/platform_link_file_runtime.dart');
  const host = read('zephyr_agent/android_host/MainActivity.kt');
  const api = read('zephyr_agent/android_host/EmbeddedLinkApi.kt');
  // Self-signed deployments (allowBadCertificates=true) must let the Go
  // runtime's Link dial skip CA verification, mirroring the file WebSocket's
  // badCertificateCallback; otherwise dial always fails and bastion never
  // reports a session.
  assert.match(controller, /allowBadCertificates: _config\.allowBadCertificates/);
  assert.match(runtime, /'insecure': allowBadCertificates/);
  assert.match(host, /call\.argument<Boolean>\("insecure"\)/);
  assert.match(api, /fun dial\(serverUrl: String, deviceId: String, insecure: Boolean\)/);
  assert.match(api, /put\("insecure", insecure\)/);
});

test('Link runtime .so must be exec-able despite extractNativeLibs=false APKs', () => {
  const host = read('zephyr_agent/android_host/EmbeddedLinkProcess.kt');
  const script = read('zephyr_agent/tool/prepare_android.sh');
  // Modern APKs keep .so files page-aligned inside the APK; only an on-disk
  // file can be exec()d as the Link child process.
  assert.match(host, /resolveBinary/);
  assert.match(host, /ZipFile/);
  assert.match(host, /lib\/\$abi\/libzephyr_link\.so|entryName/);
  assert.match(script, /useLegacyPackaging = true/);
  // A missing .so must fail the build, not silently ship a crippled APK.
  assert.doesNotMatch(script, /warning: libzephyr_link\.so is not present/);
  assert.match(script, /exit 1/);
});

test('loopback cleartext is whitelisted for the embedded runtime only', () => {
  const script = read('zephyr_agent/tool/prepare_android.sh');
  // Android 9+ blocks cleartext even to 127.0.0.1; the app talks plain HTTP
  // to its own Go child process on loopback, so that one host must be
  // permitted while remote cleartext stays blocked.
  assert.match(script, /network_security_config\.xml/);
  assert.match(script, /cleartextTrafficPermitted="false"/);
  assert.match(script, /127\.0\.0\.1/);
  assert.match(script, /android:networkSecurityConfig="@xml\/network_security_config"/);
});

test('Link failures surface to the agent UI instead of being swallowed', () => {
  const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
  const ui = read('zephyr_agent/lib/screens/home_screen.dart');
  assert.match(controller, /String get linkError/);
  assert.match(controller, /_linkError = error\.toString\(\)/);
  assert.match(ui, /加密通道未建立/);
  assert.match(ui, /ctrl\.linkError/);
  // Encrypted channel group stays visible while active — never vanishes upon success
  assert.match(ui, /if \(isActive\) _linkGroup\(ctrl, s\)/);
  // File sharing has its own independent toggle
  assert.match(ui, /s\.rowFileSharing/);
  assert.match(ui, /ctrl\.config\.fileSharingEnabled/);
});

test('server resolveRoutePlan accepts agent bastion prefix in jump chain', () => {
  const server = read('server.js');
  assert.match(server, /rawId\.startsWith\('agent:'\)/);
  assert.match(server, /每条跳板链最多包含一个 Agent 跳板/);
  assert.match(server, /Agent 跳板必须置于首级跳板位置/);
  assert.match(server, /firstProxy \= agentBastion/);

  const app = read('public/app.js');
  assert.match(app, /api\('\/api\/rdp\/agent-bastions'\)/);
  assert.match(app, /agent:\$\{(?:a\.agentId|id)\}/);
  assert.match(app, /在线 Agent 跳板机/);
});
