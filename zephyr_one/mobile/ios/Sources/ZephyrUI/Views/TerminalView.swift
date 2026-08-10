#if canImport(SwiftUI)
import SwiftUI

/// S21 SSH/Telnet 终端.
///
/// The terminal viewport is an honest placeholder: the native engine is a
/// separate blocked track, so this view renders the chrome, the dock, the
/// Telnet differences and the host-key gate while the canvas reports the
/// engine's absence rather than faking pixels. Every interaction routes
/// through ``TerminalViewModel``.
public struct TerminalView: View {

    @ObservedObject var viewModel: TerminalViewModel

    @State private var showHostKey = false

    public init(viewModel: TerminalViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        content
            .navigationTitle(viewModel.page.contentValue?.connection.name ?? "终端")
            .zephyrInlineTitle()
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("会话列表") { viewModel.minimise() }
                }
            }
            .confirmationDialog(
                "主机密钥确认",
                isPresented: $showHostKey,
                titleVisibility: .visible
            ) {
                Button("信任该主机") { viewModel.trustHostKey() }
                Button("拒绝", role: .destructive) { viewModel.rejectHostKey() }
                Button("取消", role: .cancel) {}
            } message: {
                Text(hostKeyMessage)
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
            .onChange(of: viewModel.page) { _ in
                showHostKey = viewModel.page.contentValue?.hostKeyPrompt != nil
            }
            .onChange(of: viewModel.event) { event in
                guard let event else { return }
                viewModel.consumeEvent()
                switch event {
                case .minimised, .closed, .openDock:
                    // Navigation is owned by the host stack; the event just
                    // tells it to pop or push.
                    break
                }
            }
    }

    private var hostKeyMessage: String {
        guard let prompt = viewModel.page.contentValue?.hostKeyPrompt else { return "" }
        let change = prompt.changed ? "此密钥与上次不同，可能发生了中间人攻击。" : "该主机尚未被本机信任。"
        return change + "指纹：" + prompt.fingerprint
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.page {
        case .initialLoading:
            ProgressView("正在载入会话…")
        case let .content(value, _, _, _):
            terminal(value)
        case .notFoundOrRevoked:
            Text("会话权限已撤销或已不存在")
        case let .permissionDenied(_, reason):
            Text(reason ?? "无使用权限")
        case let .retryableError(error):
            errorView(error)
        case let .fatalIncompatible(error):
            errorView(error)
        case .empty, .offlineWithCache, .offlineNoCache:
            EmptyView()
        }
    }

    private func terminal(_ value: TerminalContent) -> some View {
        VStack(spacing: 0) {
            if let warning = value.cleartextWarning {
                Text(warning)
                    .font(.footnote)
                    .padding(4)
            }
            if let disclosure = value.executionDisclosure {
                Text(disclosure)
                    .font(.footnote)
                    .padding(4)
            }
            if let autoLogin = value.autoLoginStatus {
                Text(autoLogin)
                    .font(.footnote)
                    .padding(4)
            }

            // The surface region. Honest placeholder: the engine is blocked.
            VStack {
                Spacer()
                Image(systemName: "terminal")
                    .font(.largeTitle)
                Text("终端引擎尚未接入")
                    .font(.headline)
                Text(engineMessage(value))
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            statusBar(value)

            dock(value)
        }
        .onAppear {
            viewModel.load()
        }
    }

    private func engineMessage(_ value: TerminalContent) -> String {
        switch value.transport {
        case .connecting: return "正在建立连接…"
        case .connected: return "已连接，等待原生引擎接入后显示内容"
        case .disconnected: return "会话已断开"
        case .closed: return "会话已关闭"
        }
    }

    private func statusBar(_ value: TerminalContent) -> some View {
        HStack {
            Text(transportLabel(value.transport))
                .font(.footnote)
            Spacer()
            Text("\(value.surface.columns) × \(value.surface.rows)")
                .font(.footnote)
            if value.surface.missedOutputRows > 0 {
                Button("\(value.surface.missedOutputRows) 行新输出") {
                    viewModel.jumpToBottom()
                }
                .font(.footnote)
            }
            if value.canReconnect {
                Button("重连") { viewModel.reconnect() }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    private func transportLabel(_ transport: SessionTransport) -> String {
        switch transport {
        case .connecting: return "连接中"
        case .connected: return "已连接"
        case .disconnected: return "已断开"
        case .closed: return "已关闭"
        }
    }

    private func dock(_ value: TerminalContent) -> some View {
        HStack {
            ForEach(value.dock, id: \.self) { item in
                Button {
                    viewModel.onDock(item)
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: item.systemImage)
                        Text(item.title)
                            .font(.caption2)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func errorView(_ error: MobileError) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
            Text(error.message)
            Text(error.diagnosticText())
                .font(.footnote)
            if error.retryable || error.isRegistryRetryable {
                Button("重试连接") { viewModel.connect() }
            }
        }
        .padding()
    }
}

extension PageState where Value == TerminalContent {
    fileprivate var contentValue: TerminalContent? {
        if case let .content(value, _, _, _) = self { return value }
        return nil
    }
}
#endif