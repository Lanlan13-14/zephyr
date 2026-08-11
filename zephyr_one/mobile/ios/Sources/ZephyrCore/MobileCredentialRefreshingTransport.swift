import Foundation

public protocol MobileBindingAPI: SyncTransport {
    func login(
        username: String,
        password: String,
        captchaToken: String?,
        remember: Bool
    ) async throws -> MobileLoginResponse
    func verifyTotp(tempToken: String, code: String) async throws -> MobileLoginResponse
    func logout(sid: String) async throws
    func verifySensitive(
        action: MobileSensitiveAction,
        secret: String,
        targetIds: [String],
        sid: String
    ) async throws -> MobileSensitiveGrantResponse
    func bind(
        _ request: MobileDeviceBindRequest,
        sid: String,
        sensitiveGrant: String
    ) async throws -> MobileDeviceBindResponse
    func refresh(
        deviceId: String,
        refreshCredential: String
    ) async throws -> MobileDeviceRefreshResponse
    func revokeDevice(
        deviceId: String,
        sid: String,
        sensitiveGrant: String
    ) async throws -> MobileDeviceRevokeResponse
}

extension MobileApiClient: MobileBindingAPI {}

protocol MobileBindingCredentialStoring: AnyObject, Sendable {
    func activateLease(_ lease: GenerationSideEffectLease) throws
    func replaceLease(
        _ replacement: GenerationSideEffectLease,
        expected: GenerationSideEffectLease
    ) throws
    func reconcileLease(
        _ replacement: GenerationSideEffectLease,
        replacing expected: GenerationSideEffectLease?
    ) throws
    func activeLease() throws -> GenerationSideEffectLease?
    func credentials(for lease: GenerationSideEffectLease) throws -> KeychainCredentials?
    func storeInitial(
        _ credentials: KeychainCredentials,
        for lease: GenerationSideEffectLease
    ) throws
    func rotate(
        accessCredential: String,
        accessExpiresAtMilliseconds: Int64?,
        refreshCredential: String,
        for lease: GenerationSideEffectLease
    ) throws
    /// Completes a cleanup handoff only after the caller has reconciled the
    /// exact source lease to its durable cleanup snapshot. This preserves the
    /// terminal tombstone; callers must not substitute a Keychain delete.
    func terminateLease(_ lease: GenerationSideEffectLease) throws
    func accessNeedsRefresh(
        nowMilliseconds: Int64,
        for lease: GenerationSideEffectLease
    ) throws -> Bool
}

extension KeychainCredentialStore: MobileBindingCredentialStoring {}

protocol MobileBindingSigningIdentityManaging: AnyObject, Sendable {
    var deviceID: String { get }
    func ensureIdentity() throws -> DeviceSigningIdentity
    func hasIdentity() throws -> Bool
    func deleteIdentity() throws
    func makeProofSigner() -> any DeviceProofSigning
}

extension DeviceIdentityStore: MobileBindingSigningIdentityManaging {
    func makeProofSigner() -> any DeviceProofSigning {
        KeychainDeviceProofSigner(identityStore: self)
    }
}

protocol MobileBindingSyncRepository: SyncRepository, SyncMirrorStore {}
extension SQLiteSyncRepository: MobileBindingSyncRepository {}

/// Serializes rotating refresh credentials across SyncEngine and the SSE
/// reconnect loop. A successful response replaces access + refresh atomically
/// before either caller is allowed to continue.
actor MobileAccessCredentialController {
    private let api: any MobileBindingAPI
    private let credentials: any MobileBindingCredentialStoring
    private var lease: GenerationSideEffectLease
    private let identity: SyncBindingIdentity
    private let tokenID: String
    private let appVersion: String
    private let expectedRegistryHash: String
    private let clock: any MobileBindingClock

    private var refreshTask: (id: UUID, task: Task<MobileDeviceRefreshResponse, Error>)?
    private var credentialVersion: UInt64 = 0
    private var cancelled = false

    init(
        api: any MobileBindingAPI,
        credentials: any MobileBindingCredentialStoring,
        lease: GenerationSideEffectLease,
        identity: SyncBindingIdentity,
        tokenID: String,
        appVersion: String,
        expectedRegistryHash: String,
        clock: any MobileBindingClock
    ) {
        self.api = api
        self.credentials = credentials
        self.lease = lease
        self.identity = identity
        self.tokenID = tokenID
        self.appVersion = appVersion
        self.expectedRegistryHash = expectedRegistryHash
        self.clock = clock
    }

    func ensureFresh(force: Bool = false) async throws -> MobileDeviceRefreshResponse? {
        guard !cancelled else { throw CancellationError() }
        if !force, try !credentials.accessNeedsRefresh(
            nowMilliseconds: clock.nowMilliseconds(),
            for: lease
        ) {
            return nil
        }
        if let ongoing = refreshTask {
            do {
                let response = try await ongoing.task.value
                if refreshTask?.id == ongoing.id {
                    refreshTask = nil
                    credentialVersion &+= 1
                }
                return response
            } catch {
                if refreshTask?.id == ongoing.id {
                    refreshTask = nil
                    if let apiError = error as? MobileApiError,
                       apiError.code == "registry_mismatch" {
                        credentialVersion &+= 1
                    }
                }
                throw error
            }
        }
        let lease = self.lease
        guard let current = try credentials.credentials(for: lease) else {
            throw MobileApiError.local(
                code: "token_missing",
                message: "The binding credential is unavailable"
            )
        }

        let api = self.api
        let credentials = self.credentials
        let identity = self.identity
        let tokenID = self.tokenID
        let appVersion = self.appVersion
        let expectedRegistryHash = self.expectedRegistryHash
        let nowMilliseconds = clock.nowMilliseconds()
        let task = Task {
            let response = try await api.refresh(
                deviceId: identity.deviceID,
                refreshCredential: current.refreshCredential
            )
            guard response.device.deviceId == identity.deviceID,
                  response.device.ownerUserId == identity.accountID,
                  response.device.tokenId == tokenID,
                  response.device.platform == "ios",
                  response.device.appVersion == appVersion,
                  response.device.enabled,
                  response.device.revokedAt == nil,
                  (SyncContract.minIntervalSec...SyncContract.maxIntervalSec)
                      .contains(response.device.syncIntervalSec) else {
                throw MobileApiError.local(
                    code: "client_revoked",
                    message: "The refreshed binding identity is no longer valid"
                )
            }
            guard response.accessExpiresAt > nowMilliseconds else {
                throw MobileApiError.local(
                    code: "access_credential_expired",
                    message: "The refreshed access credential is already expired",
                    retryable: true
                )
            }
            try Task.checkCancellation()
            try credentials.rotate(
                accessCredential: response.accessCredential,
                accessExpiresAtMilliseconds: response.accessExpiresAt,
                refreshCredential: response.refreshCredential,
                for: lease
            )
            guard response.registryHash == expectedRegistryHash else {
                throw MobileApiError.local(
                    code: "registry_mismatch",
                    message: "The server entity registry changed"
                )
            }
            return response
        }
        let refreshID = UUID()
        refreshTask = (refreshID, task)
        do {
            let response = try await task.value
            if refreshTask?.id == refreshID {
                refreshTask = nil
                credentialVersion &+= 1
            }
            return response
        } catch {
            if refreshTask?.id == refreshID {
                refreshTask = nil
                if let apiError = error as? MobileApiError,
                   apiError.code == "registry_mismatch" {
                    credentialVersion &+= 1
                }
            }
            throw error
        }
    }

    func currentCredentialVersion() -> UInt64 { credentialVersion }

    func currentLease() -> GenerationSideEffectLease { lease }

    /// Advances the controller and Keychain item together after an exact
    /// binding-record CAS. Retrying an already-completed handoff is safe.
    func replaceLease(
        _ replacement: GenerationSideEffectLease,
        expected: GenerationSideEffectLease
    ) throws {
        guard lease == expected || lease == replacement else {
            throw KeychainCredentialStoreError.staleLease
        }
        try credentials.replaceLease(replacement, expected: expected)
        lease = replacement
    }

    func refreshAfterUnauthorized(ifVersion version: UInt64) async throws {
        guard version == credentialVersion else { return }
        _ = try await ensureFresh(force: true)
    }

    func cancelAndJoin() async {
        cancelled = true
        let task = refreshTask?.task
        refreshTask = nil
        task?.cancel()
        if let task { _ = await task.result }
    }
}

/// Ensures a fresh access credential before every finite sync request. The
/// wrapped MobileApiClient still creates a new Device Proof v2 challenge for
/// each request after refresh has completed.
final class RefreshingSyncTransport: SyncTransport, @unchecked Sendable {
    private let api: any MobileBindingAPI
    private let refresh: MobileAccessCredentialController

    init(api: any MobileBindingAPI, refresh: MobileAccessCredentialController) {
        self.api = api
        self.refresh = refresh
    }

    func capabilities() async throws -> MobileCapabilitiesResponse {
        try await api.capabilities()
    }

    func bootstrap(pageToken: String?, limit: Int?) async throws -> MobileBootstrapResponse {
        try await withFreshAccess {
            try await self.api.bootstrap(pageToken: pageToken, limit: limit)
        }
    }

    func changes(cursor: Int64, limit: Int?) async throws -> MobileChangesResponse {
        try await withFreshAccess {
            try await self.api.changes(cursor: cursor, limit: limit)
        }
    }

    func push(_ request: MobilePushRequest) async throws -> MobilePushResponse {
        try await withFreshAccess { try await self.api.push(request) }
    }

    func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse {
        try await withFreshAccess { try await self.api.ack(request) }
    }

    private func withFreshAccess<T>(
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        _ = try await refresh.ensureFresh()
        let credentialVersion = await refresh.currentCredentialVersion()
        do {
            return try await operation()
        } catch let error as MobileApiError where Self.canRecoverByRefreshing(error) {
            try Task.checkCancellation()
            try await refresh.refreshAfterUnauthorized(ifVersion: credentialVersion)
            return try await operation()
        }
    }

    private static func canRecoverByRefreshing(_ error: MobileApiError) -> Bool {
        // An access request can race a successful refresh performed by the SSE
        // loop. `token_rotated` is recoverable here: a stale credential version
        // skips the second refresh and retries with the credentials now on disk.
        if error.code == "token_rotated" { return true }
        guard !error.requiresRebind, error.code != "device_proof_invalid" else { return false }
        return error.httpStatus == 401 || [
            "access_expired", "access_credential_expired", "access_credential_invalid",
        ].contains(error.code)
    }
}

final class RefreshingWakeStreamTransport: WakeStreamTransport, @unchecked Sendable {
    private let refresh: MobileAccessCredentialController
    private let wake: any WakeStreamTransport

    init(refresh: MobileAccessCredentialController, wake: any WakeStreamTransport) {
        self.refresh = refresh
        self.wake = wake
    }

    func open(
        lastEventID: String?,
        onWake: @escaping @Sendable (WakeStreamEvent) async -> Void
    ) async -> WakeStreamOutcome {
        do {
            _ = try await refresh.ensureFresh()
            let credentialVersion = await refresh.currentCredentialVersion()
            let outcome = await wake.open(lastEventID: lastEventID, onWake: onWake)
            guard Self.canRecoverByRefreshing(outcome) else { return outcome }
            try Task.checkCancellation()
            try await refresh.refreshAfterUnauthorized(ifVersion: credentialVersion)
            return await wake.open(lastEventID: lastEventID, onWake: onWake)
        } catch is CancellationError {
            return WakeStreamOutcome(failureCode: "cancelled")
        } catch let error as MobileApiError {
            return WakeStreamOutcome(
                retryAfterMilliseconds: error.retryAfterSeconds.map(Self.milliseconds),
                failureCode: error.code
            )
        } catch let error as MobileBindingCoordinatorError {
            let code = error == .identityMismatch ? "client_revoked" : "token_missing"
            return WakeStreamOutcome(failureCode: code)
        } catch {
            return WakeStreamOutcome(failureCode: "token_refresh_failed")
        }
    }

    private static func milliseconds(_ seconds: Int64) -> Int64 {
        let nonnegative = max(0, seconds)
        return nonnegative > Int64.max / 1_000 ? Int64.max : nonnegative * 1_000
    }

    private static func canRecoverByRefreshing(_ outcome: WakeStreamOutcome) -> Bool {
        guard let code = outcome.failureCode else { return false }
        return [
            "wake_unauthorized", "access_expired", "access_credential_expired",
            "access_credential_invalid", "token_rotated",
        ].contains(code)
    }
}
