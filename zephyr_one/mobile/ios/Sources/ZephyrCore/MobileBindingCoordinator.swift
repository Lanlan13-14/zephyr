import Foundation
import ZephyrContracts

final class MobileBindingDataPlaneGuard: @unchecked Sendable {
    final class Permit {
        fileprivate init() {}
    }

    private let lock = NSLock()
    private var accepting = true

    func disable() {
        lock.lock()
        accepting = false
        lock.unlock()
    }

    func acquire() -> Permit? {
        lock.lock()
        defer { lock.unlock() }
        return accepting ? Permit() : nil
    }
}

public final class MobileBindingRuntime: @unchecked Sendable {
    public let summary: MobileBindingSummary
    public let identity: SyncBindingIdentity
    private let engine: SyncEngine
    private let scheduler: SyncScheduler

    let syncRepository: any MobileBindingSyncRepository
    let credentials: any MobileBindingCredentialStoring
    let signingIdentity: any MobileBindingSigningIdentityManaging
    let managementAPI: any MobileBindingAPI
    let refreshController: MobileAccessCredentialController
    let sideEffectLease: GenerationSideEffectLease
    private let connectivityMonitorFactory: (@Sendable () -> any ConnectivityMonitoring)?
    private let startAction: (@Sendable () async -> [SyncRoundResult])?
    private let dataPlaneGuard: MobileBindingDataPlaneGuard

    init(
        summary: MobileBindingSummary,
        identity: SyncBindingIdentity,
        syncRepository: any MobileBindingSyncRepository,
        credentials: any MobileBindingCredentialStoring,
        signingIdentity: any MobileBindingSigningIdentityManaging,
        managementAPI: any MobileBindingAPI,
        refreshController: MobileAccessCredentialController,
        sideEffectLease: GenerationSideEffectLease,
        engine: SyncEngine,
        scheduler: SyncScheduler,
        dataPlaneGuard: MobileBindingDataPlaneGuard = MobileBindingDataPlaneGuard(),
        connectivityMonitorFactory: (@Sendable () -> any ConnectivityMonitoring)?,
        startAction: (@Sendable () async -> [SyncRoundResult])? = nil
    ) {
        self.summary = summary
        self.identity = identity
        self.syncRepository = syncRepository
        self.credentials = credentials
        self.signingIdentity = signingIdentity
        self.managementAPI = managementAPI
        self.refreshController = refreshController
        self.sideEffectLease = sideEffectLease
        self.engine = engine
        self.scheduler = scheduler
        self.dataPlaneGuard = dataPlaneGuard
        self.connectivityMonitorFactory = connectivityMonitorFactory
        self.startAction = startAction
    }

    public func start() async -> [SyncRoundResult] {
        guard let permit = dataPlaneGuard.acquire() else { return [] }
        defer { withExtendedLifetime(permit) {} }
        if let startAction { return await startAction() }
        if let connectivityMonitorFactory {
            await scheduler.attachConnectivityMonitor(connectivityMonitorFactory())
        }
        let results = await engine.request(.manual)
        await scheduler.applicationDidEnterForeground()
        return results
    }

    public func applicationDidEnterForeground() async {
        guard let permit = dataPlaneGuard.acquire() else { return }
        defer { withExtendedLifetime(permit) {} }
        await scheduler.applicationDidEnterForeground()
    }

    public func applicationDidEnterBackground() async {
        guard let permit = dataPlaneGuard.acquire() else { return }
        defer { withExtendedLifetime(permit) {} }
        await scheduler.applicationDidEnterBackground()
    }

    @discardableResult
    public func trigger(
        _ source: ScheduledSyncSource,
        cursor: Int64? = nil,
        waitForCompletion: Bool = true
    ) async -> ScheduledSyncResult {
        guard let permit = dataPlaneGuard.acquire() else { return .unavailable }
        defer { withExtendedLifetime(permit) {} }
        return await scheduler.trigger(
            source,
            cursor: cursor,
            for: identity,
            waitForCompletion: waitForCompletion
        )
    }

    func cancelAndJoin(reason: SyncSchedulerCancellationReason) async {
        disableDataPlane()
        await scheduler.cancelAndJoin(reason: reason)
        await refreshController.cancelAndJoin()
    }

    func beginCleanupHandoff() {
        disableDataPlane()
    }

    private func disableDataPlane() {
        dataPlaneGuard.disable()
    }

    func removePrivateIdentityMaterial() -> [MobileBindingCleanupComponent] {
        var failures = [MobileBindingCleanupComponent]()
        do { try signingIdentity.deleteIdentity() } catch { failures.append(.signingIdentity) }
        return failures
    }
}

private func syncRepositoryIdentity(_ snapshot: MobileBindingRecordSnapshot) -> SyncBindingIdentity {
    snapshot.record.identity.replacingBindingRecordVersion(snapshot.recordVersion.data)
}

private func syncRepositoryIdentity(_ lease: GenerationSideEffectLease) -> SyncBindingIdentity {
    lease.identity.replacingBindingRecordVersion(lease.recordVersion)
}

private func cleanupRecord(from summary: MobileBindingSummary) -> MobileBindingRecord {
    MobileBindingRecord(
        phase: .cleanupPending,
        baseURL: summary.baseURL,
        serverID: summary.serverID,
        accountID: summary.accountID,
        username: summary.username,
        deviceID: summary.deviceID,
        deviceName: summary.deviceName,
        tokenID: summary.tokenID,
        tokenName: summary.tokenName,
        registryHash: summary.registryHash,
        generation: summary.generation,
        syncIntervalSeconds: summary.syncIntervalSeconds,
        boundAtMilliseconds: summary.boundAtMilliseconds
    )
}

private func fenceRepositoryForCleanup(
    _ repository: any MobileBindingSyncRepository,
    cleanupIdentity: SyncBindingIdentity
) async throws {
    guard let current = try await repository.snapshot() else { return }
    guard current.identity.hasSameBindingGeneration(as: cleanupIdentity) else {
        throw SQLiteSyncRepositoryError.bindingChanged
    }
    if current.identity == cleanupIdentity {
        guard current.runtimeLeaseState == .fenced else {
            throw SQLiteSyncRepositoryError.bindingChanged
        }
        return
    }
    try await repository.fenceRuntime(from: current.identity, to: cleanupIdentity)
    guard let fenced = try await repository.snapshot(),
          fenced.identity == cleanupIdentity,
          fenced.runtimeLeaseState == .fenced else {
        throw SQLiteSyncRepositoryError.bindingChanged
    }
}

struct MobileBindingRuntimeHandlers: Sendable {
    let serverRevocation: MobileServerRevocationHandler
}

private func requireBindingOwnership(
    recordStore: any MobileBindingRecordStoring,
    expected: MobileBindingRecordSnapshot,
    credentials: any MobileBindingCredentialStoring,
    lease: GenerationSideEffectLease
) throws {
    guard try recordStore.load() == expected else {
        throw MobileBindingCoordinatorError.identityMismatch
    }
    _ = try credentials.credentials(for: lease)
}

private func compensateOwnedBindingFailure(
    prepared: MobilePreparedBinding,
    encryptionIdentity: any MobileEncryptionIdentityManaging,
    recordStore: any MobileBindingRecordStoring,
    ownedSnapshot: MobileBindingRecordSnapshot,
    credentialSourceLease: GenerationSideEffectLease,
    repository: (any MobileBindingSyncRepository)?,
    runtime: MobileBindingRuntime?,
    allowsRestartLeaseAdoption: Bool = false
) async -> [MobileBindingCleanupComponent] {
    runtime?.beginCleanupHandoff()
    let cleanupSnapshot: MobileBindingRecordSnapshot
    do {
        guard let persisted = try recordStore.replace(
            ownedSnapshot.record.replacingPhase(.cleanupPending),
            expected: ownedSnapshot
        ) else {
            return [.bindingRecord]
        }
        cleanupSnapshot = persisted
    } catch {
        return [.bindingRecord]
    }
    let cleanupIdentity = syncRepositoryIdentity(cleanupSnapshot)

    let ownedRepository = runtime?.syncRepository ?? repository ?? prepared.existingRepository
    var repositoryFenced = ownedRepository == nil
    if let ownedRepository {
        do {
            try await fenceRepositoryForCleanup(
                ownedRepository,
                cleanupIdentity: cleanupIdentity
            )
            guard try recordStore.load() == cleanupSnapshot else {
                return [.bindingRecord]
            }
            repositoryFenced = true
        } catch {
            repositoryFenced = false
        }
    }

    let cleanupLease: GenerationSideEffectLease
    do {
        cleanupLease = try GenerationSideEffectLease(snapshot: cleanupSnapshot)
    } catch {
        return [.credentials]
    }
    do {
        try prepared.credentials.reconcileLease(
            cleanupLease,
            replacing: credentialSourceLease
        )
    } catch {
        guard allowsRestartLeaseAdoption,
              (try? recordStore.load()) == cleanupSnapshot else {
            return [.credentials]
        }
        do {
            try prepared.credentials.reconcileLease(cleanupLease, replacing: nil)
        } catch {
            return [.credentials]
        }
    }
    do {
        try prepared.credentials.terminateLease(cleanupLease)
    } catch {
        // No repository or key material may be erased until the terminal
        // credential tombstone owns the exact cleanup marker version.
        return [.credentials]
    }

    var failures = [MobileBindingCleanupComponent]()
    var repositoryErased = false
    if let runtime {
        await runtime.cancelAndJoin(reason: .unbind)
    }
    if repositoryFenced, let ownedRepository {
        do {
            try await ownedRepository.purgeAll(for: cleanupIdentity)
            repositoryErased = true
        } catch {}
    } else if repositoryFenced {
        switch prepared.existingRepositoryStatus {
        case .valid:
            break
        case .invalid:
            do {
                try prepared.eraseEncryptedStorage()
                repositoryErased = true
            } catch {}
        case .notRequested:
            do {
                try await prepared.cleanupFailedRuntimeCreation(cleanupIdentity)
                repositoryErased = true
            } catch {}
        }
    }
    if repositoryFenced, !repositoryErased {
        do {
            try prepared.eraseEncryptedStorage()
            repositoryErased = true
        } catch {
            failures.append(.repository)
        }
    }
    if !repositoryErased, !failures.contains(.repository) {
        failures.append(.repository)
    }

    do { try prepared.signingIdentity.deleteIdentity() }
    catch { failures.append(.signingIdentity) }
    do { try encryptionIdentity.deleteIdentity(for: cleanupIdentity) }
    catch { failures.append(.encryptionIdentity) }

    if failures.isEmpty {
        do {
            guard try recordStore.clear(expected: cleanupSnapshot) else {
                throw MobileBindingCleanupHandoffError.staleIdentity
            }
        } catch {
            failures.append(.bindingRecord)
        }
    }
    return failures
}

struct MobilePreparedBinding: Sendable {
    enum ExistingRepositoryStatus: Equatable, Sendable {
        case notRequested
        case valid
        case invalid
    }

    let credentials: any MobileBindingCredentialStoring
    let signingIdentity: any MobileBindingSigningIdentityManaging
    let existingRepository: (any MobileBindingSyncRepository)?
    let existingRepositoryStatus: ExistingRepositoryStatus
    let eraseEncryptedStorage: @Sendable () throws -> Void
    let makeRepository: @Sendable (
        SyncBindingIdentity
    ) throws -> any MobileBindingSyncRepository
    let cleanupFailedRuntimeCreation: @Sendable (
        SyncBindingIdentity
    ) async throws -> Void
    let makeRuntime: @Sendable (
        MobileBindingRecord,
        GenerationSideEffectLease,
        SyncBindingIdentity,
        any MobileBindingSyncRepository,
        MobileBindingRuntimeHandlers
    ) throws -> MobileBindingRuntime
}

protocol MobileBindingEnvironment: Sendable {
    func prepare(
        record: MobileBindingRecord,
        repositoryIdentity: SyncBindingIdentity,
        restoring: Bool
    ) throws -> MobilePreparedBinding
}

private final class ProductionMobileBindingEnvironment: MobileBindingEnvironment, @unchecked Sendable {
    private let configuration: MobileBindingConfiguration
    private let clock: any MobileBindingClock

    init(configuration: MobileBindingConfiguration, clock: any MobileBindingClock) {
        self.configuration = configuration
        self.clock = clock
    }

    func prepare(
        record: MobileBindingRecord,
        repositoryIdentity: SyncBindingIdentity,
        restoring: Bool
    ) throws -> MobilePreparedBinding {
        let identity = record.identity
        let credentialScope = try KeychainCredentialScope(
            serverID: identity.serverID,
            accountID: identity.accountID,
            deviceID: identity.deviceID,
            generation: identity.generation
        )
        let credentials = try KeychainCredentialStore(scope: credentialScope)
        let signingScope = try DeviceIdentityScope(
            serverID: identity.serverID,
            accountID: identity.accountID,
            deviceID: identity.deviceID,
            generation: identity.generation
        )
        let signingIdentity = DeviceIdentityStore(scope: signingScope)
        let databaseKeyStore = KeychainSyncDatabaseKeyStore.shared
        let databaseURL = SQLiteSyncRepository.bindingDatabaseURL(
            in: configuration.databaseDirectory,
            identity: identity
        )
        let legacyDatabaseURL = SQLiteSyncRepository.legacyAccountDatabaseURL(
            in: configuration.databaseDirectory,
            serverID: identity.serverID,
            accountID: identity.accountID
        )
        let existingRepository: SQLiteSyncRepository?
        let existingRepositoryStatus: MobilePreparedBinding.ExistingRepositoryStatus
        if restoring {
            do {
                existingRepository = try SQLiteSyncRepository(
                    databaseURL: databaseURL,
                    identity: repositoryIdentity,
                    requireExistingBinding: record.phase == .active || record.phase == .restoring,
                    cleanupOnly: record.phase == .cleanupPending,
                    keyStore: databaseKeyStore,
                    legacyDatabaseURL: legacyDatabaseURL
                )
                existingRepositoryStatus = .valid
            } catch {
                existingRepository = nil
                existingRepositoryStatus = .invalid
            }
        } else {
            existingRepository = nil
            existingRepositoryStatus = .notRequested
        }

        let configuration = self.configuration
        let clock = self.clock
        return MobilePreparedBinding(
            credentials: credentials,
            signingIdentity: signingIdentity,
            existingRepository: existingRepository,
            existingRepositoryStatus: existingRepositoryStatus,
            eraseEncryptedStorage: {
                try SQLiteSyncRepository.eraseEncryptedStorageForCleanup(
                    at: databaseURL,
                    legacyDatabaseURL: legacyDatabaseURL,
                    identity: identity,
                    keyStore: databaseKeyStore
                )
            },
            makeRepository: { runtimeIdentity in
                guard runtimeIdentity.hasSameBindingGeneration(as: identity) else {
                    throw MobileBindingCoordinatorError.identityMismatch
                }
                return try SQLiteSyncRepository(
                    databaseURL: databaseURL,
                    identity: runtimeIdentity,
                    initialState: .boundNeedsBootstrap,
                    keyStore: databaseKeyStore,
                    legacyDatabaseURL: legacyDatabaseURL
                )
            },
            cleanupFailedRuntimeCreation: { cleanupIdentity in
                // The coordinator calls this only after the exact cleanup
                // lease has been terminally tombstoned.
                let repository = try SQLiteSyncRepository(
                    databaseURL: databaseURL,
                    identity: cleanupIdentity,
                    cleanupOnly: true,
                    keyStore: databaseKeyStore,
                    legacyDatabaseURL: legacyDatabaseURL
                )
                try await fenceRepositoryForCleanup(
                    repository,
                    cleanupIdentity: cleanupIdentity
                )
                try await repository.purgeAll(for: cleanupIdentity)
            },
            makeRuntime: {
                finalRecord, sideEffectLease, runtimeIdentity, repository,
                handlers in
                guard finalRecord.identity.hasSameBindingGeneration(as: identity),
                      runtimeIdentity == syncRepositoryIdentity(sideEffectLease) else {
                    throw MobileBindingCoordinatorError.identityMismatch
                }
                let proofCoordinator = DeviceProofCoordinator(
                    signer: signingIdentity.makeProofSigner(),
                    nowMilliseconds: { clock.nowMilliseconds() }
                )
                let api = try MobileApiClient(
                    baseURL: configuration.baseURL,
                    appVersion: configuration.appVersion,
                    sha256SPKIPins: configuration.sha256SPKIPins,
                    proofCoordinator: proofCoordinator,
                    credentialProvider: {
                        try? credentials.credentials(for: sideEffectLease)?.accessCredential
                    }
                )
                let refresh = MobileAccessCredentialController(
                    api: api,
                    credentials: credentials,
                    lease: sideEffectLease,
                    identity: runtimeIdentity,
                    tokenID: finalRecord.tokenID,
                    appVersion: configuration.appVersion,
                    expectedRegistryHash: finalRecord.registryHash,
                    clock: clock
                )
                let transport = RefreshingSyncTransport(api: api, refresh: refresh)
                let engine = SyncEngine(
                    identity: runtimeIdentity,
                    transport: transport,
                    repository: repository,
                    clock: clock,
                    serverRevocationHandler: handlers.serverRevocation
                )
                let wake = RefreshingWakeStreamTransport(
                    refresh: refresh,
                    wake: try WakeStreamClient(apiClient: api)
                )
                let scheduler = SyncScheduler(
                    identity: runtimeIdentity,
                    repository: repository,
                    engine: engine,
                    wakeTransport: wake,
                    intervalSeconds: finalRecord.syncIntervalSeconds,
                    serverRevocationHandler: handlers.serverRevocation
                )
                return MobileBindingRuntime(
                    summary: finalRecord.summary,
                    identity: runtimeIdentity,
                    syncRepository: repository,
                    credentials: credentials,
                    signingIdentity: signingIdentity,
                    managementAPI: api,
                    refreshController: refresh,
                    sideEffectLease: sideEffectLease,
                    engine: engine,
                    scheduler: scheduler,
                    connectivityMonitorFactory: { ConnectivityMonitor() }
                )
            }
        )
    }
}

private struct MobileAuthenticationContext: Sendable {
    let session: MobileAuthenticatedSession
    let capabilities: MobileCapabilitiesResponse
}

private enum MobileAuthenticationAttempt: Sendable {
    case totpRequired(String, MobileCapabilitiesResponse)
    case passwordChangeRequired
    case authenticated(MobileAuthenticationContext)
}

private enum MobileBindingRestoreAbort: Error {
    case serverRevoked
    case repositoryUnavailable
    case ownershipLost
}

private enum MobileBindingCleanupHandoffError: Error {
    case staleIdentity
    case markerUnavailable
}

/// Owns authentication, binding, recovery and erasure for one configured
/// server. The application shell must retain this actor for the account
/// lifetime; a pushed binding view is not the runtime owner.
public actor MobileBindingCoordinator {
    private let configuration: MobileBindingConfiguration
    private let api: any MobileBindingAPI
    private let recordStore: any MobileBindingRecordStoring
    private let environment: any MobileBindingEnvironment
    private let encryptionIdentity: any MobileEncryptionIdentityManaging
    private let tokenLoader: (any MobileBindingTokenLoading)?
    private let clock: any MobileBindingClock
    private let generationSource: @Sendable () -> String
    private let serverRevocationCleanupStart: @Sendable () async -> Void
    private let serverRevocationCleanupRetrySleep: @Sendable (Int64) async -> Void

    private var authentication: MobileAuthenticationContext?
    private var tempToken: String?
    private var pendingCapabilities: MobileCapabilitiesResponse?
    private var loadedTokens = [MobileBindingToken]()
    private var runtime: MobileBindingRuntime?
    private var cleanupRuntime: MobileBindingRuntime?
    private var tearingDown = false
    private var serverRevocationCleanupIdentity: SyncBindingIdentity?
    private var serverRevocationFenceTask: Task<Bool, Never>?
    private var serverRevocationCleanupTask: Task<Void, Never>?

    private var authenticationTask: (id: UUID, task: Task<MobileAuthenticationAttempt, Error>)?
    private var tokenTask: (id: UUID, task: Task<[MobileBindingToken], Error>)?
    private var bindingTask: (id: UUID, task: Task<MobileBindingRuntime, Error>)?

    public init(
        configuration: MobileBindingConfiguration,
        encryptionIdentity: any MobileEncryptionIdentityManaging,
        tokenLoader: (any MobileBindingTokenLoading)? = nil,
        clock: any MobileBindingClock = SystemSyncClock()
    ) throws {
        let api = try MobileApiClient(
            baseURL: configuration.baseURL,
            appVersion: configuration.appVersion,
            sha256SPKIPins: configuration.sha256SPKIPins
        )
        self.configuration = configuration
        self.api = api
        self.recordStore = KeychainMobileBindingRecordStore(baseURL: configuration.baseURL)
        self.environment = ProductionMobileBindingEnvironment(configuration: configuration, clock: clock)
        self.encryptionIdentity = encryptionIdentity
        self.tokenLoader = tokenLoader
        self.clock = clock
        self.generationSource = { UUID().uuidString }
        self.serverRevocationCleanupStart = {}
        self.serverRevocationCleanupRetrySleep = { milliseconds in
            guard milliseconds > 0 else { return }
            let bounded = min(milliseconds, Int64.max / 1_000_000)
            try? await Task.sleep(nanoseconds: UInt64(bounded) * 1_000_000)
        }
    }

    init(
        configuration: MobileBindingConfiguration,
        api: any MobileBindingAPI,
        recordStore: any MobileBindingRecordStoring,
        environment: any MobileBindingEnvironment,
        encryptionIdentity: any MobileEncryptionIdentityManaging,
        tokenLoader: (any MobileBindingTokenLoading)?,
        clock: any MobileBindingClock,
        generationSource: @escaping @Sendable () -> String,
        serverRevocationCleanupStart: @escaping @Sendable () async -> Void = {},
        serverRevocationCleanupRetrySleep: @escaping @Sendable (Int64) async -> Void = { _ in
            await Task.yield()
        }
    ) {
        self.configuration = configuration
        self.api = api
        self.recordStore = recordStore
        self.environment = environment
        self.encryptionIdentity = encryptionIdentity
        self.tokenLoader = tokenLoader
        self.clock = clock
        self.generationSource = generationSource
        self.serverRevocationCleanupStart = serverRevocationCleanupStart
        self.serverRevocationCleanupRetrySleep = serverRevocationCleanupRetrySleep
    }

    public func currentRuntime() -> MobileBindingRuntime? { runtime }

    public func beginLogin(
        username: String,
        password: String,
        captchaToken: String? = nil
    ) async throws -> MobileBindingLoginStep {
        guard runtime == nil, cleanupRuntime == nil, !tearingDown,
              serverRevocationCleanupIdentity == nil,
              serverRevocationCleanupTask == nil,
              try recordStore.load() == nil else {
            throw MobileBindingCoordinatorError.invalidState
        }
        await cancelTransientWork()
        let api = self.api
        let appVersion = configuration.appVersion
        return try await authenticate {
            let capabilities = try await api.capabilities()
            try Self.validate(capabilities, appVersion: appVersion)
            let response = try await api.login(
                username: username,
                password: password,
                captchaToken: captchaToken,
                remember: false
            )
            return (response, capabilities)
        }
    }

    public func continueTotp(code: String) async throws -> MobileBindingLoginStep {
        guard runtime == nil, !tearingDown, authenticationTask == nil,
              let tempToken, let pendingCapabilities else {
            throw MobileBindingCoordinatorError.invalidState
        }
        let api = self.api
        return try await authenticate {
            let response = try await api.verifyTotp(tempToken: tempToken, code: code)
            return (response, pendingCapabilities)
        }
    }

    public func listTokens() async throws -> [MobileBindingToken] {
        guard let authentication, !tearingDown else {
            throw MobileBindingCoordinatorError.invalidState
        }
        guard let tokenLoader else {
            throw MobileBindingCoordinatorError.tokenLoaderUnavailable
        }
        let id = UUID()
        let accountID = authentication.session.user.userId
        let sid = authentication.session.sid
        let task = Task { try await tokenLoader.tokens(sid: sid, accountID: accountID) }
        tokenTask = (id, task)
        do {
            let tokens = try await task.value
            guard tokenTask?.id == id else {
                throw MobileBindingCoordinatorError.authenticationCancelled
            }
            tokenTask = nil
            let tokenIDs = tokens.map(\.id)
            guard Set(tokenIDs).count == tokenIDs.count,
                  tokens.allSatisfy({ token in
                      !token.id.isEmpty && token.ownerAccountID == accountID
                  }) else {
                throw MobileBindingCoordinatorError.identityMismatch
            }
            loadedTokens = tokens.filter(\.enabled)
            return loadedTokens
        } catch {
            if tokenTask?.id == id { tokenTask = nil }
            throw error
        }
    }

    public func bind(
        secret: String,
        registration: MobileBindingRegistration
    ) async throws -> MobileBindingRuntime {
        guard !secret.isEmpty, let authentication, !tearingDown, runtime == nil,
              cleanupRuntime == nil,
              serverRevocationCleanupIdentity == nil,
              serverRevocationCleanupTask == nil,
              bindingTask == nil,
              try recordStore.load() == nil,
              let token = loadedTokens.first(where: { $0.id == registration.tokenID }) else {
            throw MobileBindingCoordinatorError.invalidState
        }
        guard token.ownerAccountID == authentication.session.user.userId, token.enabled else {
            throw MobileBindingCoordinatorError.identityMismatch
        }

        let generation = generationSource()
        guard !generation.isEmpty else { throw MobileBindingCoordinatorError.incompleteBinding }
        let preliminaryRecord = MobileBindingRecord(
            phase: .binding,
            baseURL: configuration.baseURL,
            serverID: authentication.capabilities.serverId,
            accountID: authentication.session.user.userId,
            username: authentication.session.user.username,
            deviceID: configuration.deviceID,
            deviceName: registration.deviceName,
            tokenID: token.id,
            tokenName: token.name,
            registryHash: authentication.capabilities.registryHash,
            generation: generation,
            syncIntervalSeconds: registration.syncIntervalSeconds,
            boundAtMilliseconds: 0
        )

        let id = UUID()
        let environment = self.environment
        let encryptionIdentity = self.encryptionIdentity
        let recordStore = self.recordStore
        let api = self.api
        let clock = self.clock
        let appVersion = configuration.appVersion
        let session = authentication.session
        let capabilities = authentication.capabilities
        let task = Task { () throws -> MobileBindingRuntime in
            guard let inserted = try recordStore.insertIfAbsent(preliminaryRecord) else {
                throw MobileBindingCoordinatorError.identityMismatch
            }
            let bindingIdentity = syncRepositoryIdentity(inserted)
            let prepared: MobilePreparedBinding
            do {
                prepared = try environment.prepare(
                    record: preliminaryRecord,
                    repositoryIdentity: bindingIdentity,
                    restoring: false
                )
            } catch {
                _ = try? recordStore.replace(
                    preliminaryRecord.replacingPhase(.cleanupPending),
                    expected: inserted
                )
                throw error
            }
            var createdRuntime: MobileBindingRuntime?
            var createdRepository: (any MobileBindingSyncRepository)?
            var ownedSnapshot = inserted
            var credentialLease = try GenerationSideEffectLease(snapshot: inserted)
            do {
                let bindingLease = credentialLease
                try prepared.credentials.activateLease(bindingLease)
                let signing = try prepared.signingIdentity.ensureIdentity()
                let encryption = try encryptionIdentity.publicIdentity(for: preliminaryRecord.identity)
                guard encryption.alg == "ML-KEM-768", !encryption.publicKey.isEmpty,
                      let encryptionBytes = Data(base64Encoded: encryption.publicKey),
                      encryptionBytes.count == 1_184 else {
                    throw MobileBindingCoordinatorError.incompleteBinding
                }
                let signingJWK = Dictionary(
                    uniqueKeysWithValues: signing.jwk.map { ($0.key, MobileJSONValue.string($0.value)) }
                )
                let keys = MobileDeviceKeys(
                    encryption: encryption,
                    signing: MobileDeviceSigningKey(alg: signing.algorithm, jwk: signingJWK)
                )
                let grant = try await api.verifySensitive(
                    action: .deviceBind,
                    secret: secret,
                    targetIds: [registration.tokenID, preliminaryRecord.deviceID],
                    sid: session.sid
                )
                try Task.checkCancellation()
                try requireBindingOwnership(
                    recordStore: recordStore,
                    expected: inserted,
                    credentials: prepared.credentials,
                    lease: bindingLease
                )
                guard grant.expiresAt > clock.nowMilliseconds() else {
                    throw MobileBindingCoordinatorError.grantExpired
                }
                guard grant.bindingProtocolVersion == 2,
                      let bindAttempt = grant.bindAttempt else {
                    throw MobileBindingCoordinatorError.unsupportedProtocol
                }
                guard bindAttempt.expiresAt > clock.nowMilliseconds() else {
                    throw MobileBindingCoordinatorError.grantExpired
                }
                let response = try await api.bind(
                    MobileDeviceBindRequest(
                        deviceId: preliminaryRecord.deviceID,
                        deviceName: preliminaryRecord.deviceName,
                        appVersion: appVersion,
                        tokenId: preliminaryRecord.tokenID,
                        keys: keys,
                        syncIntervalSec: preliminaryRecord.syncIntervalSeconds,
                        bindReceipt: bindAttempt.receipt
                    ),
                    sid: session.sid,
                    sensitiveGrant: grant.grant
                )
                try Task.checkCancellation()
                try requireBindingOwnership(
                    recordStore: recordStore,
                    expected: inserted,
                    credentials: prepared.credentials,
                    lease: bindingLease
                )
                try Self.validate(
                    response: response,
                    bindAttempt: bindAttempt,
                    record: preliminaryRecord,
                    capabilities: capabilities,
                    appVersion: appVersion,
                    nowMilliseconds: clock.nowMilliseconds()
                )
                try prepared.credentials.storeInitial(
                    KeychainCredentials(
                        accessCredential: response.accessCredential,
                        accessExpiresAtMilliseconds: response.accessExpiresAt,
                        refreshCredential: response.refreshCredential,
                        sid: session.sid
                    ),
                    for: bindingLease
                )
                let record = MobileBindingRecord(
                    phase: .active,
                    baseURL: preliminaryRecord.baseURL,
                    serverID: preliminaryRecord.serverID,
                    accountID: preliminaryRecord.accountID,
                    username: preliminaryRecord.username,
                    deviceID: response.device.deviceId,
                    deviceName: response.device.deviceName,
                    tokenID: response.device.tokenId,
                    tokenName: preliminaryRecord.tokenName,
                    registryHash: response.registryHash,
                    generation: preliminaryRecord.generation,
                    syncIntervalSeconds: response.device.syncIntervalSec,
                    boundAtMilliseconds: response.device.createdAt
                )
                guard let activeSnapshot = try recordStore.replace(
                    record,
                    expected: inserted
                ) else {
                    throw MobileBindingCoordinatorError.identityMismatch
                }
                ownedSnapshot = activeSnapshot
                let activeLease = try GenerationSideEffectLease(snapshot: activeSnapshot)
                try prepared.credentials.replaceLease(activeLease, expected: bindingLease)
                credentialLease = activeLease
                let activeIdentity = syncRepositoryIdentity(activeSnapshot)
                let repository = try prepared.makeRepository(activeIdentity)
                createdRepository = repository
                try await repository.saveRegistryHash(record.registryHash, for: activeIdentity)
                try requireBindingOwnership(
                    recordStore: recordStore,
                    expected: activeSnapshot,
                    credentials: prepared.credentials,
                    lease: activeLease
                )
                let handler = MobileBindingRuntimeHandlers(
                    serverRevocation: { [weak self] reason in
                        await self?.handleReportedServerRevocation(reason, for: activeIdentity)
                    }
                )
                let runtime = try prepared.makeRuntime(
                    record,
                    activeLease,
                    activeIdentity,
                    repository,
                    handler
                )
                createdRuntime = runtime
            } catch {
                let failures = await compensateOwnedBindingFailure(
                    prepared: prepared,
                    encryptionIdentity: encryptionIdentity,
                    recordStore: recordStore,
                    ownedSnapshot: ownedSnapshot,
                    credentialSourceLease: credentialLease,
                    repository: createdRepository,
                    runtime: createdRuntime
                )
                if !failures.isEmpty {
                    throw Self.cleanupError(failures)
                }
                throw error
            }
            guard let createdRuntime else {
                throw MobileBindingCoordinatorError.incompleteBinding
            }
            return try await self.activateRuntime(
                createdRuntime,
                operationID: id,
                clearsAuthentication: true
            )
        }
        bindingTask = (id, task)
        do {
            return try await task.value
        } catch {
            if bindingTask?.id == id { bindingTask = nil }
            throw error
        }
    }

    public func restore() async throws -> MobileBindingRuntime? {
        guard !tearingDown else { return nil }
        if let runtime { return runtime }
        if cleanupRuntime != nil {
            let expectedIdentity = cleanupRuntime?.identity
            guard try await destroyBinding(
                reason: .unbind,
                expectedIdentity: expectedIdentity
            ) else {
                throw MobileBindingCoordinatorError.identityMismatch
            }
            return nil
        }
        if let bindingTask {
            let restored = try await bindingTask.task.value
            guard !tearingDown else { return nil }
            if self.bindingTask?.id == bindingTask.id {
                runtime = restored
                return restored
            }
            return runtime
        }
        guard let record = try recordStore.load() else { return nil }
        if record.phase != .active {
            guard try await destroyBinding(
                reason: .unbind,
                expectedIdentity: syncRepositoryIdentity(record)
            ) else {
                throw MobileBindingCoordinatorError.identityMismatch
            }
            return nil
        }
        guard record.record.baseURL == configuration.baseURL,
              record.record.deviceID == configuration.deviceID else {
            throw MobileBindingCoordinatorError.identityMismatch
        }

        // This exact CAS is the restore lease. Environment preparation can open
        // the repository and inspect Keychain state, so it must happen only after
        // the durable record is non-runnable and this process owns its version.
        let activeIdentity = syncRepositoryIdentity(record)
        guard let restoringSnapshot = try recordStore.replace(
            record.record.replacingPhase(.restoring),
            expected: record
        ) else {
            throw MobileBindingCoordinatorError.identityMismatch
        }
        let activeLease = try GenerationSideEffectLease(snapshot: record)
        let restoringLease = try GenerationSideEffectLease(snapshot: restoringSnapshot)
        let restoringIdentity = syncRepositoryIdentity(restoringSnapshot)

        let id = UUID()
        let api = self.api
        let environment = self.environment
        let recordStore = self.recordStore
        let encryptionIdentity = self.encryptionIdentity
        let appVersion = configuration.appVersion
        let clock = self.clock
        let task = Task { () throws -> MobileBindingRuntime in
            let prepared: MobilePreparedBinding
            do {
                prepared = try environment.prepare(
                    record: restoringSnapshot.record,
                    repositoryIdentity: activeIdentity,
                    restoring: true
                )
            } catch {
                _ = try? recordStore.replace(
                    restoringSnapshot.record.replacingPhase(.cleanupPending),
                    expected: restoringSnapshot
                )
                throw error
            }
            var ownedSnapshot = restoringSnapshot
            var credentialLease = activeLease
            var createdRuntime: MobileBindingRuntime?
            var ownedRepository: (any MobileBindingSyncRepository)?
            do {
                guard prepared.existingRepositoryStatus == .valid,
                      let repository = prepared.existingRepository else {
                    throw MobileBindingRestoreAbort.repositoryUnavailable
                }
                ownedRepository = repository
                do {
                    try await repository.fenceRuntime(
                        from: activeIdentity,
                        to: restoringIdentity
                    )
                } catch {
                    throw MobileBindingRestoreAbort.repositoryUnavailable
                }
                guard try recordStore.load() == restoringSnapshot else {
                    throw MobileBindingRestoreAbort.ownershipLost
                }
                let snapshot: SyncRepositorySnapshot
                do {
                    guard let loadedSnapshot = try await repository.snapshot() else {
                        throw MobileBindingRestoreAbort.repositoryUnavailable
                    }
                    snapshot = loadedSnapshot
                } catch let abort as MobileBindingRestoreAbort {
                    throw abort
                } catch {
                    throw MobileBindingRestoreAbort.repositoryUnavailable
                }
                guard snapshot.identity == restoringIdentity,
                      snapshot.runtimeLeaseState == .fenced else {
                    throw MobileBindingCoordinatorError.incompleteBinding
                }
                if snapshot.bindingState == .revoked {
                    throw MobileBindingRestoreAbort.serverRevoked
                }
                try prepared.credentials.reconcileLease(
                    restoringLease,
                    replacing: activeLease
                )
                credentialLease = restoringLease
                guard snapshot.bindingState.canRunSync,
                      try prepared.signingIdentity.hasIdentity(),
                      try encryptionIdentity.hasIdentity(for: restoringIdentity),
                      let storedCredentials = try prepared.credentials.credentials(for: restoringLease) else {
                    throw MobileBindingCoordinatorError.incompleteBinding
                }
                let capabilities = try await api.capabilities()
                try Task.checkCancellation()
                try requireBindingOwnership(
                    recordStore: recordStore,
                    expected: restoringSnapshot,
                    credentials: prepared.credentials,
                    lease: restoringLease
                )
                try Self.validate(capabilities, appVersion: appVersion)
                guard capabilities.serverId == restoringSnapshot.record.serverID else {
                    throw MobileBindingCoordinatorError.identityMismatch
                }
                let encryption = try encryptionIdentity.publicIdentity(
                    for: restoringIdentity
                )
                guard encryption.alg == "ML-KEM-768",
                      let publicKey = Data(base64Encoded: encryption.publicKey),
                      publicKey.count == 1_184 else {
                    throw MobileBindingCoordinatorError.incompleteBinding
                }

                let refreshed = try await api.refresh(
                    deviceId: restoringSnapshot.record.deviceID,
                    refreshCredential: storedCredentials.refreshCredential
                )
                try Task.checkCancellation()
                try requireBindingOwnership(
                    recordStore: recordStore,
                    expected: restoringSnapshot,
                    credentials: prepared.credentials,
                    lease: restoringLease
                )
                try Self.validate(
                    refresh: refreshed,
                    record: restoringSnapshot.record,
                    capabilities: capabilities,
                    appVersion: appVersion,
                    nowMilliseconds: clock.nowMilliseconds()
                )
                try prepared.credentials.rotate(
                    accessCredential: refreshed.accessCredential,
                    accessExpiresAtMilliseconds: refreshed.accessExpiresAt,
                    refreshCredential: refreshed.refreshCredential,
                    for: restoringLease
                )
                let updatedRecord = restoringSnapshot.record.replacing(
                    device: refreshed.device,
                    registryHash: refreshed.registryHash
                ).replacingPhase(.active)
                guard let activeSnapshot = try recordStore.replace(
                    updatedRecord,
                    expected: restoringSnapshot
                ) else {
                    throw MobileBindingRestoreAbort.ownershipLost
                }
                ownedSnapshot = activeSnapshot
                let finalIdentity = syncRepositoryIdentity(activeSnapshot)
                do {
                    try await repository.publishRuntime(
                        from: restoringIdentity,
                        to: finalIdentity
                    )
                } catch {
                    throw MobileBindingRestoreAbort.repositoryUnavailable
                }
                guard try recordStore.load() == activeSnapshot else {
                    throw MobileBindingRestoreAbort.ownershipLost
                }
                let finalLease = try GenerationSideEffectLease(snapshot: activeSnapshot)
                try prepared.credentials.replaceLease(finalLease, expected: restoringLease)
                credentialLease = finalLease
                let handlers = MobileBindingRuntimeHandlers(
                    serverRevocation: { [weak self] reason in
                        await self?.handleReportedServerRevocation(reason, for: finalIdentity)
                    }
                )
                let restored = try prepared.makeRuntime(
                    updatedRecord,
                    finalLease,
                    finalIdentity,
                    repository,
                    handlers
                )
                createdRuntime = restored
                return try await self.activateRuntime(
                    restored,
                    operationID: id,
                    clearsAuthentication: false
                )
            } catch MobileBindingRestoreAbort.ownershipLost {
                createdRuntime?.beginCleanupHandoff()
                throw MobileBindingRestoreAbort.ownershipLost
            } catch {
                let failures = await compensateOwnedBindingFailure(
                    prepared: prepared,
                    encryptionIdentity: encryptionIdentity,
                    recordStore: recordStore,
                    ownedSnapshot: ownedSnapshot,
                    credentialSourceLease: credentialLease,
                    repository: ownedRepository,
                    runtime: createdRuntime,
                    allowsRestartLeaseAdoption: true
                )
                if !failures.isEmpty { throw Self.cleanupError(failures) }
                throw error
            }
        }
        bindingTask = (id, task)
        do {
            return try await task.value
        } catch {
            if bindingTask?.id == id { bindingTask = nil }
            if let restoreAbort = error as? MobileBindingRestoreAbort {
                switch restoreAbort {
                case .serverRevoked, .repositoryUnavailable:
                    return nil
                case .ownershipLost:
                    throw MobileBindingCoordinatorError.identityMismatch
                }
            }
            if let apiError = error as? MobileApiError,
               MobileServerRevocationReason(errorCode: apiError.code) != nil {
                return nil
            }
            throw error
        }
    }

    /// Cancels and joins only incomplete login, TOTP, token loading and bind
    /// work. A runtime that completed concurrently is retained and keeps sync
    /// ownership; callers must use logout or revocation to stop it.
    public func cancelTransientWork() async {
        let authenticationTask = self.authenticationTask
        let tokenTask = self.tokenTask
        let bindingTask = self.bindingTask
        self.authenticationTask = nil
        self.tokenTask = nil
        authenticationTask?.task.cancel()
        tokenTask?.task.cancel()
        bindingTask?.task.cancel()
        clearAuthenticationState()
        if let authenticationTask { _ = await authenticationTask.task.result }
        if let tokenTask { _ = await tokenTask.task.result }
        if let bindingTask {
            let result = await bindingTask.task.result
            if case .success(let completed) = result {
                if tearingDown { cleanupRuntime = completed }
                else { runtime = completed }
            }
            if self.bindingTask?.id == bindingTask.id { self.bindingTask = nil }
        }
    }

    /// Publishes a fully constructed runtime before its first sync can report a terminal
    /// server decision. Keeping this transition actor-owned closes the window where the
    /// revocation callback had an identity but no runtime or trusted record to fence.
    private func activateRuntime(
        _ candidate: MobileBindingRuntime,
        operationID: UUID,
        clearsAuthentication: Bool
    ) async throws -> MobileBindingRuntime {
        guard !tearingDown, bindingTask?.id == operationID,
              runtime == nil, cleanupRuntime == nil,
              serverRevocationCleanupIdentity == nil else {
            throw CancellationError()
        }
        runtime = candidate
        if clearsAuthentication { clearAuthenticationState() }

        _ = await candidate.start()
        guard !tearingDown, runtime?.identity == candidate.identity,
              cleanupRuntime?.identity != candidate.identity,
              serverRevocationCleanupIdentity != candidate.identity else {
            throw CancellationError()
        }
        if bindingTask?.id == operationID { bindingTask = nil }
        return candidate
    }

    public func logout() async throws {
        let currentRuntime = runtime ?? cleanupRuntime
        let expectedIdentity = try currentBindingIdentityForTeardown()
        let logoutAPI: any MobileBindingAPI = currentRuntime?.managementAPI ?? api
        var sid = authentication?.session.sid
        if sid == nil, let currentRuntime {
            sid = try? currentRuntime.credentials.credentials(
                for: currentRuntime.sideEffectLease
            )?.sid
        }

        var cleanupError: Error?
        do {
            guard try await destroyBinding(
                reason: .unbind,
                expectedIdentity: expectedIdentity
            ) else {
                throw MobileBindingCoordinatorError.identityMismatch
            }
        } catch { cleanupError = error }

        var remoteError: Error?
        if let sid, !sid.isEmpty {
            do { try await logoutAPI.logout(sid: sid) } catch { remoteError = error }
        }

        if let cleanupError { throw cleanupError }
        if let remoteError { throw remoteError }
    }

    public func handleServerRevocation() async throws {
        let targetRuntime = runtime ?? cleanupRuntime
        let expectedIdentity: SyncBindingIdentity
        let trustedRecord: MobileBindingRecord?
        if let targetRuntime {
            // This handoff is deliberately before record-store I/O and before the first await.
            // Keychain unavailability must never leave a server-revoked runtime reachable.
            targetRuntime.beginCleanupHandoff()
            if runtime?.identity == targetRuntime.identity { runtime = nil }
            cleanupRuntime = targetRuntime
            expectedIdentity = targetRuntime.identity
            trustedRecord = cleanupRecord(from: targetRuntime.summary)
        } else {
            guard let stored = try recordStore.load() else { return }
            expectedIdentity = syncRepositoryIdentity(stored)
            trustedRecord = stored.record
        }

        await handleReportedServerRevocation(
            .deviceRevoked,
            for: expectedIdentity,
            trustedRecord: trustedRecord
        )
        if serverRevocationCleanupIdentity == expectedIdentity,
           let serverRevocationFenceTask {
            _ = await serverRevocationFenceTask.value
        }
        if serverRevocationCleanupIdentity == expectedIdentity,
           let serverRevocationCleanupTask {
            await serverRevocationCleanupTask.value
        }
    }

    private func serverRevocationHandler(
        for identity: SyncBindingIdentity
    ) -> MobileServerRevocationHandler {
        { [weak self] reason in
            await self?.handleReportedServerRevocation(reason, for: identity)
        }
    }

    private func handleReportedServerRevocation(
        _: MobileServerRevocationReason,
        for identity: SyncBindingIdentity,
        trustedRecord: MobileBindingRecord? = nil
    ) async {
        if serverRevocationCleanupIdentity == identity {
            if let serverRevocationFenceTask {
                _ = await serverRevocationFenceTask.value
            }
            return
        }
        guard !tearingDown, serverRevocationCleanupIdentity == nil else { return }

        if let runtime, runtime.identity != identity { return }
        if let cleanupRuntime, cleanupRuntime.identity != identity { return }
        let matchingRuntime = runtime ?? cleanupRuntime
        guard matchingRuntime != nil ||
                trustedRecord?.identity.hasSameBindingGeneration(as: identity) == true else {
            return
        }

        // Fail closed before touching the record store. A transient Keychain failure must not
        // leave a server-revoked runtime available to the UI or data plane.
        matchingRuntime?.beginCleanupHandoff()
        if runtime?.identity == identity {
            cleanupRuntime = runtime
            runtime = nil
        }
        serverRevocationCleanupIdentity = identity
        let fenceTask = Task { [weak self] in
            guard let self else { return false }
            return await self.establishDurableRevocationFence(
                for: identity,
                trustedRecord: trustedRecord
            )
        }
        serverRevocationFenceTask = fenceTask
        let fenced = await fenceTask.value
        if serverRevocationCleanupIdentity == identity {
            serverRevocationFenceTask = nil
        }
        guard fenced, serverRevocationCleanupIdentity == identity else {
            if serverRevocationCleanupIdentity == identity {
                serverRevocationCleanupIdentity = nil
            }
            return
        }

        serverRevocationCleanupTask = Task { [weak self] in
            guard let self else { return }
            await self.finishReportedServerRevocation(
                for: identity,
                trustedRecord: trustedRecord
            )
        }
    }

    private func finishReportedServerRevocation(
        for identity: SyncBindingIdentity,
        trustedRecord: MobileBindingRecord?
    ) async {
        let matchingRuntime = [runtime, cleanupRuntime]
            .compactMap { $0 }
            .first { $0.identity == identity }
        await matchingRuntime?.cancelAndJoin(reason: .revocation)
        await serverRevocationCleanupStart()
        var retry = 0
        while serverRevocationCleanupIdentity == identity {
            if retry > 0 {
                let delays = [Int64(250), 1_000, 5_000, 30_000]
                await serverRevocationCleanupRetrySleep(delays[min(retry - 1, delays.count - 1)])
            }
            do {
                guard try await destroyBinding(
                    reason: .revocation,
                    expectedIdentity: identity
                ) else {
                    finishServerRevocationCleanup(for: identity)
                    return
                }
                finishServerRevocationCleanup(for: identity)
                return
            } catch {
                retry += 1
            }
        }
    }

    private func establishDurableRevocationFence(
        for identity: SyncBindingIdentity,
        trustedRecord: MobileBindingRecord?
    ) async -> Bool {
        var retry = 0
        while serverRevocationCleanupIdentity == identity {
            let matchingRuntime = [runtime, cleanupRuntime]
                .compactMap { $0 }
                .first { $0.identity == identity }
            do {
                let cleanupSnapshot = try persistCleanupMarker(
                    for: identity,
                    trustedRecord: trustedRecord
                )
                let cleanupIdentity = syncRepositoryIdentity(cleanupSnapshot)
                let repository: (any MobileBindingSyncRepository)?
                if let matchingRuntime {
                    repository = matchingRuntime.syncRepository
                } else if let trustedRecord {
                    let prepared = try? environment.prepare(
                        record: trustedRecord.replacingPhase(.cleanupPending),
                        repositoryIdentity: cleanupIdentity,
                        restoring: true
                    )
                    repository = prepared?.existingRepository
                } else {
                    repository = nil
                }
                if let repository {
                    try await fenceRepositoryForCleanup(
                        repository,
                        cleanupIdentity: cleanupIdentity
                    )
                }
                guard try recordStore.load() == cleanupSnapshot else {
                    throw MobileBindingCleanupHandoffError.staleIdentity
                }
                return true
            } catch MobileBindingCleanupHandoffError.staleIdentity {
                return false
            } catch {
                // If the binding-index Keychain is temporarily unavailable,
                // keep crash recovery non-runnable while retrying the exact
                // marker. This fence does not authorize erasure.
                if let matchingRuntime {
                    try? await matchingRuntime.syncRepository.saveBindingState(
                        .revoked,
                        for: identity
                    )
                } else if let trustedRecord,
                          let prepared = try? environment.prepare(
                              record: trustedRecord.replacingPhase(.cleanupPending),
                              repositoryIdentity: identity,
                              restoring: true
                          ), prepared.existingRepositoryStatus == .valid,
                          let repository = prepared.existingRepository {
                    try? await repository.saveBindingState(.revoked, for: identity)
                }
            }

            let delays = [Int64(250), 1_000, 5_000, 30_000]
            await serverRevocationCleanupRetrySleep(delays[min(retry, delays.count - 1)])
            retry += 1
        }
        return false
    }

    private func finishServerRevocationCleanup(for identity: SyncBindingIdentity) {
        if serverRevocationCleanupIdentity == identity {
            serverRevocationFenceTask = nil
            serverRevocationCleanupTask = nil
            serverRevocationCleanupIdentity = nil
        }
    }

    /// Commits a durable, non-runnable revocation intent before the first
    /// management request. A failed request leaves only the cleanup runtime,
    /// so the caller can retry without making the data plane reachable again.
    public func revoke(secret: String) async throws {
        guard !secret.isEmpty,
              serverRevocationCleanupIdentity == nil,
              let targetRuntime = runtime ?? cleanupRuntime else {
            throw MobileBindingCoordinatorError.invalidState
        }
        targetRuntime.beginCleanupHandoff()
        if runtime?.identity == targetRuntime.identity {
            runtime = nil
        }
        cleanupRuntime = targetRuntime

        guard let sid = try targetRuntime.credentials.credentials(
            for: targetRuntime.sideEffectLease
        )?.sid else {
            throw MobileBindingCoordinatorError.incompleteBinding
        }

        do {
            guard let loaded = try recordStore.load() else {
                throw MobileBindingCleanupHandoffError.staleIdentity
            }
            let loadedIdentity = syncRepositoryIdentity(loaded)
            guard loadedIdentity == targetRuntime.identity ||
                    (loaded.phase == .cleanupPending &&
                     loadedIdentity.hasSameBindingGeneration(as: targetRuntime.identity)) else {
                throw MobileBindingCleanupHandoffError.staleIdentity
            }
            let cleanupSnapshot: MobileBindingRecordSnapshot
            if loaded.phase == .cleanupPending {
                cleanupSnapshot = loaded
            } else {
                cleanupSnapshot = try persistCleanupMarker(
                    for: targetRuntime.identity,
                    trustedRecord: nil,
                    expectedSnapshot: loaded
                )
            }
            try await fenceRepositoryForCleanup(
                targetRuntime.syncRepository,
                cleanupIdentity: syncRepositoryIdentity(cleanupSnapshot)
            )
            guard try recordStore.load() == cleanupSnapshot else {
                throw MobileBindingCleanupHandoffError.staleIdentity
            }
        } catch MobileBindingCleanupHandoffError.staleIdentity {
            throw MobileBindingCoordinatorError.identityMismatch
        } catch is SQLiteSyncRepositoryError {
            throw Self.cleanupError([.repository])
        } catch {
            throw Self.cleanupError([.bindingRecord])
        }
        // The durable marker and exact repository fence precede cancellation and
        // every management request, so retained runtime references cannot re-enter.
        await targetRuntime.cancelAndJoin(reason: .revocation)

        let grant = try await targetRuntime.managementAPI.verifySensitive(
            action: .deviceRevoke,
            secret: secret,
            targetIds: [targetRuntime.identity.deviceID],
            sid: sid
        )
        guard grant.expiresAt > clock.nowMilliseconds() else {
            throw MobileBindingCoordinatorError.grantExpired
        }
        try Task.checkCancellation()
        _ = try await targetRuntime.managementAPI.revokeDevice(
            deviceId: targetRuntime.identity.deviceID,
            sid: sid,
            sensitiveGrant: grant.grant
        )

        guard try await destroyBinding(
            reason: .revocation,
            expectedIdentity: targetRuntime.identity
        ) else {
            throw MobileBindingCoordinatorError.identityMismatch
        }
    }

    private func authenticate(
        _ operation: @escaping @Sendable () async throws
            -> (MobileLoginResponse, MobileCapabilitiesResponse)
    ) async throws -> MobileBindingLoginStep {
        let id = UUID()
        let task = Task { () throws -> MobileAuthenticationAttempt in
            let (response, capabilities) = try await operation()
            switch response {
            case .totpRequired(let tempToken):
                return .totpRequired(tempToken, capabilities)
            case .mustChangePassword:
                return .passwordChangeRequired
            case .authenticated(let session):
                return .authenticated(
                    MobileAuthenticationContext(session: session, capabilities: capabilities)
                )
            }
        }
        authenticationTask = (id, task)
        do {
            let attempt = try await task.value
            guard authenticationTask?.id == id else {
                throw MobileBindingCoordinatorError.authenticationCancelled
            }
            authenticationTask = nil
            switch attempt {
            case .totpRequired(let token, let capabilities):
                tempToken = token
                pendingCapabilities = capabilities
                authentication = nil
                loadedTokens = []
                return .totpRequired
            case .passwordChangeRequired:
                clearAuthenticationState()
                return .passwordChangeRequired
            case .authenticated(let context):
                authentication = context
                tempToken = nil
                pendingCapabilities = nil
                loadedTokens = []
                return .ready(
                    accountID: context.session.user.userId,
                    username: context.session.user.username
                )
            }
        } catch {
            if authenticationTask?.id == id { authenticationTask = nil }
            throw error
        }
    }

    private static func validate(
        _ capabilities: MobileCapabilitiesResponse,
        appVersion: String
    ) throws {
        guard capabilities.supports(protocolVersion: SyncContract.protocolVersion) else {
            throw MobileBindingCoordinatorError.unsupportedProtocol
        }
        guard capabilities.features.bidirectionalSync,
              capabilities.features.nearRealtimeWake,
              capabilities.serverEncryption != nil else {
            throw MobileBindingCoordinatorError.unsupportedSyncFeatures
        }
        if let minimum = capabilities.minimumAppVersions?.ios,
           Self.compareVersions(appVersion, minimum) < 0 {
            throw MobileBindingCoordinatorError.unsupportedProtocol
        }
    }

    private static func validate(
        response: MobileDeviceBindResponse,
        bindAttempt: MobileBindAttempt,
        record: MobileBindingRecord,
        capabilities: MobileCapabilitiesResponse,
        appVersion: String,
        nowMilliseconds: Int64
    ) throws {
        guard response.device.deviceId == record.deviceID,
              response.device.ownerUserId == record.accountID,
              response.device.tokenId == record.tokenID,
              response.device.platform == "ios",
              response.device.appVersion == appVersion,
              response.device.enabled,
              response.device.revokedAt == nil,
              response.device.syncIntervalSec == record.syncIntervalSeconds,
              response.device.createdAt > 0,
              response.bindingProtocolVersion == 2,
              response.bindingRevision == bindAttempt.expectedBindingRevision + 1,
              response.device.bindingRevision == nil ||
                response.device.bindingRevision == response.bindingRevision,
              response.registryHash == capabilities.registryHash,
              response.accessExpiresAt > nowMilliseconds,
              response.bootstrapRequired else {
            throw MobileBindingCoordinatorError.identityMismatch
        }
    }

    private static func validate(
        refresh: MobileDeviceRefreshResponse,
        record: MobileBindingRecord,
        capabilities: MobileCapabilitiesResponse,
        appVersion: String,
        nowMilliseconds: Int64
    ) throws {
        guard refresh.device.deviceId == record.deviceID,
              refresh.device.ownerUserId == record.accountID,
              refresh.device.tokenId == record.tokenID,
              refresh.device.platform == "ios",
              refresh.device.appVersion == appVersion,
              refresh.device.enabled,
              refresh.device.revokedAt == nil,
              refresh.registryHash == capabilities.registryHash,
              refresh.accessExpiresAt > nowMilliseconds else {
            throw MobileBindingCoordinatorError.identityMismatch
        }
    }

    private func persistCleanupMarker(
        for identity: SyncBindingIdentity,
        trustedRecord: MobileBindingRecord?,
        expectedSnapshot: MobileBindingRecordSnapshot? = nil
    ) throws -> MobileBindingRecordSnapshot {
        let liveRuntimes = [runtime, cleanupRuntime].compactMap { $0 }
        guard liveRuntimes.allSatisfy({ $0.identity == identity }) else {
            throw MobileBindingCleanupHandoffError.staleIdentity
        }

        let storedSnapshot: MobileBindingRecordSnapshot?
        do { storedSnapshot = try recordStore.load() }
        catch { throw MobileBindingCleanupHandoffError.markerUnavailable }
        if let expectedSnapshot, syncRepositoryIdentity(expectedSnapshot) != identity {
            throw MobileBindingCleanupHandoffError.staleIdentity
        }
        if let trustedRecord, !trustedRecord.identity.hasSameBindingGeneration(as: identity) {
            throw MobileBindingCleanupHandoffError.staleIdentity
        }

        if let expectedSnapshot, storedSnapshot != expectedSnapshot {
            throw MobileBindingCleanupHandoffError.staleIdentity
        }

        if let storedSnapshot {
            let storedIdentity = syncRepositoryIdentity(storedSnapshot)
            if storedSnapshot.phase == .cleanupPending,
               storedIdentity.hasSameBindingGeneration(as: identity) {
                return storedSnapshot
            }
            guard storedIdentity == identity else {
                throw MobileBindingCleanupHandoffError.staleIdentity
            }
        }
        let sourceSnapshot = expectedSnapshot ?? storedSnapshot
        let sourceRecord = sourceSnapshot?.record ?? trustedRecord
            ?? liveRuntimes.first.map { cleanupRecord(from: $0.summary) }
        guard let sourceRecord else {
            throw MobileBindingCleanupHandoffError.staleIdentity
        }
        do {
            let cleanupRecord = sourceRecord.replacingPhase(.cleanupPending)
            let persisted: MobileBindingRecordSnapshot?
            if let sourceSnapshot {
                guard storedSnapshot == sourceSnapshot else {
                    throw MobileBindingCleanupHandoffError.staleIdentity
                }
                persisted = try recordStore.replace(cleanupRecord, expected: sourceSnapshot)
            } else {
                guard storedSnapshot == nil else {
                    throw MobileBindingCleanupHandoffError.staleIdentity
                }
                persisted = try recordStore.insertIfAbsent(cleanupRecord)
            }
            guard let persisted else { throw MobileBindingCleanupHandoffError.staleIdentity }
            return persisted
        } catch let handoff as MobileBindingCleanupHandoffError {
            throw handoff
        } catch {
            throw MobileBindingCleanupHandoffError.markerUnavailable
        }
    }

    private func currentBindingIdentityForTeardown() throws -> SyncBindingIdentity? {
        let storedSnapshot: MobileBindingRecordSnapshot?
        do {
            storedSnapshot = try recordStore.load()
        } catch {
            runtime?.beginCleanupHandoff()
            if cleanupRuntime == nil { cleanupRuntime = runtime }
            runtime = nil
            throw Self.cleanupError([.bindingRecord])
        }
        let liveIdentities = [runtime?.identity, cleanupRuntime?.identity].compactMap { $0 }
        guard let first = liveIdentities.first ?? storedSnapshot.map(syncRepositoryIdentity) else {
            return nil
        }
        guard liveIdentities.allSatisfy({ $0 == first }) else {
            throw Self.cleanupError([.bindingRecord])
        }
        if let storedSnapshot {
            let storedIdentity = syncRepositoryIdentity(storedSnapshot)
            guard storedIdentity == first ||
                    (storedSnapshot.phase == .cleanupPending &&
                     storedIdentity.hasSameBindingGeneration(as: first)) else {
                throw Self.cleanupError([.bindingRecord])
            }
        }
        return first
    }

    @discardableResult
    private func destroyBinding(
        reason: SyncSchedulerCancellationReason,
        expectedIdentity: SyncBindingIdentity?
    ) async throws -> Bool {
        let storedSnapshot: MobileBindingRecordSnapshot?
        do {
            storedSnapshot = try recordStore.load()
        } catch {
            [runtime, cleanupRuntime].compactMap { $0 }.forEach {
                $0.beginCleanupHandoff()
            }
            if cleanupRuntime == nil { cleanupRuntime = runtime }
            runtime = nil
            throw Self.cleanupError([.bindingRecord])
        }
        let liveRuntimes = [runtime, cleanupRuntime].compactMap { $0 }
        let liveIdentities = liveRuntimes.map(\.identity)
        let storedIdentity = storedSnapshot.map(syncRepositoryIdentity)
        let identities = liveIdentities + [storedIdentity].compactMap { $0 }
        if let expectedIdentity {
            guard !liveIdentities.contains(where: { $0 != expectedIdentity }) else { return false }
            if let storedSnapshot {
                let storedIdentity = syncRepositoryIdentity(storedSnapshot)
                guard storedIdentity == expectedIdentity ||
                        (storedSnapshot.phase == .cleanupPending &&
                         storedIdentity.hasSameBindingGeneration(as: expectedIdentity)) else {
                    return false
                }
            }
            if liveIdentities.isEmpty {
                guard storedIdentity == expectedIdentity else { return false }
            }
        } else {
            guard identities.isEmpty else { return false }
        }

        guard !tearingDown else { throw MobileBindingCoordinatorError.invalidState }
        tearingDown = true
        defer { tearingDown = false }

        let targetIdentity = expectedIdentity ?? identities.first
        let currentRuntime = [runtime, cleanupRuntime]
            .compactMap { $0 }
            .first { targetIdentity == nil || $0.identity == targetIdentity }
        currentRuntime?.beginCleanupHandoff()
        runtime = nil
        cleanupRuntime = currentRuntime

        guard targetIdentity != nil else {
            clearAuthenticationState()
            return true
        }

        let cleanupSnapshot: MobileBindingRecordSnapshot
        let credentialSourceLease: GenerationSideEffectLease?
        do {
            if let storedSnapshot, storedSnapshot.phase == .cleanupPending {
                cleanupSnapshot = storedSnapshot
                credentialSourceLease = currentRuntime?.sideEffectLease
            } else if let storedSnapshot {
                guard let persisted = try recordStore.replace(
                    storedSnapshot.record.replacingPhase(.cleanupPending),
                    expected: storedSnapshot
                ) else {
                    return false
                }
                cleanupSnapshot = persisted
                credentialSourceLease = try GenerationSideEffectLease(snapshot: storedSnapshot)
            } else if let currentRuntime {
                guard let persisted = try recordStore.insertIfAbsent(
                    cleanupRecord(from: currentRuntime.summary)
                ) else {
                    return false
                }
                cleanupSnapshot = persisted
                credentialSourceLease = currentRuntime.sideEffectLease
            } else {
                return false
            }
        } catch {
            throw Self.cleanupError([.bindingRecord])
        }
        let cleanupIdentity = syncRepositoryIdentity(cleanupSnapshot)

        var preparedForCleanup: MobilePreparedBinding?
        let cleanupCredentials: (any MobileBindingCredentialStoring)?
        if let currentRuntime {
            cleanupCredentials = currentRuntime.credentials
        } else {
            preparedForCleanup = try? environment.prepare(
                record: cleanupSnapshot.record,
                repositoryIdentity: cleanupIdentity,
                restoring: true
            )
            cleanupCredentials = preparedForCleanup?.credentials
        }

        do {
            guard try recordStore.load() == cleanupSnapshot else {
                throw MobileBindingCleanupHandoffError.staleIdentity
            }
        } catch {
            throw Self.cleanupError([.bindingRecord])
        }
        let cleanupRepository = currentRuntime?.syncRepository ?? preparedForCleanup?.existingRepository
        if let cleanupRepository {
            do {
                try await fenceRepositoryForCleanup(
                    cleanupRepository,
                    cleanupIdentity: cleanupIdentity
                )
                guard try recordStore.load() == cleanupSnapshot else {
                    throw MobileBindingCleanupHandoffError.staleIdentity
                }
            } catch MobileBindingCleanupHandoffError.staleIdentity {
                return false
            } catch {
                throw Self.cleanupError([.repository])
            }
        }
        guard let cleanupCredentials,
              let cleanupLease = try? GenerationSideEffectLease(snapshot: cleanupSnapshot) else {
            throw Self.cleanupError([.credentials])
        }
        do {
            try cleanupCredentials.reconcileLease(
                cleanupLease,
                replacing: credentialSourceLease
            )
        } catch {
            // A predecessor can be older than the durable restoring record if
            // the process died between the record CAS and Keychain reconcile.
            // Only restart cleanup, with no live runtime, may adopt it after
            // revalidating the exact terminal marker again.
            guard currentRuntime == nil,
                  (try? recordStore.load()) == cleanupSnapshot else {
                throw Self.cleanupError([.credentials])
            }
            do {
                try cleanupCredentials.reconcileLease(cleanupLease, replacing: nil)
            } catch {
                throw Self.cleanupError([.credentials])
            }
        }
        do {
            try cleanupCredentials.terminateLease(cleanupLease)
        } catch {
            throw Self.cleanupError([.credentials])
        }

        // The exact repository cleanup lease and secret-free credential tombstone
        // are durable before cancellation and erasure continue.
        await cancelTransientWork()
        await currentRuntime?.cancelAndJoin(reason: reason)

        var failures = [MobileBindingCleanupComponent]()

        var repositoryErased = false
        if let cleanupRepository {
            do {
                try await cleanupRepository.purgeAll(for: cleanupIdentity)
                repositoryErased = true
            } catch {}
        }
        if !repositoryErased, preparedForCleanup == nil {
            preparedForCleanup = try? environment.prepare(
                record: cleanupSnapshot.record,
                repositoryIdentity: cleanupIdentity,
                restoring: true
            )
        }
        if !repositoryErased, let preparedForCleanup {
            do {
                try preparedForCleanup.eraseEncryptedStorage()
                repositoryErased = true
            } catch {
                failures.append(.repository)
            }
        }
        if !repositoryErased, !failures.contains(.repository) {
            failures.append(.repository)
        }

        if let currentRuntime {
            failures.append(contentsOf: currentRuntime.removePrivateIdentityMaterial())
        } else if let preparedForCleanup {
            do { try preparedForCleanup.signingIdentity.deleteIdentity() }
            catch { failures.append(.signingIdentity) }
        }
        do { try encryptionIdentity.deleteIdentity(for: cleanupIdentity) }
        catch { failures.append(.encryptionIdentity) }

        if failures.isEmpty {
            do {
                guard try recordStore.clear(expected: cleanupSnapshot) else {
                    throw MobileBindingCleanupHandoffError.staleIdentity
                }
            } catch {
                failures.append(.bindingRecord)
            }
        }
        clearAuthenticationState()
        if !failures.isEmpty {
            throw Self.cleanupError(failures)
        }
        cleanupRuntime = nil
        runtime = nil
        return true
    }

    private func clearAuthenticationState() {
        authentication = nil
        tempToken = nil
        pendingCapabilities = nil
        loadedTokens.removeAll(keepingCapacity: false)
    }

    private static func cleanupError(
        _ failures: [MobileBindingCleanupComponent]
    ) -> MobileBindingCoordinatorError {
        .cleanupFailed(Array(Set(failures)).sorted { $0.rawValue < $1.rawValue })
    }

    private static func compareVersions(_ left: String, _ right: String) -> Int {
        let lhs = left.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let rhs = right.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let count = max(lhs.count, rhs.count)
        for index in 0..<count {
            let a = index < lhs.count ? lhs[index] : 0
            let b = index < rhs.count ? rhs[index] : 0
            if a < b { return -1 }
            if a > b { return 1 }
        }
        return 0
    }
}
