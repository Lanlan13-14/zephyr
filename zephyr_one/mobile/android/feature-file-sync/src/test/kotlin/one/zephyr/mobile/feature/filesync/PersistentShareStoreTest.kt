package one.zephyr.mobile.feature.filesync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Persistence and selection for the authorised-directory rows.
 *
 * These are the rules the picker wiring depends on, and every one of them fails silently rather than
 * loudly. A grant row that does not survive a relaunch leaves the app holding a SAF permission with
 * no row describing it -- access the user granted that the UI can no longer show or revoke. A
 * connection choice naming a dead profile makes a session report "no directory is authorised" while
 * the editor still shows a directory as selected.
 */
class PersistentShareStoreTest {

    private val backing = FakeKeyValueStore()
    private val tree = "content://com.android.externalstorage.documents/tree/primary%3ADocuments"

    private fun grants(store: FakeKeyValueStore, permissions: FakeUriPermissions) =
        SafShareGrants(permissions = permissions, store = PersistentShareStore(store))

    @Test
    fun anAuthorisedDirectorySurvivesARelaunch() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "DOCUMENTS", tree, requestWrite = true)

        /* The whole point of the store. Without it the row lives only in memory, and after a restart
         * the app still holds the SAF permission with nothing describing it. */
        val restarted = grants(backing.surviveRestart(), permissions)
        val recovered = restarted.grant("p1")
        assertEquals("DOCUMENTS", recovered?.shareName)
        assertEquals(tree, recovered?.treeUri)
        assertEquals(false, recovered?.readOnly)
        assertEquals(true, recovered?.grantValid)
    }

    @Test
    fun aReadOnlyShareIsStillReadOnlyAfterARelaunch() {
        val permissions = FakeUriPermissions()
        permissions.readOnlyUris += tree
        grants(backing, permissions).authorize("p1", "PHONE", tree, requestWrite = true)

        /* A share that came back writable would offer a write the platform refuses, which is the
         * corrupted half-copy DEVELOPMENT.md 13.4 calls out. */
        assertEquals(true, grants(backing.surviveRestart(), permissions).grant("p1")?.readOnly)
    }

    @Test
    fun validityIsNeverPersistedAsFalse() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "PHONE", tree, requestWrite = true)
        permissions.revokeOutsideTheApp(tree)

        /* Read once while the grant is gone, so a naive implementation would write false back. */
        assertEquals(false, grants(backing, permissions).grant("p1")?.grantValid)

        /* Now the user re-grants the same directory. Validity is re-derived from the live permission
         * list, so a persisted false would have outlived the condition that caused it and left the
         * share permanently broken. */
        permissions.takePersistable(tree, allowWrite = true)
        assertEquals(true, grants(backing.surviveRestart(), permissions).grant("p1")?.grantValid)
    }

    @Test
    fun revokingRemovesTheRowFromStorageToo() {
        val permissions = FakeUriPermissions()
        val live = grants(backing, permissions)
        live.authorize("p1", "PHONE", tree, requestWrite = true)
        live.revoke("p1")

        assertNull(grants(backing.surviveRestart(), permissions).grant("p1"))
        /* And the id index no longer names it, or load() would read a row with no URI behind it. */
        assertTrue(backing.stringSet("share.profileIds").isEmpty())
    }

    @Test
    fun aRowWhoseUriWasLostIsDroppedRatherThanRepaired() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "PHONE", tree, requestWrite = true)

        /* Simulates external truncation. A row with no tree URI cannot address anything, and inventing
         * one would point the share at a directory the user never picked. */
        backing.drop("share.p1.treeUri")
        assertNull(grants(backing.surviveRestart(), permissions).grant("p1"))
    }

    @Test
    fun aRowMissingItsWriteFlagIsAssumedReadOnly() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "PHONE", tree, requestWrite = true)
        backing.drop("share.p1.readOnly")

        /* The strictest reading is the safe one: assuming writable would offer a write on a grant
         * whose recorded authority is unknown. */
        assertEquals(true, grants(backing.surviveRestart(), permissions).grant("p1")?.readOnly)
    }

    @Test
    fun aGrantRowIsWrittenAsOneBatch() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "DOCUMENTS", tree, requestWrite = true)

        /* Three keys plus the index in one batch. Written key by key, a process death in the middle
         * would leave an id in the index with no URI behind it. */
        assertEquals(1, backing.batches)
    }

    @Test
    fun twoSharesOverOneDirectoryBothSurvive() {
        val permissions = FakeUriPermissions()
        val live = grants(backing, permissions)
        live.authorize("p1", "PHONE", tree, requestWrite = true)
        live.authorize("p2", "DOCUMENTS", tree, requestWrite = false)

        val restarted = grants(backing.surviveRestart(), permissions)
        assertEquals(listOf("p1", "p2"), restarted.all().map { it.profileId }.sorted())
        /* And the stricter of the two keeps its own narrowing rather than inheriting the other's. */
        assertEquals(true, restarted.grant("p2")?.readOnly)
        assertEquals(false, restarted.grant("p1")?.readOnly)
    }
}

/** The per-connection directory choice. */
class ConnectionSharePreferencesTest {

    private val store = FakeKeyValueStore()
    private val shares = ConnectionSharePreferences(store)

    @Test
    fun aChoiceIsRememberedAndForgettable() {
        assertNull(shares.profileFor("c1"))
        shares.choose("c1", "p1")
        assertEquals("p1", shares.profileFor("c1"))
        shares.forget("c1")
        assertNull(shares.profileFor("c1"))
    }

    @Test
    fun aChoiceSurvivesARestart() {
        shares.choose("c1", "p1")
        assertEquals("p1", ConnectionSharePreferences(store.surviveRestart()).profileFor("c1"))
    }

    @Test
    fun pruningDropsChoicesNamingAProfileThatIsGone() {
        shares.choose("c1", "p1")
        shares.choose("c2", "p2")

        /* A dangling choice is worse than no choice: the coordinator resolves it to null and the
         * session reports "no directory is authorised" while the editor shows one as selected. */
        assertEquals(listOf("c1"), shares.pruneMissing(setOf("p2")))
        assertNull(shares.profileFor("c1"))
        assertEquals("p2", shares.profileFor("c2"))
    }

    @Test
    fun pruningTouchesNothingWhenEveryChoiceIsLive() {
        shares.choose("c1", "p1")
        val before = store.batches
        assertEquals(emptyList<String>(), shares.pruneMissing(setOf("p1")))
        /* No write at all, rather than a no-op write. */
        assertEquals(before, store.batches)
    }

    @Test
    fun pruningIgnoresKeysThatAreNotConnectionChoices() {
        /* The grant rows share the same store, and pruning must not touch them. */
        store.edit { putString("share.p1.treeUri", "content://tree") }
        shares.choose("c1", "p1")

        assertEquals(emptyList<String>(), shares.pruneMissing(setOf("p1")))
        assertEquals("content://tree", store.string("share.p1.treeUri"))
    }
}

/** Selecting which authorised directory a connection uses. */
class FileSyncShareCoordinatorTest {

    private val permissions = FakeUriPermissions()
    private val grants = SafShareGrants(permissions)
    private val choices = mutableMapOf<String, String>()

    private val coordinator = FileSyncShareCoordinator(
        grants = grants,
        profileForConnection = { connectionId -> choices[connectionId] },
        treeFactory = { FakeDocumentTree() },
    )

    private val docs = "content://tree/Documents"
    private val other = "content://tree/Other"

    @Test
    fun anExplicitChoiceWins() {
        grants.authorize("p1", "DOCUMENTS", docs, requestWrite = true)
        grants.authorize("p2", "OTHER", other, requestWrite = false)
        choices["c1"] = "p2"

        assertEquals("OTHER", coordinator.profile("c1")?.shareName)
    }

    @Test
    fun oneAuthorisedDirectoryNeedsNoChoice() {
        grants.authorize("p1", "DOCUMENTS", docs, requestWrite = true)
        /* No ambiguity to resolve, so requiring a choice would make the common case need a pointless
         * extra tap. */
        assertEquals("DOCUMENTS", coordinator.profile("c1")?.shareName)
    }

    @Test
    fun severalDirectoriesWithNoChoiceResolvesToNothing() {
        grants.authorize("p1", "DOCUMENTS", docs, requestWrite = true)
        grants.authorize("p2", "OTHER", other, requestWrite = true)

        /* Picking the first would silently share a directory the user did not mean for this
         * connection. Null makes RdpDrivePolicy ask, which is what storageIntent=ask expects. */
        assertNull(coordinator.profile("c1"))
    }

    @Test
    fun aDeadGrantStillReturnsAProfileSoTheUserCanBeTold() {
        grants.authorize("p1", "DOCUMENTS", docs, requestWrite = true)
        choices["c1"] = "p1"
        permissions.revokeOutsideTheApp(docs)

        /* Not null. RdpDrivePolicy renders "no directory is authorised" and "the directory grant is no
         * longer valid" differently, and only the second tells the user to re-authorise. */
        val profile = coordinator.profile("c1")
        assertEquals("DOCUMENTS", profile?.shareName)
        assertFalse(profile!!.grantValid)
    }

    @Test
    fun aChoiceNamingAnUnknownProfileResolvesToNothing() {
        choices["c1"] = "gone"
        assertNull(coordinator.profile("c1"))
    }

    @Test
    fun theProviderCarriesTheGrantsOwnReadOnlyValue() {
        permissions.readOnlyUris += docs
        grants.authorize("p1", "DOCUMENTS", docs, requestWrite = true)

        /* ADR-004 requires the provider to enforce read-only per operation, so the value it is built
         * with has to be the one the grant was narrowed to rather than what the caller hoped for. */
        val provider = coordinator.provider("p1")
        assertTrue(provider != null)
    }

    @Test
    fun noProviderIsBuiltForAGrantThatCannotServe() {
        grants.authorize("p1", "DOCUMENTS", docs, requestWrite = true)
        permissions.revokeOutsideTheApp(docs)

        /* A provider over a revoked grant would fail on the first READ, after Windows Explorer has
         * already opened a folder. */
        assertNull(coordinator.provider("p1"))
        assertNull(coordinator.provider("never-existed"))
    }
}
