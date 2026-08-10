import XCTest
@testable import ZephyrUI

/// In-memory ConnectionStore fake recording every write.
private final class FakeConnectionStore: ConnectionStore {
    var rows: [String: Connection] = [:]
    var savedMasks: [[String]] = []
    var savedSecrets: [[String: SecretState]] = []
    var savedCreatedLocally: [Bool] = []
    var intentWrites: [(String, FileSyncDirectoryIntent)] = []
    var deleted: [String] = []
    var rejection: LocalWriteRejected?

    func find(_ connectionId: String) -> Connection? {
        rows[connectionId]
    }

    func save(
        connection: Connection,
        mask: [String],
        secrets: [String: SecretState],
        ownerUserId: String,
        createdLocally: Bool
    ) async throws {
        if let rejection { throw rejection }
        savedMasks.append(mask)
        savedSecrets.append(secrets)
        savedCreatedLocally.append(createdLocally)
        rows[connection.id] = connection
    }

    func delete(_ connection: Connection, ownerUserId: String) async throws {
        deleted.append(connection.id)
    }

    func setFileSyncIntent(
        _ connectionId: String,
        _ intent: FileSyncDirectoryIntent,
        _ nowMs: Int64
    ) async throws {
        intentWrites.append((connectionId, intent))
    }
}

/// The S11 view model: load branches, save gating and the mask-skip rule.
final class ConnectionEditorViewModelTests: XCTestCase {

    private func makeViewModel(
        store: FakeConnectionStore,
        connectionId: String? = nil
    ) -> ConnectionEditorViewModel {
        ConnectionEditorViewModel(
            connections: store,
            ownerUserId: UiTestData.owner,
            connectionId: connectionId,
            newId: { "c-new" }
        )
    }

    private func content(of viewModel: ConnectionEditorViewModel) -> ConnectionEditorUiState? {
        guard case let .content(ui, _, _, _) = viewModel.page else { return nil }
        return ui
    }

    func testCreateLoad() {
        let viewModel = makeViewModel(store: FakeConnectionStore())
        viewModel.load()
        let ui = content(of: viewModel)
        XCTAssertNotNil(ui)
        XCTAssertEqual(true, ui?.draft.isCreate)
        XCTAssertEqual("c-new", ui?.draft.current.id)
    }

    func testMissingRowIsNotFound() {
        let viewModel = makeViewModel(store: FakeConnectionStore(), connectionId: "c-404")
        viewModel.load()
        guard case .notFoundOrRevoked = viewModel.page else {
            return XCTFail("expected notFoundOrRevoked")
        }
    }

    func testDeletedRowIsNotFound() {
        let store = FakeConnectionStore()
        store.rows["c-1"] = UiTestData.connection(deletedAt: 1)
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        guard case .notFoundOrRevoked = viewModel.page else {
            return XCTFail("expected notFoundOrRevoked")
        }
    }

    func testReadOnlyRowIsPermissionDenied() {
        let store = FakeConnectionStore()
        store.rows["c-1"] = UiTestData.connection(capabilities: CapabilitySet([.view, .use]))
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        guard case let .permissionDenied(missing, reason) = viewModel.page else {
            return XCTFail("expected permissionDenied")
        }
        XCTAssertEqual(.edit, missing)
        XCTAssertEqual(ConnectionEditorViewModel.reasonNoEdit, reason)
    }

    func testSaveSkipsTheGatewayWhenOnlyTheIntentChanged() async {
        let store = FakeConnectionStore()
        store.rows["c-1"] = UiTestData.connection()
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        viewModel.setFileSyncIntent(.localShare)
        await viewModel.save()
        // The device-local intent has its own write; the sync gateway is never
        // called with an empty mask.
        XCTAssertTrue(store.savedMasks.isEmpty)
        XCTAssertEqual(store.intentWrites.count, 1)
        XCTAssertEqual(ConnectionEditorViewModel.msgSaved, viewModel.message)
        XCTAssertEqual(.dismissed, viewModel.event)
        // The saved row is the new baseline: the form is clean again.
        XCTAssertEqual(false, content(of: viewModel)?.draft.isDirty)
    }

    func testSavePushesTheMaskAndSecrets() async {
        let store = FakeConnectionStore()
        store.rows["c-1"] = UiTestData.connection()
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        viewModel.setName("renamed")
        viewModel.setPassword(.replace("hunter2"))
        await viewModel.save()
        XCTAssertEqual([["name"]], store.savedMasks)
        XCTAssertEqual(.replace("hunter2"), store.savedSecrets.first?["password"])
        XCTAssertEqual([false], store.savedCreatedLocally)
        XCTAssertEqual(ConnectionEditorViewModel.msgSaved, viewModel.message)
    }

    func testSaveValidationFailureNeverWrites() async {
        let store = FakeConnectionStore()
        let viewModel = makeViewModel(store: store)
        viewModel.load()
        // A create with no name and no host cannot save.
        await viewModel.save()
        XCTAssertTrue(store.savedMasks.isEmpty)
        XCTAssertFalse(content(of: viewModel)?.issues.isEmpty ?? true)
        XCTAssertNil(viewModel.event)
    }

    func testRejectedWriteMapsToTheRightMessage() async {
        let store = FakeConnectionStore()
        store.rows["c-1"] = UiTestData.connection()
        store.rejection = LocalWriteRejected(reason: "capability_denied")
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        viewModel.setName("renamed")
        await viewModel.save()
        XCTAssertEqual(ConnectionEditorViewModel.reasonNoEdit, viewModel.message)
        XCTAssertNil(viewModel.event)
        XCTAssertEqual(false, content(of: viewModel)?.saving)
    }

    func testConnectWithoutSavingIsEphemeral() {
        let store = FakeConnectionStore()
        let viewModel = makeViewModel(store: store)
        viewModel.load()
        viewModel.setName("quick")
        viewModel.setHost("example.org")
        viewModel.setUsername("root")
        viewModel.connectWithoutSaving()
        guard case let .connect(connection, persisted) = viewModel.event else {
            return XCTFail("expected connect event")
        }
        XCTAssertFalse(persisted)
        XCTAssertTrue(connection.ephemeral)
        XCTAssertTrue(store.savedMasks.isEmpty)
    }

    func testSaveAndConnectEmitsPersistedConnect() async {
        let store = FakeConnectionStore()
        store.rows["c-1"] = UiTestData.connection()
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        viewModel.setRemark("x")
        await viewModel.save(thenConnect: true)
        guard case let .connect(_, persisted) = viewModel.event else {
            return XCTFail("expected connect event")
        }
        XCTAssertTrue(persisted)
    }

    func testInventoryRevocationSurfacesRouteRepair() {
        let store = FakeConnectionStore()
        var stored = UiTestData.connection()
        stored.proxyId = "p-1"
        store.rows["c-1"] = stored
        let viewModel = makeViewModel(store: store, connectionId: "c-1")
        viewModel.load()
        viewModel.applyInventory(
            proxies: [Proxy(id: "p-1", name: "proxy", capabilities: CapabilitySet([.view]))],
            sshKeys: [],
            jumpHosts: []
        )
        let ui = content(of: viewModel)
        XCTAssertEqual(
            [DraftIssue(field: "proxyId", message: ConnectionDraft.msgRouteRepair)],
            ui?.routeIssues
        )
        viewModel.repairRoute("proxyId")
        XCTAssertNil(content(of: viewModel)?.draft.current.proxyId)
        XCTAssertEqual(true, content(of: viewModel)?.routeIssues.isEmpty)
    }

    func testNonNumericPortInputIsIgnored() {
        let store = FakeConnectionStore()
        let viewModel = makeViewModel(store: store)
        viewModel.load()
        viewModel.setPort("abc")
        XCTAssertEqual(22, content(of: viewModel)?.draft.current.port)
        XCTAssertEqual(false, content(of: viewModel)?.draft.portWasEdited)
        viewModel.setPort("2222")
        XCTAssertEqual(2222, content(of: viewModel)?.draft.current.port)
        XCTAssertEqual(true, content(of: viewModel)?.draft.portWasEdited)
    }
}
