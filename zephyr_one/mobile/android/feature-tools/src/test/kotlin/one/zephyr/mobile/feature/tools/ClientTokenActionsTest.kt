package one.zephyr.mobile.feature.tools

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.ClientTokenManagementPort
import one.zephyr.mobile.network.ManagedClientToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientTokenActionsTest {

    @Test
    fun `rotate caches minted secret before requesting mirror refresh`() = runTest {
        val order = mutableListOf<String>()
        val cache = RecordingSecretCache(order)
        val port = FakeTokenManagementPort().apply { rotated = success(token("token-1")) }
        val subject = ClientTokenActions(port, cache, localMode = false) { order += "sync" }

        val result = subject.rotate("token-1", "password")

        assertTrue(result is ApiResult.Success)
        assertEquals(listOf("replace:token-1", "sync"), order)
        assertEquals(TOKEN_SECRET, cache.secrets.getValue("token-1"))
    }

    @Test
    fun `reset clears every old secret before caching the only replacement`() = runTest {
        val order = mutableListOf<String>()
        val cache = RecordingSecretCache(order).apply { secrets["old"] = "old-secret-value-123" }
        val port = FakeTokenManagementPort().apply { reset = success(token("fresh")) }
        val subject = ClientTokenActions(port, cache, localMode = false) { order += "sync" }

        val result = subject.resetAll("One Android", "123456")

        assertTrue(result is ApiResult.Success)
        assertEquals(listOf("forgetAll", "replace:fresh", "sync"), order)
        assertEquals(mapOf("fresh" to TOKEN_SECRET), cache.secrets)
    }

    @Test
    fun `local mode refuses management without touching network or cache`() = runTest {
        val port = FakeTokenManagementPort()
        val cache = RecordingSecretCache(mutableListOf())
        val subject = ClientTokenActions(port, cache, localMode = true)

        val result = subject.create("One Android")

        assertTrue(result is ApiResult.Failure)
        assertEquals("main_end_unavailable", (result as ApiResult.Failure).error.code)
        assertEquals(0, port.calls)
        assertTrue(cache.secrets.isEmpty())
    }

    @Test
    fun `cache failure is non retryable because the server already rotated`() = runTest {
        val port = FakeTokenManagementPort().apply { rotated = success(token("token-1")) }
        val cache = object : ClientTokenSecretCache {
            override fun replace(tokenId: String, secret: String) = error("keystore unavailable")
            override fun forget(tokenId: String) = Unit
            override suspend fun forgetAll() = Unit
        }
        var syncRequested = false
        val subject = ClientTokenActions(port, cache, localMode = false) { syncRequested = true }

        val result = subject.rotate("token-1", "password")

        assertTrue(result is ApiResult.Failure)
        val error = (result as ApiResult.Failure).error
        assertEquals("client_token_cache_failed", error.code)
        assertFalse(error.retryable)
        assertFalse(syncRequested)
    }

    private fun token(id: String) = ManagedClientToken(
        id = id,
        name = "One Android",
        secret = TOKEN_SECRET,
        revision = 2,
        createdAt = 100,
        updatedAt = 200,
        lastUsedAt = null,
    )

    private fun success(token: ManagedClientToken): ApiResult<ManagedClientToken> =
        ApiResult.Success(token, requestId = "request-1")

    private companion object {
        const val TOKEN_SECRET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"
    }
}

private class RecordingSecretCache(
    private val order: MutableList<String>,
) : ClientTokenSecretCache {
    val secrets = linkedMapOf<String, String>()

    override fun replace(tokenId: String, secret: String) {
        order += "replace:$tokenId"
        secrets[tokenId] = secret
    }

    override fun forget(tokenId: String) {
        order += "forget:$tokenId"
        secrets.remove(tokenId)
    }

    override suspend fun forgetAll() {
        order += "forgetAll"
        secrets.clear()
    }
}

private class FakeTokenManagementPort : ClientTokenManagementPort {
    var calls: Int = 0
    var created: ApiResult<ManagedClientToken>? = null
    var revealed: ApiResult<ManagedClientToken>? = null
    var rotated: ApiResult<ManagedClientToken>? = null
    var deleted: ApiResult<Unit>? = null
    var reset: ApiResult<ManagedClientToken>? = null

    override suspend fun create(name: String): ApiResult<ManagedClientToken> {
        calls++
        return checkNotNull(created)
    }

    override suspend fun reveal(tokenId: String, verificationSecret: String): ApiResult<ManagedClientToken> {
        calls++
        return checkNotNull(revealed)
    }

    override suspend fun rotate(tokenId: String, verificationSecret: String): ApiResult<ManagedClientToken> {
        calls++
        return checkNotNull(rotated)
    }

    override suspend fun delete(tokenId: String, verificationSecret: String): ApiResult<Unit> {
        calls++
        return checkNotNull(deleted)
    }

    override suspend fun resetAll(name: String, verificationSecret: String): ApiResult<ManagedClientToken> {
        calls++
        return checkNotNull(reset)
    }
}
