#if canImport(SwiftUI)
import SwiftUI

/// S10 首页/连接库.
///
/// State selection and filtering remain in ``ConnectionListViewModel``. This
/// view renders the frozen home composition and forwards host-owned protocol
/// operations through required callbacks, so no visible action is a no-op.
public struct ConnectionListView: View {

    @ObservedObject var viewModel: ConnectionListViewModel
    @Environment(\.colorScheme) private var colorScheme

    let onOpenConnection: (Connection) -> Void
    let onEditConnection: (String?) -> Void
    let onOpenBinding: () -> Void
    let onDuplicateConnection: (Connection) -> Void
    let onTestConnection: (Connection) -> Void
    let onShareConnection: (Connection) -> Void

    @State private var pendingDelete: Connection?

    public init(
        viewModel: ConnectionListViewModel,
        onOpenConnection: @escaping (Connection) -> Void,
        onEditConnection: @escaping (String?) -> Void,
        onOpenBinding: @escaping () -> Void,
        onDuplicateConnection: @escaping (Connection) -> Void,
        onTestConnection: @escaping (Connection) -> Void,
        onShareConnection: @escaping (Connection) -> Void
    ) {
        self.viewModel = viewModel
        self.onOpenConnection = onOpenConnection
        self.onEditConnection = onEditConnection
        self.onOpenBinding = onOpenBinding
        self.onDuplicateConnection = onDuplicateConnection
        self.onTestConnection = onTestConnection
        self.onShareConnection = onShareConnection
    }

    public var body: some View {
        content
            .navigationTitle("Zephyr One")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { onEditConnection(nil) }) {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建连接")
                }
                if viewModel.canSync {
                    ToolbarItem(placement: .primaryAction) {
                        Button(action: { Task { await viewModel.syncNow() } }) {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        .accessibilityLabel("立即同步")
                    }
                }
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
            .confirmationDialog(
                "删除连接？",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let connection = pendingDelete {
                    Button("删除", role: .destructive) {
                        Task { await viewModel.delete(connection) }
                    }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("连接会先从本机删除，并在同步可用时提交删除记录。")
            }
            .zephyrInteractivePopGesture()
    }

    @ViewBuilder private var content: some View {
        ZStack {
            ZephyrRootBackground()
            switch viewModel.state {
            case .initialLoading:
                ProgressView("正在读取本地连接…")
            case let .content(connections, pendingSync, conflict, _):
                connectionLibrary(
                    connections,
                    pendingSync: pendingSync,
                    conflict: conflict,
                    offlineSince: nil
                )
            case let .offlineWithCache(connections, lastSyncedAt):
                connectionLibrary(
                    connections,
                    pendingSync: connections.contains { $0.syncState == .pendingLocal },
                    conflict: connections.contains { $0.syncState == .conflicted },
                    offlineSince: lastSyncedAt
                )
            case let .empty(reason):
                emptyView(reason)
            case .offlineNoCache:
                statePanel(
                    icon: "wifi.slash",
                    title: "离线，且无本地缓存",
                    detail: "恢复网络后可以重新读取共享连接",
                    actionTitle: viewModel.canSync ? "重试" : nil,
                    action: { Task { await viewModel.syncNow() } }
                )
            case let .permissionDenied(_, reason):
                statePanel(icon: "lock", title: "没有权限", detail: reason, actionTitle: nil, action: {})
            case .notFoundOrRevoked:
                statePanel(icon: "xmark.circle", title: "资源不可用", detail: "资源不存在或已被撤销", actionTitle: nil, action: {})
            case let .retryableError(error):
                errorView(error, retryable: viewModel.canSync)
            case let .fatalIncompatible(error):
                errorView(error, retryable: false)
            }
        }
    }

    private func connectionLibrary(
        _ connections: [Connection],
        pendingSync: Bool,
        conflict: Bool,
        offlineSince: Int64?
    ) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                statusBanners(
                    pendingSync: pendingSync,
                    conflict: conflict,
                    offlineSince: offlineSince
                )
                searchField
                    .padding(.top, 6)
                filterChips

                if !viewModel.recents.isEmpty {
                    ZephyrSectionTitle("最近连接")
                    ForEach(viewModel.recents, id: \.id) { connection in
                        connectionCard(connection)
                            .padding(.bottom, 10)
                    }
                }

                ZephyrSectionTitle(viewModel.recents.isEmpty ? "连接" : "全部连接")
                ForEach(connections, id: \.id) { connection in
                    connectionCard(connection)
                        .padding(.bottom, 10)
                }

                ZephyrSectionTitle("活动摘要")
                activitySummary(connections)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 112)
        }
    }

    @ViewBuilder
    private func statusBanners(
        pendingSync: Bool,
        conflict: Bool,
        offlineSince: Int64?
    ) -> some View {
        if offlineSince != nil {
            statusBanner(
                icon: "wifi.slash",
                text: "离线 · 正在使用本地镜像",
                tint: ZephyrStyle.secondaryText(colorScheme)
            )
        }
        if pendingSync {
            statusBanner(icon: "arrow.up.circle", text: "有修改待同步", tint: ZephyrStyle.pending)
        }
        if conflict {
            statusBanner(icon: "exclamationmark.triangle", text: "存在同步冲突", tint: ZephyrStyle.conflict)
        }
    }

    private func statusBanner(icon: String, text: String, tint: Color) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote.weight(.medium))
            .foregroundColor(tint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(tint.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.bottom, 6)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.secondary)
            TextField(
                "搜索连接、标签、主机…",
                text: Binding(
                    get: { viewModel.filter.query },
                    set: { viewModel.setQuery($0) }
                )
            )
            .textFieldStyle(.plain)
            if !viewModel.filter.query.isEmpty {
                Button { viewModel.setQuery("") } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .frame(height: 36)
        .padding(.horizontal, 12)
        .background(ZephyrStyle.elevated(colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip("全部", selected: !hasFacetFilter) { viewModel.clearFilters() }
                ForEach(ConnectionProtocol.allCases, id: \.self) { value in
                    filterChip(
                        displayName(value),
                        selected: viewModel.filter.protocols.contains(value)
                    ) { viewModel.toggleProtocol(value) }
                }
                filterChip("收藏", selected: viewModel.filter.favouritesOnly) {
                    viewModel.setFavouritesOnly(!viewModel.filter.favouritesOnly)
                }
                filterChip("自有", selected: viewModel.filter.ownership == .owned) {
                    viewModel.setOwnership(viewModel.filter.ownership == .owned ? .all : .owned)
                }
                filterChip("共享给我", selected: viewModel.filter.ownership == .shared) {
                    viewModel.setOwnership(viewModel.filter.ownership == .shared ? .all : .shared)
                }
                ForEach(viewModel.availableTags, id: \.self) { tag in
                    filterChip(tag, selected: viewModel.filter.tags.contains(tag)) {
                        viewModel.toggleTag(tag)
                    }
                }
            }
            .padding(.vertical, 6)
        }
    }

    private var hasFacetFilter: Bool {
        !viewModel.filter.protocols.isEmpty ||
            !viewModel.filter.tags.isEmpty ||
            viewModel.filter.ownership != .all ||
            viewModel.filter.favouritesOnly
    }

    private func filterChip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(selected ? .white : ZephyrStyle.secondaryText(colorScheme))
                .padding(.horizontal, 13)
                .frame(height: 30)
                .background(selected ? ZephyrStyle.accent : ZephyrStyle.elevated(colorScheme))
                .clipShape(Capsule())
        }
        .buttonStyle(ZephyrPressButtonStyle())
    }

    private func connectionCard(_ connection: Connection) -> some View {
        HStack(alignment: .top, spacing: 12) {
                Text(displayName(connection.`protocol`))
                    .font(.system(size: 10.5, weight: .heavy, design: .monospaced))
                    .foregroundColor(protocolColor(connection.`protocol`))
                    .frame(width: 40, height: 40)
                    .background(protocolColor(connection.`protocol`).opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(connection.name)
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundColor(.primary)
                            .lineLimit(1)
                        if viewModel.favouriteIds.contains(connection.id) {
                            Image(systemName: "star.fill")
                                .font(.caption2)
                                .foregroundColor(ZephyrStyle.warning)
                        }
                    }

                    Text(connection.displayAddress)
                        .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                        .foregroundColor(.secondary)
                        .lineLimit(1)

                    cardMetadata(connection)

                    if connection.residency == .sharedOnlineOnly {
                        Text("来自 \(connection.sharedOwnerLabel ?? "?") · 在线使用 · 不保存到此设备")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let disclosure = ConnectionActions.sharedUseDisclosure(connection) {
                            Text(disclosure)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Spacer(minLength: 4)

                VStack(alignment: .trailing, spacing: 6) {
                    if let timestamp = connection.lastConnectedAt {
                        Text(Date(timeIntervalSince1970: TimeInterval(timestamp) / 1_000), style: .relative)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    Menu {
                        Button(viewModel.favouriteIds.contains(connection.id) ? "取消收藏" : "收藏") {
                            viewModel.toggleFavourite(connection.id)
                        }
                        ForEach(ConnectionActions.visibleActions(connection), id: \.self) { action in
                            actionButton(action, for: connection)
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Circle())
                    }
                    .accessibilityLabel("\(connection.name) 操作")
                }
        }
        .padding(14)
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onTapGesture {
            if ConnectionActions.gate(connection, action: .use).isAllowed {
                onOpenConnection(connection)
            }
        }
        .zephyrCard()
        .contextMenu {
            Button(viewModel.favouriteIds.contains(connection.id) ? "取消收藏" : "收藏") {
                viewModel.toggleFavourite(connection.id)
            }
            ForEach(ConnectionActions.visibleActions(connection), id: \.self) { action in
                actionButton(action, for: connection)
            }
        }
    }

    @ViewBuilder
    private func cardMetadata(_ connection: Connection) -> some View {
        let tags = Array(connection.tags.prefix(3))
        if !tags.isEmpty || connection.syncState != .synced || connection.residency == .sharedOnlineOnly {
            HStack(spacing: 6) {
                ForEach(tags, id: \.self) { tag in
                    metadataBadge(tag, tint: .secondary)
                }
                if connection.residency == .sharedOnlineOnly {
                    metadataBadge("共享", tint: ZephyrStyle.secondaryText(colorScheme))
                }
                switch connection.syncState {
                case .pendingLocal:
                    metadataBadge("待同步", tint: ZephyrStyle.pending)
                case .conflicted:
                    metadataBadge("冲突", tint: ZephyrStyle.conflict)
                case .readOnlyRemote:
                    metadataBadge("只读", tint: ZephyrStyle.secondaryText(colorScheme))
                case .synced:
                    EmptyView()
                }
            }
        }
    }

    private func metadataBadge(_ title: String, tint: Color) -> some View {
        Text(title)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundColor(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    @ViewBuilder
    private func actionButton(_ action: ConnectionAction, for connection: Connection) -> some View {
        let gate = ConnectionActions.gate(connection, action: action)
        switch action {
        case .use:
            Button("连接") { onOpenConnection(connection) }
        case .edit:
            Button("编辑") { onEditConnection(connection.id) }
        case .duplicate:
            Button("复制") { onDuplicateConnection(connection) }
                .disabled(!gate.isAllowed)
        case .delete:
            Button("删除", role: .destructive) { pendingDelete = connection }
        case .test:
            Button("测试") { onTestConnection(connection) }
        case .share:
            Button("共享") { onShareConnection(connection) }
                .disabled(!gate.isAllowed)
        }
    }

    private func activitySummary(_ connections: [Connection]) -> some View {
        HStack(spacing: 10) {
            activityCard(value: viewModel.recents.count, label: "最近连接", tint: .primary)
            activityCard(
                value: connections.filter { $0.syncState == .pendingLocal }.count,
                label: "待同步",
                tint: ZephyrStyle.pending
            )
            activityCard(
                value: connections.filter { $0.syncState == .conflicted }.count,
                label: "冲突",
                tint: ZephyrStyle.conflict
            )
        }
    }

    private func activityCard(value: Int, label: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(String(value))
                .font(.title3.weight(.bold))
                .foregroundColor(tint)
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .zephyrCard()
    }

    @ViewBuilder
    private func emptyView(_ reason: EmptyReason) -> some View {
        switch reason {
        case .noData:
            statePanel(
                icon: "rectangle.stack.badge.plus",
                title: "还没有连接",
                detail: "新建一个连接即可在本机使用",
                actionTitle: "新建连接",
                action: { onEditConnection(nil) }
            )
        case .noMatchingFilter:
            statePanel(
                icon: "line.3.horizontal.decrease.circle",
                title: "没有匹配的连接",
                detail: "调整搜索词或筛选条件",
                actionTitle: "清除筛选",
                action: { viewModel.resetSearchAndFilters() }
            )
        case .notYetSynced:
            statePanel(
                icon: "link.badge.plus",
                title: "尚未绑定主端",
                detail: "本地使用不受影响，也可以绑定主端获取已有连接",
                actionTitle: "绑定主端",
                action: onOpenBinding
            )
        }
    }

    private func errorView(_ error: MobileError, retryable: Bool) -> some View {
        statePanel(
            icon: retryable ? "exclamationmark.arrow.triangle.2.circlepath" : "exclamationmark.octagon",
            title: error.message,
            detail: error.diagnosticText(),
            actionTitle: retryable ? "重试" : nil,
            action: { Task { await viewModel.syncNow() } }
        )
    }

    private func statePanel(
        icon: String,
        title: String,
        detail: String?,
        actionTitle: String?,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.largeTitle)
                .foregroundColor(.secondary)
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let actionTitle {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: 360)
        .padding(24)
    }

    private func displayName(_ value: ConnectionProtocol) -> String {
        value == .telnet ? "Telnet" : value.wireName
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
#endif
