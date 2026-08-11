package one.zephyr.mobile.data.repository

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.data.db.MirrorEntityRow
import one.zephyr.mobile.data.db.TombstoneRow
import one.zephyr.mobile.model.ClientToken
import one.zephyr.mobile.model.SecretRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ClientTokenRepositoryTest {

    @Test
    fun `orphan old token blob is never read without a current owner mirror`() = runTest {
        var reads = 0

        val revealed = revealLiveClientToken(
            id = TOKEN_ID,
            boundOwnerUserId = OWNER,
            grantId = GRANT,
            loadMirror = { null },
            loadTombstone = { null },
            readSecret = {
                reads += 1
                "old-token-secret"
            },
        )

        assertNull(revealed)
        assertEquals(0, reads)
    }

    @Test
    fun `foreign owner mirror cannot reveal a blob from the bound generation`() = runTest {
        var reads = 0

        val revealed = reveal(row(owner = "previous-owner")) {
            reads += 1
            "old-token-secret"
        }

        assertNull(revealed)
        assertEquals(0, reads)
    }

    @Test
    fun `false token presence rejects a stale blob without reading it`() = runTest {
        var reads = 0

        val revealed = reveal(row(hasToken = false)) {
            reads += 1
            "stale-token-secret"
        }

        assertNull(revealed)
        assertEquals(0, reads)
    }

    @Test
    fun `deleted or revoked mirror cannot reveal a retained blob`() = runTest {
        var reads = 0
        val deleted = reveal(row(deletedAt = 50L)) {
            reads += 1
            "deleted-token-secret"
        }
        val revoked = reveal(row(), tombstone = tombstone()) {
            reads += 1
            "revoked-token-secret"
        }

        assertNull(deleted)
        assertNull(revoked)
        assertEquals(0, reads)
    }

    @Test
    fun `live owner token with presence reads the canonical secret ref`() = runTest {
        var requestedRef: SecretRef? = null

        val revealed = reveal(row()) { ref ->
            requestedRef = ref
            "current-token-secret"
        }

        assertEquals("current-token-secret", revealed)
        assertEquals(SecretRef.of(ClientToken.ENTITY_TYPE, TOKEN_ID, "token"), requestedRef)
    }

    private suspend fun reveal(
        row: MirrorEntityRow,
        tombstone: TombstoneRow? = null,
        readSecret: (SecretRef) -> String?,
    ): String? = revealLiveClientToken(
        id = TOKEN_ID,
        boundOwnerUserId = OWNER,
        grantId = GRANT,
        loadMirror = { row },
        loadTombstone = { tombstone },
        readSecret = readSecret,
    )

    private fun row(
        owner: String = OWNER,
        hasToken: Boolean = true,
        deletedAt: Long? = null,
    ) = MirrorEntityRow(
        entityType = ClientToken.ENTITY_TYPE,
        entityId = TOKEN_ID,
        ownerUserId = owner,
        revision = 7,
        payloadJson = "{\"name\":\"Desktop\"}",
        secretPresenceJson = "{\"hasToken\":$hasToken}",
        deletedAt = deletedAt,
        serverUpdatedAt = 40,
        localUpdatedAt = 40,
    )

    private fun tombstone() = TombstoneRow(
        entityType = ClientToken.ENTITY_TYPE,
        entityId = TOKEN_ID,
        revision = 8,
        deletedAt = 50,
        authoritative = true,
    )

    private companion object {
        const val OWNER = "owner-current"
        const val TOKEN_ID = "token/hostile:id"
        const val GRANT = "grant-current"
    }
}
