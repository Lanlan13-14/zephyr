import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const android = path.join(root, 'zephyr_one/mobile/android');
const read = file => fs.readFileSync(path.join(android, file), 'utf8');
const app = 'app/src/main/kotlin/one/zephyr/mobile/app/';
const data = 'core-data/src/main/kotlin/one/zephyr/mobile/data/';
const sync = 'core-sync/src/main/kotlin/one/zephyr/mobile/sync/';

test('first import is armed from separate local workspace before network producers', () => {
  const graph = read(app + 'di/AccountContainer.kt');
  const activate = graph.slice(graph.indexOf('override suspend fun activate()'), graph.indexOf('override fun startNetworkProducers()'));
  assert.ok(activate.indexOf('localImport.prepare()') > 0);
  assert.ok(activate.indexOf('localImport.prepare()') < activate.indexOf('networkEnabled.set(true)'));
  const coordinator = read(app + 'di/LocalImportCoordinator.kt');
  assert.match(coordinator, /AccountContainer\.databaseScopeOf\(sourceBinding\)/);
  assert.match(coordinator, /listByType\(it.type, sourceBinding.userId\)/);
  assert.match(coordinator, /SecretStore\.SecretScope\(sourceBinding\.serverProfileId, sourceBinding\.userId/);
  assert.match(coordinator, /target\.acceptsLocalImport/);
  assert.doesNotMatch(coordinator, /database\.close\(|wipeBindingState|ownerUserId\s*=\s*sourceBinding/);
});

test('first import copy choice and per-entity receipts survive interruption without duplicate ids', () => {
  const coordinator = read(app + 'di/LocalImportCoordinator.kt');
  assert.match(coordinator, /preference\("\$preferenceKey\.batch"\)/);
  assert.match(coordinator, /check\(pending == null\)/);
  assert.match(coordinator, /Resume the original credential choice/);
  assert.match(coordinator, /Resume the original type selection/);
  assert.match(coordinator, /commitReceipt = DevicePreferenceRow/);
  assert.match(coordinator, /requireAbsent = true/);
  assert.match(coordinator, /commitGuard = ::assertCurrent/);
  const gateway = read(data + 'LocalWriteGateway.kt');
  assert.match(gateway, /val roomCommit:[\s\S]*commitGuard\(\)[\s\S]*requireAbsent[\s\S]*commitReceipt\?\.let/);
  assert.match(gateway, /secretJournal\.commitBatch\([\s\S]*roomCommit = roomCommit/);
  assert.match(coordinator, /withExclusiveLocalWrite/);
  const actor = read(sync + 'SyncActor.kt');
  assert.match(actor, /withExclusiveLocalWrite[\s\S]*storeLock\.withLock/);
  assert.match(actor, /val result = storeLock\.withLock \{ runRound/);
});

test('preview defaults to no copy and no credentials and is actually mounted', () => {
  const ui = read(app + 'LocalImportDialog.kt');
  assert.match(ui, /mutableStateOf\(emptySet<String>\(\)\)/);
  assert.match(ui, /var credentials[\s\S]*mutableStateOf\(false\)/);
  assert.match(ui, /var confirmed[\s\S]*mutableStateOf\(false\)/);
  assert.match(ui, /decideLocalImport\(emptySet\(\), false, false\)/);
  assert.match(ui, /selected\.isNotEmpty\(\) && confirmed/);
  assert.match(ui, /view\.pendingTypes == null/);
  assert.match(read(app + 'ZephyrOneRoot.kt'), /LocalImportDialog\(account/);
});

test('instrumentation is a remote execution gate and release cannot skip it', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/zephyr-one-mobile.yml'), 'utf8');
  assert.match(workflow, /android-import-transactions:/);
  assert.match(workflow, /android-emulator-runner@v2/);
  assert.match(workflow, /:core-data:connectedDebugAndroidTest/);
  assert.match(workflow, /LocalImportTransactionTest/);
  assert.match(workflow, /needs: \[contracts, android, android-import-transactions, ios\]/);
  assert.match(workflow, /needs\.android-import-transactions\.result == 'success'/);
});
