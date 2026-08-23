package one.zephyr.mobile.sync

import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.model.ServerCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import one.zephyr.mobile.model.ServerEncryptionCapabilities
import one.zephyr.mobile.model.SyncTrigger

/**
 * The secret-sync link that was missing: the server has always published its ML-KEM key on
 * /capabilities, and the device has the full seal/open path, but nothing fed the key into the
 * app-layer key state, so canSeal() stayed false and every secret op deferred. These pin that the
 * actor surfaces the published key through [SyncActor]'s capabilities callback, which is the only
 * thing AccountContainer needs to wire ServerEncryptionKeyProvider.
 *
 * A bound store takes the short round (VALIDATE_BINDING first, no snapshot phases), which is
 * enough to exercise validateBinding without staging any bootstrap pages.
 */
class SyncActorCapabilitiesTest {

    private var now = 1_000L

    private fun actor(
        transport: FakeSyncTransport,
        store: FakeSyncLocalStore,
        onCapabilities: (ServerCapabilities) -> Unit,
    ) = SyncActor(
        transport = transport,
        store = store,
        sealer = NoSealer,
        blobs = NoBlobs,
        clock = { now },
        batchIdFactory = { "batch-fixed" },
        jitter = { 1.0 },
        onCapabilities = onCapabilities,
    )

    @Test
    fun `validateBinding surfaces the published serverEncryption key`() = runTest {
        val transport = FakeSyncTransport()
        val published = ServerEncryptionCapabilities(
            alg = "ML-KEM-768",
            keyVersion = 7,
            publicKey = "a2V5", // "key"
        )
        transport.capabilitiesResult = ApiResult.Success(
            ServerCapabilities(
                protocolVersions = listOf(SyncContract.PROTOCOL_VERSION),
                registryHash = "h",
                serverEncryption = published,
            ),
            null,
        )
        var seen: ServerCapabilities? = null
        val subject = actor(transport, FakeSyncLocalStore(BindingState.IDLE)) { seen = it }

        subject.request(SyncTrigger.MANUAL)

        val caps = seen
        assertNotNull("onCapabilities must be invoked with the validated payload", caps)
        assertEquals(published, caps!!.serverEncryption)
        assertEquals(7, caps.serverEncryption?.keyVersion)
    }

    @Test
    fun `a capabilities payload without a key still fires the callback`() = runTest {
        val transport = FakeSyncTransport()
        transport.capabilitiesResult = ApiResult.Success(
            ServerCapabilities(
                protocolVersions = listOf(SyncContract.PROTOCOL_VERSION),
                registryHash = "h",
                serverEncryption = null,
            ),
            null,
        )
        var fired = false
        var sawKey = true
        val subject = actor(transport, FakeSyncLocalStore(BindingState.IDLE)) {
            fired = true
            sawKey = it.serverEncryption != null
        }

        subject.request(SyncTrigger.MANUAL)

        assertTrue(fired, "callback fires even when the server has no key (host then defers secrets)")
        assertFalse(sawKey, "an absent key must read as null, never as a fabricated key")
    }
}
