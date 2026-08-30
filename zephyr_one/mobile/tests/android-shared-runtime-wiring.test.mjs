import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

test('home connection list refreshes shared-to-me resources without persisting them', () => {
  const root = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  const viewModel = read('android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionListViewModel.kt');
  const container = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AccountContainer.kt');
  const store = read('android/core-data/src/main/kotlin/one/zephyr/mobile/data/repository/SharedResourceStore.kt');
  const relay = read('android/app/src/main/kotlin/one/zephyr/mobile/app/SharedRelayTerminalHost.kt');
  const terminal = read('android/feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/TerminalViewModel.kt');
  const coordinator = read('android/core-sync/src/main/kotlin/one/zephyr/mobile/sync/SharedResourceCoordinator.kt');

  assert.match(root, /sharedCoordinator = account\.sharedResourceCoordinator/);
  assert.match(viewModel, /runCatching \{ sharedCoordinator\?\.refresh\(\) \}/);
  assert.match(container, /SharedResourceCoordinator/);
  assert.match(container, /if \(state\.connected\) runCatching \{ sharedResourceCoordinator\.refresh\(\) \}/);
  assert.match(coordinator, /client\.detail\(resource\.resourceType, resource\.resourceId\)/);
  assert.match(coordinator, /!detail\.value\.protocol\.isNullOrBlank\(\)/);
  assert.match(root, /SharedRelayTerminalHost\(account, ownedHost\)/);
  assert.match(root, /connection\.residency == Residency\.SHARED_ONLINE_ONLY[\s\S]*TerminalCredentials\(\)/);
  assert.match(terminal, /findConnection: suspend \(String\) -> Connection\?/);
  assert.match(relay, /sharedResourceClient\.openRelaySession/);
  assert.match(relay, /requestedChannels = listOf\("terminal", "resize"\)/);
  assert.match(relay, /\.header\("Sec-WebSocket-Protocol", "zephyr-shared-relay-v1, \$\{session\.credential\}"\)/);
  assert.match(relay, /\\\"type\\\":\\\"input\\\"/);
  assert.match(relay, /\\\"type\\\":\\\"resize\\\"/);
  assert.doesNotMatch(store, /import androidx\.room|\bSharedPreferences\b|java\.io\.File/);
});
