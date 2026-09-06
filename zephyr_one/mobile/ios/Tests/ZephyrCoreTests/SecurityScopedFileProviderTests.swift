import Foundation
import XCTest
@testable import ZephyrCore

/// The iOS security-scoped provider: the jail, the read-only refusals, handle
/// binding and the resource limits.
///
/// Every case is either a documented attack from DEVELOPMENT.md 19.6 (path
/// traversal, symlink escape, hostile file names, huge directories, handle leaks)
/// or a POSIX-specific hazard the Android port does not have. The symlink cases
/// are the ones that matter most here: SAF has no link concept, so this is the
/// hazard that is genuinely new on iOS.
final class SecurityScopedFileProviderTests: XCTestCase {

    private var fs = FakeSecurityScopedFileSystem()

    override func setUp() {
        super.setUp()
        fs = FakeSecurityScopedFileSystem()
        fs.addDirectory("/granted/docs")
        fs.addFile("/granted/docs/a.txt", contents: "hello world")
        fs.addFile("/granted/top.bin", contents: "xy")
        // Outside the granted root. Nothing addressable may ever reach it.
        fs.addDirectory("/elsewhere")
        fs.addFile("/elsewhere/secret.txt", contents: "not yours")
    }

    private func provider(
        readOnly: Bool = false,
        maxHandles: Int = 64,
        maxList: Int = 2000,
        maxRead: Int = SecurityScopedFileProvider.defaultMaxReadBytes
    ) -> SecurityScopedFileProvider {
        SecurityScopedFileProvider(
            fileSystem: fs,
            readOnly: readOnly,
            maxOpenHandles: maxHandles,
            maxListEntries: maxList,
            maxReadBytes: maxRead
        )
    }

    /// Asserts the operation is refused with a specific wire code.
    private func refused(
        _ code: String,
        _ operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("expected " + code, file: file, line: line)
        } catch let failure as Zft2Error {
            XCTAssertEqual(failure.code, code, file: file, line: line)
        } catch {
            XCTFail("expected Zft2Error " + code, file: file, line: line)
        }
    }

    // MARK: - The jail

    func testTraversalIsRejectedBeforeAnythingIsJoined() async throws {
        let provider = provider()
        await refused("invalid_path") { _ = try await provider.stat(path: "/../elsewhere/secret.txt") }
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs/../../elsewhere") }
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs/./a.txt") }
        await refused("invalid_path") { _ = try await provider.stat(path: "C:/Windows") }
        await refused("invalid_path") { _ = try await provider.stat(path: "//server/share") }
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs\\a.txt") }
        await refused("invalid_path") { _ = try await provider.stat(path: "/a\u{0000}b") }
    }

    func testASymlinkOutOfTheRootIsRefusedNotFollowed() async throws {
        /* The hazard that does not exist on SAF. DEVELOPMENT.md 13.4 requires links
         * leaving the root to be refused, and the refusal has to come from
         * canonicalising rather than from inspecting the name. */
        fs.addSymlink("/granted/docs/escape", to: "/elsewhere/secret.txt")
        let provider = provider()
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs/escape") }
        await refused("invalid_path") { _ = try await provider.open(path: "/docs/escape", mode: "read") }
    }

    func testALinkInTheMiddleOfAPathCannotCarryTheResolutionOut() async throws {
        /* The case a prefix test on the unresolved string misses completely:
         * "/granted/docs/bridge/secret.txt" is textually inside "/granted" and
         * resolves to "/elsewhere/secret.txt". Only canonicalising the whole path
         * catches it. */
        fs.addSymlink("/granted/docs/bridge", to: "/elsewhere")
        let provider = provider()
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs/bridge/secret.txt") }
        await refused("invalid_path") { _ = try await provider.list(path: "/docs/bridge") }
    }

    func testAContainedSymlinkIsAlsoRefusedFailClosed() async throws {
        /* A contained link can be retargeted between validation and use. The
         * descriptor-relative policy therefore refuses every ancestor and target
         * symlink rather than trying to preserve contained-link convenience. */
        fs.addSymlink("/granted/docs/inside", to: "/granted/top.bin")
        let provider = provider()
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs/inside") }
        await refused("invalid_path") { _ = try await provider.open(path: "/docs/inside", mode: "read") }
    }

    func testCreatingThroughAnEscapingLinkIsRefused() async throws {
        /* The write path must refuse an escape too, not only the read path.
         *
         * Two independent checks have to agree for that: resolveForWrite catches
         * only not_found before deciding a file is absent, and the parent is then
         * resolved through the same canonicalising containment check. Either one
         * alone refuses this case -- confirmed by transliterating the provider with
         * and without the typed catch -- and the test pins the outcome so a
         * refactor cannot remove both and leave a create landing outside the root. */
        fs.addSymlink("/granted/docs/bridge", to: "/elsewhere")
        let provider = provider()
        await refused("invalid_path") { _ = try await provider.open(path: "/docs/bridge/new.bin", mode: "write") }
        // And nothing was created out there.
        XCTAssertNil(fs.nodes["/elsewhere/new.bin"])
    }

    func testASiblingOfTheRootIsNotReachableEvenWhenItsNamePrefixMatches() async throws {
        /* A provider comparing by string prefix would let "/granted-other" pass a
         * hasPrefix("/granted") check. */
        fs.addDirectory("/granted-other")
        fs.addFile("/granted-other/leak.txt", contents: "no")
        fs.addSymlink("/granted/docs/near", to: "/granted-other/leak.txt")
        let provider = provider()
        await refused("invalid_path") { _ = try await provider.stat(path: "/docs/near") }
    }

    func testAVanishedRootIsReportedRatherThanCrashing() async throws {
        /* The user can move or delete the granted directory at any moment and nothing
         * notifies the app. */
        let empty = FakeSecurityScopedFileSystem(rootPath: "/gone")
        empty.nodes.removeAll()
        let provider = SecurityScopedFileProvider(fileSystem: empty, readOnly: false)
        await refused("not_found") { _ = try await provider.stat(path: "/anything") }
        await refused("not_found") { _ = try await provider.list(path: "/") }
    }

    // MARK: - Listing

    func testListReportsVirtualPathsNotHostPaths() async throws {
        let entries = try await provider().list(path: "/docs")
        XCTAssertEqual(entries.map(\.path), ["/docs/a.txt"])
        XCTAssertEqual(entries.map(\.name), ["a.txt"])
        /* A host path on the wire would leak the device's directory layout, which
         * SHARED_RESOURCE_RESIDENCY.md keeps off it. */
        XCTAssertFalse(entries.contains { $0.path.contains("/granted") })
    }

    func testListSkipsNamesTheWireCouldNotAddress() async throws {
        /* A name with a separator or a control character would resolve to a different
         * path than the one advertised, and is a classic way to spoof a different
         * file in the main end's browser. One bad name must not fail the directory. */
        fs.addFile("/granted/docs/ok.txt", contents: "fine")
        fs.addFile("/granted/docs/bell\u{0007}.txt", contents: "bad")
        let entries = try await provider().list(path: "/docs")
        XCTAssertEqual(entries.map(\.name), ["a.txt", "ok.txt"])
    }

    func testListDropsEscapingLinksInsteadOfAdvertisingThem() async throws {
        /* Advertising a link the peer then cannot open invites a request that will be
         * refused, and makes the share look broken rather than scoped. */
        fs.addSymlink("/granted/docs/escape", to: "/elsewhere/secret.txt")
        fs.addSymlink("/granted/docs/inside", to: "/granted/top.bin")
        let names = try await provider().list(path: "/docs").map(\.name)
        XCTAssertEqual(names, ["a.txt"])
    }

    func testListIsBoundedSoAHugeDirectoryCannotExhaustMemory() async throws {
        for index in 0..<50 {
            fs.addFile("/granted/docs/f\(index).txt", contents: "x")
        }
        /* One past the limit, so the dispatcher's own too_many_entries check still
         * trips instead of this silently truncating the directory. */
        let entries = try await provider(maxList: 10).list(path: "/docs")
        XCTAssertEqual(entries.count, 11)
        XCTAssertEqual(fs.lastDescriptorListLimit, 11)
    }

    func testListRefusesAFile() async throws {
        await refused("not_a_directory") { _ = try await self.provider().list(path: "/docs/a.txt") }
    }

    // MARK: - Read-only jail

    func testEveryMutatingOperationIsRefusedOnAReadOnlyShare() async throws {
        let provider = provider(readOnly: true)
        await refused("read_only") { try await provider.mkdir(path: "/docs/new") }
        await refused("read_only") { try await provider.delete(path: "/docs/a.txt", recursive: false) }
        await refused("read_only") { try await provider.rename(oldPath: "/docs/a.txt", newPath: "/docs/b.txt") }
        await refused("read_only") { try await provider.truncate(path: "/docs/a.txt", size: 0) }
        await refused("read_only") { _ = try await provider.open(path: "/docs/a.txt", mode: "write") }
        await refused("read_only") { _ = try await provider.open(path: "/docs/a.txt", mode: "writeTruncate") }

        /* Nothing reached the platform. The dispatcher also refuses write ops, but
         * this provider is reachable from the JSON-RPC surface too. */
        XCTAssertEqual(fs.opened, [])
        XCTAssertEqual(fs.contents(of: "/granted/docs/a.txt"), "hello world")
    }

    func testAReadOnlyShareAdvertisesCanWriteFalseEvenForWritableFiles() async throws {
        /* DEVELOPMENT.md 13.4: the main end reads canWrite to decide whether to offer
         * a write at all. Advertising true and refusing later is what leaves a
         * half-copied file on the Windows side. */
        let writable = try await provider().stat(path: "/docs/a.txt")
        XCTAssertTrue(writable.canWrite)
        let shared = try await provider(readOnly: true).stat(path: "/docs/a.txt")
        XCTAssertFalse(shared.canWrite)
    }

    func testAWritableShareStillReportsThePlatformsAnswer() async throws {
        /* The share being writable does not make a read-only file writable, and
         * discovering that on the first WRITE means the copy already started. */
        fs.addFile("/granted/docs/locked.txt", contents: "x", canWrite: false)
        let locked = try await provider().stat(path: "/docs/locked.txt")
        XCTAssertFalse(locked.canWrite)
        await refused("permission_denied") { _ = try await self.provider().open(path: "/docs/locked.txt", mode: "write") }
    }

    // MARK: - Handles

    func testAHandleOpenedForReadingCannotBeWrittenThrough() async throws {
        let provider = provider()
        let handle = try await provider.open(path: "/docs/a.txt", mode: "read")
        /* The mode the handle was opened with decides, not the mode implied by the
         * frame. */
        await refused("read_only") { _ = try await provider.write(handle: handle, offset: 0, data: Data("zzz".utf8)) }
        XCTAssertEqual(fs.contents(of: "/granted/docs/a.txt"), "hello world")
        XCTAssertEqual(fs.opened, ["/granted/docs/a.txt:r"])
    }

    func testHandlesAreUnpredictable() async throws {
        let provider = provider()
        let first = try await provider.open(path: "/docs/a.txt", mode: "read")
        let second = try await provider.open(path: "/top.bin", mode: "read")
        /* DEVELOPMENT.md 13.3 requires unguessable handles: a sequential one lets a
         * peer name a file it never opened, including one another operation opened
         * for writing. */
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(first.hasPrefix("h_"))
        // "h_" plus 16 bytes of hex.
        XCTAssertEqual(first.count, 34)
        XCTAssertTrue(first.dropFirst(2).allSatisfy { "0123456789abcdef".contains($0) })
        /* A counter increases (weakly) in open order. Random handles clear the
         * increasing-order property with probability 1 - 1/8! ≈ 99.99998% over
         * eight sampled handles, while a counter never can — a deterministic
         * discriminator with no false-positive flake. (The previous
         * hasSuffix("1") && hasSuffix("2") check failed 1/256 runs even on the
         * correct random implementation.) */
        var previous = UInt64.max
        for index in 0..<8 {
            let handle = try await provider.open(path: "/docs/a.txt", mode: "read")
            try await provider.close(handle: handle)
            let tail = UInt64(String(handle.dropFirst(2).suffix(8)), radix: 16) ?? UInt64.max
            XCTAssertLessThan(tail, previous, "handle \(index) must not trend upward like a counter")
            previous = tail
        }
    }

    func testAnUnknownHandleIsRefusedRatherThanIgnored() async throws {
        let provider = provider()
        await refused("not_found") { _ = try await provider.read(handle: "h_deadbeef", offset: 0, length: 4) }
        await refused("not_found") { _ = try await provider.write(handle: "h_deadbeef", offset: 0, data: Data("x".utf8)) }
    }

    func testClosingAnUnknownHandleSucceeds() async throws {
        /* CLOSE is idempotent on the wire: a peer retrying after a dropped response
         * must not get an error for work already done. */
        try await provider().close(handle: "h_never_existed")
    }

    func testHandleCountIsBoundedAndNoDescriptorLeaksWhenRefused() async throws {
        let provider = provider(maxHandles: 2)
        _ = try await provider.open(path: "/docs/a.txt", mode: "read")
        _ = try await provider.open(path: "/top.bin", mode: "read")
        await refused("too_many_handles") { _ = try await provider.open(path: "/docs/a.txt", mode: "read") }
        /* Refused before openAccess, so no descriptor was created to leak. */
        XCTAssertEqual(fs.liveAccess.count, 2)
        let bounded = await provider.openHandleCount()
        XCTAssertEqual(bounded, 2)
    }

    func testCloseAllReleasesEveryDescriptorAndClaim() async throws {
        let provider = provider()
        try await provider.beginAccess()
        _ = try await provider.open(path: "/docs/a.txt", mode: "read")
        _ = try await provider.open(path: "/top.bin", mode: "read")
        XCTAssertEqual(fs.liveAccess.count, 2)
        XCTAssertEqual(fs.accessBalance, 1)

        await provider.closeAll()

        /* Called on disconnect: a dropped socket must not leave descriptors behind,
         * and a residual security-scoped claim keeps a sandbox extension alive after
         * the user stopped the share. */
        XCTAssertEqual(fs.liveAccess, [])
        let remainingHandles = await provider.openHandleCount()
        XCTAssertEqual(remainingHandles, 0)
        XCTAssertEqual(fs.accessBalance, 0)
        let remainingClaims = await provider.accessClaimCount()
        XCTAssertEqual(remainingClaims, 0)
        await refused("not_found") { _ = try await provider.open(path: "/docs/a.txt", mode: "read") }
    }

    func testCloseAllFencesAnOpenAlreadySuspendedInTheFilesystem() async throws {
        let provider = provider()
        try await provider.beginAccess()
        let gate = ProviderOpenGate()
        fs.pauseNextDescriptorOpen = { await gate.pause() }

        let opening = Task { () -> Zft2Error? in
            do {
                _ = try await provider.open(path: "/docs/a.txt", mode: "read")
                return nil
            } catch let error as Zft2Error {
                return error
            } catch {
                return Zft2Error(code: "unexpected", message: "unexpected error")
            }
        }
        await gate.waitUntilEntered()

        let closing = Task { await provider.closeAll() }
        var observedFence = false
        for _ in 0..<100 {
            do {
                _ = try await provider.stat(path: "/docs/a.txt")
            } catch let error as Zft2Error where error.code == "not_found" {
                observedFence = true
                break
            } catch {
                break
            }
            await Task<Never, Never>.yield()
        }
        XCTAssertTrue(observedFence)
        /* The claim stays live while the pre-fence open is suspended. */
        XCTAssertEqual(fs.accessBalance, 1)

        await gate.release()
        let openFailure = await opening.value
        await closing.value

        XCTAssertEqual(openFailure?.code, "not_found")
        XCTAssertEqual(fs.liveAccess, [])
        XCTAssertEqual(fs.accessBalance, 0)
        let remainingHandles = await provider.openHandleCount()
        XCTAssertEqual(remainingHandles, 0)
    }

    func testARefusedClaimIsReportedRatherThanAssumed() async throws {
        /* Unlike a SAF grant, a security-scoped URL is not ambiently readable: the
         * claim can be refused, and that is how a stale bookmark presents. */
        fs.refuseAccess = true
        let provider = provider()
        await refused("permission_denied") { try await provider.beginAccess() }
        let claimsAfterRefusal = await provider.accessClaimCount()
        XCTAssertEqual(claimsAfterRefusal, 0)
    }

    // MARK: - Reads and writes

    func testReadIsPositionalAndReportsEndOfFileAsAShortRead() async throws {
        let provider = provider()
        let handle = try await provider.open(path: "/docs/a.txt", mode: "read")
        var chunk = try await provider.read(handle: handle, offset: 0, length: 5)
        XCTAssertEqual(String(decoding: chunk, as: UTF8.self), "hello")
        chunk = try await provider.read(handle: handle, offset: 6, length: 5)
        XCTAssertEqual(String(decoding: chunk, as: UTF8.self), "world")
        chunk = try await provider.read(handle: handle, offset: 99, length: 5)
        XCTAssertTrue(chunk.isEmpty)
        await refused("invalid_argument") { _ = try await provider.read(handle: handle, offset: -1, length: 5) }
    }

    func testReadClampsIntMaxBeforeTheRandomAccessAllocation() async throws {
        let provider = provider(maxRead: 1024)
        let handle = try await provider.open(path: "/docs/a.txt", mode: "read")
        let data = try await provider.read(handle: handle, offset: 0, length: Int.max)

        XCTAssertEqual(String(decoding: data, as: UTF8.self), "hello world")
        XCTAssertEqual(fs.readLengths, [1024])
    }

    func testOpenForWriteCreatesTheFileWithoutCreatingItsParents() async throws {
        let provider = provider()
        let handle = try await provider.open(path: "/docs/new.bin", mode: "write")
        let written = try await provider.write(handle: handle, offset: 0, data: Data("abc".utf8))
        XCTAssertEqual(written, 3)
        try await provider.close(handle: handle)
        XCTAssertEqual(fs.contents(of: "/granted/docs/new.bin"), "abc")

        /* A missing parent is not invented: auto-creating the chain would turn one
         * typo into a tree of empty directories inside the user's shared folder. */
        await refused("not_found") { _ = try await provider.open(path: "/nope/deeper/file.bin", mode: "write") }
        XCTAssertNil(fs.nodes["/granted/nope"])
    }

    func testWriteDoesNotTruncateUnlessAskedTo() async throws {
        /* RDPDR delivers a large file as sequential writes on one handle. A
         * truncate-on-open mode would discard everything already written on every
         * write after the first. */
        let provider = provider()
        let handle = try await provider.open(path: "/docs/a.txt", mode: "write")
        _ = try await provider.write(handle: handle, offset: 0, data: Data("HELLO".utf8))
        try await provider.close(handle: handle)
        XCTAssertEqual(fs.contents(of: "/granted/docs/a.txt"), "HELLO world")
    }

    func testWriteTruncateEmptiesTheFileFirst() async throws {
        let provider = provider()
        let handle = try await provider.open(path: "/docs/a.txt", mode: "writeTruncate")
        _ = try await provider.write(handle: handle, offset: 0, data: Data("new".utf8))
        try await provider.close(handle: handle)
        XCTAssertEqual(fs.contents(of: "/granted/docs/a.txt"), "new")
    }

    func testAnUnknownOpenModeIsRefused() async throws {
        await refused("invalid_argument") { _ = try await self.provider().open(path: "/docs/a.txt", mode: "append") }
    }

    func testOpeningADirectoryIsRefused() async throws {
        await refused("is_a_directory") { _ = try await self.provider().open(path: "/docs", mode: "read") }
    }

    // MARK: - mkdir / delete / rename / truncate

    func testMkdirRefusesAnExistingNameAndTheRoot() async throws {
        let provider = provider()
        try await provider.mkdir(path: "/docs/sub")
        let made = try await provider.stat(path: "/docs/sub")
        XCTAssertTrue(made.isDir)
        await refused("already_exists") { try await provider.mkdir(path: "/docs/sub") }
        await refused("already_exists") { try await provider.mkdir(path: "/") }
    }

    func testDeleteRefusesTheShareRoot() async throws {
        /* Deleting the granted root would revoke the share from inside a file
         * operation. */
        let provider = provider()
        await refused("invalid_path") { try await provider.delete(path: "/", recursive: true) }
        await refused("invalid_path") { try await provider.delete(path: "", recursive: true) }
        XCTAssertNotNil(fs.nodes["/granted"])
    }

    func testDeleteRefusesANonEmptyDirectoryUnlessRecursive() async throws {
        let provider = provider()
        await refused("not_empty") { try await provider.delete(path: "/docs", recursive: false) }
        let survived = try await provider.stat(path: "/docs")
        XCTAssertTrue(survived.isDir)
        try await provider.delete(path: "/docs", recursive: true)
        await refused("not_found") { _ = try await provider.stat(path: "/docs") }
    }

    func testRenameWithinTheSameDirectory() async throws {
        let provider = provider()
        try await provider.rename(oldPath: "/docs/a.txt", newPath: "/docs/b.txt")
        let renamed = try await provider.stat(path: "/docs/b.txt")
        XCTAssertEqual(renamed.path, "/docs/b.txt")
        await refused("not_found") { _ = try await provider.stat(path: "/docs/a.txt") }
    }

    func testRenameRefusesTheCasesThatWouldDetachOrClobber() async throws {
        let provider = provider()
        fs.addFile("/granted/docs/taken.txt", contents: "x")
        await refused("already_exists") { try await provider.rename(oldPath: "/docs/a.txt", newPath: "/docs/taken.txt") }
        await refused("invalid_path") { try await provider.rename(oldPath: "/docs/a.txt", newPath: "/docs/a.txt") }
        await refused("invalid_path") { try await provider.rename(oldPath: "/docs", newPath: "/") }
        /* Moving a directory inside itself makes it its own ancestor, and everything
         * under it stops resolving from the root. */
        await refused("invalid_path") { try await provider.rename(oldPath: "/docs", newPath: "/docs/inner") }
        await refused("invalid_path") { try await provider.rename(oldPath: "/docs/a.txt", newPath: "/docs/../a.txt") }
    }

    func testACrossVolumeMoveIsRefusedRatherThanEmulated() async throws {
        /* Refused rather than emulated with copy-then-delete: a copy that fails
         * halfway leaves two partial files while the peer believes it moved one. */
        fs.addDirectory("/granted/other")
        fs.refuseMove = true
        let provider = provider()
        await refused("unsupported") { try await provider.rename(oldPath: "/docs/a.txt", newPath: "/other/a.txt") }

        fs.refuseMove = false
        try await provider.rename(oldPath: "/docs/a.txt", newPath: "/other/moved.txt")
        let moved = try await provider.stat(path: "/other/moved.txt")
        XCTAssertEqual(moved.path, "/other/moved.txt")
    }

    func testTruncateRefusesNegativeSizesAndDirectoriesAndReleasesItsDescriptor() async throws {
        let provider = provider()
        await refused("invalid_argument") { try await provider.truncate(path: "/docs/a.txt", size: -1) }
        await refused("is_a_directory") { try await provider.truncate(path: "/docs", size: 0) }
        try await provider.truncate(path: "/docs/a.txt", size: 5)
        XCTAssertEqual(fs.contents(of: "/granted/docs/a.txt"), "hello")
        /* truncate opens a descriptor that is not tracked in `handles`, so nothing
         * else would ever close it. */
        XCTAssertEqual(fs.liveAccess, [])
    }

    func testTheRootItselfStats() async throws {
        let root = try await provider().stat(path: "/")
        XCTAssertTrue(root.isDir)
        XCTAssertEqual(root.path, "/")
        XCTAssertEqual(root.name, "")
        XCTAssertEqual(root.size, 0)
    }
}

private actor ProviderOpenGate {
    private var entered = false
    private var continuation: CheckedContinuation<Void, Never>?

    func pause() async {
        entered = true
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilEntered() async {
        while !entered {
            await Task<Never, Never>.yield()
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

final class PosixSecurityScopedFileSystemRaceTests: XCTestCase {

    func testReplacingCanonicalisedAncestorCannotRedirectSensitiveOperations() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let provider = fixture.provider
        try await provider.beginAccess()

        let originalFile = fixture.root.appendingPathComponent("docs/a.txt")
        XCTAssertNotNil(try fixture.fileSystem.canonicalPath(of: originalFile.path))
        XCTAssertNotNil(try fixture.fileSystem.canonicalPath(
            of: fixture.root.appendingPathComponent("docs").path
        ))

        let parked = fixture.root.appendingPathComponent("parked-docs")
        try FileManager.default.moveItem(
            at: fixture.root.appendingPathComponent("docs"),
            to: parked
        )
        try FileManager.default.createSymbolicLink(
            atPath: fixture.root.appendingPathComponent("docs").path,
            withDestinationPath: fixture.outside.path
        )

        await refused("invalid_path") {
            _ = try await provider.open(path: "/docs/a.txt", mode: "read")
        }
        await refused("invalid_path") {
            _ = try await provider.open(path: "/docs/new.bin", mode: "write")
        }
        await refused("invalid_path") {
            try await provider.delete(path: "/docs/a.txt", recursive: false)
        }
        await refused("invalid_path") {
            try await provider.rename(oldPath: "/docs/a.txt", newPath: "/moved.txt")
        }
        await refused("invalid_path") {
            try await provider.truncate(path: "/docs/a.txt", size: 0)
        }

        XCTAssertEqual(
            try String(contentsOf: fixture.outside.appendingPathComponent("a.txt"), encoding: .utf8),
            "outside"
        )
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: fixture.outside.appendingPathComponent("new.bin").path
        ))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: fixture.root.appendingPathComponent("moved.txt").path
        ))
        await provider.closeAll()
    }

    func testPosixListStopsReaddirAtTheProviderLimit() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let provider = SecurityScopedFileProvider(
            fileSystem: fixture.fileSystem,
            readOnly: false,
            maxListEntries: 10
        )
        try await provider.beginAccess()
        for index in 0..<500 {
            XCTAssertTrue(FileManager.default.createFile(
                atPath: fixture.root.appendingPathComponent("many/f\(index)").path,
                contents: Data("x".utf8)
            ))
        }

        let entries = try await provider.list(path: "/many")
        XCTAssertEqual(entries.count, 11)
        await provider.closeAll()
    }

    private struct Fixture {
        let base: URL
        let root: URL
        let outside: URL
        let fileSystem: PosixSecurityScopedFileSystem
        let provider: SecurityScopedFileProvider
    }

    private func makeFixture() throws -> Fixture {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("zephyr-posix-" + UUID().uuidString)
        let root = base.appendingPathComponent("root")
        let outside = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("docs"),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("many"),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("inside".utf8).write(to: root.appendingPathComponent("docs/a.txt"))
        try Data("outside".utf8).write(to: outside.appendingPathComponent("a.txt"))

        let fileSystem = try PosixSecurityScopedFileSystem(
            root: root,
            requiresSecurityScope: false
        )
        return Fixture(
            base: base,
            root: root,
            outside: outside,
            fileSystem: fileSystem,
            provider: SecurityScopedFileProvider(fileSystem: fileSystem, readOnly: false)
        )
    }

    private func refused(
        _ code: String,
        _ operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("expected " + code, file: file, line: line)
        } catch let failure as Zft2Error {
            XCTAssertEqual(failure.code, code, file: file, line: line)
        } catch {
            XCTFail("expected Zft2Error " + code, file: file, line: line)
        }
    }
}
