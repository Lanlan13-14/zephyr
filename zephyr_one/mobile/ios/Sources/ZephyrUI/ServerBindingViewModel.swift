import Combine
import Foundation
import ZephyrContracts
import ZephyrCore

@MainActor
protocol ServerBindingSensitiveBufferClearing: AnyObject {
    func clear()
    func clearTotp()
}

public enum ServerBindingFailureOperation: String, Equatable, Sendable {
    case prepareServer
    case login
    case totp
    case loadTokens
    case bind
}

/// Presentation-safe failure data. Server-provided messages and details never
/// enter this value; only a normalized code and request id may be displayed.
public struct ServerBindingFailure: Equatable, Sendable {
    public let operation: ServerBindingFailureOperation
    public let title: String
    public let message: String
    public let code: String
    public let requestID: String?
    public let retryable: Bool

    public var diagnosticText: String {
        var text = "code=" + code
        if let requestID { text += " requestId=" + requestID }
        return text
    }
}

/// Every visible page in the server-binding flow. Network work has explicit
/// loading states, while failures retain the operation needed for a safe retry.
public enum ServerBindingStage: Equatable, Sendable {
    case serverAddress
    case credentials
    case secondFactor
    case passwordChangeRequired
    case resettingAuthentication
    case loadingTokens
    case tokenChoice
    case device
    case binding
    case success(MobileBindingSummary)
    case failure(ServerBindingFailure)
}

/// A small closure adapter keeps XCTest independent of Keychain, SQLite and
/// the network while the public initializer still uses MobileBindingCoordinator.
struct ServerBindingDriver: Sendable {
    let beginLogin: @Sendable (String, String, String?) async throws -> MobileBindingLoginStep
    let continueTotp: @Sendable (String) async throws -> MobileBindingLoginStep
    let listTokens: @Sendable () async throws -> [MobileBindingToken]
    let bind: @Sendable (String, MobileBindingRegistration) async throws -> MobileBindingSummary
    let cancelTransientWork: @Sendable () async -> Void
}

/// S02 主端与绑定.
///
/// Password and TOTP text are owned by SwiftUI's short-lived secure-field
/// buffers and passed into individual methods. This object never stores them
/// in its draft. The coordinator owns SID, temp token and one-shot grant state.
@MainActor
public final class ServerBindingViewModel: ObservableObject, LockSensitiveSink {

    /// These codes are created by the Apple client or its binding coordinator.
    /// Server codes are displayable only when the frozen registry recognizes
    /// them, so an attacker cannot smuggle private data into diagnostics by
    /// choosing a syntactically valid error code.
    private static let localFailureCodes: Set<String> = [
        "binding_cancelled",
        "binding_cleanup_failed",
        "binding_configuration_invalid",
        "binding_failed",
        "binding_identity_mismatch",
        "binding_incomplete",
        "binding_invalid_state",
        "certificate_error",
        "conflict_unstructured",
        "forbidden_unstructured",
        "malformed_response",
        "network_offline",
        "network_timeout",
        "network_unreachable",
        "not_found_unstructured",
        "password_change_required",
        "response_too_large",
        "server_error",
        "server_incompatible",
        "sync_features_unsupported",
        "tls_pin_mismatch",
        "tls_untrusted",
        "token_loader_unavailable",
        "unexpected_redirect",
    ]

    @Published public var draft = ServerBindingDraft()
    @Published public private(set) var stage: ServerBindingStage = .serverAddress
    @Published public private(set) var issues: [BindingFormIssue] = []
    @Published public private(set) var busy = false
    @Published public private(set) var availableTokens: [ClientToken] = []

    /// SwiftUI observes these counters to clear its own plaintext copies on
    /// lock, backgrounding, cancellation, unbind and successful completion.
    @Published public private(set) var sensitiveClearGeneration: UInt64 = 0
    @Published public private(set) var totpClearGeneration: UInt64 = 0

    public var failure: ServerBindingFailure? {
        guard case .failure(let failure) = stage else { return nil }
        return failure
    }

    private let makeDriver: @MainActor (String) throws -> ServerBindingDriver
    private var driver: ServerBindingDriver?
    private weak var appLock: AppLock?
    private weak var sensitiveBuffers: (any ServerBindingSensitiveBufferClearing)?
    private var authenticatedAccountID: String?
    private var operationTask: Task<Void, Never>?
    private var operationSerial: UInt64 = 0

    /// The application shell supplies a coordinator factory because the actor
    /// is configured for the URL entered on this screen. `onBound` must retain
    /// both the coordinator and runtime for the account lifetime.
    public init(
        makeCoordinator: @escaping @MainActor (String) throws -> MobileBindingCoordinator,
        onBound: @escaping @MainActor (MobileBindingCoordinator, MobileBindingRuntime) -> Void
    ) {
        self.makeDriver = { baseURL in
            let coordinator = try makeCoordinator(baseURL)
            return ServerBindingDriver(
                beginLogin: { username, password, captchaToken in
                    try await coordinator.beginLogin(
                        username: username,
                        password: password,
                        captchaToken: captchaToken
                    )
                },
                continueTotp: { code in
                    try await coordinator.continueTotp(code: code)
                },
                listTokens: {
                    try await coordinator.listTokens()
                },
                bind: { secret, registration in
                    let runtime = try await coordinator.bind(
                        secret: secret,
                        registration: registration
                    )
                    await onBound(coordinator, runtime)
                    return runtime.summary
                },
                cancelTransientWork: {
                    await coordinator.cancelTransientWork()
                }
            )
        }
    }

    init(makeDriver: @escaping @MainActor (String) throws -> ServerBindingDriver) {
        self.makeDriver = makeDriver
    }

    public func attachSensitiveLifecycle(to appLock: AppLock) {
        guard self.appLock !== appLock else { return }
        self.appLock?.unregister(self)
        self.appLock = appLock
        appLock.register(self)
    }

    func attachSensitiveBuffers(_ buffers: any ServerBindingSensitiveBufferClearing) {
        sensitiveBuffers = buffers
    }

    func detachSensitiveBuffers() {
        sensitiveBuffers?.clear()
        sensitiveBuffers = nil
    }

    public func detachSensitiveLifecycle() {
        cancel()
        appLock?.unregister(self)
        appLock = nil
    }

    public func onLocked() {
        resetForSensitiveBoundary()
    }

    public func clearSensitiveMaterial() {
        resetForSensitiveBoundary()
    }

    /// Called by explicit cancel, native back navigation and system dismissal.
    public func cancel() {
        operationSerial &+= 1
        operationTask?.cancel()
        operationTask = nil
        busy = false
        requestSensitiveClear()
        clearAuthenticationMetadata()
        let driver = self.driver
        self.driver = nil
        stage = .serverAddress
        if let driver {
            Task { await driver.cancelTransientWork() }
        }
    }

    public func issueFor(field: String) -> BindingFormIssue? {
        issues.first { $0.field == field }
    }

    /// Validates locally before constructing any network-bearing coordinator.
    public func continueFromServerAddress() {
        guard !busy else { return }
        if let issue = draft.urlIssue {
            issues = [issue]
            return
        }
        guard let baseURL = draft.normalizedBaseUrl() else { return }
        do {
            driver = try makeDriver(baseURL)
            clearAuthenticationMetadata()
            issues = []
            stage = .credentials
        } catch {
            stage = .failure(Self.displayFailure(error, operation: .prepareServer))
        }
    }

    public func submitCredentials(password: String, captchaToken: String? = nil) {
        guard !busy, let driver else { return }
        var credentialIssues = [BindingFormIssue]()
        if draft.username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            credentialIssues.append(
                BindingFormIssue(field: "username", message: ServerBindingDraft.msgUsernameRequired)
            )
        }
        if password.isEmpty {
            credentialIssues.append(
                BindingFormIssue(field: "password", message: ServerBindingDraft.msgPasswordRequired)
            )
        }
        guard credentialIssues.isEmpty else {
            issues = credentialIssues
            stage = .credentials
            return
        }

        issues = []
        let username = draft.username.trimmingCharacters(in: .whitespacesAndNewlines)
        let serial = beginOperation()
        operationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let loginStep = try await driver.beginLogin(username, password, captchaToken)
                await self.resolveLoginStep(loginStep, driver: driver, serial: serial, clearTotp: false)
            } catch {
                self.finishWithError(error, operation: .login, serial: serial)
            }
        }
    }

    public func submitSecondFactor(code: String) {
        guard !busy, let driver else { return }
        guard !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            issues = [
                BindingFormIssue(field: "totpCode", message: ServerBindingDraft.msgTotpRequired),
            ]
            stage = .secondFactor
            return
        }

        issues = []
        let serial = beginOperation()
        operationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let loginStep = try await driver.continueTotp(code)
                await self.resolveLoginStep(loginStep, driver: driver, serial: serial, clearTotp: true)
            } catch {
                guard self.isCurrent(serial) else { return }
                self.requestTotpClear()
                self.finishWithError(error, operation: .totp, serial: serial)
            }
        }
    }

    public func continueFromTokenChoice() -> Bool {
        guard !busy else { return false }
        guard let accountID = authenticatedAccountID else {
            stage = .failure(Self.flowStateFailure(operation: .loadTokens))
            return false
        }
        if let issue = draft.tokenIssue(available: availableTokens, accountUserId: accountID) {
            issues = [issue]
            return false
        }
        issues = []
        stage = .device
        return true
    }

    public func reloadTokens() {
        loadTokens()
    }

    public func deviceIssues() -> [BindingFormIssue] {
        var collected = [BindingFormIssue]()
        if let issue = draft.deviceNameIssue { collected.append(issue) }
        return collected
    }

    public func submitBinding(secret: String) {
        guard !busy, let driver else { return }
        let collected = deviceIssues()
        guard collected.isEmpty else {
            issues = collected
            stage = .device
            return
        }
        guard !secret.isEmpty else {
            issues = [
                BindingFormIssue(field: "password", message: ServerBindingDraft.msgPasswordRequired),
            ]
            stage = .credentials
            return
        }
        let registration: MobileBindingRegistration
        do {
            registration = try MobileBindingRegistration(
                tokenID: "link-v2-enrollment",
                tokenName: "Zephyr Link",
                deviceName: draft.deviceName,
                syncIntervalSeconds: draft.clampedIntervalSec
            )
        } catch {
            issues = deviceIssues()
            if issues.isEmpty {
                stage = .failure(Self.displayFailure(error, operation: .bind))
            }
            return
        }

        issues = []
        stage = .binding
        let serial = beginOperation()
        operationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let summary = try await driver.bind(secret, registration)
                guard self.finishOperation(serial) else { return }
                self.requestSensitiveClear()
                self.clearAuthenticationMetadata(keepTokens: false)
                self.stage = .success(summary)
            } catch {
                self.finishWithError(error, operation: .bind, serial: serial)
            }
        }
    }

    public func retry(password: String, totpCode: String) {
        guard case .failure(let failure) = stage, !busy else { return }
        switch failure.operation {
        case .prepareServer:
            stage = .serverAddress
            continueFromServerAddress()
        case .login:
            stage = .credentials
            submitCredentials(password: password)
        case .totp:
            // The coordinator consumes its temp token before attempting TOTP.
            // A safe retry must start a fresh login and obtain a new token.
            stage = .credentials
            submitCredentials(password: password)
        case .loadTokens:
            loadTokens()
        case .bind:
            stage = .device
            submitBinding(secret: password)
        }
    }

    public func editAfterFailure() {
        guard case .failure(let failure) = stage, !busy else { return }
        issues = []
        switch failure.operation {
        case .prepareServer:
            driver = nil
            stage = .serverAddress
        case .login:
            stage = .credentials
        case .totp:
            stage = .credentials
        case .loadTokens:
            stage = .tokenChoice
        case .bind:
            stage = .device
        }
    }

    public func restartAfterPasswordChange() {
        guard !busy else { return }
        resetForSensitiveBoundary()
    }

    func waitForCurrentOperation() async {
        let task = operationTask
        await task?.value
    }

    private func resolveLoginStep(
        _ loginStep: MobileBindingLoginStep,
        driver: ServerBindingDriver,
        serial: UInt64,
        clearTotp: Bool
    ) async {
        guard isCurrent(serial) else { return }
        switch loginStep {
        case .totpRequired:
            _ = finishOperation(serial)
            if clearTotp { requestTotpClear() }
            stage = .secondFactor
        case .passwordChangeRequired:
            await driver.cancelTransientWork()
            guard finishOperation(serial) else { return }
            requestSensitiveClear()
            clearAuthenticationMetadata()
            stage = .passwordChangeRequired
        case .ready(let accountID, _):
            authenticatedAccountID = accountID
            if clearTotp { requestTotpClear() }
            availableTokens = []
            _ = finishOperation(serial)
            stage = .device
        }
    }

    private func loadTokens() {
        guard !busy, let driver, authenticatedAccountID != nil else {
            if !busy { stage = .failure(Self.flowStateFailure(operation: .loadTokens)) }
            return
        }
        issues = []
        stage = .loadingTokens
        let serial = beginOperation()
        operationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let tokens = try await driver.listTokens()
                guard self.isCurrent(serial), let accountID = self.authenticatedAccountID else { return }
                self.availableTokens = tokens
                    .filter { $0.enabled && $0.ownerAccountID == accountID }
                    .map {
                        ClientToken(id: $0.id, ownerUserId: $0.ownerAccountID, name: $0.name)
                    }
                    .sorted {
                        $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                    }
                _ = self.finishOperation(serial)
                self.stage = .tokenChoice
            } catch {
                self.finishWithError(error, operation: .loadTokens, serial: serial)
            }
        }
    }

    private func resetForSensitiveBoundary() {
        requestSensitiveClear()
        guard case .success = stage else {
            operationSerial &+= 1
            operationTask?.cancel()
            clearAuthenticationMetadata()
            issues = []
            let destination: ServerBindingStage = draft.normalizedBaseUrl() == nil
                ? .serverAddress
                : .credentials
            guard let driver else {
                busy = false
                operationTask = nil
                stage = destination
                return
            }
            busy = true
            stage = .resettingAuthentication
            let serial = operationSerial
            operationTask = Task { [weak self] in
                await driver.cancelTransientWork()
                guard let self else { return }
                if self.finishOperation(serial) { self.stage = destination }
            }
            return
        }
    }

    private func beginOperation() -> UInt64 {
        operationSerial &+= 1
        busy = true
        return operationSerial
    }

    @discardableResult
    private func finishOperation(_ serial: UInt64) -> Bool {
        guard isCurrent(serial) else { return false }
        busy = false
        operationTask = nil
        return true
    }

    private func isCurrent(_ serial: UInt64) -> Bool {
        serial == operationSerial
    }

    private func finishWithError(
        _ error: Error,
        operation: ServerBindingFailureOperation,
        serial: UInt64
    ) {
        guard finishOperation(serial) else { return }
        if Self.isCancellation(error) { return }
        stage = .failure(Self.displayFailure(error, operation: operation))
    }

    private func requestSensitiveClear() {
        sensitiveBuffers?.clear()
        var cleared = draft
        cleared.password.removeAll(keepingCapacity: false)
        cleared.totpCode.removeAll(keepingCapacity: false)
        draft = cleared
        sensitiveClearGeneration &+= 1
    }

    private func requestTotpClear() {
        sensitiveBuffers?.clearTotp()
        if !draft.totpCode.isEmpty {
            var cleared = draft
            cleared.totpCode.removeAll(keepingCapacity: false)
            draft = cleared
        }
        totpClearGeneration &+= 1
    }

    private func clearAuthenticationMetadata(keepTokens: Bool = false) {
        authenticatedAccountID = nil
        if !keepTokens {
            availableTokens.removeAll(keepingCapacity: false)
            draft.selectedTokenId = nil
        }
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return (error as? MobileBindingCoordinatorError) == .authenticationCancelled
    }

    private static func displayFailure(
        _ error: Error,
        operation: ServerBindingFailureOperation
    ) -> ServerBindingFailure {
        if let error = error as? MobileApiError {
            return makeFailure(
                operation: operation,
                code: error.code,
                requestID: error.requestId,
                retryable: apiFailureIsRetryable(code: error.code, localHint: error.retryable)
            )
        }
        if let error = error as? MobileError {
            return makeFailure(
                operation: operation,
                code: error.code,
                requestID: error.requestId,
                retryable: apiFailureIsRetryable(code: error.code, localHint: error.retryable)
            )
        }
        if let error = error as? MobileBindingCoordinatorError {
            let metadata: (String, Bool)
            switch error {
            case .invalidState: metadata = ("binding_invalid_state", false)
            case .authenticationCancelled: metadata = ("binding_cancelled", true)
            case .passwordChangeRequired: metadata = ("password_change_required", false)
            case .tokenLoaderUnavailable: metadata = ("token_loader_unavailable", false)
            case .unsupportedProtocol: metadata = ("server_incompatible", false)
            case .unsupportedSyncFeatures: metadata = ("sync_features_unsupported", false)
            case .identityMismatch: metadata = ("binding_identity_mismatch", false)
            case .grantExpired: metadata = ("sensitive_grant_expired", true)
            case .incompleteBinding: metadata = ("binding_incomplete", false)
            case .cleanupFailed: metadata = ("binding_cleanup_failed", true)
            }
            return makeFailure(
                operation: operation,
                code: metadata.0,
                requestID: nil,
                retryable: metadata.1
            )
        }
        if error is MobileBindingConfigurationError {
            return makeFailure(
                operation: operation,
                code: "binding_configuration_invalid",
                requestID: nil,
                retryable: false
            )
        }
        return makeFailure(
            operation: operation,
            code: "binding_failed",
            requestID: nil,
            retryable: true
        )
    }

    private static func makeFailure(
        operation: ServerBindingFailureOperation,
        code rawCode: String,
        requestID rawRequestID: String?,
        retryable: Bool
    ) -> ServerBindingFailure {
        let code = normalizedFailureCode(rawCode) ?? "unknown_error"
        let message: String
        switch code {
        case "network_offline", "network_timeout", "network_unreachable", "server_unavailable":
            message = "暂时无法连接主端，请检查网络后重试。"
        case "invalid_credentials":
            message = "账号或密码不正确，请修改后重试。"
        case "account_locked", "rate_limited":
            message = "登录暂时受限，请稍后再试。"
        case "totp_invalid":
            message = "动态验证码无效或已过期，请输入新验证码。"
        case "totp_temp_exhausted":
            message = "动态验证码尝试次数已用完，请重新登录后再试。"
        case "captcha_required":
            message = "主端要求额外的人机验证，请先在主端完成验证。"
        case "must_change_password", "password_change_required":
            message = "主端要求先修改账号密码，完成后请重新登录。"
        case "login_guard_blocked":
            message = "主端的登录安全策略阻止了本次登录，请检查主端策略。"
        case "tls_untrusted", "tls_pin_mismatch", "certificate_error":
            message = "无法验证主端证书，请检查地址或已固定的证书指纹。"
        case "server_incompatible", "sync_features_unsupported":
            message = "该主端版本不支持 Zephyr One 的安全同步协议。"
        case "token_loader_unavailable":
            message = "当前主端尚未提供可用的 Client Token 列表，请更新主端或检查集成配置。"
        case "sensitive_grant_expired", "sensitive_grant_consumed":
            message = "安全验证已过期，请重新尝试绑定。"
        case "binding_identity_mismatch":
            message = "主端返回的账号、设备或 Token 信息不一致，绑定已停止。"
        case "binding_configuration_invalid":
            message = "无法准备此主端，请检查地址、证书和本机存储设置。"
        default:
            message = "操作未完成。为保护隐私，错误详情不会显示服务器地址、账号或凭据。"
        }
        let title: String
        switch operation {
        case .prepareServer: title = "无法连接主端"
        case .login: title = "登录未完成"
        case .totp: title = "验证未完成"
        case .loadTokens: title = "无法读取 Client Token"
        case .bind: title = "绑定未完成"
        }
        return ServerBindingFailure(
            operation: operation,
            title: title,
            message: message,
            code: code,
            requestID: code == "unknown_error" ? nil : safeIdentifier(rawRequestID),
            retryable: code == "unknown_error" ? false : retryable
        )
    }

    private static func apiFailureIsRetryable(code rawCode: String, localHint: Bool) -> Bool {
        guard let code = safeIdentifier(rawCode) else { return false }
        if let specification = ErrorRegistry.spec(for: code) {
            return specification.retryable
        }
        return localFailureCodes.contains(code) && localHint
    }

    private static func normalizedFailureCode(_ rawCode: String) -> String? {
        guard let code = safeIdentifier(rawCode) else { return nil }
        guard ErrorRegistry.spec(for: code) != nil || localFailureCodes.contains(code) else {
            return nil
        }
        return code
    }

    private static func flowStateFailure(
        operation: ServerBindingFailureOperation
    ) -> ServerBindingFailure {
        makeFailure(
            operation: operation,
            code: "binding_invalid_state",
            requestID: nil,
            retryable: false
        )
    }

    private static func safeIdentifier(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.utf8.count <= 96 else { return nil }
        let isSafe = value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) ||
                (97...122).contains($0) || $0 == 45 || $0 == 46 || $0 == 95
        }
        return isSafe ? value : nil
    }
}
