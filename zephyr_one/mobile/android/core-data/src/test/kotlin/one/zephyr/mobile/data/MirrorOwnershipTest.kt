package one.zephyr.mobile.data

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.contracts.SyncAction
import one.zephyr.mobile.model.SyncChange
import one.zephyr.mobile.security.ResidencyViolationException
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class MirrorOwnershipTest {

    @Test
    fun `known upsert without owner rejects the complete page`() {
        val page = listOf(
            change(1, payload = ownedPayload()),
            change(2, entityId = "missing-owner", payload = JsonObject(emptyMap())),
        )

        val error = expectResidencyViolation { requireOwnedChanges(page, BOUND_USER) }

        assertEquals("refusing connection/missing-owner: missing or invalid ownerUserId", error.message)
    }

    @Test
    fun `non string owner values are rejected instead of coerced`() {
        val invalidOwners = listOf(JsonPrimitive(42), JsonPrimitive(true), JsonNull)

        for (owner in invalidOwners) {
            expectResidencyViolation {
                requireOwnedChanges(
                    listOf(change(1, payload = JsonObject(mapOf("ownerUserId" to owner)))),
                    BOUND_USER,
                )
            }
        }
    }

    @Test
    fun `foreign owner rejects the page before any later processing`() {
        val error = expectResidencyViolation {
            requireOwnedChanges(
                listOf(change(1, payload = ownedPayload("another-user"))),
                BOUND_USER,
            )
        }

        assertEquals("refusing foreign-owned connection/c-1", error.message)
    }

    @Test
    fun `delete proves owner from tombstone and fails closed when absent`() {
        requireOwnedChanges(
            listOf(
                change(
                    seq = 1,
                    action = SyncAction.DELETE,
                    payload = JsonObject(emptyMap()),
                    tombstone = ownedPayload(),
                ),
            ),
            BOUND_USER,
        )

        expectResidencyViolation {
            requireOwnedChanges(
                listOf(
                    change(
                        seq = 2,
                        action = SyncAction.DELETE,
                        payload = ownedPayload(),
                        tombstone = JsonObject(emptyMap()),
                    ),
                ),
                BOUND_USER,
            )
        }
    }

    @Test
    fun `unknown future entity remains skippable without weakening known owner checks`() {
        requireOwnedChanges(
            listOf(
                change(1, entityType = "futureEntity", payload = JsonObject(emptyMap())),
                change(2, entityId = "owned", payload = ownedPayload()),
            ),
            BOUND_USER,
        )
    }

    private fun change(
        seq: Long,
        entityType: String = "connection",
        entityId: String = "c-1",
        action: SyncAction = SyncAction.UPSERT,
        payload: JsonObject,
        tombstone: JsonObject? = null,
    ) = SyncChange(
        changeSeq = seq,
        entityType = entityType,
        entityId = entityId,
        action = action,
        revision = 1,
        changedAt = 1,
        payload = payload,
        tombstone = tombstone,
    )

    private fun ownedPayload(owner: String = BOUND_USER) =
        JsonObject(mapOf("ownerUserId" to JsonPrimitive(owner)))

    private fun expectResidencyViolation(block: () -> Unit): ResidencyViolationException =
        try {
            block()
            fail("expected ResidencyViolationException")
            error("unreachable")
        } catch (error: ResidencyViolationException) {
            error
        }

    private companion object {
        const val BOUND_USER = "user-1"
    }
}
