import XCTest
@testable import ZephyrUI

/// The S10 filter matrix, mirrored from the Kotlin ConnectionFiltersTest.
final class ConnectionFilterTests: XCTestCase {

    func testQueryMatchesNameHostRemarkTagsAndDisplayAddress() {
        let connection = UiTestData.connection(
            name: "prod-web",
            host: "10.0.0.1",
            remark: "主站",
            tags: ["prod", "web"]
        )
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "prod"))
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "10.0"))
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "主站"))
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "web"))
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "10.0.0.1:22"))
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "  PROD  "))
    }

    func testQueryDoesNotMatchUsername() {
        let connection = UiTestData.connection(username: "deploy")
        XCTAssertFalse(ConnectionFilters.matchesQuery(connection, rawQuery: "deploy"))
    }

    func testBlankQueryMatchesEverything() {
        let connection = UiTestData.connection()
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: ""))
        XCTAssertTrue(ConnectionFilters.matchesQuery(connection, rawQuery: "   "))
    }

    func testProtocolFacetNarrows() {
        let filter = ConnectionFilter(protocols: [.ssh])
        XCTAssertTrue(ConnectionFilters.matches(UiTestData.connection(), filter: filter, favouriteIds: []))
        XCTAssertFalse(
            ConnectionFilters.matches(
                UiTestData.connection(protocol: .rdp),
                filter: filter,
                favouriteIds: []
            )
        )
    }

    func testTagFacetIsOrWithinTheFacet() {
        let filter = ConnectionFilter(tags: ["a", "b"])
        XCTAssertTrue(
            ConnectionFilters.matches(
                UiTestData.connection(tags: ["b"]),
                filter: filter,
                favouriteIds: []
            )
        )
        XCTAssertFalse(
            ConnectionFilters.matches(
                UiTestData.connection(tags: ["c"]),
                filter: filter,
                favouriteIds: []
            )
        )
    }

    func testOwnershipFacet() {
        let owned = ConnectionFilter(ownership: .owned)
        let sharedOnly = ConnectionFilter(ownership: .shared)
        XCTAssertTrue(ConnectionFilters.matches(UiTestData.connection(), filter: owned, favouriteIds: []))
        XCTAssertFalse(ConnectionFilters.matches(UiTestData.shared(), filter: owned, favouriteIds: []))
        XCTAssertTrue(ConnectionFilters.matches(UiTestData.shared(), filter: sharedOnly, favouriteIds: []))
    }

    func testFavouritesOnlyKeepsFavourites() {
        let filter = ConnectionFilter(favouritesOnly: true)
        XCTAssertFalse(
            ConnectionFilters.matches(UiTestData.connection(id: "c-1"), filter: filter, favouriteIds: ["c-2"])
        )
        XCTAssertTrue(
            ConnectionFilters.matches(UiTestData.connection(id: "c-1"), filter: filter, favouriteIds: ["c-1"])
        )
    }

    func testApplyDropsDeletedRows() {
        let rows = [
            UiTestData.connection(id: "c-1"),
            UiTestData.connection(id: "c-2", deletedAt: 100),
        ]
        let visible = ConnectionFilters.apply(rows, filter: ConnectionFilter())
        XCTAssertEqual(visible.map { $0.id }, ["c-1"])
    }

    func testOrderingIsFavouritesThenCaseInsensitiveNameThenId() {
        let rows = [
            UiTestData.connection(id: "c-3", name: "zebra"),
            UiTestData.connection(id: "c-2", name: "Alpha"),
            UiTestData.connection(id: "c-1", name: "apple"),
        ]
        let ordered = ConnectionFilters.apply(rows, filter: ConnectionFilter(), favouriteIds: ["c-3"])
        XCTAssertEqual(ordered.map { $0.id }, ["c-3", "c-2", "c-1"])
    }

    func testRecentsExcludeNeverConnectedAndDeleted() {
        let rows = [
            UiTestData.connection(id: "c-1", lastConnectedAt: 100),
            UiTestData.connection(id: "c-2"),
            UiTestData.connection(id: "c-3", lastConnectedAt: 300),
            UiTestData.connection(id: "c-4", lastConnectedAt: 200, deletedAt: 1),
        ]
        XCTAssertEqual(
            ConnectionFilters.recents(rows).map { $0.id },
            ["c-3", "c-1"]
        )
    }

    func testRecentsHonourTheLimit() {
        let rows = (0..<20).map { index in
            UiTestData.connection(id: "c-\(index)", lastConnectedAt: Int64(index))
        }
        XCTAssertEqual(ConnectionFilters.recents(rows).count, ConnectionFilters.maxRecents)
    }

    func testAvailableTagsAreDistinctAndSortedCaseInsensitively() {
        let rows = [
            UiTestData.connection(id: "c-1", tags: ["prod", "Alpha"]),
            UiTestData.connection(id: "c-2", tags: ["prod", "beta"]),
            UiTestData.connection(id: "c-3", tags: ["gone"], deletedAt: 5),
        ]
        XCTAssertEqual(ConnectionFilters.availableTags(rows), ["Alpha", "beta", "prod"])
    }

    func testClearedKeepsTheQuery() {
        let filter = ConnectionFilter(
            query: "web",
            protocols: [.ssh],
            tags: ["a"],
            ownership: .owned,
            favouritesOnly: true
        )
        XCTAssertEqual(filter.cleared(), ConnectionFilter(query: "web"))
    }

    func testToggleSemantics() {
        let empty = ConnectionFilter()
        XCTAssertEqual(empty.withProtocolToggled(.ssh).protocols, [.ssh])
        XCTAssertEqual(empty.withProtocolToggled(.ssh).withProtocolToggled(.ssh).protocols, [])
        XCTAssertEqual(empty.withTagToggled("a").tags, ["a"])
        XCTAssertEqual(empty.withTagToggled("a").withTagToggled("a").tags, [])
    }

    func testIsActive() {
        XCTAssertFalse(ConnectionFilter().isActive)
        XCTAssertFalse(ConnectionFilter(query: "  ").isActive)
        XCTAssertTrue(ConnectionFilter(query: "w").isActive)
        XCTAssertTrue(ConnectionFilter(protocols: [.ssh]).isActive)
        XCTAssertTrue(ConnectionFilter(ownership: .owned).isActive)
        XCTAssertTrue(ConnectionFilter(favouritesOnly: true).isActive)
    }

    func testFavouritesRoundTrip() {
        let ids: Set<String> = ["c-2", "c-1"]
        XCTAssertEqual(FavouriteConnections.decode(FavouriteConnections.encode(ids)), ids)
    }

    func testFavouritesDecodeIsTolerant() {
        XCTAssertEqual(FavouriteConnections.decode(nil), [])
        XCTAssertEqual(FavouriteConnections.decode("not json"), [])
        XCTAssertEqual(FavouriteConnections.decode("{}"), [])
        XCTAssertEqual(FavouriteConnections.decode("{\"ids\":[\"a\", \"\", \"  \", 3]}"), ["a"])
    }

    func testFavouritesToggle() {
        XCTAssertEqual(FavouriteConnections.toggled([], connectionId: "c-1"), ["c-1"])
        XCTAssertEqual(FavouriteConnections.toggled(["c-1"], connectionId: "c-1"), [])
    }
}
