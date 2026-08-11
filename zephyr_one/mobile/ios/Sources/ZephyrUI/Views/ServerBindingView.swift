import Combine

/// Plaintext owned by SwiftUI's SecureField bindings. The coordinator never
/// exposes SID, temp token or sensitive grant text to this presentation layer.
@MainActor
final class ServerBindingSensitiveTextBuffers: ObservableObject, ServerBindingSensitiveBufferClearing {
    @Published var password: String
    @Published var totpCode: String

    init(password: String = "", totpCode: String = "") {
        self.password = password
        self.totpCode = totpCode
    }

    func clear() {
        clearPassword()
        clearTotp()
    }

    func clearPassword() {
        password.removeAll(keepingCapacity: false)
    }

    func clearTotp() {
        totpCode.removeAll(keepingCapacity: false)
    }
}

#if canImport(SwiftUI)
import SwiftUI
import ZephyrContracts
import ZephyrCore

private enum ServerBindingFocusField: Hashable {
    case serverAddress
    case username
    case password
    case totp
    case deviceName
}

private extension View {
    @ViewBuilder
    func zephyrBindingURLInput() -> some View {
        #if canImport(UIKit)
        textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
        #else
        self
        #endif
    }

    @ViewBuilder
    func zephyrBindingUsernameInput() -> some View {
        #if canImport(UIKit)
        textContentType(.username)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
        #else
        self
        #endif
    }

    @ViewBuilder
    func zephyrBindingPasswordInput() -> some View {
        #if canImport(UIKit)
        textContentType(.password)
        #else
        self
        #endif
    }

    @ViewBuilder
    func zephyrBindingOneTimeCodeInput() -> some View {
        #if canImport(UIKit)
        textContentType(.oneTimeCode)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
        #else
        self
        #endif
    }

    @ViewBuilder
    func zephyrBindingDeviceNameInput() -> some View {
        #if canImport(UIKit)
        textContentType(.name)
        #else
        self
        #endif
    }
}

/// S02 主端与绑定.
///
/// The screen intentionally uses native form, navigation, progress and secure
/// input controls. Frequent state changes do not carry decorative animation;
/// native press feedback remains immediate and Reduce Motion needs no special
/// alternate path.
@MainActor
public struct ServerBindingView: View {

    @ObservedObject var viewModel: ServerBindingViewModel

    @Environment(\.dismiss) private var dismiss
    @StateObject private var sensitiveText = ServerBindingSensitiveTextBuffers()
    @FocusState private var focusedField: ServerBindingFocusField?

    public init(viewModel: ServerBindingViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        Form {
            switch viewModel.stage {
            case .serverAddress:
                serverSection
            case .credentials:
                credentialsSection
            case .secondFactor:
                secondFactorSection
            case .passwordChangeRequired:
                passwordChangeSection
            case .resettingAuthentication:
                progressSection(
                    title: "正在清理临时认证",
                    detail: "完成后可以重新登录。"
                )
            case .loadingTokens:
                progressSection(
                    title: "正在读取 Client Token",
                    detail: "正在获取当前账号可用的 Token 元数据。"
                )
            case .tokenChoice:
                tokenSection
            case .device:
                deviceSection
            case .binding:
                progressSection(
                    title: "正在完成绑定",
                    detail: "正在验证账号、创建设备并启动首次同步。"
                )
            case .success(let summary):
                successSection(summary)
            case .failure(let failure):
                failureSection(failure)
            }
        }
        .navigationTitle("绑定主端")
        .zephyrInlineTitle()
        .toolbar {
            ToolbarItem(placement: .zephyrNavTrailing) {
                Button("取消", action: cancelAndDismiss)
                    .keyboardShortcut(.cancelAction)
            }
        }
        .accessibilityAction(.escape) { cancelAndDismiss() }
        .onAppear {
            viewModel.attachSensitiveBuffers(sensitiveText)
            updateFocus(for: viewModel.stage)
        }
        .onChange(of: viewModel.stage) { updateFocus(for: $0) }
        .onChange(of: viewModel.sensitiveClearGeneration) { _ in
            clearSensitiveCopies()
        }
        .onChange(of: viewModel.totpClearGeneration) { _ in
            sensitiveText.clearTotp()
            if focusedField == .totp { focusedField = nil }
        }
        .onDisappear {
            clearSensitiveCopies()
            viewModel.detachSensitiveBuffers()
            viewModel.cancel()
        }
        .zephyrInteractivePopGesture()
    }

    private var serverSection: some View {
        Section(header: Text("服务器地址")) {
            TextField("https://zephyr.example.com", text: $viewModel.draft.baseUrl)
                .focused($focusedField, equals: .serverAddress)
                .zephyrBindingURLInput()
                .accessibilityLabel("Zephyr 主端地址")
            issueText("baseUrl")
            Text("仅支持 HTTPS 或 WSS。自签证书必须在配对时显式固定指纹。")
                .font(.footnote)
                .foregroundColor(.secondary)
            Button(action: viewModel.continueFromServerAddress) {
                Label("继续", systemImage: "arrow.right")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.busy)
        }
    }

    private var credentialsSection: some View {
        Section(
            header: Text("账号登录"),
            footer: Text("密码仅保留在当前表单和协调器的临时认证过程，不会写入普通偏好设置。")
        ) {
            TextField("账号", text: $viewModel.draft.username)
                .focused($focusedField, equals: .username)
                .zephyrBindingUsernameInput()
            issueText("username")
            SecureField("密码", text: $sensitiveText.password)
                .focused($focusedField, equals: .password)
                .zephyrBindingPasswordInput()
            issueText("password")
            if viewModel.busy {
                ProgressView("正在登录")
                    .accessibilityLabel("正在登录")
            }
            Button(action: submitCredentials) {
                Label("登录", systemImage: "person.badge.key")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.busy)
        }
    }

    private var secondFactorSection: some View {
        Section(
            header: Text("二次验证"),
            footer: Text("请输入主端当前要求的验证码。验证码使用后会立即从此表单清除。")
        ) {
            TextField("动态验证码", text: $sensitiveText.totpCode)
                .focused($focusedField, equals: .totp)
                .zephyrBindingOneTimeCodeInput()
                .accessibilityLabel("动态验证码")
            issueText("totpCode")
            if viewModel.busy {
                ProgressView("正在验证")
                    .accessibilityLabel("正在验证动态验证码")
            }
            Button(action: submitSecondFactor) {
                Label("验证", systemImage: "checkmark.shield")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.busy)
        }
    }

    private var passwordChangeSection: some View {
        Section {
            Label("需要先修改密码", systemImage: "exclamationmark.lock")
                .font(.headline)
            Text("主端要求先更新账号密码。请在 Zephyr 主端完成修改，然后返回这里重新登录。当前会话不能继续绑定。")
                .foregroundColor(.secondary)
            Button(action: viewModel.restartAfterPasswordChange) {
                Label("我已修改，重新登录", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.busy)
        }
    }

    private var tokenSection: some View {
        Section(
            header: Text("Client Token"),
            footer: Text("这里只显示当前账号的 Token 名称和标识，不显示 Token secret。")
        ) {
            if viewModel.availableTokens.isEmpty {
                Label(ServerBindingDraft.msgZeroToken, systemImage: "key.slash")
                Text("请在主端的 Zephyr Client 页面创建 Token，然后重试读取。")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                Button(action: retryTokenLoading) {
                    Label("重新读取", systemImage: "arrow.clockwise")
                }
                .disabled(viewModel.busy)
            } else {
                ForEach(viewModel.availableTokens, id: \.id) { token in
                    tokenButton(token)
                }
                issueText("tokenId")
                Button(action: continueFromTokenChoice) {
                    Label("继续", systemImage: "arrow.right")
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.busy)
            }
        }
    }

    private func tokenButton(_ token: ClientToken) -> some View {
        let selected = viewModel.draft.selectedTokenId == token.id
        return Button {
            viewModel.draft.selectedTokenId = token.id
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(token.name.isEmpty ? "未命名 Token" : token.name)
                    Text(token.id)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .accessibilityHidden(true)
                }
            }
        }
        .accessibilityLabel(token.name.isEmpty ? "未命名 Token" : token.name)
        .accessibilityValue(selected ? "已选择" : "未选择")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var deviceSection: some View {
        Section(
            header: Text("设备与同步"),
            footer: Text("绑定由主端确认后才会保存。首次 bootstrap 完成前不会显示文件同步已开启。")
        ) {
            TextField("设备名", text: $viewModel.draft.deviceName)
                .focused($focusedField, equals: .deviceName)
                .zephyrBindingDeviceNameInput()
                .accessibilityLabel("设备名")
            issueText("deviceName")
            Stepper(
                "同步间隔：\(formattedInterval)",
                value: $viewModel.draft.intervalSec,
                in: SyncContract.minIntervalSec...SyncContract.maxIntervalSec,
                step: 30
            )
            .accessibilityValue(formattedInterval)
            Button(action: submitBinding) {
                Label("完成绑定", systemImage: "link.badge.plus")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.busy)
        }
    }

    private func progressSection(title: String, detail: String) -> some View {
        Section {
            ProgressView(title)
                .accessibilityLabel(title)
                .accessibilityValue("进行中")
            Text(detail)
                .font(.footnote)
                .foregroundColor(.secondary)
            Button("取消", action: cancelAndDismiss)
        }
    }

    private func successSection(_ summary: MobileBindingSummary) -> some View {
        Section {
            Label("绑定完成", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundColor(.green)
            Text("\(summary.username) 的设备 \(summary.deviceName) 已绑定。同步状态可在文件同步页面查看。")
            Button(action: finishAndDismiss) {
                Label("完成", systemImage: "checkmark")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private func failureSection(_ failure: ServerBindingFailure) -> some View {
        Section {
            Label(failure.title, systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(failure.message)
            Text(failure.diagnosticText)
                .font(.footnote)
                .foregroundColor(.secondary)
                .textSelection(.enabled)
                .accessibilityLabel("诊断信息，\(failure.diagnosticText)")
            if failure.retryable || failure.operation == .loadTokens {
                Button(action: retryFailure) {
                    Label("重试", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.busy)
            }
            if failure.operation != .loadTokens {
                Button(action: viewModel.editAfterFailure) {
                    Label("返回修改", systemImage: "pencil")
                }
                .disabled(viewModel.busy)
            }
            Button("取消", action: cancelAndDismiss)
        }
    }

    private var formattedInterval: String {
        let seconds = viewModel.draft.clampedIntervalSec
        if seconds.isMultiple(of: 3_600) { return "\(seconds / 3_600) 小时" }
        if seconds.isMultiple(of: 60) { return "\(seconds / 60) 分钟" }
        return "\(seconds) 秒"
    }

    private func submitCredentials() {
        viewModel.submitCredentials(password: sensitiveText.password)
    }

    private func submitSecondFactor() {
        viewModel.submitSecondFactor(code: sensitiveText.totpCode)
    }

    private func continueFromTokenChoice() {
        _ = viewModel.continueFromTokenChoice()
    }

    private func retryTokenLoading() {
        viewModel.reloadTokens()
    }

    private func submitBinding() {
        viewModel.submitBinding(secret: sensitiveText.password)
    }

    private func retryFailure() {
        viewModel.retry(
            password: sensitiveText.password,
            totpCode: sensitiveText.totpCode
        )
    }

    private func cancelAndDismiss() {
        clearSensitiveCopies()
        viewModel.cancel()
        dismiss()
    }

    private func finishAndDismiss() {
        clearSensitiveCopies()
        dismiss()
    }

    private func clearSensitiveCopies() {
        sensitiveText.clear()
        focusedField = nil
    }

    private func updateFocus(for stage: ServerBindingStage) {
        switch stage {
        case .serverAddress:
            focusedField = .serverAddress
        case .credentials:
            focusedField = viewModel.draft.username.isEmpty ? .username : .password
        case .secondFactor:
            focusedField = .totp
        case .device:
            focusedField = .deviceName
        case .passwordChangeRequired, .resettingAuthentication, .loadingTokens,
             .tokenChoice, .binding, .success, .failure:
            focusedField = nil
        }
    }

    private func issueText(_ field: String) -> some View {
        Group {
            if let issue = viewModel.issueFor(field: field) {
                Text(issue.message)
                    .font(.footnote)
                    .foregroundColor(.red)
                    .accessibilityLabel("错误：\(issue.message)")
            }
        }
    }
}
#endif
