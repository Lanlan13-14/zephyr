import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(MOBILE_ROOT, 'ios', 'Sources', 'ZephyrCore');
const TESTS = path.join(MOBILE_ROOT, 'ios', 'Tests', 'ZephyrCoreTests');

const read = (directory, name) => fs.readFileSync(path.join(directory, name), 'utf8');
const compact = (source) => source.replace(/\s+/g, ' ').trim();

const coordinator = read(CORE, 'MobileBindingCoordinator.swift');
const apiClient = read(CORE, 'MobileApiClient.swift');
const scheduler = read(CORE, 'SyncScheduler.swift');
const engine = read(CORE, 'SyncEngine.swift');
const pushCoordinator = read(CORE, 'PushNotificationCoordinator.swift');
const coordinatorTests = read(TESTS, 'MobileBindingCoordinatorTests.swift');
const engineTests = read(TESTS, 'SyncEngineTests.swift');
const schedulerTests = read(TESTS, 'SyncSchedulerTests.swift');

test('iOS terminal callbacks are async and awaited by every network producer', () => {
  assert.match(
    compact(engine),
    /typealias MobileServerRevocationHandler = @Sendable \(MobileServerRevocationReason\) async -> Void/,
  );
  assert.match(engine, /await serverRevocationHandler\(reason\)/);
  assert.match(scheduler, /await serverRevocationHandler\(reason\)/);
  assert.match(
    compact(coordinator),
    /await self\?\.handleReportedServerRevocation\(reason, for: identity\)/,
  );
});

test('terminal wake isolates all network work before durable I/O and callback handoff', () => {
  const source = compact(scheduler);
  const terminalStart = source.indexOf(
    'if let reason = MobileServerRevocationReason(errorCode: outcome.failureCode)',
  );
  const isolate = source.indexOf('await isolateForTerminalRevocation()', terminalStart);
  const fence = source.indexOf('await persistTerminalRevocationFence()', terminalStart);
  const callback = source.indexOf('await serverRevocationHandler(reason)', terminalStart);

  assert.ok(terminalStart >= 0 && terminalStart < isolate && isolate < fence && fence < callback);
  assert.match(
    source,
    /private func isolateForTerminalRevocation\(\) async \{[^]*invalidated = true[^]*sync\?\.cancel\(\)[^]*await syncCancellation\(\.revocation\)/,
  );
  assert.match(source, /if !wasInvalidated \{ stream\?\.cancel\(\) \}/);
  assert.match(source, /private func persistTerminalRevocationFence\(\) async \{[^]*while true/);
});

test('restore owns an exact active-to-restoring lease before every side effect', () => {
  const source = compact(coordinator);
  const restoreStart = source.indexOf('public func restore() async throws');
  const restoreEnd = source.indexOf('public func cancelTransientWork()', restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);

  const restoringCAS = restore.indexOf('record.record.replacingPhase(.restoring), expected: record');
  const prepare = restore.indexOf('record: restoringSnapshot.record');
  const activeIdentity = restore.indexOf('let activeIdentity = syncRepositoryIdentity(record)');
  const fence = restore.indexOf('repository.fenceRuntime( from: activeIdentity, to: restoringIdentity )');
  const fencedSnapshot = restore.indexOf('snapshot.runtimeLeaseState == .fenced');
  const reconcile = restore.indexOf('prepared.credentials.reconcileLease(');
  const network = restore.indexOf('api.capabilities()');
  const activeCAS = restore.indexOf('updatedRecord, expected: restoringSnapshot');
  const publish = restore.indexOf(
    'repository.publishRuntime( from: restoringIdentity, to: finalIdentity )',
  );
  const leaseHandoff = restore.indexOf(
    'prepared.credentials.replaceLease(finalLease, expected: restoringLease)',
  );
  const runtime = restore.indexOf('let restored = try prepared.makeRuntime(');

  assert.ok(restoringCAS >= 0);
  assert.ok(activeIdentity >= 0 && activeIdentity < restoringCAS);
  assert.ok(restoringCAS < prepare && prepare < fence && fence < fencedSnapshot);
  assert.ok(fencedSnapshot < reconcile && reconcile < network && network < activeCAS);
  assert.ok(activeCAS < publish && publish < leaseHandoff && leaseHandoff < runtime);
  assert.match(restore, /catch MobileBindingRestoreAbort\.ownershipLost/);
  assert.match(restore, /ownedSnapshot: ownedSnapshot,[^]*credentialSourceLease: credentialLease/);
  assert.doesNotMatch(restore, /updatedRecord, expected: record/);
});

test('bind side effects are generation-leased and stale compensation cannot erase a winner', () => {
  const source = compact(coordinator);
  const bindStart = source.indexOf('public func bind(');
  const bindEnd = source.indexOf('public func restore()', bindStart);
  const bind = source.slice(bindStart, bindEnd);

  const insert = bind.indexOf('recordStore.insertIfAbsent(preliminaryRecord)');
  const activate = bind.indexOf('prepared.credentials.activateLease(bindingLease)');
  const credential = bind.indexOf('prepared.credentials.storeInitial(');
  const activeCAS = bind.indexOf('record, expected: inserted');
  const repository = bind.indexOf('prepared.makeRepository(activeIdentity)');
  const leaseHandoff = bind.indexOf(
    'prepared.credentials.replaceLease(activeLease, expected: bindingLease)',
  );
  const runtime = bind.indexOf('let runtime = try prepared.makeRuntime(');

  assert.ok(insert >= 0 && insert < activate && activate < credential);
  assert.ok(credential < activeCAS && activeCAS < leaseHandoff);
  assert.ok(leaseHandoff < repository && repository < runtime);
  assert.equal((bind.match(/requireBindingOwnership\(/g) || []).length, 3);
  assert.match(bind, /bindReceipt: bindAttempt\.receipt/);
  assert.match(bind, /bindAttempt: bindAttempt/);
  assert.match(
    source,
    /guard let persisted = try recordStore\.replace\([^]*expected: ownedSnapshot[^]*else \{ return \[\.bindingRecord\] \}/,
  );
  assert.match(source, /runtime\?\.beginCleanupHandoff\(\)/);
});

test('public runtime and push entry points share one atomic lifecycle fence', () => {
  const source = compact(coordinator);
  assert.match(source, /func acquire\(\) -> Permit\? \{[^]*return accepting \? Permit\(\) : nil/);
  for (const signature of [
    'public func start()',
    'public func applicationDidEnterForeground()',
    'public func applicationDidEnterBackground()',
    'public func trigger(',
  ]) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} must remain public`);
    assert.ok(
      source.indexOf('dataPlaneGuard.acquire()', start) >= start,
      `${signature} must acquire the lifecycle permit`,
    );
  }
  assert.match(source, /private let engine: SyncEngine private let scheduler: SyncScheduler/);
  assert.doesNotMatch(source, /public let repository/);
  assert.doesNotMatch(compact(engine), /public init\( transport:/);
  assert.doesNotMatch(compact(scheduler), /public init\( identity:/);
  assert.match(compact(engine), /public func request\([^]*guard !invalidated else \{ return \[\] \}/);
  assert.match(compact(engine), /private func cancelActiveBinding\([^]*invalidated = true/);
  assert.match(compact(pushCoordinator), /public init\(runtime: MobileBindingRuntime\)/);
  assert.match(compact(pushCoordinator), /await runtime\.trigger\(/);
});

test('reported revocation closes admission, commits a marker, then joins and cleans', () => {
  const source = compact(coordinator);
  const reportStart = source.indexOf('private func handleReportedServerRevocation(');
  const reportEnd = source.indexOf('private func finishReportedServerRevocation(', reportStart);
  const report = source.slice(reportStart, reportEnd);
  assert.ok(report.indexOf('matchingRuntime?.beginCleanupHandoff()') >= 0);
  assert.ok(
    report.indexOf('matchingRuntime?.beginCleanupHandoff()')
      < report.indexOf('let fenceTask = Task'),
  );

  const durableStart = source.indexOf('private func establishDurableRevocationFence(');
  const durableEnd = source.indexOf('private func finishServerRevocationCleanup(', durableStart);
  const durable = source.slice(durableStart, durableEnd);
  const marker = durable.indexOf('persistCleanupMarker( for: identity');
  const runtimeFence = durable.indexOf('fenceRepositoryForCleanup(', marker);
  const markerRevalidation = durable.indexOf('recordStore.load() == cleanupSnapshot', runtimeFence);
  assert.ok(marker >= 0 && marker < runtimeFence && runtimeFence < markerRevalidation);
  assert.match(durable, /while serverRevocationCleanupIdentity == identity/);

  const finishStart = source.indexOf('private func finishReportedServerRevocation(');
  const finishEnd = source.indexOf('private func establishDurableRevocationFence(', finishStart);
  const finish = source.slice(finishStart, finishEnd);
  const cancel = finish.indexOf('cancelAndJoin(reason: .revocation)');
  const destroy = finish.indexOf('destroyBinding( reason: .revocation');
  assert.ok(cancel >= 0 && cancel < destroy);
});

test('explicit revoke persists exact intent before cancellation and management traffic', () => {
  const source = compact(coordinator);
  const revokeStart = source.indexOf('public func revoke(secret: String) async throws');
  const handoff = source.indexOf('targetRuntime.beginCleanupHandoff()', revokeStart);
  const marker = source.indexOf('persistCleanupMarker(', handoff);
  const repositoryFence = source.indexOf(
    'fenceRepositoryForCleanup( targetRuntime.syncRepository,',
    marker,
  );
  const isolate = source.indexOf('await targetRuntime.cancelAndJoin(reason: .revocation)', repositoryFence);
  const verify = source.indexOf('targetRuntime.managementAPI.verifySensitive(', repositoryFence);
  const remoteRevoke = source.indexOf('targetRuntime.managementAPI.revokeDevice(', verify);
  const destroy = source.indexOf('guard try await destroyBinding(', remoteRevoke);

  assert.ok(revokeStart < handoff && handoff < marker && marker < repositoryFence);
  assert.ok(repositoryFence < isolate && isolate < verify);
  assert.ok(verify < remoteRevoke && remoteRevoke < destroy);
  assert.match(source, /expectedSnapshot: loaded/);
});

test('cleanup requires exact marker ownership and a terminal credential tombstone before purge', () => {
  const source = compact(coordinator);
  const teardownStart = source.indexOf('private func destroyBinding(');
  const teardown = source.slice(teardownStart);
  const handoff = teardown.indexOf('currentRuntime?.beginCleanupHandoff()');
  const marker = teardown.indexOf('storedSnapshot.record.replacingPhase(.cleanupPending)');
  const repositoryFence = teardown.indexOf('fenceRepositoryForCleanup(');
  const revalidate = teardown.indexOf('guard try recordStore.load() == cleanupSnapshot');
  const reconcile = teardown.indexOf('cleanupCredentials.reconcileLease(');
  const terminate = teardown.indexOf('cleanupCredentials.terminateLease(cleanupLease)');
  const cancel = teardown.indexOf('await currentRuntime?.cancelAndJoin(reason: reason)');
  const purge = teardown.indexOf('cleanupRepository.purgeAll(for: cleanupIdentity)');

  assert.ok(handoff >= 0 && handoff < marker && marker < revalidate);
  assert.ok(revalidate < repositoryFence && repositoryFence < reconcile);
  assert.ok(reconcile < terminate);
  assert.ok(terminate < cancel && cancel < purge);
  assert.match(
    teardown,
    /guard let persisted = try recordStore\.replace\([^]*else \{ return false \}/,
  );
  assert.match(teardown, /replacing: credentialSourceLease/);
  assert.match(teardown, /recordStore\.clear\(expected: cleanupSnapshot\)/);
  assert.match(teardown, /purgeAll\(for: cleanupIdentity\)/);
  assert.doesNotMatch(teardown, /removeForUnbind|removeForRevocation/);
});

test('Swift behavior tests cover restore leases, process kills, and cleanup races', () => {
  for (const name of [
    'testRestoreAcquiresRestoringCASBeforePreparingAnySideEffect',
    'testRestoreProcessKillAfterRestoringMarkerResumesCleanupOnly',
    'testRestoreProcessKillAfterActiveCASCannotPublishStaleLease',
    'testRestoreLeaseOwnerLossCannotPublishOrPurgeWinner',
    'testFenceRuntimeFailureFailsClosedIntoExactCleanup',
    'testPublishRuntimeFailureNeverConstructsOrStartsRuntime',
    'testSameGenerationStaleRuntimeCannotCommitInFlightResponseAfterRestorePublishes',
    'testCleanupMarkerCASLossNeverPurgesReplacementGeneration',
    'testCleanupFailureRetainsScopedRecordAndCanBeRetried',
    'testFirstStartRevocationIsFencedAndCannotPublishTheRuntime',
    'testRevocationRebuildsMissingRecordFromRuntimeSummary',
    'testRevocationDoesNotOverwriteUnreadableRecordAndRetriesCleanupInProcess',
    'testRevocationRecordSaveFailureRecoversAfterCrashFromRepositoryFence',
    'testExplicitRevocationRecordLoadFailureFencesAndRetriesToCompletion',
    'testExplicitRevocationRecordSaveFailureRetainsSentinelAndRetries',
    'testActiveBindingWithUnopenableRepositoryIsCryptoErasedBeforeNetwork',
    'testTerminalSyncCleanupFailureRetainsMarkerAndRetriesInProcess',
    'testExplicitRevokeProcessKillWindowRestartsAsCleanupOnly',
    'testExplicitRevokeRemoteFailureStaysCleanupOnlyAndCanRetry',
    'testTwoSceneBindBWinsWhenSceneAResponseArrivesLate',
    'testBindOwnershipLossAfterSensitiveVerifyStopsBeforeRemoteBind',
    'testServerRevisionConflictCompensatesOnlyRejectedGeneration',
  ]) {
    assert.match(coordinatorTests, new RegExp(`func ${name}\\b`), `${name} must remain covered`);
  }
  assert.match(engineTests, /func testTerminalServerCallbackIsAwaitedBeforeRequestReturns\b/);
  assert.match(schedulerTests, /\["isolate", "fence", "handler"\]/);
});

test('iOS conditional bind models consume and redact the frozen v2 authorities', () => {
  const source = compact(apiClient);
  assert.match(source, /struct MobileBindAttempt: Codable[^]*expectedBindingRevision: Int/);
  assert.match(source, /expectedRefreshGeneration: Int/);
  assert.match(source, /bindingProtocolVersion: Int\?/);
  assert.match(source, /bindAttempt: MobileBindAttempt\?/);
  assert.match(source, /struct MobileDeviceBindRequest:[^]*bindingProtocolVersion: Int[^]*bindReceipt: String/);
  assert.match(source, /struct MobileDeviceBindResponse:[^]*bindingRevision: Int[^]*bindingToken: String/);
  assert.match(source, /sensitiveValues: \[request\.tokenId, request\.bindReceipt\]/);
  assert.doesNotMatch(source, /description[^]*receipt=\\\(receipt\)/);
  assert.match(compact(coordinator), /response\.bindingRevision == bindAttempt\.expectedBindingRevision \+ 1/);
});
