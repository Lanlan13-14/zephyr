import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const android = path.resolve(here, '..', 'android');
const read = (relative) => fs.readFileSync(path.join(android, relative), 'utf8');

test('sync failures attach phase-specific local diagnostics before persistence', () => {
  const api = read('core-network/src/main/kotlin/one/zephyr/mobile/network/MobileApi.kt');
  const client = read('core-network/src/main/kotlin/one/zephyr/mobile/network/MobileApiClient.kt');
  const actor = read('core-sync/src/main/kotlin/one/zephyr/mobile/sync/SyncActor.kt');
  const store = read('core-sync/src/main/kotlin/one/zephyr/mobile/sync/RoomSyncLocalStore.kt');

  for (const phase of ['capabilities', 'sync.bootstrap', 'sync.changes', 'sync.push', 'sync.ack']) {
    assert.match(api, new RegExp(JSON.stringify(phase).slice(1, -1)));
  }
  assert.match(client, /device-proof validate: challenge fields do not match request binding/);
  assert.match(actor, /sync actor validate: \$message/);
  assert.match(store, /error\.persistedDiagnosticText\(\)/);
});

test('incremental secret downlink seals and opens under the field revision', () => {
  const hydrate = fs.readFileSync(path.join(here, '..', '..', '..', 'mobile-v1-routes.js'), 'utf8');
  assert.match(hydrate, /this\.store\.fieldRevision\(/);
  assert.match(hydrate, /unsupported: true/);
  assert.match(hydrate, /needsSecretDownlink/);
  assert.match(hydrate, /mask\.length === 0 \|\| secretTouched/);
  const store = fs.readFileSync(path.join(here, '..', '..', '..', 'mobile-v1-store.js'), 'utf8');
  assert.match(store, /fieldRevision\(ownerUserId, entityType, entityId, fieldPath\)/);

  const opener = read('core-sync/src/main/kotlin/one/zephyr/mobile/sync/DeviceEnvelopeOpener.kt');
  assert.match(opener, /envelope\.entityRevision/);
  assert.match(opener, /change\.revision/);

  const writer = read('core-data/src/main/kotlin/one/zephyr/mobile/data/MirrorWriter.kt');
  assert.match(writer, /retainedSecretsFor/);
  assert.match(writer, /retainedSecrets: Map<String, ByteArray> = emptyMap\(\)/);
  assert.match(writer, /isSkippableInboundChange/);
  assert.match(writer, /change\.unsupported/);

  const actor = read('core-sync/src/main/kotlin/one/zephyr/mobile/sync/SyncActor.kt');
  assert.match(actor, /SecretPayloadViolationException/);
  assert.match(actor, /unsafe inbound secret payload/);

  const dto = read('core-network/src/main/kotlin/one/zephyr/mobile/network/dto/MobileDtos.kt');
  assert.match(dto, /val unsupported: Boolean = false/);
});

test('remote and parser messages are not implicitly trusted as local diagnostics', () => {
  const diagnostics = read('core-model/src/main/kotlin/one/zephyr/mobile/model/MobileErrorDiagnostics.kt');
  const client = read('core-network/src/main/kotlin/one/zephyr/mobile/network/MobileApiClient.kt');
  const store = read('core-sync/src/main/kotlin/one/zephyr/mobile/sync/RoomSyncLocalStore.kt');

  assert.match(diagnostics, /details\[LOCAL_DIAGNOSTIC_DETAIL\]/);
  assert.match(diagnostics, /lineSequence\(\)/);
  assert.doesNotMatch(client, /parse\.message/);
  assert.doesNotMatch(store, /append\(error\.message/);
  assert.doesNotMatch(store, /httpStatus == null && error\.requestId != null/);
});
