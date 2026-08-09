package one.zephyr.mobile.feature.filesync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The SAF grant lifecycle.
 *
 * The pair under test is (what the user granted) and (what the share config claims). On Android those
 * drift constantly: the config is durable app state, the grant is revocable system state, and nothing
 * notifies the app when it goes. DEVELOPMENT.md 3 additionally forbids syncing a tree URI to another
 * device, so the target device must re-authorise rather than inherit.
 */
class SafShareGrantsTest {

    private val permissions = FakeUriPermissions()
    private val grants = SafShareGrants(permissions)

    private val tree = "content://com.android.externalstorage.documents/tree/primary%3ADocuments"

    @Test
    fun authorizingStoresAWritableShareWhenTheSystemGrantsWrite() {
        val grant = grants.authorize("p1", "DOCUMENTS", tree, requestWrite = true)
        assertEquals("DOCUMENTS", grant?.shareName)
        assertEquals(false, grant?.readOnly)
        assertEquals(true, grant?.grantValid)
        assertEquals(listOf("p1"), grants.usable().map { it.profileId })
    }

    @Test
    fun aReadOnlyGrantNarrowsTheShareEvenWhenTheConfigAskedForWrite() {
        /* DEVELOPMENT.md 13.2 takes the strictest of the layers. Offering a writable share over a
         * read-only grant is what produces the corrupted half-copy on the Windows side. */
        permissions.readOnlyUris += tree
        val grant = grants.authorize("p1", "PHONE", tree, requestWrite = true)
        assertEquals(true, grant?.readOnly)
        assertEquals(true, grant?.grantValid)
    }

    @Test
    fun aConfigThatAsksForReadOnlyIsNeverWidenedByAWritableGrant() {
        val grant = grants.authorize("p1", "PHONE", tree, requestWrite = false)
        assertEquals(true, grant?.readOnly)
        /* And it stays read-only on every later read, rather than being recomputed from the grant. */
        assertEquals(true, grants.grant("p1")?.readOnly)
    }

    @Test
    fun anUnnamedShareGetsTheSameDefaultLabelAsTheRdpPolicy() {
        assertEquals("PHONE", grants.authorize("p1", "   ", tree, requestWrite = false)?.shareName)
    }

    @Test
    fun aRefusedPermissionStoresNothing() {
        /* takePersistableUriPermission fails when the URI did not come from a picker result. A share
         * that cannot survive a restart is worse than an absent one, so nothing is stored. */
        permissions.refuse += tree
        assertNull(grants.authorize("p1", "PHONE", tree, requestWrite = true))
        assertEquals(emptyList<SafShareGrant>(), grants.all())
    }

    @Test
    fun revokedOutsideTheAppTheShareIsReportedInvalidRatherThanMissing() {
        grants.authorize("p1", "DOCUMENTS", tree, requestWrite = true)
        permissions.revokeOutsideTheApp(tree)

        val grant = grants.grant("p1")
        /* Still returned: the UI has to name which directory needs re-authorising, and it cannot do
         * that from a null. */
        assertEquals("DOCUMENTS", grant?.shareName)
        assertEquals(false, grant?.grantValid)
        /* And narrowed, so nothing offers a write against a grant that is gone. */
        assertEquals(true, grant?.readOnly)
        assertEquals(emptyList<String>(), grants.usable().map { it.profileId })
    }

    @Test
    fun revokingReleasesTheSystemGrant() {
        grants.authorize("p1", "PHONE", tree, requestWrite = true)
        grants.revoke("p1")
        /* Releasing matters: a grant left behind keeps the app able to read a directory the user has
         * removed from the app's own list, which is the ambient access SAF exists to avoid. */
        assertEquals(listOf(tree), permissions.released)
        assertNull(grants.grant("p1"))
    }

    @Test
    fun revokingOneOfTwoSharesOverTheSameTreeKeepsTheGrant() {
        /* Multiple profiles over one directory is legal (DEVELOPMENT.md 13.2). Releasing on the first
         * removal would silently break the second. */
        grants.authorize("p1", "PHONE", tree, requestWrite = true)
        grants.authorize("p2", "DOCUMENTS", tree, requestWrite = false)

        grants.revoke("p1")
        assertEquals(emptyList<String>(), permissions.released)
        assertEquals(true, grants.grant("p2")?.grantValid)

        grants.revoke("p2")
        assertEquals(listOf(tree), permissions.released)
    }

    @Test
    fun pruningDropsRevokedSharesAndNamesThem() {
        val second = tree + "%2FOther"
        grants.authorize("p1", "PHONE", tree, requestWrite = true)
        grants.authorize("p2", "OTHER", second, requestWrite = true)

        permissions.revokeOutsideTheApp(tree)
        /* Called on foreground resume, where DEVELOPMENT.md 13.5 requires the binding and the
         * file-bridge lease to be re-verified before reconnecting. */
        assertEquals(listOf("p1"), grants.pruneRevoked())
        assertNull(grants.grant("p1"))
        assertEquals(true, grants.grant("p2")?.grantValid)
    }

    @Test
    fun anUnknownProfileIsNull() {
        assertNull(grants.grant("nope"))
        assertFalse(grants.all().any { it.profileId == "nope" })
    }

    @Test
    fun theTreeUriIsTheOnlyDeviceBoundFieldAndItIsStoredVerbatim() {
        /* Stored as given, never rewritten: it is an opaque provider string, and normalising it would
         * make it stop matching the persisted-permission list. */
        val grant = grants.authorize("p1", "PHONE", tree, requestWrite = false)
        assertEquals(tree, grant?.treeUri)
        assertTrue(grants.usable().single().treeUri == tree)
    }
}
