import Foundation
import XCTest
@testable import ZephyrCore

/// The security-scoped bookmark lifecycle.
///
/// The pair under test is (what the user granted) and (what the share config
/// claims). On iOS those drift because a bookmark goes stale when the directory
/// moves, when the providing app is removed, or when a volume is detached -- and
/// nothing notifies the app. DEVELOPMENT.md 3 additionally forbids syncing a
/// bookmark to another device, so the target device must re-authorise rather than
/// inherit.
///
/// Deliberately parallel to `SafShareGrantsTest.kt`: the two platforms differ in
/// how a grant dies, and asserting the same invariants on both is what keeps them
/// from drifting into two different products.
final class SecurityScopedGrantsTests: XCTestCase {

    private var bookmarks = FakeBookmarkStore()
    private var grants = SecurityScopedGrants(bookmarks: FakeBookmarkStore())

    private let bookmark = "bookmark:Documents"

    override func setUp() {
        super.setUp()
        bookmarks = FakeBookmarkStore()
        grants = SecurityScopedGrants(bookmarks: bookmarks)
    }

    func testAuthorizingStoresAWritableShareWhenTheOsGrantsWrite() {
        let grant = grants.authorize(
            profileId: "p1",
            shareName: "DOCUMENTS",
            bookmarkId: bookmark,
            requestWrite: true
        )
        XCTAssertEqual(grant?.shareName, "DOCUMENTS")
        XCTAssertEqual(grant?.readOnly, false)
        XCTAssertEqual(grant?.grantValid, true)
        XCTAssertEqual(grants.usable().map(\.profileId), ["p1"])
    }

    func testAReadOnlyGrantNarrowsTheShareEvenWhenTheConfigAskedForWrite() {
        /* DEVELOPMENT.md 13.2 takes the strictest of the layers. Offering a writable
         * share over a read-only grant is what produces the corrupted half-copy on
         * the Windows side. */
        bookmarks.readOnly.insert(bookmark)
        let grant = grants.authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: true
        )
        XCTAssertEqual(grant?.readOnly, true)
        XCTAssertEqual(grant?.grantValid, true)
    }

    func testAConfigThatAsksForReadOnlyIsNeverWidenedByAWritableGrant() {
        let grant = grants.authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: false
        )
        XCTAssertEqual(grant?.readOnly, true)
        /* And it stays read-only on every later read, rather than being recomputed
         * from the grant alone. */
        XCTAssertEqual(grants.grant(profileId: "p1")?.readOnly, true)
    }

    func testAnUnnamedShareGetsTheSameDefaultLabelAsAndroid() {
        let grant = grants.authorize(
            profileId: "p1",
            shareName: "   ",
            bookmarkId: bookmark,
            requestWrite: false
        )
        XCTAssertEqual(grant?.shareName, "PHONE")
        XCTAssertEqual(SecurityScopedGrants.defaultShareName, "PHONE")
    }

    func testARefusedBookmarkStoresNothing() {
        /* Minting fails when the URL did not come from a picker result. A share that
         * cannot survive a relaunch is worse than an absent one. */
        bookmarks.refuse.insert(bookmark)
        XCTAssertNil(
            grants.authorize(
                profileId: "p1",
                shareName: "PHONE",
                bookmarkId: bookmark,
                requestWrite: true
            )
        )
        XCTAssertTrue(grants.all().isEmpty)
    }

    func testAStaleBookmarkIsReportedInvalidRatherThanMissing() {
        grants.authorize(profileId: "p1", shareName: "DOCUMENTS", bookmarkId: bookmark, requestWrite: true)
        bookmarks.goStale(bookmark)

        let grant = grants.grant(profileId: "p1")
        /* Still returned: the UI has to name which directory needs re-authorising,
         * and it cannot do that from a nil. A stale bookmark may even still resolve,
         * which is exactly why "resolves today" is not the test. */
        XCTAssertEqual(grant?.shareName, "DOCUMENTS")
        XCTAssertEqual(grant?.grantValid, false)
        XCTAssertTrue(grants.usable().isEmpty)
    }

    func testAVanishedBookmarkNarrowsTheShareToReadOnly() {
        grants.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        bookmarks.vanish(bookmark)

        let grant = grants.grant(profileId: "p1")
        XCTAssertEqual(grant?.grantValid, false)
        /* Narrowed as well, so nothing offers a write against a grant that is gone. */
        XCTAssertEqual(grant?.readOnly, true)
    }

    func testRevokingDiscardsTheBookmark() {
        grants.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        grants.revoke(profileId: "p1")
        /* Discarding matters: a bookmark left behind keeps the app able to resolve a
         * directory the user removed from the app's own list, which is the ambient
         * access security-scoped URLs exist to avoid. */
        XCTAssertEqual(bookmarks.discarded, [bookmark])
        XCTAssertNil(grants.grant(profileId: "p1"))
    }

    func testRevokingOneOfTwoSharesOverTheSameBookmarkKeepsIt() {
        /* Multiple profiles over one directory is legal (DEVELOPMENT.md 13.2).
         * Discarding on the first removal would silently break the second. */
        grants.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        grants.authorize(profileId: "p2", shareName: "DOCUMENTS", bookmarkId: bookmark, requestWrite: false)

        grants.revoke(profileId: "p1")
        XCTAssertEqual(bookmarks.discarded, [])
        XCTAssertEqual(grants.grant(profileId: "p2")?.grantValid, true)

        grants.revoke(profileId: "p2")
        XCTAssertEqual(bookmarks.discarded, [bookmark])
    }

    func testPruningDropsInvalidSharesAndNamesThem() {
        let second = bookmark + ":Other"
        grants.authorize(profileId: "p1", shareName: "PHONE", bookmarkId: bookmark, requestWrite: true)
        grants.authorize(profileId: "p2", shareName: "OTHER", bookmarkId: second, requestWrite: true)

        bookmarks.goStale(bookmark)
        /* Called on foreground resume, where DEVELOPMENT.md 13.5 requires the binding
         * and the file-bridge lease to be re-verified before reconnecting. */
        XCTAssertEqual(grants.pruneInvalid(), ["p1"])
        XCTAssertNil(grants.grant(profileId: "p1"))
        XCTAssertEqual(grants.grant(profileId: "p2")?.grantValid, true)
    }

    func testAnUnknownProfileIsNil() {
        XCTAssertNil(grants.grant(profileId: "nope"))
        XCTAssertTrue(grants.all().isEmpty)
    }

    func testTheBookmarkIsStoredVerbatim() {
        /* Stored as given, never rewritten: it is an opaque platform identity, and
         * normalising it would make it stop matching the stored list. */
        let grant = grants.authorize(
            profileId: "p1",
            shareName: "PHONE",
            bookmarkId: bookmark,
            requestWrite: false
        )
        XCTAssertEqual(grant?.bookmarkId, bookmark)
        XCTAssertEqual(grants.usable().first?.bookmarkId, bookmark)
    }
}

/// The shared path jail, asserted on the Swift side against the same cases the
/// Kotlin suite uses.
///
/// DEVELOPMENT.md 13.4 requires Android and iOS to interpret a virtual path
/// identically. Two ports that disagree here are two different jails wearing one
/// specification, so these cases mirror `VirtualPathTest.kt` deliberately.
final class VirtualPathTests: XCTestCase {

    private func rejected(_ path: String?, file: StaticString = #filePath, line: UInt = #line) {
        do {
            _ = try VirtualPath.normalize(path)
            XCTFail("should have rejected " + (path ?? "nil"), file: file, line: line)
        } catch let failure as Zft2Error {
            XCTAssertEqual(failure.code, "invalid_path", file: file, line: line)
        } catch {
            XCTFail("expected Zft2Error", file: file, line: line)
        }
    }

    func testCollapsesSeparatorsAndTrailingSlashes() throws {
        XCTAssertEqual(try VirtualPath.normalize("/a/b"), "/a/b")
        XCTAssertEqual(try VirtualPath.normalize("/a/b/"), "/a/b")
        XCTAssertEqual(try VirtualPath.normalize("a/b"), "/a/b")
        XCTAssertEqual(try VirtualPath.normalize("/a///b"), "/a/b")
        XCTAssertEqual(try VirtualPath.normalize("/"), "/")
        XCTAssertEqual(try VirtualPath.normalize(""), "/")
    }

    func testRejectsRelativeSegments() {
        rejected("/a/../b")
        rejected("/a/./b")
        rejected("..")
        rejected("/../etc/passwd")
        rejected("a/b/..")
    }

    func testRejectsHostPathSyntax() {
        rejected("C:/Windows")
        rejected("/a\\b")
        rejected("//server/share")
    }

    func testRejectsNulAndControlCharacters() {
        rejected("/a\u{0000}b")
        rejected("/a\u{0001}b")
        rejected("/a\u{007f}b")
    }

    func testRejectsAMissingPath() {
        rejected(nil)
    }

    func testRejectsOversizedAndOverdeepPaths() {
        rejected("/" + String(repeating: "a", count: VirtualPath.maxSegmentLength + 1))
        rejected("/" + String(repeating: "a", count: VirtualPath.maxPathLength + 1))
        rejected(String(repeating: "/x", count: VirtualPath.maxDepth + 1))
    }

    func testAcceptsUnicodeAndSpaces() throws {
        XCTAssertEqual(try VirtualPath.normalize("/\u{4e2d}\u{6587}"), "/\u{4e2d}\u{6587}")
        XCTAssertEqual(try VirtualPath.normalize("/My Files/a b.txt"), "/My Files/a b.txt")
    }

    func testContainmentIsPrefixSafeAtASegmentBoundary() {
        XCTAssertTrue(VirtualPath.isWithin(root: "/share", candidate: "/share"))
        XCTAssertTrue(VirtualPath.isWithin(root: "/share", candidate: "/share/a"))
        /* "/shared" must not count as inside "/share": a plain hasPrefix says it is,
         * and that is the bug the segment boundary exists to prevent. */
        XCTAssertFalse(VirtualPath.isWithin(root: "/share", candidate: "/shared"))
        XCTAssertFalse(VirtualPath.isWithin(root: "/share", candidate: "/other"))
        XCTAssertTrue(VirtualPath.isWithin(root: "/", candidate: "/anything"))
    }

    func testBasenameAndParent() {
        XCTAssertEqual(VirtualPath.basename("/a/b.txt"), "b.txt")
        XCTAssertEqual(VirtualPath.parent("/a/b.txt"), "/a")
        XCTAssertEqual(VirtualPath.parent("/a"), "/")
        XCTAssertEqual(VirtualPath.parent("/"), "/")
    }
}
