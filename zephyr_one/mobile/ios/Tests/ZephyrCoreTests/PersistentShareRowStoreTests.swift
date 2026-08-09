import Foundation
import XCTest
@testable import ZephyrCore

/// Persistence for the iOS share rows and the per-connection choice.
///
/// These are the rules the picker wiring will depend on, and every one of them fails
/// silently rather than loudly. A row that does not survive a relaunch leaves the app
/// holding a security-scoped bookmark with no row describing it -- access the user
/// granted that the UI can no longer show or revoke. A choice naming a dead profile
/// makes a session report "no directory is authorised" while the editor still shows
/// a directory as selected.
///
/// Deliberately parallel to `PersistentShareStoreTest.kt`: the two platforms lost the
/// same guarantee for different reasons, and asserting it on both is what keeps them
/// from drifting into two different products.
final class PersistentShareRowStoreTests: XCTestCase {

    private var backing = FakeKeyValueStore()
    private let bookmark = "file:///granted/Documents/"

    override func setUp() {
        super.setUp()
        backing = FakeKeyValueStore()
    }

    private func grants(
        _ store: FakeKeyValueStore,
        _ bookmarks: FakeBookmarkStore
    ) -> SecurityScopedGrants {
        SecurityScopedGrants(bookmarks: bookmarks, rows: PersistentShareRowStore(store: store))
    }

    func testAnAuthorisedDirectorySurvivesARelaunch() {
        let bookmarks = FakeBookmarkStore()
        grants(backing, bookmarks).authorize(
            profileId: "p1",
            shareName: "DOCUMENTS",
            bookmarkId: bookmark,
            requestWrite: true
        )

        /* The whole point of the store. Without it the row lives only in memory and the
         * app forgets the directory on the next launch while still holding the
         * bookmark. */
        let recovered = grants(backing.surviveRestart(), bookmarks).grant(profileId: "p1")
        XCTAssertEqual(recovered?.shareName, "DOCUMENTS")
        XCTAssertEqual(recovered?.bookmarkId, bookmark)
        XCTAssertEqual(recovered?.readOnly, false)
        XCTAssertEqual(recovered?.grantValid, true)
    }

    func testAReadOnlyShareIsStillReadOnlyAfterARelaunch() {
        let bookmarks = FakeBookmarkStore()
        bookmarks.readOnly.insert(bookmark)
        grants(backing, bookmarks).authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: true
        )

        /* A share that came back writable would offer a write the platform refuses,
         * which is the corrupted half-copy DEVELOPMENT.md 13.4 calls out. */
        XCTAssertEqual(grants(backing.surviveRestart(), bookmarks).grant(profileId: "p1")?.readOnly, true)
    }

    func testValidityIsNeverPersistedAsFalse() {
        let bookmarks = FakeBookmarkStore()
        grants(backing, bookmarks).authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: true
        )
        bookmarks.goStale(bookmark)

        /* Read once while the bookmark is stale, so a naive implementation writes false
         * back. */
        XCTAssertEqual(grants(backing, bookmarks).grant(profileId: "p1")?.grantValid, false)

        /* The user re-creates the bookmark. Validity is re-derived on every read, so a
         * persisted false would have outlived its cause and left the share broken. */
        bookmarks.refresh(bookmark)
        XCTAssertEqual(
            grants(backing.surviveRestart(), bookmarks).grant(profileId: "p1")?.grantValid,
            true
        )
    }

    func testRevokingRemovesTheRowFromStorageToo() {
        let bookmarks = FakeBookmarkStore()
        let live = grants(backing, bookmarks)
        live.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        live.revoke(profileId: "p1")

        XCTAssertNil(grants(backing.surviveRestart(), bookmarks).grant(profileId: "p1"))
        /* And the index no longer names it, or a load would read a row with no bookmark
         * behind it. */
        XCTAssertTrue(backing.stringArray("share.profileIds").isEmpty)
    }

    func testRevokingOneOfTwoSharesOverOneBookmarkKeepsIt() {
        /* Multiple profiles over one directory is legal (DEVELOPMENT.md 13.2), and the
         * bookmark must outlive the first removal. The regression this guards against is
         * subtler: counting remaining users from a pre-removal snapshot would find the
         * row being removed and keep every bookmark alive forever. */
        let bookmarks = FakeBookmarkStore()
        let live = grants(backing, bookmarks)
        live.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        live.authorize(profileId: "p2", shareName: "DOCUMENTS", bookmarkId: bookmark, requestWrite: false)

        live.revoke(profileId: "p1")
        XCTAssertEqual(bookmarks.discarded, [])
        XCTAssertEqual(live.grant(profileId: "p2")?.grantValid, true)

        live.revoke(profileId: "p2")
        XCTAssertEqual(bookmarks.discarded, [bookmark])
    }

    func testARowWhoseBookmarkIdWasLostIsDropped() {
        let bookmarks = FakeBookmarkStore()
        grants(backing, bookmarks).authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: true
        )

        /* Simulates external truncation. A row naming no bookmark cannot address
         * anything, and inventing one would point the share at a directory the user
         * never picked. */
        backing.drop("share.p1.bookmark")
        XCTAssertNil(grants(backing.surviveRestart(), bookmarks).grant(profileId: "p1"))
    }

    func testARowMissingItsWriteFlagIsAssumedReadOnly() {
        let bookmarks = FakeBookmarkStore()
        grants(backing, bookmarks).authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: true
        )
        backing.drop("share.p1.readOnly")

        /* The strictest reading is the safe one: assuming writable would offer a write
         * on a row whose recorded authority is unknown. */
        XCTAssertEqual(grants(backing.surviveRestart(), bookmarks).grant(profileId: "p1")?.readOnly, true)
    }

    func testARowIsWrittenAsOneBatch() {
        let bookmarks = FakeBookmarkStore()
        grants(backing, bookmarks).authorize(
            profileId: "p1",
            shareName: "DOCUMENTS",
            bookmarkId: bookmark,
            requestWrite: true
        )

        /* Three keys plus the index in one batch. Written key by key, a termination in
         * the middle would leave an id in the index with no bookmark behind it. */
        XCTAssertEqual(backing.batches, 1)
    }

    func testPruningDropsInvalidRowsFromStorage() {
        let bookmarks = FakeBookmarkStore()
        let second = bookmark + "Other/"
        let live = grants(backing, bookmarks)
        live.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        live.authorize(profileId: "p2", shareName: "OTHER", bookmarkId: second, requestWrite: true)

        bookmarks.goStale(bookmark)
        XCTAssertEqual(live.pruneInvalid(), ["p1"])

        /* Pruned from storage, not just from memory: a row that came back on the next
         * launch would advertise a share the provider cannot open. */
        let restarted = grants(backing.surviveRestart(), bookmarks)
        XCTAssertNil(restarted.grant(profileId: "p1"))
        XCTAssertEqual(restarted.grant(profileId: "p2")?.grantValid, true)
    }

    func testTheDefaultStoreIsStillInMemory() {
        /* The existing lifecycle suites construct SecurityScopedGrants without a row
         * store, so the default has to keep working -- and it must NOT persist, or those
         * tests would leak state into each other. */
        let bookmarks = FakeBookmarkStore()
        let ephemeral = SecurityScopedGrants(bookmarks: bookmarks)
        ephemeral.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        XCTAssertEqual(ephemeral.grant(profileId: "p1")?.shareName, "PHONE")
        XCTAssertTrue(backing.keys().isEmpty, "the default store must not touch persistence")
    }
}

/// The per-connection directory choice on iOS.
final class ConnectionShareChoicesTests: XCTestCase {

    private var store = FakeKeyValueStore()
    private var choices = ConnectionShareChoices(store: FakeKeyValueStore())

    override func setUp() {
        super.setUp()
        store = FakeKeyValueStore()
        choices = ConnectionShareChoices(store: store)
    }

    func testAChoiceIsRememberedAndForgettable() {
        XCTAssertNil(choices.profile(for: "c1"))
        choices.choose(connectionId: "c1", profileId: "p1")
        XCTAssertEqual(choices.profile(for: "c1"), "p1")
        choices.forget(connectionId: "c1")
        XCTAssertNil(choices.profile(for: "c1"))
    }

    func testAChoiceSurvivesARestart() {
        choices.choose(connectionId: "c1", profileId: "p1")
        XCTAssertEqual(
            ConnectionShareChoices(store: store.surviveRestart()).profile(for: "c1"),
            "p1"
        )
    }

    func testPruningDropsChoicesNamingAProfileThatIsGone() {
        choices.choose(connectionId: "c1", profileId: "p1")
        choices.choose(connectionId: "c2", profileId: "p2")

        XCTAssertEqual(choices.pruneMissing(knownProfileIds: ["p2"]), ["c1"])
        XCTAssertNil(choices.profile(for: "c1"))
        XCTAssertEqual(choices.profile(for: "c2"), "p2")
    }

    func testPruningWritesNothingWhenEveryChoiceIsLive() {
        choices.choose(connectionId: "c1", profileId: "p1")
        let before = store.batches
        XCTAssertEqual(choices.pruneMissing(knownProfileIds: ["p1"]), [])
        /* No write at all rather than a no-op write. */
        XCTAssertEqual(store.batches, before)
    }

    func testPruningIgnoresKeysThatAreNotConnectionChoices() {
        /* The share rows share the same store, and pruning must not touch them. */
        store.edit { writer in writer.setString("share.p1.bookmark", "file:///x/") }
        choices.choose(connectionId: "c1", profileId: "p1")

        XCTAssertEqual(choices.pruneMissing(knownProfileIds: ["p1"]), [])
        XCTAssertEqual(store.string("share.p1.bookmark"), "file:///x/")
    }
}
