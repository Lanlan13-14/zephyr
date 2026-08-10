import XCTest
@testable import ZephyrUI

private final class FakePreferenceStore: PreferenceStore {
    var values: [String: String] = [:]

    func preference(_ key: String) -> String? {
        values[key]
    }

    func putPreference(_ key: String, _ value: String) {
        values[key] = value
    }
}

private final class FakeListConnectionStore: ConnectionStore {
    var deleteError: Error?
    private(set) var deletedIds: [String] = []

    func find(_ connectionId: String) -> Connection? {
        nil
    }

    func save(
        connection: Connection,
        mask: [String],
        secrets: [String: SecretState],
        ownerUserId: String,
        createdLocally: Bool
    ) async throws {}

    func delete(_ connection: Connection, ownerUserId: String) async throws {
        if let deleteError { throw deleteError }
        deletedIds.append(connection.id)
    }

    func setFileSyncIntent(
        _ connectionId: String,
        _ intent: FileSyncDirectoryIntent,
        _ nowMs: Int64
    ) async throws {}
}

/// The S10 view model: snapshot inputs in, derived page state out.
final class ConnectionListViewModelTests: XCTestCase {

    private func makeViewModel(
        preferences: FakePreferenceStore? = nil,
        connections: FakeListConnectionStore? = nil
    ) -> ConnectionListViewModel {
        ConnectionListViewModel(
            ownerUserId: UiTestData.owner,
            connections: connections,
            preferences: preferences
        )
    }

    func testColdStartIsInitialLoading() {
        let viewModel = makeViewModel()
        guard case .initialLoading = viewModel.state else {
            return XCTFail("expected initialLoading, got \(viewModel.state)")
        }
    }

    func testRowsArriveAsContent() {
        let viewModel = makeViewModel()
        viewModel.updateOwnedRows([UiTestData.connection()])
        guard case let .content(rows, _, _, _) = viewModel.state else {
            return XCTFail("expected content, got \(viewModel.state)")
        }
        XCTAssertEqual(1, rows.count)
    }

    func testOwnedPlusSharedMerge() {
        let viewModel = makeViewModel()
        viewModel.updateOwnedRows([UiTestData.connection(id: "c-1")])
        viewModel.updateSharedRows([
            SharedResourceSummary(
                resourceType: "connection",
                resourceId: "s-1",
                displayName: "shared-db",
                ownerLabel: "alice",
                capabilities: .implicitShare,
                usePolicy: .relayOnly,
                protocol: "SSH"
            )
        ])
        guard case let .content(rows, _, _, _) = viewModel.state else {
            return XCTFail("expected content, got \(viewModel.state)")
        }
        XCTAssertEqual(Set(rows.map { $0.id }), ["c-1", "s-1"])
    }

    func testOfflineShowsTheMirror() {
        let viewModel = makeViewModel()
        viewModel.updateOwnedRows([UiTestData.connection()])
        viewModel.updateBinding(bound: true, lastSyncedAt: 42)
        viewModel.updateConnectivity(online: false)
        guard case let .offlineWithCache(_, lastSyncedAt) = viewModel.state else {
            return XCTFail("expected offlineWithCache, got \(viewModel.state)")
        }
        XCTAssertEqual(42, lastSyncedAt)
    }

    func testFilterIntentsRecompute() {
        let viewModel = makeViewModel()
        viewModel.updateOwnedRows([
            UiTestData.connection(id: "c-1"),
            UiTestData.connection(id: "c-2", protocol: .rdp),
        ])
        viewModel.toggleProtocol(.ssh)
        guard case let .content(rows, _, _, _) = viewModel.state else {
            return XCTFail("expected content, got \(viewModel.state)")
        }
        XCTAssertEqual(["c-1"], rows.map { $0.id })
        viewModel.clearFilters()
        guard case let .content(allRows, _, _, _) = viewModel.state else {
            return XCTFail("expected content, got \(viewModel.state)")
        }
        XCTAssertEqual(2, allRows.count)
    }

    func testToggleFavouritePersists() {
        let preferences = FakePreferenceStore()
        let viewModel = makeViewModel(preferences: preferences)
        viewModel.updateOwnedRows([UiTestData.connection(id: "c-1")])
        viewModel.toggleFavourite("c-1")
        XCTAssertEqual(["c-1"], viewModel.favouriteIds)
        XCTAssertEqual(
            ["c-1"],
            FavouriteConnections.decode(preferences.preference(FavouriteConnections.preferenceKey))
        )
    }

    func testDeleteSuccessMessageIsLocalFirst() async {
        let store = FakeListConnectionStore()
        let viewModel = makeViewModel(connections: store)
        await viewModel.delete(UiTestData.connection())
        XCTAssertEqual(["c-1"], store.deletedIds)
        XCTAssertEqual(ConnectionListViewModel.msgDeleted, viewModel.message)
    }

    func testDeleteRejectionMessage() async {
        let store = FakeListConnectionStore()
        store.deleteError = LocalWriteRejected(reason: "capability_denied")
        let viewModel = makeViewModel(connections: store)
        await viewModel.delete(UiTestData.connection())
        XCTAssertEqual(ConnectionListViewModel.msgDeleteDenied, viewModel.message)
    }

    func testDeleteFailureMessage() async {
        let store = FakeListConnectionStore()
        store.deleteError = MobileError.offline
        let viewModel = makeViewModel(connections: store)
        await viewModel.delete(UiTestData.connection())
        XCTAssertEqual(ConnectionListViewModel.msgDeleteFailed, viewModel.message)
    }

    func testRecentsAndTagsTrackTheRows() {
        let viewModel = makeViewModel()
        viewModel.updateOwnedRows([
            UiTestData.connection(id: "c-1", tags: ["prod"], lastConnectedAt: 10),
            UiTestData.connection(id: "c-2", tags: ["dev"]),
        ])
        XCTAssertEqual(["c-1"], viewModel.recents.map { $0.id })
        XCTAssertEqual(["dev", "prod"], viewModel.availableTags)
    }
}
