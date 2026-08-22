import XCTest
import ZephyrContracts
import ZephyrCore
@testable import ZephyrUI

private final class BindingAuthenticator: DeviceAuthenticator {
    func availability() -> BiometricAvailability { .available }
    func authenticate(title: String, subtitle: String) async -> AuthResult { .success }
}

private actor BindingCallRecorder {
    private(set) var beginLoginCount = 0
    private(set) var listTokenCount = 0
    private(set) var bindCount = 0
    private(set) var cancelCount = 0
    private(set) var receivedNonemptySecret = false
    private(set) var registration: MobileBindingRegistration?

    func recordLogin() { beginLoginCount += 1 }
    func recordTokens() { listTokenCount += 1 }
    func recordBind(secret: String, registration: MobileBindingRegistration) {
        bindCount += 1
        receivedNonemptySecret = !secret.isEmpty
        self.registration = registration
    }
    func recordCancel() { cancelCount += 1 }
}

private actor LoginGate {
    private(set) var callCount = 0
    private var continuation: CheckedContinuation<MobileBindingLoginStep, Never>?

    func login() async -> MobileBindingLoginStep {
        callCount += 1
        return await withCheckedContinuation { continuation = $0 }
    }

    func release(_ step: MobileBindingLoginStep) {
        continuation?.resume(returning: step)
        continuation = nil
    }

    func waitUntilCalled() async {
        while callCount == 0 || continuation == nil {
            await Task<Never, Never>.yield()
        }
    }
}

private actor RetryLogin {
    private(set) var callCount = 0

    func login() throws -> MobileBindingLoginStep {
        callCount += 1
        if callCount == 1 { throw MobileApiError.offline }
        return .ready(accountID: "user-1", username: "andy")
    }
}

private func bindingSummary() -> MobileBindingSummary {
    MobileBindingSummary(
        baseURL: "https://zephyr.example.com/",
        serverID: "server-1",
        accountID: "user-1",
        username: "andy",
        deviceID: "device-12345678",
        deviceName: "iPhone",
        tokenID: "t-1",
        tokenName: "Primary",
        registryHash: "registry-hash",
        generation: "generation-1",
        syncIntervalSeconds: 300,
        boundAtMilliseconds: 1_725_000_000_000
    )
}

/// The S02 form rules plus the coordinator-backed view-model transitions.
@MainActor
final class ServerBindingFormTests: XCTestCase {

    // MARK: - Draft validation

    func testHttpsUrlIsAcceptedVerbatim() {
        var draft = ServerBindingDraft()
        draft.baseUrl = "https://zephyr.example.com"
        XCTAssertEqual("https://zephyr.example.com", draft.normalizedBaseUrl())
        XCTAssertNil(draft.urlIssue)
    }

    func testWssUrlIsNormalisedToHttps() {
        var draft = ServerBindingDraft()
        draft.baseUrl = "  wss://zephyr.example.com:8443  "
        XCTAssertEqual("https://zephyr.example.com:8443", draft.normalizedBaseUrl())
    }

    func testPlainHttpAndGarbageAreRefused() {
        var draft = ServerBindingDraft()
        for value in ["http://zephyr.example.com", "not a url", "", "https://"] {
            draft.baseUrl = value
            XCTAssertNil(draft.normalizedBaseUrl(), value)
            XCTAssertNotNil(draft.urlIssue, value)
        }
    }

    func testDeviceNameBoundsAndIntervalClamp() {
        var draft = ServerBindingDraft()
        draft.deviceName = ""
        XCTAssertNotNil(draft.deviceNameIssue)
        draft.deviceName = String(repeating: "x", count: 120)
        XCTAssertNil(draft.deviceNameIssue)
        draft.deviceName = String(repeating: "x", count: 121)
        XCTAssertNotNil(draft.deviceNameIssue)

        draft.intervalSec = 1
        XCTAssertEqual(SyncContract.minIntervalSec, draft.clampedIntervalSec)
        draft.intervalSec = 999_999
        XCTAssertEqual(SyncContract.maxIntervalSec, draft.clampedIntervalSec)
        XCTAssertEqual(SyncContract.defaultIntervalSec, ServerBindingDraft().intervalSec)
    }

    func testCredentialAndSecondFactorIssues() {
        var draft = ServerBindingDraft()
        XCTAssertEqual(2, draft.credentialIssues().count)
        draft.username = "andy"
        draft.password = "credential-value"
        XCTAssertTrue(draft.credentialIssues().isEmpty)
        XCTAssertNotNil(draft.secondFactorIssue())
        draft.totpCode = "123456"
        XCTAssertNil(draft.secondFactorIssue())
    }

    func testTokenChoiceEnforcesCurrentOwner() {
        let own = token(id: "t-1", owner: "user-1")
        let foreign = token(id: "t-2", owner: "user-2")
        var draft = ServerBindingDraft()
        XCTAssertEqual(ServerBindingDraft.msgTokenRequired, draft.tokenIssue(
            available: [own], accountUserId: "user-1"
        )?.message)
        draft.selectedTokenId = foreign.id
        XCTAssertEqual(ServerBindingDraft.msgWrongOwnerToken, draft.tokenIssue(
            available: [foreign], accountUserId: "user-1"
        )?.message)
        draft.selectedTokenId = own.id
        XCTAssertNil(draft.tokenIssue(available: [own], accountUserId: "user-1"))
    }

    // MARK: - Coordinator flow

    func testInvalidUrlNeverConstructsCoordinator() {
        var factoryCalls = 0
        let viewModel = ServerBindingViewModel { _ in
            factoryCalls += 1
            return self.driver()
        }
        viewModel.draft.baseUrl = "http://nope"

        viewModel.continueFromServerAddress()

        XCTAssertEqual(.serverAddress, viewModel.stage)
        XCTAssertNotNil(viewModel.issueFor(field: "baseUrl"))
        XCTAssertEqual(0, factoryCalls)
    }

    func testTotpRequiredThenReadyLoadsOnlyCurrentOwnerTokens() async {
        let recorder = BindingCallRecorder()
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in
                await recorder.recordLogin()
                return .totpRequired
            },
            continueTotp: { _ in .ready(accountID: "user-1", username: "andy") },
            listTokens: {
                await recorder.recordTokens()
                return [
                    MobileBindingToken(id: "t-1", name: "Primary", ownerAccountID: "user-1"),
                    MobileBindingToken(id: "t-2", name: "Disabled", ownerAccountID: "user-1", enabled: false),
                    MobileBindingToken(id: "t-3", name: "Foreign", ownerAccountID: "user-2"),
                ]
            }
        ))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()
        XCTAssertEqual(.secondFactor, viewModel.stage)

        let totpGeneration = viewModel.totpClearGeneration
        viewModel.submitSecondFactor(code: "123456")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.device, viewModel.stage)
        XCTAssertTrue(viewModel.availableTokens.isEmpty)
        XCTAssertGreaterThan(viewModel.totpClearGeneration, totpGeneration)
        let beginLoginCount = await recorder.beginLoginCount
        let listTokenCount = await recorder.listTokenCount
        XCTAssertEqual(1, beginLoginCount)
        XCTAssertEqual(0, listTokenCount)
    }

    func testPasswordChangeIsABlockingStateAndClearsSensitiveCopies() async {
        let recorder = BindingCallRecorder()
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in .passwordChangeRequired },
            cancel: { await recorder.recordCancel() }
        ))
        viewModel.draft.username = "andy"
        let generation = viewModel.sensitiveClearGeneration

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.passwordChangeRequired, viewModel.stage)
        XCTAssertGreaterThan(viewModel.sensitiveClearGeneration, generation)
        XCTAssertTrue(viewModel.availableTokens.isEmpty)
        let cancelCount = await recorder.cancelCount
        XCTAssertEqual(1, cancelCount)
    }

    func testZeroTokensShowsTokenChoiceInsteadOfPretendingLoading() async {
        let viewModel = preparedViewModel(driver: driver(listTokens: { [] }))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.device, viewModel.stage)
        XCTAssertTrue(viewModel.availableTokens.isEmpty)
    }

    func testDeviceSubmissionPerformsRealBindAndClearsInputBuffers() async {
        let recorder = BindingCallRecorder()
        let expectedSummary = bindingSummary()
        let viewModel = preparedViewModel(driver: driver(
            bind: { secret, registration in
                await recorder.recordBind(secret: secret, registration: registration)
                return expectedSummary
            }
        ))
        viewModel.draft.username = "andy"
        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()
        viewModel.draft.deviceName = "Andy's iPhone"
        viewModel.draft.intervalSec = 300
        let buffers = ServerBindingSensitiveTextBuffers(
            password: "credential-value",
            totpCode: "123456"
        )
        viewModel.attachSensitiveBuffers(buffers)
        let generation = viewModel.sensitiveClearGeneration

        viewModel.submitBinding(secret: "credential-value")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.success(expectedSummary), viewModel.stage)
        let bindCount = await recorder.bindCount
        let receivedNonemptySecret = await recorder.receivedNonemptySecret
        XCTAssertEqual(1, bindCount)
        XCTAssertTrue(receivedNonemptySecret)
        let registration = await recorder.registration
        XCTAssertEqual("link-v2-enrollment", registration?.tokenID)
        XCTAssertEqual("Andy's iPhone", registration?.deviceName)
        XCTAssertEqual(300, registration?.syncIntervalSeconds)
        XCTAssertGreaterThan(viewModel.sensitiveClearGeneration, generation)
        XCTAssertTrue(buffers.password.isEmpty)
        XCTAssertTrue(buffers.totpCode.isEmpty)
        XCTAssertTrue(viewModel.draft.password.isEmpty)
        XCTAssertTrue(viewModel.draft.totpCode.isEmpty)
    }

    func testBusyGuardCoalescesRapidDuplicateLoginTaps() async {
        let gate = LoginGate()
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in await gate.login() }
        ))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        viewModel.submitCredentials(password: "credential-value")
        await gate.waitUntilCalled()

        let initialCallCount = await gate.callCount
        XCTAssertEqual(1, initialCallCount)
        await gate.release(.ready(accountID: "user-1", username: "andy"))
        await viewModel.waitForCurrentOperation()
        XCTAssertEqual(.device, viewModel.stage)
    }

    func testFailureUsesFixedRedactedCopyAndRetryResumesTheFailedOperation() async {
        let retry = RetryLogin()
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in try await retry.login() }
        ))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        let failure = try? XCTUnwrap(viewModel.failure)
        XCTAssertEqual(.login, failure?.operation)
        XCTAssertFalse(failure?.message.contains("credential-value") ?? true)
        XCTAssertEqual("code=network_offline", failure?.diagnosticText)

        viewModel.retry(password: "credential-value", totpCode: "")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.device, viewModel.stage)
        let retryCallCount = await retry.callCount
        XCTAssertEqual(2, retryCallCount)
    }

    func testUntrustedServerMessageAndRequestIdNeverReachDisplayState() async {
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in
                throw MobileApiError(
                    code: "server_failed",
                    message: "credential-value https://private.example.test alice",
                    retryable: true,
                    requestId: "private-username-alice"
                )
            }
        ))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        let rendered = viewModel.failure?.message ?? ""
        XCTAssertFalse(rendered.contains("credential-value"))
        XCTAssertFalse(rendered.contains("private.example.test"))
        XCTAssertFalse(rendered.contains("alice"))
        XCTAssertNil(viewModel.failure?.requestID)
        XCTAssertEqual("code=unknown_error", viewModel.failure?.diagnosticText)
        XCTAssertFalse(viewModel.failure?.retryable ?? true)
    }

    func testRegisteredServerCodeAndSanitizedRequestIdRemainUseful() async {
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in
                throw MobileApiError(
                    code: "server_unavailable",
                    message: "credential-value https://private.example.test alice",
                    retryable: false,
                    requestId: "request-123"
                )
            }
        ))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual("code=server_unavailable requestId=request-123", viewModel.failure?.diagnosticText)
        XCTAssertTrue(viewModel.failure?.retryable ?? false)
        XCTAssertFalse(viewModel.failure?.message.contains("private.example.test") ?? true)
    }

    func testRegistryRejectsServerRetryHintForNonRetryableCode() async {
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in
                throw MobileApiError(
                    code: "invalid_credentials",
                    message: "retry this forever",
                    retryable: true,
                    requestId: nil
                )
            }
        ))
        viewModel.draft.username = "andy"

        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual("invalid_credentials", viewModel.failure?.code)
        XCTAssertFalse(viewModel.failure?.retryable ?? true)
    }

    func testFrozenTotpExhaustionCodeUsesFixedRestartGuidance() async {
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in .totpRequired },
            continueTotp: { _ in
                throw MobileApiError(
                    code: "totp_temp_exhausted",
                    message: "credential-value",
                    retryable: false,
                    requestId: nil
                )
            }
        ))
        viewModel.draft.username = "andy"
        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()

        let buffers = ServerBindingSensitiveTextBuffers(totpCode: "123456")
        viewModel.attachSensitiveBuffers(buffers)
        viewModel.submitSecondFactor(code: "123456")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual("totp_temp_exhausted", viewModel.failure?.code)
        XCTAssertFalse(viewModel.failure?.message.contains("credential-value") ?? true)
        XCTAssertFalse(viewModel.failure?.retryable ?? true)
        XCTAssertTrue(buffers.totpCode.isEmpty)

        viewModel.editAfterFailure()
        XCTAssertEqual(.credentials, viewModel.stage)
    }

    func testRetryAfterTotpTransportFailureStartsFreshLogin() async {
        let recorder = BindingCallRecorder()
        let viewModel = preparedViewModel(driver: driver(
            beginLogin: { _, _, _ in
                await recorder.recordLogin()
                return .totpRequired
            },
            continueTotp: { _ in throw MobileApiError.offline }
        ))
        viewModel.draft.username = "andy"
        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()
        viewModel.submitSecondFactor(code: "123456")
        await viewModel.waitForCurrentOperation()
        XCTAssertEqual(.totp, viewModel.failure?.operation)
        XCTAssertTrue(viewModel.failure?.retryable ?? false)

        viewModel.retry(password: "credential-value", totpCode: "123456")
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.secondFactor, viewModel.stage)
        let beginLoginCount = await recorder.beginLoginCount
        XCTAssertEqual(2, beginLoginCount)
    }

    func testLockCancelsTransientCoordinatorStateAndResetsAuthenticatedPages() async {
        let recorder = BindingCallRecorder()
        let viewModel = preparedViewModel(driver: driver(
            cancel: { await recorder.recordCancel() }
        ))
        viewModel.draft.username = "andy"
        viewModel.submitCredentials(password: "credential-value")
        await viewModel.waitForCurrentOperation()
        XCTAssertEqual(.device, viewModel.stage)
        let generation = viewModel.sensitiveClearGeneration

        viewModel.onLocked()
        await viewModel.waitForCurrentOperation()

        XCTAssertEqual(.credentials, viewModel.stage)
        XCTAssertTrue(viewModel.availableTokens.isEmpty)
        XCTAssertGreaterThan(viewModel.sensitiveClearGeneration, generation)
        let cancelCount = await recorder.cancelCount
        XCTAssertEqual(1, cancelCount)
    }

    func testAppLockRegistrationAndCancelClearEveryPlaintextCopy() async {
        let lock = AppLock(authenticator: BindingAuthenticator(), clock: { 0 })
        let viewModel = preparedViewModel(driver: driver())
        let buffers = ServerBindingSensitiveTextBuffers(
            password: "credential-value",
            totpCode: "123456"
        )
        viewModel.attachSensitiveBuffers(buffers)
        viewModel.attachSensitiveLifecycle(to: lock)
        viewModel.draft.password = "credential-value"
        viewModel.draft.totpCode = "123456"
        XCTAssertEqual(1, lock.registeredSensitiveSinkCount)

        lock.lockNow()

        XCTAssertTrue(buffers.password.isEmpty)
        XCTAssertTrue(buffers.totpCode.isEmpty)
        await viewModel.waitForCurrentOperation()

        XCTAssertTrue(viewModel.draft.password.isEmpty)
        XCTAssertTrue(viewModel.draft.totpCode.isEmpty)
        viewModel.detachSensitiveLifecycle()
        XCTAssertEqual(0, lock.registeredSensitiveSinkCount)
    }

    func testBackgroundUnbindAndExplicitCancelSynchronouslyClearViewBuffers() async {
        let lock = AppLock(authenticator: BindingAuthenticator(), clock: { 0 })
        XCTAssertTrue(lock.enable(.fiveMinutes))
        let viewModel = preparedViewModel(driver: driver())
        let buffers = ServerBindingSensitiveTextBuffers(
            password: "credential-value",
            totpCode: "123456"
        )
        viewModel.attachSensitiveBuffers(buffers)
        viewModel.attachSensitiveLifecycle(to: lock)

        lock.onEnterBackground()
        XCTAssertTrue(buffers.password.isEmpty)
        XCTAssertTrue(buffers.totpCode.isEmpty)
        await viewModel.waitForCurrentOperation()

        buffers.password = "credential-value"
        buffers.totpCode = "654321"
        lock.onUnbind()
        XCTAssertTrue(buffers.password.isEmpty)
        XCTAssertTrue(buffers.totpCode.isEmpty)
        await viewModel.waitForCurrentOperation()

        buffers.password = "credential-value"
        buffers.totpCode = "111111"
        viewModel.cancel()
        XCTAssertTrue(buffers.password.isEmpty)
        XCTAssertTrue(buffers.totpCode.isEmpty)
    }

    func testSwiftUISensitiveBuffersClearPasswordAndTotpTogether() {
        var buffers = ServerBindingSensitiveTextBuffers(
            password: "credential-value",
            totpCode: "123456"
        )

        buffers.clear()

        XCTAssertTrue(buffers.password.isEmpty)
        XCTAssertTrue(buffers.totpCode.isEmpty)
    }

    // MARK: - Helpers

    private func preparedViewModel(driver: ServerBindingDriver) -> ServerBindingViewModel {
        let viewModel = ServerBindingViewModel { _ in driver }
        viewModel.draft.baseUrl = "https://zephyr.example.com"
        viewModel.continueFromServerAddress()
        XCTAssertEqual(.credentials, viewModel.stage)
        return viewModel
    }

    private func driver(
        beginLogin: @escaping @Sendable (String, String, String?) async throws -> MobileBindingLoginStep = {
            _, _, _ in .ready(accountID: "user-1", username: "andy")
        },
        continueTotp: @escaping @Sendable (String) async throws -> MobileBindingLoginStep = {
            _ in .ready(accountID: "user-1", username: "andy")
        },
        listTokens: @escaping @Sendable () async throws -> [MobileBindingToken] = {
            [MobileBindingToken(id: "t-1", name: "Primary", ownerAccountID: "user-1")]
        },
        bind: @escaping @Sendable (String, MobileBindingRegistration) async throws -> MobileBindingSummary = {
            _, _ in bindingSummary()
        },
        cancel: @escaping @Sendable () async -> Void = {}
    ) -> ServerBindingDriver {
        ServerBindingDriver(
            beginLogin: beginLogin,
            continueTotp: continueTotp,
            listTokens: listTokens,
            bind: bind,
            cancelTransientWork: cancel
        )
    }

    private func token(id: String, owner: String) -> ClientToken {
        ClientToken(id: id, ownerUserId: owner, name: "token-\(id)")
    }

}
