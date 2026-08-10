#if canImport(SwiftUI)
import SwiftUI
import ZephyrContracts

/// S02 主端与绑定.
///
/// Renders the frozen flow pages from ``ServerBindingViewModel/step``. The
/// form is deliberately a thin rendering: URL/device/interval rules live in
/// ``ServerBindingDraft`` and the outcome mapping in the view model, so the
/// whole flow is exercised by host-side XCTest.
public struct ServerBindingView: View {

    @ObservedObject var viewModel: ServerBindingViewModel

    public init(viewModel: ServerBindingViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        Form {
            switch viewModel.step {
            case .serverAddress:
                serverSection
            case .credentials:
                credentialsSection
            case .secondFactor:
                secondFactorSection
            case .tokenChoice:
                tokenSection
            case .device:
                deviceSection
            case .bootstrap:
                bootstrapSection
            }
        }
        .navigationTitle("绑定主端")
        .zephyrInlineTitle()
        .zephyrInteractivePopGesture()
    }

    private var serverSection: some View {
        Section(header: Text("服务器地址")) {
            TextField("https://zephyr.example.com", text: $viewModel.draft.baseUrl)
            issueText("baseUrl")
            Text("仅支持 HTTPS/WSS；自签证书需在配对时显式固定指纹。")
                .font(.footnote)
            Button("继续") { viewModel.continueFromServerAddress() }
        }
    }

    private var credentialsSection: some View {
        Section(header: Text("账号密码")) {
            TextField("账号", text: $viewModel.draft.username)
            issueText("username")
            SecureField("密码", text: $viewModel.draft.password)
            issueText("password")
            failureText
            Button(viewModel.busy ? "正在登录…" : "登录") {
                Task { await viewModel.submitCredentials() }
            }
            .disabled(viewModel.busy)
        }
    }

    private var secondFactorSection: some View {
        Section(header: Text("二次验证")) {
            TextField("动态验证码", text: $viewModel.draft.totpCode)
            issueText("totpCode")
            failureText
            Button(viewModel.busy ? "正在验证…" : "验证") {
                Task { await viewModel.submitSecondFactor() }
            }
            .disabled(viewModel.busy)
        }
    }

    private var tokenSection: some View {
        Section(header: Text("Client Token")) {
            if viewModel.availableTokens.isEmpty {
                Text(ServerBindingDraft.msgZeroToken)
                    .font(.footnote)
            } else {
                ForEach(viewModel.availableTokens, id: \.id) { token in
                    Button(action: { viewModel.draft.selectedTokenId = token.id }) {
                        HStack {
                            Text(token.name)
                            Spacer()
                            if viewModel.draft.selectedTokenId == token.id {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
                issueText("tokenId")
                Button("继续") {
                    _ = viewModel.continueFromTokenChoice()
                }
            }
        }
    }

    private var deviceSection: some View {
        Section(header: Text("设备与同步")) {
            TextField("设备名", text: $viewModel.draft.deviceName)
            issueText("deviceName")
            Stepper(
                "同步间隔：\(viewModel.draft.clampedIntervalSec) 秒",
                value: $viewModel.draft.intervalSec,
                in: SyncContract.minIntervalSec...SyncContract.maxIntervalSec
            )
            Button("完成绑定") {
                _ = viewModel.continueFromDevice()
            }
        }
    }

    private var bootstrapSection: some View {
        Section(header: Text("Bootstrap")) {
            if let bound = viewModel.bound {
                Text("已绑定 \(bound.username)@\(bound.serverProfileId)，正在执行首次同步。")
            } else {
                ProgressView()
            }
        }
    }

    private func issueText(_ field: String) -> some View {
        Group {
            if let issue = viewModel.issueFor(field: field) {
                Text(issue.message)
                    .font(.footnote)
            }
        }
    }

    @ViewBuilder private var failureText: some View {
        if let failure = viewModel.failure {
            Text(failure.message)
                .font(.footnote)
            Text(failure.diagnosticText())
                .font(.footnote)
        }
    }
}
#endif
