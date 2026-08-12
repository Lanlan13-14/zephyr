/// Owns every decision about leaving the editor. Explicit controls call
/// `requestDismiss`, while system navigation reads `allowsSystemDismissal`.
/// Keeping both paths on the same value prevents a new exit from bypassing
/// dirty-draft protection.
struct ConnectionEditorDismissCoordinator {

    enum Decision: Equatable {
        case dismiss
        case confirmDiscard
    }

    let hasUnsavedChanges: Bool

    var decision: Decision {
        hasUnsavedChanges ? .confirmDiscard : .dismiss
    }

    var allowsSystemDismissal: Bool {
        decision == .dismiss
    }

    func requestDismiss(
        confirmDiscard: () -> Void,
        dismiss: () -> Void
    ) {
        switch decision {
        case .dismiss:
            dismiss()
        case .confirmDiscard:
            confirmDiscard()
        }
    }
}

/// Plaintext copies owned by SwiftUI's SecureField bindings. Keeping them in
/// one value makes every lifecycle clear atomic from the view's perspective.
struct ConnectionEditorSensitiveTextBuffers: Equatable {
    var password = ""
    var privateKey = ""

    mutating func clear() {
        clearPassword()
        clearPrivateKey()
    }

    mutating func clearPassword() {
        password.removeAll(keepingCapacity: false)
    }

    mutating func clearPrivateKey() {
        privateKey.removeAll(keepingCapacity: false)
    }
}

#if canImport(SwiftUI)
import SwiftUI

private enum ConnectionEditorSensitiveField: Hashable {
    case password
    case privateKey
}

/// The masked-secret tri-state as the form presents it (SCREEN_CATALOG.md 6:
/// 保持不变/替换/清除). A masked placeholder is never a new secret.
enum SecretEditChoice: String, CaseIterable {
    case unchanged
    case replace
    case clear

    var title: String {
        switch self {
        case .unchanged: return "保持不变"
        case .replace: return "替换"
        case .clear: return "清除"
        }
    }
}

/// S11 连接编辑器.
///
/// Renders ``ConnectionEditorViewModel/page`` and nothing more: section order
/// and visibility, the field mask, the secret tri-state and the validation
/// rules all live in ``ConnectionDraft`` so XCTest covers them on the host.
@MainActor
public struct ConnectionEditorView: View {

    @ObservedObject var viewModel: ConnectionEditorViewModel

    let onConnect: (Connection, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showDiscardConfirmation = false
    @State private var sensitiveText = ConnectionEditorSensitiveTextBuffers()
    @State private var jumpHostToAdd = ""
    @FocusState private var focusedSensitiveField: ConnectionEditorSensitiveField?

    public init(
        viewModel: ConnectionEditorViewModel,
        onConnect: @escaping (Connection, Bool) -> Void
    ) {
        self.viewModel = viewModel
        self.onConnect = onConnect
    }

    public var body: some View {
        content
            .navigationTitle(viewModel.draft?.isCreate == false ? "编辑连接" : "新建连接")
            .zephyrInlineTitle()
            .zephyrNavigationBackButtonHidden(!dismissCoordinator.allowsSystemDismissal)
            .toolbar {
                ToolbarItem(placement: .zephyrNavLeading) {
                    if !dismissCoordinator.allowsSystemDismissal {
                        Button(action: requestClose) {
                            Label("返回", systemImage: "chevron.backward")
                        }
                    }
                }
                ToolbarItem(placement: .zephyrNavTrailing) {
                    Button("取消") { requestClose() }
                        .keyboardShortcut(.cancelAction)
                }
            }
            .accessibilityAction(.escape) { requestClose() }
            .confirmationDialog(
                "放弃未保存的修改？",
                isPresented: $showDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("放弃修改", role: .destructive) { finishDismiss() }
                Button("继续编辑", role: .cancel) {}
            }
            .alert(
                "提示",
                isPresented: Binding(
                    get: { viewModel.message != nil },
                    set: { if !$0 { viewModel.consumeMessage() } }
                )
            ) {
                Button("好", role: .cancel) {}
            } message: {
                Text(viewModel.message ?? "")
            }
            .onChange(of: viewModel.event) { event in
                guard let event else { return }
                switch event {
                case .dismissed:
                    clearSensitiveCopies()
                    viewModel.consumeEvent()
                    dismiss()
                case let .connect(connection, persisted):
                    clearSensitiveCopies()
                    viewModel.consumeEvent()
                    onConnect(connection, persisted)
                }
            }
            .onChange(of: viewModel.sensitiveClearGeneration) { _ in
                clearSensitiveCopies()
            }
            .onChange(of: viewModel.draft?.privateKey) { state in
                guard case .replace? = state else {
                    sensitiveText.clearPrivateKey()
                    if focusedSensitiveField == .privateKey {
                        focusedSensitiveField = nil
                    }
                    return
                }
            }
            .onAppear { viewModel.load() }
            .onDisappear {
                clearSensitiveCopies()
                viewModel.clearSensitiveMaterial()
            }
            .zephyrInteractivePopGesture(
                isEnabled: dismissCoordinator.allowsSystemDismissal
            )
    }

    @ViewBuilder private var content: some View {
        switch viewModel.page {
        case .initialLoading:
            ProgressView()
        case let .content(ui, _, _, _):
            editorForm(ui)
        case .notFoundOrRevoked:
            Text("连接不存在或已被撤销")
        case let .permissionDenied(_, reason):
            Text(reason ?? ConnectionEditorViewModel.reasonNoEdit)
        case let .retryableError(error):
            Text(error.message)
        case let .fatalIncompatible(error):
            Text(error.message)
        case .empty:
            Text("连接不存在或已被撤销")
        case .offlineNoCache:
            Text("离线，且无本地缓存")
        case .offlineWithCache:
            Text("离线，且无本地缓存")
        }
    }

    private func editorForm(_ ui: ConnectionEditorUiState) -> some View {
        Form {
            ForEach(ui.sections, id: \.self) { section in
                sectionView(section, ui: ui)
            }
            Section(header: Text("操作")) {
                Button(ui.testing ? "正在测试…" : "测试") {
                    Task { await viewModel.test() }
                }
                .disabled(ui.testing)
                if let result = ui.testResult {
                    testResultText(result)
                }
                Button("保存") {
                    Task { await viewModel.save(thenConnect: false) }
                }
                .disabled(!canSave(ui) || ui.saving)
                Button("保存并连接") {
                    Task { await viewModel.save(thenConnect: true) }
                }
                .disabled(!canSave(ui) || ui.saving)
                Button("不保存直接连接") {
                    viewModel.connectWithoutSaving()
                }
            }
        }
    }

    private func canSave(_ ui: ConnectionEditorUiState) -> Bool {
        ui.draft.validate(inventory: ui.inventory).isEmpty &&
            (ui.draft.isDirty || ui.draft.isCreate)
    }

    private var dismissCoordinator: ConnectionEditorDismissCoordinator {
        ConnectionEditorDismissCoordinator(
            hasUnsavedChanges: viewModel.draft?.isDirty == true
        )
    }

    private func requestClose() {
        dismissCoordinator.requestDismiss(
            confirmDiscard: { showDiscardConfirmation = true },
            dismiss: { finishDismiss() }
        )
    }

    private func finishDismiss() {
        clearSensitiveCopies()
        viewModel.dismiss()
    }

    private func clearSensitiveCopies() {
        sensitiveText.clear()
        focusedSensitiveField = nil
    }

    @ViewBuilder
    private func sectionView(_ section: EditorSection, ui: ConnectionEditorUiState) -> some View {
        switch section {
        case .basic:
            Section(header: Text("基础")) {
                TextField("名称", text: stringBinding(ui, \.name) { viewModel.setName($0) })
                issueText(ui, "name")
                Picker(
                    "协议",
                    selection: Binding(
                        get: { ui.draft.current.`protocol` },
                        set: { viewModel.setProtocol($0) }
                    )
                ) {
                    ForEach(ConnectionProtocol.allCases, id: \.self) { value in
                        Text(value.wireName).tag(value)
                    }
                }
                if ui.draft.current.`protocol`.isCleartext {
                    Text("Telnet 为明文协议")
                        .font(.footnote)
                }
                TextField("主机", text: stringBinding(ui, \.host) { viewModel.setHost($0) })
                issueText(ui, "host")
                TextField(
                    "端口",
                    text: Binding(
                        get: { String(ui.draft.current.port) },
                        set: { viewModel.setPort($0) }
                    )
                )
                issueText(ui, "port")
                TextField("用户名", text: stringBinding(ui, \.username) { viewModel.setUsername($0) })
                issueText(ui, "username")
                if ui.draft.showsDomainField {
                    TextField("域", text: rdpStringBinding(ui, \.domain))
                }
                if ui.draft.showsEncodingField {
                    Picker(
                        "编码",
                        selection: Binding(
                            get: { ui.draft.current.encoding },
                            set: { viewModel.setEncoding($0) }
                        )
                    ) {
                        ForEach(
                            ConnectionDraft.availableEncodings(ui.draft.current.`protocol`),
                            id: \.self
                        ) { value in
                            Text(value.wireName).tag(value)
                        }
                    }
                }
            }
        case .auth:
            Section(header: Text("认证")) {
                secretEditor(
                    title: "密码",
                    stored: ui.draft.current.password,
                    state: ui.draft.password,
                    text: $sensitiveText.password,
                    focusedField: .password,
                    onState: { viewModel.setPassword($0) }
                )
                if ui.draft.showsSshKeyField {
                    Picker(
                        "已保存的 SSH Key",
                        selection: Binding(
                            get: { ui.draft.current.sshKeyId },
                            set: { viewModel.setSshKey($0) }
                        )
                    ) {
                        Text("无").tag(String?.none)
                        ForEach(ui.sshKeys, id: \.id) { key in
                            Text(key.name).tag(String?.some(key.id))
                        }
                    }
                    issueText(ui, "sshKeyId")
                    secretEditor(
                        title: "内联私钥",
                        stored: ui.draft.current.privateKey,
                        state: ui.draft.privateKey,
                        text: $sensitiveText.privateKey,
                        focusedField: .privateKey,
                        onState: { viewModel.setPrivateKey($0) }
                    )
                }
            }
        case .route:
            Section(header: Text("路由")) {
                Picker(
                    "模式",
                    selection: Binding(
                        get: { ui.draft.current.connectionMode },
                        set: { viewModel.setConnectionMode($0) }
                    )
                ) {
                    Text("直连").tag(ConnectionMode.direct)
                    Text("代理").tag(ConnectionMode.proxy)
                    Text("跳板").tag(ConnectionMode.jump)
                }
                if ui.draft.current.connectionMode == .proxy {
                    Picker(
                        "代理",
                        selection: Binding(
                            get: { ui.draft.current.proxyId },
                            set: { viewModel.setProxy($0) }
                        )
                    ) {
                        Text("无").tag(String?.none)
                        ForEach(ui.proxies, id: \.id) { proxy in
                            Text(proxy.name).tag(String?.some(proxy.id))
                        }
                    }
                    issueText(ui, "proxyId")
                }
                if ui.draft.current.connectionMode == .jump {
                    ForEach(Array(ui.draft.current.jumpHostIds.indices), id: \.self) { index in
                        HStack {
                            Text("\(index + 1). \(jumpHostName(ui.draft.current.jumpHostIds[index], ui: ui))")
                            Spacer()
                            Button("上移") {
                                viewModel.moveJumpHost(from: index, to: index - 1)
                            }
                            .disabled(index == 0)
                            Button("移除") { viewModel.removeJumpHost(ui.draft.current.jumpHostIds[index]) }
                        }
                    }
                    Picker("添加跳板", selection: $jumpHostToAdd) {
                        Text("选择…").tag("")
                        ForEach(ui.jumpHosts, id: \.id) { host in
                            Text(host.name).tag(host.id)
                        }
                    }
                    .onChange(of: jumpHostToAdd) { selected in
                        if !selected.isEmpty {
                            viewModel.addJumpHost(selected)
                            jumpHostToAdd = ""
                        }
                    }
                    Text("跳板链最多 \(Connection.maxJumpDepth) 级")
                        .font(.footnote)
                    issueText(ui, "jumpHostIds")
                }
                ForEach(ui.routeIssues, id: \.field) { issue in
                    HStack {
                        Text(issue.message)
                            .font(.footnote)
                        Spacer()
                        Button("修复") { viewModel.repairRoute(issue.field) }
                    }
                }
            }
        case .rdpChannels:
            Section(header: Text("RDP 通道")) {
                Picker("声音", selection: rdpBinding(ui, \.soundMode)) {
                    ForEach(RdpSoundMode.allCases, id: \.self) { value in
                        Text(value.wireName).tag(value)
                    }
                }
                Toggle("剪贴板", isOn: rdpBinding(ui, \.clipboard))
                Toggle("麦克风", isOn: rdpBinding(ui, \.microphone))
                Toggle("摄像头", isOn: rdpBinding(ui, \.camera))
                Toggle("存储", isOn: rdpBinding(ui, \.storage))
                Toggle("位置", isOn: rdpBinding(ui, \.location))
            }
        case .rdpDisplay:
            Section(header: Text("RDP 显示")) {
                Picker("分辨率", selection: rdpBinding(ui, \.resolution)) {
                    ForEach(RdpResolution.allCases, id: \.self) { value in
                        Text(value.wireName).tag(value)
                    }
                }
                Picker("画质", selection: rdpBinding(ui, \.quality)) {
                    ForEach(RdpQuality.allCases, id: \.self) { value in
                        Text(value.wireName).tag(value)
                    }
                }
                Picker("帧率", selection: rdpBinding(ui, \.fps)) {
                    ForEach(RdpFps.allCases, id: \.self) { value in
                        Text(String(value.value)).tag(value)
                    }
                }
                Picker("触控模式", selection: rdpBinding(ui, \.touchMode)) {
                    ForEach(RdpTouchMode.allCases, id: \.self) { value in
                        Text(value.wireName).tag(value)
                    }
                }
                Slider(
                    value: rdpBinding(ui, \.touchSensitivity),
                    in: RdpSettings.minSensitivity...RdpSettings.maxSensitivity
                )
            }
        case .fileSync:
            Section(header: Text("文件同步目录意图")) {
                Picker(
                    "意图",
                    selection: Binding(
                        get: { ui.draft.current.fileSyncIntent },
                        set: { viewModel.setFileSyncIntent($0) }
                    )
                ) {
                    ForEach(FileSyncDirectoryIntent.allCases, id: \.self) { value in
                        Text(value.wireName).tag(value)
                    }
                }
            }
        case .metadata:
            Section(header: Text("Metadata")) {
                TextField(
                    "标签（逗号分隔）",
                    text: Binding(
                        get: { ui.draft.current.tags.joined(separator: ", ") },
                        set: { viewModel.setTags($0.split(separator: ",").map(String.init)) }
                    )
                )
                TextField("备注", text: stringBinding(ui, \.remark) { viewModel.setRemark($0) })
                Picker(
                    "可见性",
                    selection: Binding(
                        get: { ui.draft.current.visibility },
                        set: { viewModel.setVisibility($0) }
                    )
                ) {
                    ForEach(Connection.visibilityOptions, id: \.self) { value in
                        Text(value).tag(value)
                    }
                }
            }
        }
    }

    /// The masked-secret tri-state control. The masked value is never
    /// round-tripped into the field; "替换" starts from an empty box.
    private func secretEditor(
        title: String,
        stored: SecretPresence,
        state: SecretState,
        text: Binding<String>,
        focusedField: ConnectionEditorSensitiveField,
        onState: @escaping (SecretState) -> Void
    ) -> some View {
        VStack(alignment: .leading) {
            HStack {
                Text(title)
                Spacer()
                if case .unchanged = state, stored.hasValue {
                    Text(SecretPresence.mask)
                        .font(.footnote)
                }
            }
            Picker(
                title,
                selection: Binding(
                    get: { choice(for: state) },
                    set: { choice in
                        switch choice {
                        case .unchanged:
                            text.wrappedValue = ""
                            onState(.unchanged)
                        case .replace:
                            onState(.replace(text.wrappedValue))
                        case .clear:
                            text.wrappedValue = ""
                            onState(.clear)
                        }
                    }
                )
            ) {
                ForEach(SecretEditChoice.allCases, id: \.self) { value in
                    Text(value.title).tag(value)
                }
            }
            if case .replace = state {
                SecureField(
                    "新的\(title)",
                    text: Binding(
                        get: { text.wrappedValue },
                        set: {
                            text.wrappedValue = $0
                            onState(.replace($0))
                        }
                    )
                )
                .focused($focusedSensitiveField, equals: focusedField)
            }
        }
    }

    private func choice(for state: SecretState) -> SecretEditChoice {
        switch state {
        case .unchanged: return .unchanged
        case .replace: return .replace
        case .clear: return .clear
        }
    }

    private func testResultText(_ result: ConnectionTestResult) -> some View {
        switch result {
        case let .reachable(roundTripMs):
            return Text("可达（\(roundTripMs) ms）")
        case let .authenticated(roundTripMs):
            return Text("认证成功（\(roundTripMs) ms）")
        case let .failed(error):
            return Text(error.message)
        }
    }

    private func issueText(_ ui: ConnectionEditorUiState, _ field: String) -> some View {
        Group {
            if let issue = ui.issueFor(field: field) {
                Text(issue.message)
                    .font(.footnote)
            }
        }
    }

    private func stringBinding(
        _ ui: ConnectionEditorUiState,
        _ keyPath: WritableKeyPath<Connection, String>,
        _ apply: @escaping (String) -> Void
    ) -> Binding<String> {
        Binding(
            get: { ui.draft.current[keyPath: keyPath] },
            set: { apply($0) }
        )
    }

    private func rdpBinding<Value>(
        _ ui: ConnectionEditorUiState,
        _ keyPath: WritableKeyPath<RdpSettings, Value>
    ) -> Binding<Value> {
        Binding(
            get: { ui.draft.current.rdp[keyPath: keyPath] },
            set: { value in
                var settings = ui.draft.current.rdp
                if keyPath == \RdpSettings.touchSensitivity, let sensitivity = value as? Double {
                    settings.touchSensitivity = RdpSettings.clampSensitivity(sensitivity)
                } else {
                    settings[keyPath: keyPath] = value
                }
                viewModel.setRdp(settings)
            }
        )
    }

    private func rdpStringBinding(
        _ ui: ConnectionEditorUiState,
        _ keyPath: WritableKeyPath<RdpSettings, String>
    ) -> Binding<String> {
        rdpBinding(ui, keyPath)
    }

    private func jumpHostName(_ id: String, ui: ConnectionEditorUiState) -> String {
        ui.jumpHosts.first { $0.id == id }?.name ?? id
    }
}
#endif
