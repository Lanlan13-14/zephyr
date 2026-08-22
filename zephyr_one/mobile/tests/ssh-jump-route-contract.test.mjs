import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('jump planner treats a bare connection id as a hop like the main end', () => {
  const planner = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshRoute.kt');
  /* Main-end resolveRoutePlan: jumpHostIds entries that name no jumpHost
   * resource are themselves connection ids. The old mobile planner rejected
   * them as dependency_missing, which made every jump route saved on the
   * server read as "not configured" on the phone. */
  assert.match(planner, /jumpHosts\[jumpId\][\s\S]*connections\[jump\?\.connectionId \?: jumpId\]/);
  assert.match(planner, /Protocol\.SSH/);
});

test('the SSH engine dials the resolved chain instead of refusing routed sessions', () => {
  const engine = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
  /* The old engine answered route_unsupported for anything but a direct hop.
   * The fix connects each hop through connectVia on the previous client's
   * direct-tcpip channel, the same shape as the main end's forwardOut loop. */
  assert.match(engine, /connectVia\(from\.newDirectConnection/);
  assert.doesNotMatch(engine, /route_unsupported[\s\S]*跳板链/);
  assert.match(engine, /RouteHop\.SshJump/);
});

test('every hop gets its own host-key decision keyed by the hop address', () => {
  const engine = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
  /* A jump fingerprint must never be shown (or trusted) as the target's. Each
   * hop carries its own RecordingVerifier bound to the hop's host:port, and the
   * first untrusted hop is the one the user is asked about. */
  const connect = engine.slice(engine.indexOf('override suspend fun connect'), engine.indexOf('override fun output'));
  assert.match(connect, /RecordingVerifier\(jump\.host, jump\.port\)/);
  assert.match(connect, /RecordingVerifier\(target\.host, target\.port\)/);
  assert.match(connect, /PendingHostKey\(jump\.host, jump\.port, key\)/);
});

test('a closed jump session closes the whole chain', () => {
  const engine = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
  /* Closing only the target client would leave the jump transports (and their
   * direct-tcpip channels) open on the network. */
  const close = engine.slice(engine.indexOf('fun close()'), engine.indexOf('private enum class ConnectStage'));
  assert.match(close, /chain\.forEach\(::closeQuietly\)/);
});

test('dialers resolve the stored route rather than always dialling direct', () => {
  const root = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  const pool = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ManagedSshSessionPool.kt');
  const tester = read('android/app/src/main/kotlin/one/zephyr/mobile/app/SshConnectionTester.kt');
  const host = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SshTerminalHost.kt');

  /* The regression: every dialer hard-coded SshRoute([Target]) and the planner
   * was dead code, so a configured jump/proxy chain was silently ignored and
   * the unreachable direct target read as "not configured / unusable". The
   * terminal host was the last remaining bypass after PR #45. */
  assert.match(root, /accountRoutePlanner\(account\)/);
  assert.match(pool, /routePlanner\.plan\(connection\)/);
  assert.doesNotMatch(pool, /route = SshRoute\(listOf\(RouteHop\.Target\(connection\.host, connection\.port\)\)\)/);
  assert.match(tester, /routePlanner\(connection\)/);
  assert.match(host, /routePlanner\(connection\)/);
  assert.doesNotMatch(host, /val route = SshRoute\(listOf\(RouteHop\.Target\(request\.host, request\.port\)\)\)/);
});

test('every hop authenticates with its own stored secrets not the target\'s', () => {
  const engine = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
  const request = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshEngine.kt');
  const root = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  /* Main-end createRoutedSSHConnection calls connectSSHClient(hop) per hop.
   * Reusing request.credential (the target's password) on a jump is the
   * failure that made a working jump on the server fail on the phone. */
  assert.match(request, /val hopCredentials: Map<String, HopAuth>/);
  assert.match(engine, /authenticateHop\(hopClient, jump, request\)/);
  assert.match(engine, /request\.hopCredentials\[jump\.connectionId\]/);
  assert.match(root, /fun AccountContainer\.hopAuthFor/);
  assert.match(root, /hopAuthProvider = \{ route -> account\.hopAuthFor\(route\) \}/);
});

test('the editor jump picker lists SSH connections like the main end', () => {
  const screen = read('android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt');
  const vm = read('android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorViewModel.kt');
  /* JumpChainEditor existed but RouteSection never composed it: tapping the
   * JUMP row silently added the first JumpHost resource, and SSH connections
   * (what the main end actually stores in jumpHostIds) were not even listed. */
  assert.match(screen, /ConnectionMode\.JUMP -> JumpChainEditor\(ui, onIntent\)/);
  assert.match(screen, /for \(connection in ui\.jumpConnections\)/);
  assert.match(vm, /val jumpConnections: List<Connection>/);
  assert.match(vm, /row\.protocol == Protocol\.SSH/);
});

test('main-end jump resolution semantics are pinned in one place', () => {
  const server = fs.readFileSync(path.join(REPO, '..', 'server.js'), 'utf8');
  const resolver = server.slice(server.indexOf('const jumpHostIds = normalizeJumpHostIds'), server.indexOf('async function createRoutedSSHConnection'));
  /* The mobile planner follows this exact rule: a jumpHostConfig's connectionId
   * wins, otherwise the raw id is itself the connection id. */
  assert.match(resolver, /jumpHostConfig\?\.connectionId \|\| rawJumpHostId/);
  assert.match(resolver, /跳板机必须是 SSH 连接/);
});
