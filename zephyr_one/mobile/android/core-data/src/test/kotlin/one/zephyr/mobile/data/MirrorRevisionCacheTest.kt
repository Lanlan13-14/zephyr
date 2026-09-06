package one.zephyr.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class MirrorRevisionCacheTest {

    @Test
    fun `an existing mirror revision is cached before secret policy runs`() {
        val revisions = mutableMapOf<EntityKey, Long?>()
        val key = EntityKey("connection", "c-1")

        val resolved = rememberResolvedRevision(
            revisions = revisions,
            key = key,
            mirrorRevision = 2L,
            tombstoneRevision = 7L,
        )

        assertEquals(2L, resolved)
        assertEquals(2L, revisions[key])
    }

    @Test
    fun `a tombstone revision is cached when the mirror row is absent`() {
        val revisions = mutableMapOf<EntityKey, Long?>()
        val key = EntityKey("connection", "c-1")

        val resolved = rememberResolvedRevision(
            revisions = revisions,
            key = key,
            mirrorRevision = null,
            tombstoneRevision = 7L,
        )

        assertEquals(7L, resolved)
        assertEquals(7L, revisions[key])
    }
}
