package one.zephyr.mobile.feature.filesync

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.protocol.zft2.Zft2Exception
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The SAF provider: the jail, the read-only refusals, handle binding and the resource limits.
 *
 * Every case is either a documented attack from DEVELOPMENT.md 19.6 (path traversal, symlink escape,
 * hostile file names, huge directories, handle leaks) or a SAF-specific hazard that a provider built
 * on path arithmetic would get wrong. The suite runs on the JVM against [FakeDocumentTree]; there is
 * no Gradle wrapper here and the Android tree compiles only in CI, so a test needing a device is a
 * test nobody runs.
 */
class SafZft2FileProviderTest {

    private lateinit var tree: FakeDocumentTree
    private lateinit var docs: String

    private fun provider(readOnly: Boolean = false, maxHandles: Int = 64, maxList: Int = 2000) =
        SafZft2FileProvider(
            tree = tree,
            readOnly = readOnly,
            maxOpenHandles = maxHandles,
            maxListEntries = maxList,
        )

    private fun freshTree() {
        tree = FakeDocumentTree()
        docs = tree.addDirectory(tree.rootId, "docs")
        tree.addFile(docs, "a.txt", "hello world")
        tree.addFile(tree.rootId, "top.bin", "xy")
    }

    private inline fun refused(code: String, block: () -> Unit) {
        try {
            block()
            fail("expected $code")
        } catch (failure: Zft2Exception) {
            assertEquals(code, failure.code)
        }
    }

    init {
        freshTree()
    }

    // ---- the jail -----------------------------------------------------------

    @Test
    fun traversalCannotEscapeTheGrantedTree() = runTest {
        val provider = provider()
        /* Rejected by the validator before resolution. The walk makes escape unreachable anyway --
         * ".." is not a child name -- but a peer gets a precise code rather than not_found. */
        refused("invalid_path") { provider.stat("/../secret") }
        refused("invalid_path") { provider.stat("/docs/../../secret") }
        refused("invalid_path") { provider.stat("/docs/./a.txt") }
        refused("invalid_path") { provider.stat("C:/Windows") }
        refused("invalid_path") { provider.stat("//server/share") }
        refused("invalid_path") { provider.stat("/docs\\a.txt") }
        refused("invalid_path") { provider.stat("/a\u0000b") }
    }

    @Test
    fun aSiblingOfTheRootIsNotReachableEvenWhenItsNamePrefixMatches() = runTest {
        /* A provider that resolved by string prefix would let "/docsx" pass a startsWith("/docs")
         * check. Resolution walks children, so the only way in is an exact name match. */
        tree.addFile(tree.rootId, "docsx", "other")
        val provider = provider()
        assertEquals("/docsx", provider.stat("/docsx").path)
        refused("not_found") { provider.stat("/docs/x/a.txt") }
    }

    @Test
    fun aDocumentIdIsNeverAcceptedAsAPath() = runTest {
        /* The peer addresses files by virtual path only. Handing it a document id would make the id
         * an addressable name, which is how a crafted id reaches outside the tree. */
        refused("not_found") { provider().stat("/" + docs) }
    }

    // ---- listing ------------------------------------------------------------

    @Test
    fun listReportsVirtualPathsNotPlatformIds() = runTest {
        val entries = provider().list("/docs")
        assertEquals(listOf("/docs/a.txt"), entries.map { it.path })
        assertEquals(listOf("a.txt"), entries.map { it.name })
    }

    @Test
    fun listSkipsNamesTheWireCouldNotAddress() = runTest {
        /* SAF display names are arbitrary strings. A name with a separator or a control character
         * would resolve to a different path than the one advertised, and is a classic way to spoof a
         * different file in the main end's browser. Skipped, not listed, and one bad name does not
         * fail the whole directory. */
        tree.addFile(docs, "ok.txt", "fine")
        tree.addFile(docs, "evil/../escape.txt", "bad")
        tree.addFile(docs, "bell\u0007.txt", "bad")
        tree.addFile(docs, "", "bad")

        val names = provider().list("/docs").map { it.name }
        assertEquals(listOf("a.txt", "ok.txt"), names)
    }

    @Test
    fun listIsBoundedSoAHugeDirectoryCannotExhaustMemory() = runTest {
        repeat(50) { index -> tree.addFile(docs, "f$index.txt", "x") }
        /* One past the limit, so Zft2Dispatcher's own too_many_entries check still trips instead of
         * this silently truncating the directory. */
        assertEquals(11, provider(maxList = 10).list("/docs").size)
    }

    @Test
    fun listRefusesAFile() = runTest {
        refused("not_a_directory") { provider().list("/docs/a.txt") }
    }

    // ---- read-only jail -----------------------------------------------------

    @Test
    fun everyMutatingOperationIsRefusedOnAReadOnlyShare() = runTest {
        val provider = provider(readOnly = true)
        refused("read_only") { provider.mkdir("/docs/new") }
        refused("read_only") { provider.delete("/docs/a.txt", false) }
        refused("read_only") { provider.rename("/docs/a.txt", "/docs/b.txt") }
        refused("read_only") { provider.truncate("/docs/a.txt", 0L) }
        refused("read_only") { provider.open("/docs/a.txt", "write") }
        refused("read_only") { provider.open("/docs/a.txt", "writeTruncate") }
        /* Nothing reached the platform. The dispatcher also refuses write ops, but this provider is
         * reachable from the JSON-RPC surface too, so the check has to hold here. */
        assertEquals(emptyList<String>(), tree.opened)
        assertEquals("hello world", tree.contentOf(tree.nodes.values.first { it.name == "a.txt" }.id))
    }

    @Test
    fun aReadOnlyShareAdvertisesCanWriteFalseEvenForWritableDocuments() = runTest {
        /* DEVELOPMENT.md 13.4: the main end reads canWrite to decide whether to offer a write at all.
         * Advertising true and refusing later is what leaves a half-copied file on the Windows side. */
        assertTrue(provider().stat("/docs/a.txt").canWrite)
        assertFalse(provider(readOnly = true).stat("/docs/a.txt").canWrite)
    }

    @Test
    fun aWritableShareStillReportsThePlatformsAnswer() = runTest {
        /* The share being writable does not make a read-only document writable. The platform is the
         * authority, and discovering otherwise on the first WRITE means the copy already started. */
        tree.addFile(docs, "locked.txt", "x", canWrite = false)
        assertFalse(provider().stat("/docs/locked.txt").canWrite)
        refused("permission_denied") { provider().open("/docs/locked.txt", "write") }
    }

    // ---- handles ------------------------------------------------------------

    @Test
    fun aHandleOpenedForReadingCannotBeWrittenThrough() = runTest {
        val provider = provider()
        val handle = provider.open("/docs/a.txt", "read")
        /* The mode the handle was opened with decides, not the mode implied by the frame. */
        refused("read_only") { provider.write(handle, 0L, "zzz".toByteArray()) }
        assertEquals("hello world", tree.contentOf(tree.nodes.values.first { it.name == "a.txt" }.id))
        assertEquals(listOf(tree.nodes.values.first { it.name == "a.txt" }.id + ":r"), tree.opened)
    }

    @Test
    fun handlesAreUnpredictable() = runTest {
        val provider = provider()
        val first = provider.open("/docs/a.txt", "read")
        val second = provider.open("/top.bin", "read")
        /* DEVELOPMENT.md 13.3 requires unguessable handles: a sequential one lets a peer name a
         * document it never opened, including one another operation opened for writing. */
        assertNotEquals(first, second)
        assertTrue(first.startsWith("h_"))
        assertEquals(34, first.length)
        assertFalse("a handle must not be a counter", first.endsWith("1") && second.endsWith("2"))
        assertTrue(first.substring(2).all { it in "0123456789abcdef" })
    }

    @Test
    fun anUnknownHandleIsRefusedRatherThanIgnored() = runTest {
        refused("not_found") { provider().read("h_deadbeef", 0L, 4) }
        refused("not_found") { provider().write("h_deadbeef", 0L, "x".toByteArray()) }
    }

    @Test
    fun closingAnUnknownHandleSucceeds() = runTest {
        /* CLOSE is idempotent on the wire: a peer retrying after a dropped response must not get an
         * error for work already done. */
        provider().close("h_never_existed")
    }

    @Test
    fun handleCountIsBoundedAndTheDescriptorIsNotLeakedWhenRefused() = runTest {
        val provider = provider(maxHandles = 2)
        provider.open("/docs/a.txt", "read")
        provider.open("/top.bin", "read")
        refused("too_many_handles") { provider.open("/docs/a.txt", "read") }
        /* Refused before openAccess, so no descriptor was created to leak. */
        assertEquals(2, tree.liveAccess.size)
        assertEquals(2, provider.openHandleCount())
    }

    @Test
    fun closeAllReleasesEveryDescriptor() = runTest {
        val provider = provider()
        provider.open("/docs/a.txt", "read")
        provider.open("/top.bin", "read")
        assertEquals(2, tree.liveAccess.size)
        provider.closeAll()
        /* Called on disconnect: a dropped socket must not leave file descriptors behind. */
        assertEquals(emptyList<String>(), tree.liveAccess)
        assertEquals(0, provider.openHandleCount())
    }

    // ---- reads and writes ---------------------------------------------------

    @Test
    fun readIsPositionalAndReportsEndOfFileAsAShortRead() = runTest {
        val provider = provider()
        val handle = provider.open("/docs/a.txt", "read")
        assertEquals("hello", String(provider.read(handle, 0L, 5), Charsets.UTF_8))
        assertEquals("world", String(provider.read(handle, 6L, 5), Charsets.UTF_8))
        assertEquals("", String(provider.read(handle, 99L, 5), Charsets.UTF_8))
        refused("invalid_argument") { provider.read(handle, -1L, 5) }
    }

    @Test
    fun openForWriteCreatesTheFileWithoutCreatingItsParents() = runTest {
        val provider = provider()
        val handle = provider.open("/docs/new.bin", "write")
        assertEquals(3, provider.write(handle, 0L, "abc".toByteArray()))
        provider.close(handle)
        assertEquals("abc", String(provider.read(provider.open("/docs/new.bin", "read"), 0L, 3), Charsets.UTF_8))
        /* A missing parent is not invented: auto-creating the chain turns one typo into a tree of
         * empty directories inside the user's shared folder. */
        refused("not_found") { provider.open("/nope/deeper/file.bin", "write") }
    }

    @Test
    fun writeDoesNotTruncateUnlessAskedTo() = runTest {
        val provider = provider()
        /* RDPDR delivers a large file as sequential writes on one handle. Opening with a truncating
         * mode would discard everything already written on every WRITE after the first. */
        val handle = provider.open("/docs/a.txt", "write")
        provider.write(handle, 0L, "HELLO".toByteArray())
        provider.close(handle)
        assertEquals("HELLO world", tree.contentOf(tree.nodes.values.first { it.name == "a.txt" }.id))
    }

    @Test
    fun writeTruncateEmptiesTheFileFirst() = runTest {
        val provider = provider()
        val handle = provider.open("/docs/a.txt", "writeTruncate")
        provider.write(handle, 0L, "new".toByteArray())
        provider.close(handle)
        assertEquals("new", tree.contentOf(tree.nodes.values.first { it.name == "a.txt" }.id))
    }

    @Test
    fun anUnknownOpenModeIsRefused() = runTest {
        refused("invalid_argument") { provider().open("/docs/a.txt", "append") }
    }

    @Test
    fun openingADirectoryIsRefused() = runTest {
        refused("is_a_directory") { provider().open("/docs", "read") }
    }

    // ---- mkdir / delete / rename / truncate ---------------------------------

    @Test
    fun mkdirRefusesAnExistingNameAndTheRoot() = runTest {
        val provider = provider()
        provider.mkdir("/docs/sub")
        assertTrue(provider.stat("/docs/sub").isDir)
        refused("already_exists") { provider.mkdir("/docs/sub") }
        refused("already_exists") { provider.mkdir("/") }
    }

    @Test
    fun deleteRefusesTheShareRoot() = runTest {
        /* Deleting the granted root would revoke the share from inside a file operation. */
        refused("invalid_path") { provider().delete("/", true) }
        refused("invalid_path") { provider().delete("", true) }
    }

    @Test
    fun deleteRefusesANonEmptyDirectoryUnlessRecursive() = runTest {
        val provider = provider()
        /* SAF deletes a tree unconditionally, so a non-recursive request has to be refused here or it
         * silently becomes recursive: data loss the peer did not ask for. */
        refused("not_empty") { provider.delete("/docs", false) }
        assertTrue(provider.stat("/docs").isDir)
        provider.delete("/docs", true)
        refused("not_found") { provider.stat("/docs") }
    }

    @Test
    fun renameWithinTheSameDirectory() = runTest {
        val provider = provider()
        provider.rename("/docs/a.txt", "/docs/b.txt")
        assertEquals("/docs/b.txt", provider.stat("/docs/b.txt").path)
        refused("not_found") { provider.stat("/docs/a.txt") }
    }

    @Test
    fun renameRefusesTheCasesThatWouldDetachOrClobber() = runTest {
        val provider = provider()
        tree.addFile(docs, "taken.txt", "x")
        refused("already_exists") { provider.rename("/docs/a.txt", "/docs/taken.txt") }
        refused("invalid_path") { provider.rename("/docs/a.txt", "/docs/a.txt") }
        refused("invalid_path") { provider.rename("/docs", "/") }
        /* Moving a directory inside itself makes it its own ancestor, and everything under it stops
         * resolving from the root. */
        refused("invalid_path") { provider.rename("/docs", "/docs/inner") }
        refused("invalid_path") { provider.rename("/docs/a.txt", "/docs/../a.txt") }
    }

    @Test
    fun aCrossDirectoryMoveIsRefusedWhenTheProviderCannotMove() = runTest {
        val other = tree.addDirectory(tree.rootId, "other")
        val provider = provider()

        tree.supportsMove = false
        /* Refused rather than emulated with copy-then-delete: a copy that fails halfway leaves two
         * partial files while the peer believes it moved one. */
        refused("unsupported") { provider.rename("/docs/a.txt", "/other/a.txt") }

        tree.supportsMove = true
        provider.rename("/docs/a.txt", "/other/moved.txt")
        assertEquals("/other/moved.txt", provider.stat("/other/moved.txt").path)
        assertEquals(0, tree.children(other).count { it.name == "a.txt" })
    }

    @Test
    fun truncateRefusesNegativeSizesAndDirectoriesAndReleasesItsDescriptor() = runTest {
        val provider = provider()
        refused("invalid_argument") { provider.truncate("/docs/a.txt", -1L) }
        refused("is_a_directory") { provider.truncate("/docs", 0L) }
        provider.truncate("/docs/a.txt", 5L)
        assertEquals("hello", tree.contentOf(tree.nodes.values.first { it.name == "a.txt" }.id))
        /* truncate opens a descriptor that is not tracked in `handles`, so nothing else would ever
         * close it. */
        assertEquals(emptyList<String>(), tree.liveAccess)
    }

    // ---- a revoked grant ----------------------------------------------------

    @Test
    fun aVanishedRootIsReportedRatherThanCrashing() = runTest {
        /* The user can revoke a SAF grant at any moment and nothing notifies the app. */
        val vanished = SafZft2FileProvider(FakeDocumentTree("gone-root").also { it.nodes.clear() }, readOnly = false)
        refused("not_found") { vanished.stat("/anything") }
        refused("not_found") { vanished.list("/") }
    }

    @Test
    fun theRootItselfStats() = runTest {
        val root = provider().stat("/")
        assertTrue(root.isDir)
        assertEquals("/", root.path)
        assertEquals("", root.name)
        assertEquals(0L, root.size)
    }
}
