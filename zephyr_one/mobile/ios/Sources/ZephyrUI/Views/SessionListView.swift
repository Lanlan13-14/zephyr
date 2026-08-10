#if canImport(SwiftUI)
import SwiftUI

/// S20 会话列表.
///
/// Renders ``SessionListViewModel/state`` and nothing more: grouping, the
/// row actions and the bulk-close count all come from the view model's
/// derived content, so the screen holds no policy. Row taps and dock
/// navigation are forwarded as events; the view never opens a transport.
public struct SessionListView: View {

    @ObservedObject var viewModel: SessionListViewModel

    let onOpenTerminal: (String, String) -> Void
    let onOpenRemote: (String, String) -> Void
    let onReconnect: (String, String) -> Void
    let onDetails: (String) -> Void

    @State private var showBulkClose = false

    public init(
        viewModel: SessionListViewModel,
        onOpenTerminal: @escaping (String, String) -> Void,
        onOpenRemote: @escaping (String, String) -> Void,
        onReconnect: @escaping (String, String) -> Void,
        onDetails: @escaping (String) -> Void
    ) {
        self.viewModel = viewModel
        self.onOpenTerminal = onOpenTerminal
        self.onOpenRemote = onOpenRemote
        self.onReconnect = onReconnect
        self.onDetails = onDetails
    }

    public var body: some View {
        content
            .navigationTitle("会话")
            .zephyrInlineTitle()
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("批量关闭") { showBulkClose = true }
                        .disabled(viewModel.state.contentValue?.closableCount == 0)
                }
            }
            .confirmationDialog(
                "关闭选中的会话？",
                isPresented: $showBulkClose,
                titleVisibility: .visible
            ) {
                Button("关闭全部可关闭会话", role: .destructive) { viewModel.closeAll() }
                Button("取消", role: .cancel) {}
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
                case let .openTerminal(sessionId, connectionId):
                    viewModel.consumeEvent()
                    onOpenTerminal(sessionId, connectionId)
                case let .openRemote(sessionId, connectionId):
                    viewModel.consumeEvent()
                    onOpenRemote(sessionId, connectionId)
                case let .reconnect(sessionId, connectionId):
                    viewModel.consumeEvent()
                    onReconnect(sessionId, connectionId)
                case let .details(sessionId):
                    viewModel.consumeEvent()
                    onDetails(sessionId)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .initialLoading:
            ProgressView("正在恢复会话…")
        case let .content(value, _, _, _):
            list(value)
        case let .empty(reason):
            emptyView(reason)
        case .offlineWithCache:
            // Sessions are process-local runtime state, so there is no mirror
            // to fall back on while offline: the list simply marks it.
            if case let .content(value, _, _, _) = viewModel.state { list(value) }
            else { EmptyView() }
        case .offlineNoCache, .notFoundOrRevoked, .fatalIncompatible:
            EmptyView()
        case let .permissionDenied(_, reason):
            Text(reason ?? "无权限查看会话")
        case let .retryableError(error):
            errorView(error)
        }
    }

    private func list(_ value: SessionListContent) -> some View {
        List {
            if !value.online {
                Text("离线：断线会话不能重连，恢复网络后重试")
                    .font(.footnote)
            }
            ForEach(value.groups) { section in
                Section(header: Text(section.group.title)) {
                    ForEach(section.rows) { row in
                        sessionRow(row, online: value.online)
                    }
                }
            }
        }
    }

    private func sessionRow(_ row: SessionRow, online: Bool) -> some View {
        VStack(alignment: .leading) {
            HStack {
                Text(row.name)
                Spacer()
                Text(row.`protocol`.wireName)
                    .font(.footnote)
            }
            Text(row.displayAddress)
                .font(.footnote)
            if let disclosure = SessionActions.executionDisclosure(row) {
                Text(disclosure)
                    .font(.footnote)
            }
            if row.revoked {
                Text(row.revokedReason ?? SessionActions.reasonRevoked)
                    .font(.footnote)
            }
            if let latency = row.latencyMs {
                Text("延迟 \(latency) ms")
                    .font(.footnote)
            }
        }
        .onTapGesture {
            handleTap(row)
        }
        .contextMenu {
            ForEach(SessionActions.visibleActions(row), id: \.self) { action in
                actionButton(action, for: row, online: online)
            }
        }
    }

    private func handleTap(_ row: SessionRow) {
        if row.revoked { return }
        switch row.transport {
        case .connecting, .connected:
            handleRestore(row)
        case .disconnected:
            if viewModel.state.contentValue?.online == true {
                handleRestore(row)
            }
        case .closed:
            break
        }
    }

    private func handleRestore(_ row: SessionRow) {
        let gate = SessionActions.gate(row, action: .restore)
        guard gate.isAllowed else { return }
        viewModel.onAction(row, action: .restore)
    }

    @ViewBuilder
    private func actionButton(_ action: SessionAction, for row: SessionRow, online: Bool) -> some View {
        let gate = SessionActions.gate(row, action: action)
        switch action {
        case .restore:
            Button("恢复") { viewModel.onAction(row, action: action) }
        case .reconnect:
            Button("重连") { viewModel.onAction(row, action: action) }
                .disabled(!gate.isAllowed || !online)
        case .close:
            Button("关闭", role: .destructive) { viewModel.onAction(row, action: action) }
        case .details:
            Button("详情") { viewModel.onAction(row, action: action) }
        }
    }

    private func emptyView(_ reason: EmptyReason) -> some View {
        VStack(spacing: 8) {
            Text("还没有会话")
            Text("从首页连接一个 SSH/Telnet/RDP/VNC 连接后，这里会列出运行中的会话")
                .font(.footnote)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private func errorView(_ error: MobileError) -> some View {
        VStack {
            Text(error.message)
            Text(error.diagnosticText())
                .font(.footnote)
            Button("重试") { Task { await viewModel.restoreWorkspace([]) } }
        }
    }
}

extension PageState where Value == SessionListContent {
    fileprivate var contentValue: SessionListContent? {
        if case let .content(value, _, _, _) = self { return value }
        return nil
    }
}
#endif