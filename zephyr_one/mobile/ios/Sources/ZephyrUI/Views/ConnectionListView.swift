#if canImport(SwiftUI)
import SwiftUI

/// S10 首页/连接库.
///
/// A thin rendering of ``ConnectionListViewModel/state``: every branch of the
/// nine-state contract gets a face, and every decision about *which* branch is
/// showing was already made by the pure derivation on the host-testable side.
public struct ConnectionListView: View {

    @ObservedObject var viewModel: ConnectionListViewModel

    let onOpenConnection: (Connection) -> Void
    let onEditConnection: (String?) -> Void
    let onOpenBinding: () -> Void

    @State private var pendingDelete: Connection?

    public init(
        viewModel: ConnectionListViewModel,
        onOpenConnection: @escaping (Connection) -> Void,
        onEditConnection: @escaping (String?) -> Void,
        onOpenBinding: @escaping () -> Void
    ) {
        self.viewModel = viewModel
        self.onOpenConnection = onOpenConnection
        self.onEditConnection = onEditConnection
        self.onOpenBinding = onOpenBinding
    }

    public var body: some View {
        content
            .navigationTitle("Zephyr One")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { onEditConnection(nil) }) {
                        Image(systemName: "plus")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { Task { await viewModel.syncNow() } }) {
                        Image(systemName: "arrow.triangle.2.circlepath")
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
                item: $pendingDelete,
                titleVisibility: .visible
            ) { connection in
                Button("删除", role: .destructive) {
                    Task { await viewModel.delete(connection) }
                }
                Button("取消", role: .cancel) {}
            }
            .zephyrInteractivePopGesture()
    }

    @ViewBuilder private var content: some View {
        switch viewModel.state {
        case .initialLoading:
            ProgressView()
        case let .content(connections, pendingSync, conflict, _):
            listView(connections, pendingSync: pendingSync, conflict: conflict, offlineSince: nil)
        case let .offlineWithCache(connections, lastSyncedAt):
            listView(connections, pendingSync: false, conflict: false, offlineSince: lastSyncedAt)
        case let .empty(reason):
            emptyView(reason)
        case .offlineNoCache:
            // The owned list never lands here; the state exists for shared
            // resources. Rendered anyway so a regression shows a face instead
            // of a blank page.
            VStack {
                Text("离线，且无本地缓存")
                Button("重试") { Task { await viewModel.syncNow() } }
            }
        case let .permissionDenied(_, reason):
            Text(reason ?? "没有权限")
        case .notFoundOrRevoked:
            Text("资源不存在或已被撤销")
        case let .retryableError(error):
            errorView(error, retryable: true)
        case let .fatalIncompatible(error):
            errorView(error, retryable: false)
        }
    }

    private func listView(
        _ connections: [Connection],
        pendingSync: Bool,
        conflict: Bool,
        offlineSince: Int64?
    ) -> some View {
        List {
            if let offlineSince {
                Text("离线，显示 \(offlineSince) 的本地镜像")
                    .font(.footnote)
            }
            if pendingSync {
                Text("有修改待同步")
                    .font(.footnote)
            }
            if conflict {
                Text("存在同步冲突")
                    .font(.footnote)
            }
            Section(header: filterHeader) {
                ForEach(connections, id: \.id) { connection in
                    connectionRow(connection)
                }
            }
        }
    }

    private var filterHeader: some View {
        VStack(alignment: .leading) {
            TextField(
                "搜索",
                text: Binding(
                    get: { viewModel.filter.query },
                    set: { viewModel.setQuery($0) }
                )
            )
            HStack {
                ForEach(ConnectionProtocol.allCases, id: \.self) { value in
                    Toggle(
                        value.wireName,
                        isOn: Binding(
                            get: { viewModel.filter.protocols.contains(value) },
                            set: { _ in viewModel.toggleProtocol(value) }
                        )
                    )
                }
            }
            Picker(
                "归属",
                selection: Binding(
                    get: { viewModel.filter.ownership },
                    set: { viewModel.setOwnership($0) }
                )
            ) {
                Text("全部").tag(OwnershipFacet.all)
                Text("自有").tag(OwnershipFacet.owned)
                Text("共享给我").tag(OwnershipFacet.shared)
            }
            Toggle(
                "仅收藏",
                isOn: Binding(
                    get: { viewModel.filter.favouritesOnly },
                    set: { viewModel.setFavouritesOnly($0) }
                )
            )
        }
    }

    private func connectionRow(_ connection: Connection) -> some View {
        VStack(alignment: .leading) {
            HStack {
                Text(connection.name)
                Spacer()
                Text(connection.`protocol`.wireName)
                    .font(.footnote)
            }
            if connection.residency == .sharedOnlineOnly {
                Text("来自 \(connection.sharedOwnerLabel ?? "?") · 在线使用 · 不保存到此设备")
                    .font(.footnote)
                if let disclosure = ConnectionActions.sharedUseDisclosure(connection) {
                    Text(disclosure)
                        .font(.footnote)
                }
            } else {
                Text(connection.displayAddress)
                    .font(.footnote)
            }
        }
        .onTapGesture {
            if ConnectionActions.gate(connection, action: .use).isAllowed {
                onOpenConnection(connection)
            }
        }
        .contextMenu {
            ForEach(ConnectionActions.visibleActions(connection), id: \.self) { action in
                actionButton(action, for: connection)
            }
        }
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
            Button("复制") {}
                .disabled(!gate.isAllowed)
        case .delete:
            Button("删除", role: .destructive) { pendingDelete = connection }
        case .test:
            Button("测试") {}
        case .share:
            Button("共享") {}
                .disabled(!gate.isAllowed)
        }
    }

    @ViewBuilder
    private func emptyView(_ reason: EmptyReason) -> some View {
        switch reason {
        case .noData:
            VStack {
                Text("还没有连接")
                Button("新建连接") { onEditConnection(nil) }
            }
        case .noMatchingFilter:
            VStack {
                Text("没有匹配的连接")
                Button("清除筛选") { viewModel.clearFilters() }
            }
        case .notYetSynced:
            VStack {
                Text("尚未绑定主端")
                Button("绑定主端") { onOpenBinding() }
            }
        }
    }

    private func errorView(_ error: MobileError, retryable: Bool) -> some View {
        VStack {
            Text(error.message)
            Text(error.diagnosticText())
                .font(.footnote)
            if retryable {
                Button("重试") { Task { await viewModel.syncNow() } }
            }
        }
    }
}
#endif
