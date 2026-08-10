import XCTest
import ZephyrContracts
@testable import ZephyrUI

/// The S02 form rules (SCREEN_CATALOG.md 4) plus the view model's step
/// transitions.
final class ServerBindingFormTests: XCTestCase {

    // ---- baseUrl -------------------------------------------------------------------

    func testHttpsUrlIsAcceptedVerbatim() {
        var draft = ServerBindingDraft()
        draft.baseUrl = "https://zephyr.example.com"
        XCTAssertEqual("https://zephyr.example.com", draft.normalizedBaseUrl())
        XCTAssertNil(draft.urlIssue)
    }

    func testWssUrlIsNormalisedToHttps() {
        // SCREEN_CATALOG.md 4 allows HTTPS/WSS; a WSS address names the same
        // deployment over its secure WebSocket transport.
        var draft = ServerBindingDraft()
        draft.baseUrl = "  wss://zephyr.example.com:8443  "
        XCTAssertEqual("https://zephyr.example.com:8443", draft.normalizedBaseUrl())
    }

    func testPlainHttpIsRefused() {
        var draft = ServerBindingDraft()
        draft.baseUrl = "http://zephyr.example.com"
        XCTAssertNil(draft.normalizedBaseUrl())
        XCTAssertEqual(
            BindingFormIssue(field: "baseUrl", message: ServerBindingDraft.msgInvalidUrl),
            draft.urlIssue
        )
    }

    func testGarbageIsRefused() {
        var draft = ServerBindingDraft()
        draft.baseUrl = "not a url"
        XCTAssertNil(draft.normalizedBaseUrl())
        draft.baseUrl = ""
        XCTAssertNil(draft.normalizedBaseUrl())
        draft.baseUrl = "https://"
        XCTAssertNil(draft.normalizedBaseUrl())
    }

    // ---- device name and interval -----------------------------------------------------

    func testDeviceNameBounds() {
        var draft = ServerBindingDraft()
        draft.deviceName = ""
        XCTAssertNotNil(draft.deviceNameIssue)
        draft.deviceName = "   "
        XCTAssertNotNil(draft.deviceNameIssue)
        draft.deviceName = String(repeating: "x", count: 120)
        XCTAssertNil(draft.deviceNameIssue)
        draft.deviceName = String(repeating: "x", count: 121)
        XCTAssertNotNil(draft.deviceNameIssue)
        draft.deviceName = "  iPhone 17  "
        XCTAssertNil(draft.deviceNameIssue)
    }

    func testIntervalIsClampedToTheContract() {
        var draft = ServerBindingDraft()
        draft.intervalSec = 1
        XCTAssertEqual(SyncContract.minIntervalSec, draft.clampedIntervalSec)
        draft.intervalSec = 999_999
        XCTAssertEqual(SyncContract.maxIntervalSec, draft.clampedIntervalSec)
        draft.intervalSec = 300
        XCTAssertEqual(300, draft.clampedIntervalSec)
    }

    func testDefaultIntervalIsTheContractDefault() {
        XCTAssertEqual(SyncContract.defaultIntervalSec, ServerBindingDraft().intervalSec)
    }

    // ---- credentials and second factor -------------------------------------------------

    func testCredentialIssues() {
        var draft = ServerBindingDraft()
        XCTAssertEqual(draft.credentialIssues().count, 2)
        draft.username = "andy"
        draft.password = "secret"
        XCTAssertTrue(draft.credentialIssues().isEmpty)
    }

    func testSecondFactorIssue() {
        var draft = ServerBindingDraft()
        XCTAssertNotNil(draft.secondFactorIssue())
        draft.totpCode = "123456"
        XCTAssertNil(draft.secondFactorIssue())
    }

    // ---- token choice --------------------------------------------------------------------

    private func token(id: String, owner: String) -> ClientToken {
        ClientToken(id: id, ownerUserId: owner, name: "token-\(id)")
    }

    func testTokenChoiceRequiresASelection() {
        let draft = ServerBindingDraft()
        let issue = draft.tokenIssue(available: [token(id: "t-1", owner: "user-1")], accountUserId: "user-1")
        XCTAssertEqual(BindingFormIssue(field: "tokenId", message: ServerBindingDraft.msgTokenRequired), issue)
    }

    func testWrongOwnerTokenIsRejected() {
        var draft = ServerBindingDraft()
        draft.selectedTokenId = "t-1"
        let issue = draft.tokenIssue(available: [token(id: "t-1", owner: "user-2")], accountUserId: "user-1")
        XCTAssertEqual(BindingFormIssue(field: "tokenId", message: ServerBindingDraft.msgWrongOwnerToken), issue)
    }

    func testOwnTokenIsAccepted() {
        var draft = ServerBindingDraft()
        draft.selectedTokenId = "t-1"
        XCTAssertNil(draft.tokenIssue(available: [token(id: "t-1", owner: "user-1")], accountUserId: "user-1"))
    }

    // ---- view model steps -------------------------------------------------------------------

    private func makeBinding() -> AccountBinding {
        AccountBinding(
            serverProfileId: "sp-1",
            userId: "user-1",
            username: "andy",
            deviceId: "device-1",
            deviceName: "iPhone",
            tokenId: "t-1",
            tokenName: "one",
            state: .boundNeedsBootstrap,
            registryHash: "hash",
            boundAt: 1,
            instanceEpoch: 0
        )
    }

    func testInvalidUrlNeverLeavesTheServerStep() {
        let viewModel = ServerBindingViewModel { _ in .failed(.offline) }
        viewModel.draft.baseUrl = "http://nope"
        viewModel.continueFromServerAddress()
        XCTAssertEqual(.serverAddress, viewModel.step)
        XCTAssertNotNil(viewModel.issueFor(field: "baseUrl"))
    }

    func testTotpRequiredMovesToSecondFactor() async {
        let viewModel = ServerBindingViewModel { _ in .totpRequired }
        viewModel.draft.baseUrl = "https://z.example.com"
        viewModel.continueFromServerAddress()
        viewModel.draft.username = "andy"
        viewModel.draft.password = "secret"
        await viewModel.submitCredentials()
        XCTAssertEqual(.secondFactor, viewModel.step)
        XCTAssertNil(viewModel.bound)
    }

    func testTokenChoiceListsTokens() async {
        let tokens = [token(id: "t-1", owner: "user-1")]
        let viewModel = ServerBindingViewModel { _ in .tokenChoiceRequired(tokens) }
        viewModel.draft.username = "andy"
        viewModel.draft.password = "secret"
        await viewModel.submitCredentials()
        XCTAssertEqual(.tokenChoice, viewModel.step)
        XCTAssertEqual(tokens, viewModel.availableTokens)
    }

    func testZeroTokensStaysOnTokenChoiceWithGuidance() async {
        let viewModel = ServerBindingViewModel { _ in .noTokenOnServer }
        viewModel.draft.username = "andy"
        viewModel.draft.password = "secret"
        await viewModel.submitCredentials()
        XCTAssertEqual(.tokenChoice, viewModel.step)
        XCTAssertTrue(viewModel.availableTokens.isEmpty)
    }

    func testSuccessLandsOnBootstrap() async {
        let binding = makeBinding()
        let viewModel = ServerBindingViewModel { _ in .success(binding) }
        viewModel.draft.username = "andy"
        viewModel.draft.password = "secret"
        await viewModel.submitCredentials()
        XCTAssertEqual(.bootstrap, viewModel.step)
        XCTAssertEqual(binding, viewModel.bound)
    }

    func testFailureStaysAndReports() async {
        let error = MobileError.local(code: "account_locked", message: "locked")
        let viewModel = ServerBindingViewModel { _ in .failed(error) }
        viewModel.draft.username = "andy"
        viewModel.draft.password = "secret"
        await viewModel.submitCredentials()
        XCTAssertEqual(.credentials, viewModel.step)
        XCTAssertEqual(error, viewModel.failure)
        XCTAssertNil(viewModel.bound)
    }

    func testTokenGateBlocksDeviceStep() async {
        let tokens = [token(id: "t-1", owner: "user-1")]
        let viewModel = ServerBindingViewModel(accountUserId: "user-1") { _ in .tokenChoiceRequired(tokens) }
        viewModel.draft.username = "andy"
        viewModel.draft.password = "secret"
        await viewModel.submitCredentials()
        XCTAssertFalse(viewModel.continueFromTokenChoice())
        XCTAssertEqual(.tokenChoice, viewModel.step)
        viewModel.draft.selectedTokenId = "t-1"
        XCTAssertTrue(viewModel.continueFromTokenChoice())
        XCTAssertEqual(.device, viewModel.step)
    }
}
