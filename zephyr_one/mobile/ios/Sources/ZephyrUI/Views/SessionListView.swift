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
    let onReconnect: (String, String, ConnectionProtocol) -> Void
    let onDetails: (String) -> Void

    @State private var showBulkClose = false

    public init(
        viewModel: SessionListViewModel,
        onOpenTerminal: @escaping (String, String) -> Void,
        onOpenRemote: @escaping (String, String) -> Void,
        onReconnect: @escaping (String, String, ConnectionProtocol) -> Void,
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
            .toolbar {
                ToolbarItem(placement: .zephyrNavTrailing) {
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
                case let .reconnect(sessionId, connectionId, `protocol`):
                    viewModel.consumeEvent()
                    onReconnect(sessionId, connectionId, `protocol`)
                case let .details(sessionId):
                    viewModel.consumeEvent()
                    onDetails(sessionId)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        ZStack {
            ZephyrRootBackground()
            switch viewModel.state {
            case .initialLoading:
                ProgressView("正在恢复会话…")
            case let .content(value, _, _, _):
                list(value)
            case let .empty(reason):
                emptyView(reason)
            case .offlineWithCache:
                if case let .content(value, _, _, _) = viewModel.state { list(value) }
                else { EmptyView() }
            case .offlineNoCache, .notFoundOrRevoked, .fatalIncompatible:
                ZephyrEmptyPanel(systemImage: "rectangle.slash", title: "会话不可用", detail: "没有可恢复的本地会话")
                    .padding()
            case let .permissionDenied(_, reason):
                ZephyrEmptyPanel(systemImage: "lock", title: "无权限查看会话", detail: reason ?? "权限不足")
                    .padding()
            case let .retryableError(error):
                errorView(error)
            }
        }
    }

    private func list(_ value: SessionListContent) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !value.online {
                    Label("离线：断线会话不能重连", systemImage: "wifi.slash")
                        .font(.footnote.weight(.medium))
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .zephyrCard()
                        .padding(.top, 6)
                }
                ForEach(value.groups) { section in
                    ZephyrSectionTitle(section.group.title)
                    ForEach(section.rows) { row in
                        sessionRow(row, online: value.online)
                            .padding(.bottom, 8)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 112)
        }
    }

    private func sessionRow(_ row: SessionRow, online: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(statusColor(row))
                .frame(width: 9, height: 9)
                .shadow(color: statusColor(row).opacity(row.transport == .connected ? 0.6 : 0), radius: 4)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 4) {
                Text(row.name)
                    .font(.system(size: 14, weight: .semibold))
                Text(sessionSummary(row))
                    .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                    .foregroundColor(.secondary)
                if let disclosure = SessionActions.executionDisclosure(row) {
                    Text(disclosure)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
                if row.revoked {
                    Text(row.revokedReason ?? SessionActions.reasonRevoked)
                        .font(.caption2)
                        .foregroundColor(ZephyrStyle.danger)
                }
            }

            Spacer(minLength: 6)

            Text(row.`protocol`.wireName)
                .font(.caption.weight(.semibold))
                .foregroundColor(protocolColor(row.`protocol`))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(protocolColor(row.`protocol`).opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            Menu {
                ForEach(SessionActions.visibleActions(row), id: \.self) { action in
                    actionButton(action, for: row, online: online)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.secondary)
                    .frame(width: 28, height: 28)
            }
            .accessibilityLabel("\(row.name) 会话操作")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onTapGesture {
            handleTap(row)
        }
        .zephyrCard()
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
        ZephyrEmptyPanel(
            systemImage: "terminal",
            title: "还没有会话",
            detail: "从首页连接 SSH/Telnet/RDP/VNC 后，运行中的会话会显示在这里"
        )
        .padding()
    }

    private func errorView(_ error: MobileError) -> some View {
        VStack {
            Text(error.message)
            Text(error.diagnosticText())
                .font(.footnote)
            Button("重试") { Task { await viewModel.restoreWorkspace([]) } }
        }
        .padding()
    }

    private func sessionSummary(_ row: SessionRow) -> String {
        var values: [String] = [row.displayAddress]
        if let latency = row.latencyMs { values.append("\(latency) ms") }
        values.append(row.execution == .local ? "本地执行" : "主端 relay")
        return values.joined(separator: " · ")
    }

    private func statusColor(_ row: SessionRow) -> Color {
        if row.minimised { return Color.gray }
        switch row.transport {
        case .connecting: return ZephyrStyle.pending
        case .connected: return ZephyrStyle.success
        case .disconnected, .closed: return ZephyrStyle.danger
        }
    }

    private func protocolColor(_ value: ConnectionProtocol) -> Color {
        switch value {
        case .ssh: return ZephyrStyle.accent
        case .telnet: return ZephyrStyle.warning
        case .rdp: return Color(red: 191 / 255, green: 90 / 255, blue: 242 / 255)
        case .vnc: return ZephyrStyle.success
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
