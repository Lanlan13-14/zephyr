package one.zephyr.mobile.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CredentialStoreTest {

    @Test
    fun `rotation failure before commit leaves complete old pair`() {
        val persistence = FakeCredentialPersistence()
        val store = CredentialStore(persistence, SCOPE)
        store.replaceBindingCredentials("access-old", 100_000L, "refresh-old")
        persistence.failure = CommitFailure.BEFORE

        expectCommitFailure {
            store.replaceBindingCredentials("access-new", 200_000L, "refresh-new")
        }

        assertEquals("access-old", store.accessCredential())
        assertEquals("refresh-old", store.refreshCredential())
        assertEquals(100_000L, store.accessExpiresAt())
    }

    @Test
    fun `rotation failure after commit exposes complete new pair after recreation`() {
        val persistence = FakeCredentialPersistence()
        CredentialStore(persistence, SCOPE).replaceBindingCredentials(
            "access-old",
            100_000L,
            "refresh-old",
        )
        persistence.failure = CommitFailure.AFTER

        expectCommitFailure {
            CredentialStore(persistence, SCOPE).replaceBindingCredentials(
                "access-new",
                200_000L,
                "refresh-new",
            )
        }

        val recreated = CredentialStore(persistence, SCOPE)
        assertEquals("access-new", recreated.accessCredential())
        assertEquals("refresh-new", recreated.refreshCredential())
        assertEquals(200_000L, recreated.accessExpiresAt())
    }

    @Test
    fun `stale account or generation cannot open another binding record`() {
        val persistence = FakeCredentialPersistence()
        val current = CredentialStore(persistence, SCOPE)
        current.replaceBindingCredentials("access", 100_000L, "refresh")
        current.storeSid("management-sid")

        val staleGeneration = CredentialStore(
            persistence,
            SCOPE.copy(generation = "8:older"),
        )
        val differentAccount = CredentialStore(
            persistence,
            CredentialScope("server/other-user/device", SCOPE.generation),
        )

        for (stale in listOf(staleGeneration, differentAccount)) {
            assertNull(stale.accessCredential())
            assertNull(stale.refreshCredential())
            assertNull(stale.sid())
            assertTrue(stale.accessNeedsRefresh(1L))
        }
        assertEquals("access", current.accessCredential())
        assertEquals("refresh", current.refreshCredential())
    }

    @Test
    fun `rotation preserves management SID and persisted expiry`() {
        val persistence = FakeCredentialPersistence()
        val store = CredentialStore(persistence, SCOPE)
        store.storeSid("management-sid")
        store.replaceBindingCredentials("access", 120_000L, "refresh")

        val recreated = CredentialStore(persistence, SCOPE)
        assertEquals("management-sid", recreated.sid())
        assertFalse(recreated.accessNeedsRefresh(59_999L))
        assertTrue(recreated.accessNeedsRefresh(60_000L))

        recreated.clearSid()
        assertNull(recreated.sid())
        assertEquals("access", recreated.accessCredential())
        assertEquals("refresh", recreated.refreshCredential())
    }

    private fun expectCommitFailure(block: () -> Unit) {
        try {
            block()
            fail("expected simulated commit failure")
        } catch (expected: SimulatedCommitFailure) {
            Unit
        }
    }

    private companion object {
        val SCOPE = CredentialScope("server/user/device", "9:1234")
    }
}

private enum class CommitFailure { NONE, BEFORE, AFTER }

private class SimulatedCommitFailure : RuntimeException()

private class FakeCredentialPersistence : CredentialPersistence {
    private var record: ByteArray? = null
    var failure: CommitFailure = CommitFailure.NONE

    override fun read(): ByteArray? = record?.copyOf()

    override fun replace(record: ByteArray) {
        if (failure == CommitFailure.BEFORE) throw SimulatedCommitFailure()
        this.record?.fill(0)
        this.record = record.copyOf()
        if (failure == CommitFailure.AFTER) throw SimulatedCommitFailure()
    }

    override fun delete() {
        record?.fill(0)
        record = null
    }
}
