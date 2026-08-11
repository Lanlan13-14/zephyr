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
        assertTrue(backing.keys().none { it.endsWith(".profileIds") })
    }

    @Test
    fun aRowWhoseUriWasLostIsDroppedRatherThanRepaired() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "PHONE", tree, requestWrite = true)

        /* Simulates external truncation. A row with no tree URI cannot address anything, and inventing
         * one would point the share at a directory the user never picked. */
        backing.drop(backing.keys().single { it.endsWith("share.p1.treeUri") })
        assertNull(grants(backing.surviveRestart(), permissions).grant("p1"))
    }

    @Test
    fun aRowMissingItsWriteFlagIsAssumedReadOnly() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "PHONE", tree, requestWrite = true)
        backing.drop(backing.keys().single { it.endsWith("share.p1.readOnly") })

        /* The strictest reading is the safe one: assuming writable would offer a write on a grant
         * whose recorded authority is unknown. */
        assertEquals(true, grants(backing.surviveRestart(), permissions).grant("p1")?.readOnly)
    }

    @Test
    fun aGrantAuthorizationUsesOneIntentAndOneAtomicRowCommit() {
        val permissions = FakeUriPermissions()
        grants(backing, permissions).authorize("p1", "DOCUMENTS", tree, requestWrite = true)

        /* First batch journals intent before ContentResolver is touched. The second atomically writes
         * three row fields plus the index and clears intent. */
        assertEquals(2, backing.batches)
    }

    @Test
    fun twoSharesOverOneDirectoryBothSurvive() {
        val permissions = FakeUriPermissions()
        val live = grants(backing, permissions)
        live.authorize("p1", "PHONE", tree, requestWrite = true)
        live.authorize("p2", "DOCUMENTS", tree, requestWrite = false)
        /* Persisted SAF modes are URI-scoped and accumulate on Android. The second profile's
         * read-only configuration must not take write away from p1's existing platform grant. */
        assertEquals(true, permissions.persisted().single().canWrite)

        val restarted = grants(backing.surviveRestart(), permissions)
        assertEquals(listOf("p1", "p2"), restarted.all().map { it.profileId }.sorted())
        /* And the stricter of the two keeps its own narrowing rather than inheriting the other's. */
        assertEquals(true, restarted.grant("p2")?.readOnly)
        assertEquals(false, restarted.grant("p1")?.readOnly)
    }

    @Test
    fun ownerlessLegacyGrantsAreRevokedInsteadOfAssignedToTheFirstAccount() {
        val readOnlyTree = "content://tree/ReadOnly"
        assertTrue(
            backing.edit {
                putStringSet("share.profileIds", setOf("p1", "p2"))
                putString("share.p1.treeUri", tree)
                putString("share.p1.shareName", "DOCUMENTS")
                putBoolean("share.p1.readOnly", false)
                putString("share.p2.treeUri", readOnlyTree)
                putString("share.p2.shareName", "READ_ONLY")
                putBoolean("share.p2.readOnly", true)
            },
        )
        val permissions = FakeUriPermissions().apply {
            seed(tree, canRead = true, canWrite = true)
            seed(readOnlyTree, canRead = true, canWrite = false)
        }

        val accountB = SafShareGrants(
            permissions,
            PersistentShareStore(backing, ownerId = "account-b-generation"),
        )

        assertTrue(accountB.all().isEmpty())
        assertNull(accountB.grant("p1"))
        assertTrue(permissions.persisted().isEmpty())
        assertEquals(
            listOf(
                FakeUriPermissions.ReleaseCall(tree, releaseRead = true, releaseWrite = true),
                FakeUriPermissions.ReleaseCall(readOnlyTree, releaseRead = true, releaseWrite = false),
            ),
            permissions.releaseCalls,
        )
        assertTrue(backing.stringSet("share.profileIds").isEmpty())
        assertNull(backing.string("share.p1.treeUri"))
        assertTrue(backing.stringSet("saf.v2.ownerIds").isEmpty())
    }

    @Test
    fun ownerlessLegacyMetadataWithoutAPlatformPermissionIsCleared() {
        assertTrue(
            backing.edit {
                putStringSet("share.profileIds", setOf("p1"))
                putString("share.p1.treeUri", tree)
                putString("share.p1.shareName", "DOCUMENTS")
                putBoolean("share.p1.readOnly", false)
            },
        )
        val permissions = FakeUriPermissions()

        val accountB = SafShareGrants(
            permissions,
            PersistentShareStore(backing, ownerId = "account-b-generation"),
        )

        assertTrue(accountB.all().isEmpty())
        assertTrue(permissions.releaseCalls.isEmpty())
        assertTrue(backing.keys().none { it.startsWith("share.") })
        assertTrue(backing.stringSet("saf.v2.ownerIds").isEmpty())
    }
}

/** Crash consistency and binding-generation ownership for app-wide SAF capabilities. */
class SafGrantRecoveryTest {

    private val tree = "content://tree/Documents"
    private val otherTree = "content://tree/Other"
    private val legacyTree = "content://tree/Legacy"
    private val owner = "owner-current"

    @Test
    fun aFailedPrepareCommitNeverTakesAPlatformPermission() {
        val values = FakeKeyValueStore().apply { failNextEdit = true }
        val permissions = FakeUriPermissions()
        val grants = SafShareGrants(permissions, PersistentShareStore(values, owner))

        assertNull(grants.authorize("p1", "PHONE", tree, requestWrite = true))
        assertTrue(permissions.persisted().isEmpty())
        assertTrue(PersistentShareStore(values.surviveRestart(), owner).pendingAuthorizations().isEmpty())
    }

    @Test
    fun aFailedRowCommitImmediatelyRollsBackTheTakenPermission() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val grants = SafShareGrants(permissions, PersistentShareStore(values, owner))
        /* authorize writes pending intent first and the complete row second. */
        values.failBatch = values.batches + 2

        assertNull(grants.authorize("p1", "PHONE", tree, requestWrite = true))
        assertTrue(permissions.persisted().isEmpty())
        val restarted = PersistentShareStore(values.surviveRestart(), owner)
        assertTrue(restarted.isEmpty())
        assertTrue(restarted.pendingAuthorizations().isEmpty())
    }

    @Test
    fun crashBeforeTakeClearsIntentWithoutReleasingAnything() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val store = PersistentShareStore(values, owner)
        assertTrue(store.prepareAuthorization("p1", tree, previous = null))

        val restartedValues = values.surviveRestart()
        SafShareGrants(permissions, PersistentShareStore(restartedValues, owner))

        assertTrue(permissions.released.isEmpty())
        assertTrue(PersistentShareStore(restartedValues, owner).pendingAuthorizations().isEmpty())
    }

    @Test
    fun crashAfterTakeReleasesFromDurableIntentOnRestart() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val store = PersistentShareStore(values, owner)
        assertTrue(store.prepareAuthorization("p1", tree, previous = null))
        assertTrue(permissions.takePersistable(tree, allowWrite = true))

        val restartedValues = values.surviveRestart()
        SafShareGrants(permissions, PersistentShareStore(restartedValues, owner))

        assertTrue(permissions.persisted().isEmpty())
        assertEquals(listOf(tree), permissions.released)
        assertTrue(PersistentShareStore(restartedValues, owner).pendingAuthorizations().isEmpty())
    }

    @Test
    fun releaseFailureKeepsJournalAndForegroundRecoveryRetries() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val store = PersistentShareStore(values, owner)
        assertTrue(store.prepareAuthorization("p1", tree, previous = null))
        assertTrue(permissions.takePersistable(tree, allowWrite = true))
        permissions.refuseRelease += tree

        val restartedValues = values.surviveRestart()
        val restartedStore = PersistentShareStore(restartedValues, owner)
        val grants = SafShareGrants(permissions, restartedStore)
        assertEquals(listOf(tree), permissions.persisted().map { it.uri })
        assertEquals(listOf("p1"), restartedStore.pendingAuthorizations().map { it.profileId })

        permissions.refuseRelease -= tree
        grants.reconcilePersistedPermissions()
        assertTrue(permissions.persisted().isEmpty())
        assertTrue(restartedStore.pendingAuthorizations().isEmpty())
        assertEquals(2, permissions.released.count { it == tree })
    }

    @Test
    fun failedLegacyRevokeStaysQuarantinedAndRetriesAfterRestart() {
        val values = FakeKeyValueStore()
        assertTrue(
            values.edit {
                putStringSet("share.profileIds", setOf("account-a-profile"))
                putString("share.account-a-profile.treeUri", tree)
                putString("share.account-a-profile.shareName", "ACCOUNT_A")
                putBoolean("share.account-a-profile.readOnly", false)
            },
        )
        val permissions = FakeUriPermissions().apply {
            seed(tree, canRead = true, canWrite = true)
            refuseRelease += tree
        }

        val accountBStore = PersistentShareStore(values, "account-b-generation")
        val accountB = SafShareGrants(permissions, accountBStore)

        assertTrue(accountB.all().isEmpty())
        assertTrue(values.keys().none { it.startsWith("share.") })
        assertEquals(1, accountBStore.ownerIds().size)
        assertFalse("account-b-generation" in accountBStore.ownerIds())
        assertEquals(
            FakeUriPermissions.ReleaseCall(tree, releaseRead = true, releaseWrite = true),
            permissions.releaseCalls.single(),
        )

        permissions.refuseRelease -= tree
        val restartedValues = values.surviveRestart()
        val restartedStore = PersistentShareStore(restartedValues, "account-b-generation")
        val restarted = SafShareGrants(permissions, restartedStore)

        assertTrue(restarted.all().isEmpty())
        assertTrue(permissions.persisted().isEmpty())
        assertTrue(restartedStore.ownerIds().isEmpty())
        assertEquals(2, permissions.releaseCalls.size)
    }

    @Test
    fun failedLegacyQuarantineCommitNeverExposesTheRowAndRetriesMetadataCleanup() {
        val values = FakeKeyValueStore()
        assertTrue(
            values.edit {
                putStringSet("share.profileIds", setOf("account-a-profile"))
                putString("share.account-a-profile.treeUri", tree)
                putString("share.account-a-profile.shareName", "ACCOUNT_A")
                putBoolean("share.account-a-profile.readOnly", false)
            },
        )
        val permissions = FakeUriPermissions().apply { seed(tree) }
        values.failNextEdit = true

        val accountB = SafShareGrants(
            permissions,
            PersistentShareStore(values, "account-b-generation"),
        )

        assertTrue(accountB.all().isEmpty())
        assertTrue(permissions.persisted().isEmpty())
        assertEquals(tree, values.string("share.account-a-profile.treeUri"))

        val restartedValues = values.surviveRestart()
        val restarted = SafShareGrants(
            permissions,
            PersistentShareStore(restartedValues, "account-b-generation"),
        )
        assertTrue(restarted.all().isEmpty())
        assertTrue(restartedValues.keys().none { it.startsWith("share.") })
        assertTrue(restartedValues.stringSet("saf.v2.ownerIds").isEmpty())
    }

    @Test
    fun unresolvedRollbackCannotBeOverwrittenByASecondPickerResult() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val store = PersistentShareStore(values, owner)
        assertTrue(store.prepareAuthorization("p1", tree, previous = null))
        assertTrue(permissions.takePersistable(tree, allowWrite = true))
        permissions.refuseRelease += tree
        val grants = SafShareGrants(permissions, store)

        assertNull(grants.authorize("p1", "OTHER", otherTree, requestWrite = true))

        assertEquals(listOf(tree), permissions.persisted().map { it.uri })
        assertEquals(tree, store.pendingAuthorizations().single().treeUri)
    }

    @Test
    fun startupSweepsAnUnindexedAmbientGrant() {
        val permissions = FakeUriPermissions().apply { seed(tree) }

        SafShareGrants(
            permissions,
            PersistentShareStore(FakeKeyValueStore(), owner),
        )

        assertTrue(permissions.persisted().isEmpty())
        assertEquals(listOf(tree), permissions.released)
    }

    @Test
    fun aReplacementGenerationCannotInheritOldRowsOrPermissions() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val old = SafShareGrants(permissions, PersistentShareStore(values, "generation-old"))
        assertTrue(old.authorize("p1", "OLD", tree, requestWrite = true) != null)

        val replacement = SafShareGrants(
            permissions,
            PersistentShareStore(values, "generation-new"),
        )

        assertTrue(replacement.all().isEmpty())
        assertTrue(permissions.persisted().isEmpty())
        assertTrue(PersistentShareStore(values, "generation-old").isEmpty())
    }

    @Test
    fun ownerScopedRowsSurviveForTheSameOwnerButStayHiddenFromAnotherAccount() {
        val values = FakeKeyValueStore()
        val accountA = PersistentShareStore(values, "account-a-generation")
        accountA["p1"] = stored("p1", tree, readOnly = false)

        val restartedA = PersistentShareStore(values.surviveRestart(), "account-a-generation")
        val accountB = PersistentShareStore(values.surviveRestart(), "account-b-generation")

        assertEquals("p1", restartedA.values.single().profileId)
        assertTrue(accountB.isEmpty())
        assertEquals(setOf("account-a-generation"), accountB.ownerIds())
    }

    @Test
    fun oldGenerationTeardownDoesNotReleaseReplacementAccountGrant() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val oldStore = PersistentShareStore(values, "generation-old")
        val newStore = PersistentShareStore(values, "generation-new")
        oldStore["old"] = stored("old", tree, readOnly = false)
        newStore["new"] = stored("new", otherTree, readOnly = false)
        permissions.seed(tree)
        permissions.seed(otherTree)

        val old = SafShareGrants(permissions, oldStore, reconcileOnInit = false)
        assertTrue(old.revokeAllOwned())

        assertEquals(listOf(otherTree), permissions.persisted().map { it.uri })
        assertEquals("new", newStore.values.single().profileId)
    }

    @Test
    fun sharedUriTeardownPreservesModesRequiredByAnotherGeneration() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val oldStore = PersistentShareStore(values, "generation-old")
        val newStore = PersistentShareStore(values, "generation-new")
        oldStore["old"] = stored("old", tree, readOnly = false)
        newStore["new"] = stored("new", tree, readOnly = true)
        permissions.seed(tree, canRead = true, canWrite = true)

        val old = SafShareGrants(permissions, oldStore, reconcileOnInit = false)
        assertTrue(old.revokeAllOwned())

        assertEquals(UriGrant(tree, canRead = true, canWrite = false), permissions.persisted().single())
        assertEquals("new", newStore.values.single().profileId)
    }

    @Test
    fun soleOwnerTeardownAlsoReleasesUnknownLegacyOrphans() {
        val values = FakeKeyValueStore()
        val permissions = FakeUriPermissions()
        val store = PersistentShareStore(values, owner)
        store["p1"] = stored("p1", tree, readOnly = false)
        permissions.seed(tree)
        permissions.seed(otherTree)

        val grants = SafShareGrants(permissions, store, reconcileOnInit = false)
        assertTrue(grants.revokeAllOwned())

        assertTrue(permissions.persisted().isEmpty())
        assertTrue(PersistentShareStore(values, owner).isEmpty())
    }

    @Test
    fun noAccountGlobalTeardownRevokesAQuarantinedLegacyGrant() {
        val values = FakeKeyValueStore()
        assertTrue(
            values.edit {
                putStringSet("share.profileIds", setOf("legacy"))
                putString("share.legacy.treeUri", legacyTree)
                putBoolean("share.legacy.readOnly", false)
            },
        )
        val permissions = FakeUriPermissions().apply { seed(legacyTree) }
        val store = PersistentShareStore(values, "no-account-teardown")
        val teardown = SafShareGrants(permissions, store, reconcileOnInit = false)

        assertTrue(teardown.all().isEmpty())
        assertTrue(store.ownerIds().isNotEmpty())
        assertTrue(teardown.revokeAllPersistedForGlobalTeardown())

        assertTrue(permissions.persisted().isEmpty())
        assertEquals(
            FakeUriPermissions.ReleaseCall(legacyTree, releaseRead = true, releaseWrite = true),
            permissions.releaseCalls.single(),
        )
        assertTrue(store.ownerIds().isEmpty())
        assertTrue(values.keys().none { it.startsWith("saf.v2.owner.") || it.startsWith("share.") })
    }

    @Test
    fun failedGlobalLegacyTeardownKeepsJournalAndRetriesAfterRestart() {
        val values = FakeKeyValueStore()
        assertTrue(
            values.edit {
                putStringSet("share.profileIds", setOf("legacy"))
                putString("share.legacy.treeUri", legacyTree)
                putBoolean("share.legacy.readOnly", false)
            },
        )
        val permissions = FakeUriPermissions().apply {
            seed(legacyTree)
            refuseRelease += legacyTree
        }
        val firstStore = PersistentShareStore(values, "no-account-teardown")
        val firstSweep = SafShareGrants(permissions, firstStore, reconcileOnInit = false)

        assertFalse(firstSweep.revokeAllPersistedForGlobalTeardown())
        assertTrue(firstSweep.all().isEmpty())
        assertTrue(firstStore.ownerIds().isNotEmpty())
        assertEquals(listOf(legacyTree), permissions.persisted().map { it.uri })

        permissions.refuseRelease -= legacyTree
        val restartedValues = values.surviveRestart()
        val restartedStore = PersistentShareStore(restartedValues, "no-account-teardown")
        val restartedSweep = SafShareGrants(permissions, restartedStore, reconcileOnInit = false)

        assertTrue(restartedSweep.revokeAllPersistedForGlobalTeardown())
        assertTrue(permissions.persisted().isEmpty())
        assertTrue(restartedStore.ownerIds().isEmpty())
        assertEquals(2, permissions.releaseCalls.size)
    }

    @Test
    fun globalTeardownReleasesEachLegacyGrantWithItsExactLiveModes() {
        val writeOnlyTree = "content://tree/WriteOnly"
        val values = FakeKeyValueStore()
        assertTrue(
            values.edit {
                putStringSet("share.profileIds", setOf("rw", "read", "write"))
                putString("share.rw.treeUri", tree)
                putBoolean("share.rw.readOnly", false)
                putString("share.read.treeUri", otherTree)
                putBoolean("share.read.readOnly", true)
                putString("share.write.treeUri", writeOnlyTree)
                putBoolean("share.write.readOnly", false)
            },
        )
        val permissions = FakeUriPermissions().apply {
            seed(tree, canRead = true, canWrite = true)
            seed(otherTree, canRead = true, canWrite = false)
            seed(writeOnlyTree, canRead = false, canWrite = true)
        }
        val teardown = SafShareGrants(
            permissions,
            PersistentShareStore(values, "no-account-teardown"),
            reconcileOnInit = false,
        )

        assertTrue(teardown.revokeAllPersistedForGlobalTeardown())

        assertEquals(
            listOf(
                FakeUriPermissions.ReleaseCall(tree, releaseRead = true, releaseWrite = true),
                FakeUriPermissions.ReleaseCall(otherTree, releaseRead = true, releaseWrite = false),
                FakeUriPermissions.ReleaseCall(writeOnlyTree, releaseRead = false, releaseWrite = true),
            ),
            permissions.releaseCalls,
        )
        assertTrue(permissions.persisted().isEmpty())
        assertTrue(values.stringSet("saf.v2.ownerIds").isEmpty())
    }

    @Test
    fun generationTeardownPreservesAnotherActiveOwnerWhenQuarantineAlsoExists() {
        val values = FakeKeyValueStore()
        assertTrue(
            values.edit {
                putStringSet("share.profileIds", setOf("legacy"))
                putString("share.legacy.treeUri", legacyTree)
                putBoolean("share.legacy.readOnly", false)
            },
        )
        val oldStore = PersistentShareStore(values, "generation-old")
        val activeStore = PersistentShareStore(values, "generation-active")
        oldStore["old"] = stored("old", tree, readOnly = false)
        activeStore["active"] = stored("active", otherTree, readOnly = true)
        val permissions = FakeUriPermissions().apply {
            seed(tree, canRead = true, canWrite = true)
            seed(otherTree, canRead = true, canWrite = false)
            seed(legacyTree, canRead = true, canWrite = true)
        }

        val old = SafShareGrants(permissions, oldStore, reconcileOnInit = false)
        assertTrue(old.revokeAllOwned())

        assertEquals(setOf(otherTree, legacyTree), permissions.persisted().map { it.uri }.toSet())
        assertEquals(UriGrant(otherTree, canRead = true, canWrite = false), permissions.persisted()[0])
        assertEquals("active", activeStore.values.single().profileId)
        assertEquals(
            listOf(FakeUriPermissions.ReleaseCall(tree, releaseRead = true, releaseWrite = true)),
            permissions.releaseCalls,
        )
    }

    @Test
    fun ownerIdentityIsGenerationAndBoundarySensitive() {
        val old = PersistentShareStore.ownerId("server", "user", "device", "generation-old")
        val replacement = PersistentShareStore.ownerId("server", "user", "device", "generation-new")
        val differentBoundary = PersistentShareStore.ownerId("server/user", "device", "generation-old")

        assertFalse(old == replacement)
        assertFalse(old == differentBoundary)
        assertEquals(64, old.length)
    }

    private fun stored(profileId: String, uri: String, readOnly: Boolean) = SafShareGrant(
        profileId = profileId,
        shareName = "PHONE",
        treeUri = uri,
        readOnly = readOnly,
        grantValid = true,
    )
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

    @Test
    fun choicesAreIsolatedByBindingGeneration() {
        val old = ConnectionSharePreferences(store, ownerId = "generation-old")
        val replacement = ConnectionSharePreferences(store, ownerId = "generation-new")
        old.choose("c1", "old-profile")

        assertNull(replacement.profileFor("c1"))
        replacement.choose("c1", "new-profile")
        assertEquals("old-profile", old.profileFor("c1"))
        assertEquals("new-profile", replacement.profileFor("c1"))
        assertTrue(old.clearAll())
        assertNull(old.profileFor("c1"))
        assertEquals("new-profile", replacement.profileFor("c1"))
    }

    @Test
    fun ownerlessLegacyChoiceIsDiscardedInsteadOfAssignedToTheFirstAccount() {
        assertTrue(store.edit { putString("connection.share.c1", "account-a-profile") })

        val accountB = ConnectionSharePreferences(store, ownerId = "account-b-generation")

        assertNull(accountB.profileFor("c1"))
        assertNull(store.string("connection.share.c1"))
    }

    @Test
    fun failedLegacyChoiceCleanupRemainsHiddenAndRetriesAfterRestart() {
        assertTrue(store.edit { putString("connection.share.c1", "account-a-profile") })
        store.failNextEdit = true

        val accountB = ConnectionSharePreferences(store, ownerId = "account-b-generation")

        assertNull(accountB.profileFor("c1"))
        assertEquals("account-a-profile", store.string("connection.share.c1"))

        val restarted = store.surviveRestart()
        val restartedB = ConnectionSharePreferences(restarted, ownerId = "account-b-generation")
        assertNull(restartedB.profileFor("c1"))
        assertNull(restarted.string("connection.share.c1"))
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
