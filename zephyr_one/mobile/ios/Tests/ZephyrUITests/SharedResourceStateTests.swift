import XCTest
@testable import ZephyrUI

/// The shared-to-me residency rules: offline is terminal, a revoked grant is
/// terminal, and search never leaves the device.
final class SharedResourceStateTests: XCTestCase {

    private func summary(
        id: String = "s-1",
        name: String = "shared-db",
        owner: String = "alice",
        capabilities: CapabilitySet = .implicitShare,
        usePolicy: SharedUsePolicy = .relayOnly,
        grantExpiresAt: Int64? = nil
    ) -> SharedResourceSummary {
        SharedResourceSummary(
            resourceType: "connection",
            resourceId: id,
            displayName: name,
            ownerLabel: owner,
            capabilities: capabilities,
            usePolicy: usePolicy,
            grantExpiresAt: grantExpiresAt,
            protocol: "SSH"
        )
    }

    func testOfflineIsNoCache() {
        let state = SharedResourceListStates.derive(resources: [summary()], online: false)
        guard case .offlineNoCache = state else {
            return XCTFail("expected offlineNoCache, got \(state)")
        }
        XCTAssertTrue(state.isTerminal)
    }

    func testOfflineBeatsTheErrorBranch() {
        // A failed fetch while offline is not a server error.
        let state = SharedResourceListStates.derive(
            resources: [],
            online: false,
            error: MobileError.local(code: "internal_error", message: "boom", retryable: true)
        )
        guard case .offlineNoCache = state else {
            return XCTFail("expected offlineNoCache, got \(state)")
        }
    }

    func testRevokedGrantIsTerminal() {
        let revoked = MobileError.local(code: "shared_grant_revoked", message: "gone")
        let state = SharedResourceListStates.derive(resources: [], error: revoked)
        guard case .notFoundOrRevoked = state else {
            return XCTFail("expected notFoundOrRevoked, got \(state)")
        }
    }

    func testRetryableErrorOffersRetry() {
        let error = MobileError.local(code: "rate_limited", message: "slow down", retryable: true)
        let state = SharedResourceListStates.derive(resources: [], error: error)
        XCTAssertEqual(state, .retryableError(error))
    }

    func testNonRetryableErrorIsFatal() {
        let error = MobileError.local(code: "protocol_incompatible", message: "upgrade")
        let state = SharedResourceListStates.derive(resources: [], error: error)
        XCTAssertEqual(state, .fatalIncompatible(error))
    }

    func testNotLoadedIsInitialLoading() {
        let state = SharedResourceListStates.derive(resources: [], loaded: false)
        guard case .initialLoading = state else {
            return XCTFail("expected initialLoading, got \(state)")
        }
    }

    func testContentHasNoSyncFlags() {
        let state = SharedResourceListStates.derive(resources: [summary()])
        guard case let .content(rows, pendingSync, conflict, savingLocal) = state else {
            return XCTFail("expected content, got \(state)")
        }
        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(pendingSync)
        XCTAssertFalse(conflict)
        XCTAssertFalse(savingLocal)
    }

    func testEmptyReasonsDistinguishSearchFromNoShares() {
        XCTAssertEqual(
            SharedResourceListStates.derive(resources: [summary()], query: "nothing-matches"),
            .empty(.noMatchingFilter)
        )
        XCTAssertEqual(
            SharedResourceListStates.derive(resources: []),
            .empty(.noData)
        )
    }

    func testFilterMatchesNameAndOwnerCaseInsensitively() {
        let rows = [summary(id: "s-1", name: "db", owner: "alice"), summary(id: "s-2", name: "web", owner: "bob")]
        XCTAssertEqual(SharedResourceListStates.filter(rows, query: "ALICE").map { $0.resourceId }, ["s-1"])
        XCTAssertEqual(SharedResourceListStates.filter(rows, query: "web").map { $0.resourceId }, ["s-2"])
        XCTAssertEqual(SharedResourceListStates.filter(rows, query: "  ").count, 2)
    }

    func testGrantWindow() {
        XCTAssertTrue(SharedResourceActions.isWithinGrantWindow(summary(grantExpiresAt: nil), nowMs: 100))
        XCTAssertTrue(SharedResourceActions.isWithinGrantWindow(summary(grantExpiresAt: 200), nowMs: 100))
        XCTAssertFalse(SharedResourceActions.isWithinGrantWindow(summary(grantExpiresAt: 100), nowMs: 100))
    }

    func testSharedProjectionNeverCarriesAnEndpoint() {
        let row = SharedConnectionRows.toDisplayRow(summary(), ownerUserId: UiTestData.owner)
        XCTAssertEqual("", row.host)
        XCTAssertEqual(Residency.sharedOnlineOnly, row.residency)
        XCTAssertEqual("alice", row.sharedOwnerLabel)
        XCTAssertEqual(ConnectionProtocol.ssh, row.`protocol`)
    }
}
