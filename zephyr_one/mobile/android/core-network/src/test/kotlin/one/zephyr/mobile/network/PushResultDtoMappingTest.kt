package one.zephyr.mobile.network

import one.zephyr.mobile.network.dto.PushResponseDto
import one.zephyr.mobile.network.dto.ChangePageDto
import one.zephyr.mobile.network.dto.PushResultDto
import one.zephyr.mobile.network.dto.SyncChangeDto
import one.zephyr.mobile.network.dto.toDomain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PushResultDtoMappingTest {

    @Test
    fun `per-operation bootstrapRequired detail survives wire mapping`() {
        val dto = MobileJson.instance.decodeFromString(
            PushResponseDto.serializer(),
            """
            {
              "ok": true,
              "batchId": "batch-1",
              "serverCursor": 17,
              "results": [{
                "opId": "op-1",
                "status": "rejected",
                "error": {
                  "ok": false,
                  "error": {
                    "code": "cursor_invalid",
                    "message": "bootstrap required",
                    "retryable": false,
                    "requestId": "request-1",
                    "details": { "bootstrapRequired": true }
                  }
                }
              }],
              "changesAvailable": false
            }
            """.trimIndent(),
        )

        val result = dto.toDomain().results.single()

        assertEquals("cursor_invalid", result.error?.code)
        assertEquals("true", result.error?.details?.get("bootstrapRequired"))
        assertTrue(result.error?.requiresBootstrapRestart == true)
    }

    @Test
    fun `sync DTO mapping rejects invalid page progression and push result structures`() {
        val malformedPages = listOf(
            ChangePageDto(ok = true, fromCursor = 0, nextCursor = 1, hasMore = false, changes = emptyList()),
            ChangePageDto(ok = true, fromCursor = 0, nextCursor = 2, hasMore = false, changes = listOf(change(2))),
            ChangePageDto(ok = true, fromCursor = 0, nextCursor = 1, hasMore = false, changes = listOf(change(1), change(1))),
            ChangePageDto(ok = true, fromCursor = 0, nextCursor = 2, hasMore = false, changes = listOf(change(1))),
        )
        for (page in malformedPages) assertMalformed { page.toDomain() }

        assertMalformed {
            PushResponseDto(
                ok = true,
                batchId = "batch-1",
                serverCursor = 1,
                results = listOf(PushResultDto(opId = "op-1", status = "accepted")),
            ).toDomain()
        }
        assertMalformed {
            PushResponseDto(
                ok = true,
                batchId = "batch-1",
                serverCursor = 1,
                results = listOf(PushResultDto(opId = "op-1", status = "unknown")),
            ).toDomain()
        }
    }

    private fun change(seq: Long) = SyncChangeDto(
        changeSeq = seq,
        entityType = "connection",
        entityId = "c-1",
        action = "upsert",
        revision = 1,
        changedAt = 1,
    )

    private fun assertMalformed(block: () -> Unit) {
        try {
            block()
            fail("expected mapping to reject malformed sync data")
        } catch (_: IllegalArgumentException) {
            // Expected: malformed wire data never reaches the sync actor.
        }
    }
}
