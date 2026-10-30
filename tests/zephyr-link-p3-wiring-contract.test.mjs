import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Desktop owned-sync injects OneLinkSyncSession and can fall back to HTTPS', () => {
  const embed = read('zephyr-one-link-embed.js');
  const sync = read('zephyr-one-link-sync.js');
  const server = read('server.js');
  assert.match(embed, /class OneLinkSyncSession/);
  assert.match(embed, /\/link\/push/);
  const session = embed.slice(embed.indexOf('class OneLinkSyncSession'));
  const posts = [...session.matchAll(/this\._post\('([^']+)'/g)].map((row) => row[1]);
  assert.deepEqual(posts.sort(), ['/link/dial', '/link/dial/finish', '/link/push'].sort());
  assert.match(sync, /linkClient/);
  assert.match(sync, /OWNED_SYNC_PATHS/);
  assert.match(sync, /link_embed_missing/);
  assert.match(sync, /_ownedSyncHttpsFallback/);
  assert.match(server, /OneLinkSyncSession/);
  assert.match(server, /linkClient/);
  assert.equal((server.match(/\n/g) || []).length + 1 >= 12000, true, 'server.js must not have been truncated');
});

test('iOS LinkSyncTransport uses sinceCursor and optional HTTPS default', () => {
  const transport = read('zephyr_one/mobile/ios/Sources/ZephyrCore/LinkSyncTransport.swift');
  const coordinator = read('zephyr_one/mobile/ios/Sources/ZephyrCore/MobileBindingCoordinator.swift');
  assert.match(transport, /protocol LinkChannel/);
  assert.match(transport, /class LinkSyncTransport/);
  assert.match(transport, /sinceCursor/);
  assert.doesNotMatch(transport, /isEstablished.*return/);
  assert.match(coordinator, /linkChannel: \(any LinkChannel\)\? = nil/);
  assert.match(coordinator, /RefreshingSyncTransport/);
});

test('Android D1 importDecisionRequired skips PUSH_PENDING and migrates additively', () => {
  const actor = read('zephyr_one/mobile/android/core-sync/src/main/kotlin/one/zephyr/mobile/sync/SyncActor.kt');
  const entity = read('zephyr_one/mobile/android/core-data/src/main/kotlin/one/zephyr/mobile/data/db/SyncEntities.kt');
  const db = read('zephyr_one/mobile/android/core-data/src/main/kotlin/one/zephyr/mobile/data/db/ZephyrDatabase.kt');
  const tests = read('zephyr_one/mobile/android/core-sync/src/test/kotlin/one/zephyr/mobile/sync/SyncActorTest.kt');
  assert.match(entity, /import_decision_required/);
  assert.match(db, /version = 4/);
  assert.match(db, /ADD COLUMN import_decision_required INTEGER NOT NULL DEFAULT 0/);
  assert.match(actor, /if \(store\.importDecisionRequired\(\)\)/);
  assert.match(actor, /BIND_COMPLETE && store\.hasPreexistingLocalData\(\)/);
  assert.match(tests, /importDecisionRequired skips push and keeps pending ops/);
  const schema = read('zephyr_one/mobile/android/core-data/schemas/one.zephyr.mobile.data.db.ZephyrDatabase/4.json');
  assert.match(schema, /import_decision_required/);
});


test('Android first-bind pending count uses a generated Room DAO query', () => {
  const store = read('zephyr_one/mobile/android/core-sync/src/main/kotlin/one/zephyr/mobile/sync/RoomSyncLocalStore.kt');
  const dao = read('zephyr_one/mobile/android/core-data/src/main/kotlin/one/zephyr/mobile/data/db/SyncDao.kt');
  assert.match(store, /pendingOperationDao\(\)\.count\(\)/);
  assert.match(dao, /@Query\("SELECT COUNT\(\*\) FROM pending_operations"\)\s+suspend fun count\(\): Int/);
});
