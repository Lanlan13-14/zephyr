import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Contract for the second-sync bootstrap freeze (§19, §26):
 *
 * 1. A bootstrap snapshot page is a full replacement; its fieldMask is the full editable set
 *    and must never be classified as an incremental secret patch. `prepareSecrets` must carry
 *    an explicit `snapshot` flag that disables the incremental fallback, so an unopenable
 *    envelope surfaces as ENVELOPE_REJECTED (or is covered by a retained local secret)
 *    instead of being silently swallowed into a misleading missing_envelope deep in the
 *    mutation planner.
 * 2. Re-staging a snapshot over an existing mirror must retain the local mirror secret when
 *    the page's envelope cannot be opened or is absent. Only "no envelope AND no retained
 *    value" fails closed with MISSING_ENVELOPE.
 * 3. Readiness of the account database follows the promoted snapshot, not the whole round:
 *    a first round that promotes the mirror but fails a later phase must still mark the
 *    database ready, so the next launch runs a normal round instead of re-downloading the
 *    account into BOUND_NEEDS_BOOTSTRAP.
 */

const mirrorWriter = read('android/core-data/src/main/kotlin/one/zephyr/mobile/data/MirrorWriter.kt');
const accountContainer = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AccountContainer.kt');
const bindingCoordinator = read('android/app/src/main/kotlin/one/zephyr/mobile/app/binding/BindingCoordinator.kt');
const reconciliationTest = read('android/core-data/src/test/kotlin/one/zephyr/mobile/data/SecretReconciliationTest.kt');
const coordinatorTest = read('android/app/src/test/kotlin/one/zephyr/mobile/app/binding/BindingCoordinatorTest.kt');

test('prepareSecrets separates snapshot semantics from incremental-patch fallback', () => {
  assert.match(mirrorWriter, /snapshot: Boolean = false/);
  assert.match(mirrorWriter, /val incrementalFallback = !snapshot && isIncrementalSecretPatch\(change\)/);
  // Both decision sites (envelope present / envelope absent) honor the snapshot flag.
  const decisionSites = mirrorWriter.split('incrementalFallback').length - 1;
  assert.ok(decisionSites >= 3, `expected >= 3 uses of incrementalFallback, found ${decisionSites}`);
});

test('bootstrap staging passes retained mirror secrets and snapshot semantics', () => {
  assert.match(mirrorWriter, /prepareSecrets\(change, opener, retainedSecrets = retained, snapshot = true\)/);
  assert.match(mirrorWriter, /val retained = retainedSecretsFor\(change\)/);
  // The retained bytes are wiped after staging consumes them.
  assert.match(mirrorWriter, /retained\.values\.forEach \{ it\.fill\(0\) \}/);
});

test('snapshot retention is covered by JVM unit tests', () => {
  assert.match(reconciliationTest, /snapshot full-replacement mask is never treated as an incremental secret patch/);
  assert.match(reconciliationTest, /snapshot re-stage retains the local mirror secret when the envelope cannot be opened/);
  assert.match(reconciliationTest, /snapshot re-stage retains the local mirror secret when the envelope is absent/);
  assert.match(reconciliationTest, /snapshot without an envelope and without a retained secret fails closed as missing envelope/);
  assert.match(reconciliationTest, /snapshot planner re-puts a retained value so promotion stays complete/);
  assert.match(reconciliationTest, /incremental pages keep the pre-existing behavior without snapshot flag/);
});

test('readiness follows the promoted snapshot rather than the whole round', () => {
  assert.match(
    accountContainer,
    /rounds\.any \{ it\.bootstrapOutcome is BootstrapOutcome\.Complete \}/,
  );
  assert.match(bindingCoordinator, /markReadyWhenSnapshotPromoted/);
  // No whole-round `complete` gate remains on the readiness path.
  const restoreBlock = bindingCoordinator.slice(
    bindingCoordinator.indexOf('preparation.restoredGraph?.takeIf { bootstrap }'),
    bindingCoordinator.indexOf('workersMayRun = preparation.result'),
  );
  assert.ok(!/\.takeIf \{ it\.complete \}/.test(restoreBlock), 'restore path must not gate readiness on round.complete');
});

test('snapshot-promoted readiness is covered by JVM unit tests', () => {
  assert.match(coordinatorTest, /a promoted snapshot marks the database ready even when a later phase fails/);
  assert.match(coordinatorTest, /a promoted snapshot with a later failure still writes the readiness marker/);
  assert.match(coordinatorTest, /no snapshot promotion leaves the readiness marker untouched/);
});
