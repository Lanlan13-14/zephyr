package one.zephyr.mobile.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import one.zephyr.mobile.model.BootstrapPage
import one.zephyr.mobile.model.ChangePage
import one.zephyr.mobile.model.PendingOperation
import one.zephyr.mobile.model.PushResponse
import one.zephyr.mobile.model.SecretEnvelope
import one.zephyr.mobile.model.ServerCapabilities
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.ValidatedAck
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Link transport's wire behaviour: every sync verb must encode the SAME DTO shape the HTTP
 * path sends (so the server-side core sees an identical request), route it under the right `op`
 * discriminator, and map a sealed failure onto a retryable ApiResult.Failure rather than throwing.
 */
class LinkSyncTransportTest {

    /** Records the op + body it was handed and replies with a canned ack. */
    private class FakeChannel(var established: Boolean = true) : LinkChannel {
        val calls = mutableListOf<Pair<String, JsonObject>>()
        var ackResponder: (String, JsonObject) -> JsonObject = { _, _ -> JsonObject(emptyMap()) }
        var throwOnCall: LinkChannelException? = null
        override val isEstablished: Boolean get() = established
        override suspend fun syncOp(op: String, body: JsonObject): JsonObject {
            throwOnCall?.let { throw it }
            calls += op to body
            return ackResponder(op, body)
        }
    }

    @Test
    fun `changes encodes sinceCursor under the changes op`() = runTest {
        val channel = FakeChannel()
        channel.ackResponder = { _, _ ->
            buildJsonObject {
                put("ok", true)
                put("fromCursor", 5)
                put("nextCursor", 5)
                put("hasMore", false)
                putJsonArray("changes") {}
            }
        }
        val transport = LinkSyncTransport(channel, "dev-1", NoopFallback)
        val result = transport.changes(sinceCursor = 5, limit = 50)
        assertTrue(result is ApiResult.Success)
        assertEquals(5L, (result as ApiResult.Success).value.nextCursor)
        assertEquals(1, channel.calls.size)
        assertEquals("changes", channel.calls[0].first)
        assertEquals(5L, channel.calls[0].second["sinceCursor"]!!.jsonPrimitive.longOrNull)
    }

    @Test
    fun `push carries the standard PushRequestDto fields under the push op`() = runTest {
        val channel = FakeChannel()
        channel.ackResponder = { _, _ ->
            buildJsonObject {
                put("ok", true)
                put("batchId", "batch-1")
                put("serverCursor", 11)
                put("changesAvailable", false)
                putJsonArray("results") {}
            }
        }
        val transport = LinkSyncTransport(channel, "dev-1", NoopFallback)
        val result = transport.push(
            batchId = "batch-1",
            baseCursor = 7,
            registryHash = "hash-1",
            operations = emptyList(),
            envelopes = emptyMap(),
        )
        assertTrue(result is ApiResult.Success)
        val (op, body) = channel.calls.single()
        assertEquals("push", op)
        assertEquals("batch-1", body["batchId"]!!.jsonPrimitive.content)
        assertEquals("hash-1", body["registryHash"]!!.jsonPrimitive.content)
        assertEquals("dev-1", body["deviceId"]!!.jsonPrimitive.content)
        assertEquals(7L, body["baseCursor"]!!.jsonPrimitive.longOrNull)
    }

    @Test
    fun `an unestablished channel surfaces a retryable failure, not a throw`() = runTest {
        val channel = FakeChannel(established = false)
        val transport = LinkSyncTransport(channel, "dev-1", NoopFallback)
        val result = transport.changes(sinceCursor = 0, limit = 50)
        assertTrue(result is ApiResult.Failure)
        assertTrue((result as ApiResult.Failure).error.retryable)
        assertEquals(0, channel.calls.size)
    }

    @Test
    fun `a channel exception surfaces as a retryable link failure`() = runTest {
        val channel = FakeChannel()
        channel.throwOnCall = LinkChannelException("seal failed")
        val transport = LinkSyncTransport(channel, "dev-1", NoopFallback)
        val result = transport.ack(cursor = 3, appliedOpIds = listOf("op-1"))
        assertTrue(result is ApiResult.Failure)
        assertEquals("link_unavailable", (result as ApiResult.Failure).error.code)
    }

    /** The HTTP fallback is never exercised by these tests; it exists so bootstrap/caps delegate. */
    private object NoopFallback : SyncTransport {
        private fun bomb(): Nothing = throw AssertionError("fallback must not be called in this test")
        override suspend fun capabilities(): ApiResult<ServerCapabilities> = bomb()
        override suspend fun bootstrap(pageToken: String?, pageSize: Int?): ApiResult<BootstrapPage> = bomb()
        override suspend fun changes(sinceCursor: Long, limit: Int?): ApiResult<ChangePage> = bomb()
        override suspend fun push(batchId: String, baseCursor: Long, registryHash: String,
            operations: List<PendingOperation>, envelopes: Map<String, Map<String, SecretEnvelope>>): ApiResult<PushResponse> = bomb()
        override suspend fun ack(cursor: Long, appliedOpIds: List<String>): ApiResult<ValidatedAck> = bomb()
    }
}
