import Combine
import Foundation

/// S02 主端与绑定.
///
/// The flow is server address → credentials → (TOTP) → token choice → device
/// → bootstrap (SCREEN_CATALOG.md 4). All field rules live in
/// ``ServerBindingDraft``; this class owns the step transitions and the single
/// bind side effect. The bind call itself is server-confirmed, never
/// optimistic: 绑定成功前不显示"已开启".
public final class ServerBindingViewModel: ObservableObject {

    @Published public var draft = ServerBindingDraft()
    @Published public private(set) var step: BindingStep = .serverAddress
    @Published public private(set) var issues: [BindingFormIssue] = []
    @Published public private(set) var busy = false

    /// The last server-side failure, shown with its diagnostic entry.
    @Published public private(set) var failure: MobileError?

    /// Tokens listed for the authenticated account; empty means the zero-token
    /// guidance state, not a loading state.
    @Published public private(set) var availableTokens: [ClientToken] = []

    /// Set exactly once, when the main end confirms the bind.
    @Published public private(set) var bound: AccountBinding?

    private let accountUserId: String
    private let bindAction: (ServerBindingDraft) async -> BindingOutcome

    public init(
        accountUserId: String = "",
        bindAction: @escaping (ServerBindingDraft) async -> BindingOutcome
    ) {
        self.accountUserId = accountUserId
        self.bindAction = bindAction
    }

    public func issueFor(field: String) -> BindingFormIssue? {
        issues.first { $0.field == field }
    }

    /// 服务器地址 → capabilities → 账号密码. An unparsable address never
    /// leaves the device.
    public func continueFromServerAddress() {
        if let issue = draft.urlIssue {
            issues = [issue]
            return
        }
        issues = []
        failure = nil
        step = .credentials
    }

    /// Submits the account credentials. The outcome decides the next step:
    /// TOTP when the account demands it, token choice (or the zero-token
    /// guidance) on a clean login, an inline failure otherwise.
    public func submitCredentials() async {
        let credentialIssues = draft.credentialIssues()
        guard credentialIssues.isEmpty else {
            issues = credentialIssues
            return
        }
        await runBind()
    }

    /// The TOTP retry after the server answered totpRequired.
    public func submitSecondFactor() async {
        if let issue = draft.secondFactorIssue() {
            issues = [issue]
            return
        }
        await runBind()
    }

    private func runBind() async {
        issues = []
        failure = nil
        busy = true
        let outcome = await bindAction(draft)
        busy = false
        switch outcome {
        case let .success(binding):
            bound = binding
            step = .bootstrap
        case .totpRequired:
            step = .secondFactor
        case let .tokenChoiceRequired(tokens):
            availableTokens = tokens
            step = .tokenChoice
        case .noTokenOnServer:
            availableTokens = []
            step = .tokenChoice
        case let .failed(error):
            failure = error
        }
    }

    /// Token choice is client-side validation only; the selected id is handed
    /// to the next bind call.
    public func continueFromTokenChoice() -> Bool {
        if let issue = draft.tokenIssue(available: availableTokens, accountUserId: accountUserId) {
            issues = [issue]
            return false
        }
        issues = []
        step = .device
        return true
    }

    /// The device page is the last one before the bind is committed; the
    /// interval is clamped so a stale UI value can never persist an
    /// out-of-range period.
    public func deviceIssues() -> [BindingFormIssue] {
        var collected: [BindingFormIssue] = []
        if let issue = draft.deviceNameIssue { collected.append(issue) }
        return collected
    }

    public func continueFromDevice() -> Bool {
        let collected = deviceIssues()
        guard collected.isEmpty else {
            issues = collected
            return false
        }
        issues = []
        return true
    }
}
