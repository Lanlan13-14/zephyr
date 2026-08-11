import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(MOBILE_ROOT, 'ios', 'Sources', 'ZephyrCore');
const CORE_TESTS = path.join(MOBILE_ROOT, 'ios', 'Tests', 'ZephyrCoreTests');

function read(directory, name) {
  return fs.readFileSync(path.join(directory, name), 'utf8');
}

test('the binding index uses cross-process versioned record CAS in the ThisDeviceOnly Keychain', () => {
  const binding = read(CORE, 'MobileBindingRecordStore.swift');
  const tests = read(CORE_TESTS, 'MobileBindingRecordStoreTests.swift');

  const storeProtocolStart = binding.indexOf('protocol MobileBindingRecordStoring');
  const storeErrorStart = binding.indexOf('enum MobileBindingRecordStoreError');
  assert.ok(storeProtocolStart >= 0, 'the binding-record store protocol must exist');
  assert.ok(storeErrorStart > storeProtocolStart, 'the binding-record error must follow the protocol');
  const storeProtocol = binding.slice(storeProtocolStart, storeErrorStart);
  assert.match(storeProtocol, /func load\(\) throws -> MobileBindingRecordSnapshot\?/);
  assert.match(
    storeProtocol,
    /func insertIfAbsent\(_ record: MobileBindingRecord\) throws -> MobileBindingRecordSnapshot\?/,
  );
  assert.match(
    storeProtocol,
    /func replace\([\s\S]*?_ record: MobileBindingRecord,[\s\S]*?expected: MobileBindingRecordSnapshot[\s\S]*?\) throws -> MobileBindingRecordSnapshot\?/,
  );
  assert.match(
    storeProtocol,
    /func clear\(expected: MobileBindingRecordSnapshot\) throws -> Bool/,
  );
  assert.doesNotMatch(storeProtocol, /expectedIdentity|func save\(|func clear\(\) throws/);

  assert.match(binding, /struct MobileBindingRecordVersion:[\s\S]*?static let byteCount = 32/);
  assert.match(
    binding,
    /struct MobileBindingRecordSnapshot:[\s\S]*?let record: MobileBindingRecord[\s\S]*?let recordVersion: MobileBindingRecordVersion/,
  );
  assert.match(
    binding,
    /SecRandomCopyBytes\(kSecRandomDefault, buffer\.count, baseAddress\)/,
    'each successful write candidate must receive an unpredictable process-independent version',
  );
  assert.match(
    binding,
    /private struct PersistedRecord:[\s\S]*?let record: MobileBindingRecord[\s\S]*?let recordVersion: Data/,
  );
  assert.match(binding, /encoder\.outputFormatting = \[\.sortedKeys\]/);
  assert.match(
    binding,
    /private static func comparisonToken\(for data: Data\)[\s\S]*?tokenMaterial\.append\(data\)[\s\S]*?SHA256\.hash/,
    'the Keychain query token must bind phase, identity, payload and record version',
  );
  assert.match(
    binding,
    /enum MobileBindingRecordPhase:[\s\S]*?case binding[\s\S]*?case active[\s\S]*?case restoring[\s\S]*?case cleanupPending/,
    'restoring must be a persisted phase rather than process-local state',
  );
  assert.match(
    binding,
    /func insertIfAbsent[\s\S]*?guard record\.phase != \.restoring[\s\S]*?invalidPhaseTransition/,
    'a restoring lease cannot be created without an active snapshot',
  );
  const transitionsStart = binding.indexOf('private static func isAllowedTransition');
  const fieldValidationStart = binding.indexOf('private static func isValidField', transitionsStart);
  assert.ok(transitionsStart >= 0 && fieldValidationStart > transitionsStart);
  const transitions = binding.slice(transitionsStart, fieldValidationStart);
  assert.match(transitions, /guard current\.identity == next\.identity else \{ return false \}/);
  assert.match(transitions, /case \(\.active, \.restoring\):[\s\S]*?next == current\.replacingPhase\(\.restoring\)/);
  assert.match(transitions, /\(\.restoring, \.active\)/);
  assert.match(transitions, /\(\.restoring, \.cleanupPending\)/);
  assert.match(transitions, /\(\.cleanupPending, \.cleanupPending\)/);
  assert.doesNotMatch(transitions, /\(\.restoring, \.restoring\)|\(\.cleanupPending, \.active\)|\(\.active, \.active\)/);
  assert.match(
    binding,
    /record\.phase == \.active \|\| record\.phase == \.restoring/,
    'active and restoring records both require a completed binding timestamp',
  );

  const protocolStart = binding.indexOf('protocol BindingRecordKeychainAccessing');
  const implementationStart = binding.indexOf('final class SystemBindingRecordKeychain');
  assert.ok(protocolStart >= 0, 'the binding-specific Keychain protocol must exist');
  assert.ok(implementationStart > protocolStart, 'the system CAS adapter must follow its protocol');

  const protocol = binding.slice(protocolStart, implementationStart);
  const implementation = binding.slice(implementationStart);
  assert.match(protocol, /AnyObject, Sendable/);
  assert.match(protocol, /func read\([\s\S]*?BindingRecordKeychainItem\?/);
  assert.match(protocol, /func insertIfAbsent\([\s\S]*?\) throws -> Bool/);
  assert.match(protocol, /func replace\([\s\S]*?matchingComparisonToken[\s\S]*?\) throws -> Bool/);
  assert.match(protocol, /func delete\([\s\S]*?matchingComparisonToken[\s\S]*?\) throws -> Bool/);

  const insertStart = implementation.indexOf('func insertIfAbsent');
  const replaceStart = implementation.indexOf('func replace', insertStart);
  const deleteStart = implementation.indexOf('func delete', replaceStart);
  assert.ok(insertStart >= 0 && replaceStart > insertStart && deleteStart > replaceStart);
  const insert = implementation.slice(insertStart, replaceStart);
  const replace = implementation.slice(replaceStart, deleteStart);
  const remove = implementation.slice(deleteStart);

  assert.match(insert, /kSecAttrGeneric\] = item\.comparisonToken/);
  assert.match(insert, /SecItemAdd\(/, 'insert must be one atomic Security operation');
  assert.match(insert, /case errSecDuplicateItem:[\s\S]*?return false/);
  assert.match(
    insert,
    /attributes\[kSecAttrAccessible\] = securityAccessibility\(accessibility\)/,
    'insert must request the declared protection class',
  );

  assert.match(replace, /query\[kSecAttrGeneric\] = expectedComparisonToken/);
  assert.match(replace, /SecItemUpdate\(/, 'replace must compare and update in one Security call');
  assert.match(replace, /kSecAttrGeneric:\s*item\.comparisonToken/);
  assert.match(replace, /case errSecItemNotFound:[\s\S]*?return false/);
  assert.match(replace, /kSecAttrAccessible:\s*securityAccessibility\(accessibility\)/);

  assert.match(remove, /query\[kSecAttrGeneric\] = expectedComparisonToken/);
  assert.match(remove, /SecItemDelete\(/, 'clear must compare and delete in one Security call');
  assert.match(remove, /case errSecItemNotFound:[\s\S]*?return false/);
  assert.match(
    implementation,
    /return kSecAttrAccessibleWhenUnlockedThisDeviceOnly/,
    'the binding record must remain unlocked-only and device-local',
  );

  assert.match(
    binding,
    /let snapshot = try Self\.decode\(item\.data\)[\s\S]*?guard item\.comparisonToken == Self\.comparisonToken\(for: item\.data\)/,
    'load must fail closed when the complete persisted record and CAS token disagree',
  );
  assert.doesNotMatch(binding, /NSLock|writeGenericPassword|deleteGenericPassword/);

  assert.match(tests, /testTwoStoresRaceToInsertAndOnlyOneWins/);
  assert.match(tests, /testTwoStoresRaceToReplaceAndOnlyOneExactVersionWins/);
  assert.match(tests, /testStaleAccountCannotClearReplacementBinding/);
  assert.match(tests, /testOldGenerationCannotReplaceOrClearSameAccountNewGeneration/);
  assert.match(tests, /testSameIdentityStaleActiveCannotOverwriteOrClearCleanupPending/);
  assert.match(tests, /testCleanupPendingCannotTransitionBackToActiveEvenWithCurrentVersion/);
  assert.match(tests, /testActiveCannotTransitionToActiveEvenWithCurrentVersion/);
  assert.match(tests, /testCleanupPendingCannotSwitchIdentityWhileRemainingCleanupPending/);
  assert.match(tests, /testOnlyOneStoreCanAcquireRestoringLeaseFromExactActiveSnapshot/);
  assert.match(tests, /testRestoringCannotAcquireASecondLease/);
  assert.match(tests, /testActiveToRestoringLeaseAcquisitionCannotMutateTheRecord/);
  assert.match(tests, /testCurrentRestoringLeaseCanPublishActiveAndStaleLeaseCannotMutateIt/);
  assert.match(tests, /testRestoringLeaseCannotPublishAnotherIdentity/);
  assert.match(tests, /testRestoringCrashStateCanOnlyFailClosedToCleanup/);
  assert.match(tests, /testRestoringCannotBeInsertedWithoutAnActiveSnapshot/);
  assert.match(tests, /testRecordVersionCannotAuthorizeAChangedExpectedRecord/);
  assert.match(tests, /testReplaceFailsClosedWhenVersionGeneratorRepeats/);
  assert.match(binding, /guard candidate\.snapshot\.recordVersion != expected\.recordVersion[\s\S]*?versionCollision/);
  assert.match(tests, /XCTAssertNotEqual\(bindingSnapshot\.recordVersion, activeSnapshot\.recordVersion\)/);
  assert.match(tests, /testIOFailuresThrowAndLeaveTheCurrentRecordIntact/);
  assert.match(tests, /testMismatchedPersistedComparisonTokenFailsClosed/);
  assert.match(tests, /insertAccessibilities[\s\S]*?\.whenUnlockedThisDeviceOnly/);
  assert.match(tests, /replaceAccessibilities[\s\S]*?\.whenUnlockedThisDeviceOnly/);
});

test('credential side effects are fenced by an exact generation lease and durable tombstone', () => {
  const credential = read(CORE, 'KeychainCredentialStore.swift');
  const transport = read(CORE, 'MobileCredentialRefreshingTransport.swift');
  const tests = read(CORE_TESTS, 'KeychainCredentialStoreTests.swift');

  assert.match(
    credential,
    /public struct GenerationSideEffectLease:[\s\S]*?let identity: SyncBindingIdentity[\s\S]*?let recordVersion: Data/,
    'the side-effect capability must bind the complete identity and opaque record version',
  );
  assert.match(
    credential,
    /init\(snapshot: MobileBindingRecordSnapshot\) throws[\s\S]*?recordVersion: snapshot\.recordVersion\.data/,
    'the credential resource lease must inherit the binding snapshot\'s random exact version',
  );
  assert.match(
    credential,
    /public struct KeychainCredentialScope:[\s\S]*?let serverID: String[\s\S]*?let accountID: String[\s\S]*?let deviceID: String[\s\S]*?let generation: String/,
  );
  assert.match(
    credential,
    /fileprivate func service\(prefix: String\)[\s\S]*?encode\(serverID\)[\s\S]*?encode\(accountID\)[\s\S]*?encode\(deviceID\)/,
    'different devices must not share credential or tombstone items',
  );
  assert.match(
    credential,
    /fileprivate var account:[\s\S]*?"generation\." \+ KeychainNamespace\.encode\(generation\)/,
    'a generation must receive an independent credential and tombstone resource',
  );

  const storeStart = credential.indexOf('public final class KeychainCredentialStore');
  const primitiveStart = credential.indexOf('enum KeychainItemAccessibility');
  assert.ok(storeStart >= 0 && primitiveStart > storeStart);
  const store = credential.slice(storeStart, primitiveStart);
  assert.match(store, /func activateLease\(_ lease: GenerationSideEffectLease\) throws/);
  assert.match(
    store,
    /func reconcileLease\([\s\S]*?_ replacement: GenerationSideEffectLease,[\s\S]*?replacing expected: GenerationSideEffectLease\?[\s\S]*?\) throws/,
  );
  assert.match(store, /func credentials\(for lease: GenerationSideEffectLease\)/);
  assert.match(store, /func storeInitial\([\s\S]*?for lease: GenerationSideEffectLease/);
  assert.match(store, /func rotate\([\s\S]*?for lease: GenerationSideEffectLease/);
  assert.match(store, /func terminateLease\(_ lease: GenerationSideEffectLease\) throws/);
  assert.doesNotMatch(
    store,
    /func removeFor(Unbind|Revocation)|SecItemDelete|deleteGenericPassword/,
    'credential cleanup must retain a tombstone rather than exposing a direct delete alias',
  );
  assert.match(
    store,
    /record\.state = \.terminated[\s\S]*?record\.accessCredential = nil[\s\S]*?record\.refreshCredential = nil[\s\S]*?record\.sid = nil[\s\S]*?items\.replace/,
    'termination must atomically replace secrets with a durable tombstone',
  );
  assert.match(
    store,
    /guard record\.lease == lease[\s\S]*?staleLease/,
    'writes and termination must reject a stale record version',
  );
  assert.doesNotMatch(store, /writeGenericPassword|deleteGenericPassword|deleteGenericPasswords|removeAllGenerations|NSLock/);

  const reconcileStart = store.indexOf('public func reconcileLease');
  const activeLeaseStart = store.indexOf('public func activeLease', reconcileStart);
  assert.ok(reconcileStart >= 0 && activeLeaseStart > reconcileStart);
  const reconcile = store.slice(reconcileStart, activeLeaseStart);
  assert.match(
    reconcile,
    /guard expected == nil \|\| record\.lease == expected else \{[\s\S]*?throw KeychainCredentialStoreError\.staleLease/,
    'the cleanup lease must reconcile from the exact predecessor unless restart recovery has revalidated the marker',
  );
  assert.match(
    reconcile,
    /record\.recordVersion = replacement\.recordVersion[\s\S]*?items\.replace/,
    'reconciliation must install cleanup snapshot N with a compare-and-set from predecessor M',
  );

  const mutationStart = store.indexOf('private func mutateActiveRecord');
  const activeReadStart = store.indexOf('private func readActiveRecord', mutationStart);
  assert.ok(mutationStart >= 0 && activeReadStart > mutationStart);
  const mutation = store.slice(mutationStart, activeReadStart);
  assert.match(mutation, /items\.replace\(/);
  assert.doesNotMatch(
    mutation,
    /insertIfAbsent|SecItemAdd/,
    'credential rotation may only perform an exact replace and may never recover an update miss by adding',
  );

  const protocolStart = credential.indexOf('protocol CredentialKeychainAccessing');
  const systemStart = credential.indexOf('final class SystemKeychainItems');
  assert.ok(protocolStart >= 0 && systemStart > protocolStart);
  const casProtocol = credential.slice(protocolStart, systemStart);
  const system = credential.slice(systemStart);
  assert.match(casProtocol, /func insertIfAbsent\([\s\S]*?\) throws -> Bool/);
  assert.match(casProtocol, /func replace\([\s\S]*?matchingComparisonToken[\s\S]*?\) throws -> Bool/);
  assert.match(system, /attributes\[kSecAttrGeneric\] = item\.comparisonToken/);
  assert.match(system, /query\[kSecAttrGeneric\] = expectedComparisonToken[\s\S]*?SecItemUpdate\(/);
  assert.match(system, /case errSecItemNotFound: return false/);
  assert.match(system, /return kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(system, /kSecUseDataProtectionKeychain: true/);
  const credentialReplaceStart = system.indexOf('func replace(\n        _ item: CredentialKeychainItem');
  const credentialBaseQueryStart = system.indexOf('private func baseQuery', credentialReplaceStart);
  assert.ok(credentialReplaceStart >= 0 && credentialBaseQueryStart > credentialReplaceStart);
  const credentialReplace = system.slice(credentialReplaceStart, credentialBaseQueryStart);
  assert.match(credentialReplace, /SecItemUpdate\(/);
  assert.match(
    credentialReplace,
    /default: throw KeychainStorageError\.status\(status\)/,
    'locked and other Keychain I/O failures must propagate rather than be treated as a miss',
  );
  assert.doesNotMatch(
    credentialReplace,
    /SecItemAdd|writeGenericPassword/,
    'the exact credential CAS adapter must not contain an update-miss add fallback',
  );

  const credentialProtocolStart = transport.indexOf('protocol MobileBindingCredentialStoring');
  const credentialExtensionStart = transport.indexOf('extension KeychainCredentialStore');
  const credentialProtocol = transport.slice(credentialProtocolStart, credentialExtensionStart);
  assert.match(credentialProtocol, /func activateLease/);
  assert.match(credentialProtocol, /func reconcileLease/);
  assert.match(credentialProtocol, /func credentials\(for lease:/);
  assert.match(credentialProtocol, /func storeInitial\([\s\S]*?for lease:/);
  assert.match(credentialProtocol, /func rotate\([\s\S]*?for lease:/);
  assert.match(credentialProtocol, /func terminateLease\(_ lease: GenerationSideEffectLease\) throws/);
  assert.doesNotMatch(
    credentialProtocol,
    /removeFor(Unbind|Revocation)|removeAllGenerations|func credentials\(\)|func rotate\([\s\S]*?refreshCredential: String\s*\) throws/,
    'the coordinator must reconcile the cleanup snapshot then explicitly terminate that lease',
  );
  assert.match(
    transport,
    /actor MobileAccessCredentialController[\s\S]*?private var lease: GenerationSideEffectLease[\s\S]*?init\([\s\S]*?lease: GenerationSideEffectLease/,
  );
  assert.match(
    transport,
    /try credentials\.rotate\([\s\S]*?for: lease/,
    'the refresh response must be committed only under the captured exact lease',
  );

  assert.match(tests, /testRotateVersusDeleteCannotRecreateRefreshCredential/);
  assert.match(tests, /testUpdateMissRetriesCASWithoutUsingUpdateMissAdd/);
  assert.match(tests, /testLockedRotateFailsClosedWithoutAnUpdateMissAddFallback/);
  assert.match(tests, /testSameIdentityGenerationADeleteCannotAffectGenerationB/);
  assert.match(tests, /testStaleRecordVersionCannotWriteRotateOrDeleteWinner/);
  assert.match(tests, /testCleanupReconcileClaimsMissingItemThenTerminatesIdempotently/);
  assert.match(tests, /testCleanupReconcilesExactSourceLeaseBeforeTerminatingSecrets/);
  assert.match(tests, /testLockedTerminationFailsClosedUntilTheExactLeaseCanBeTombstoned/);
  assert.match(tests, /testReconcileRejectsUnexpectedSameGenerationWinner/);
  assert.match(tests, /testRestartedStaleCleanupCannotRebuildOrDeleteWinnerLease/);
  assert.match(tests, /testCleanupRestartReconcilesUnknownPredecessorAfterMarkerRevalidation/);
  assert.match(tests, /testCrashRestartRecoversActiveLeaseAndTombstonePreventsReactivation/);
});
