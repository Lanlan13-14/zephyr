package one.zephyr.mobile.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.SyncTrigger
import org.junit.Assert.*
import org.junit.Test

class SyncImportExclusionTest {
    private fun actor(transport: FakeSyncTransport = FakeSyncTransport(), onCapabilities: () -> Unit = {}) = SyncActor(
        transport, FakeSyncLocalStore(BindingState.IDLE), NoSealer, NoBlobs,
        onCapabilities = { onCapabilities() },
    )

    @Test fun `sync waits until import transaction and choice have finished`() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var validates = 0
        val subject = actor(onCapabilities = { validates++ })
        val importing = async { subject.withExclusiveLocalWrite { entered.complete(Unit); release.await() } }
        entered.await()
        val syncing = async { subject.request(SyncTrigger.MANUAL) }
        runCurrent()
        assertEquals(0, validates)
        assertFalse(syncing.isCompleted)
        release.complete(Unit)
        importing.await()
        assertTrue(syncing.await().isNotEmpty())
        assertEquals(1, validates)
    }

    @Test fun `import failure releases actor lock and does not strand future sync`() = runTest {
        val subject = actor()
        try {
            subject.withExclusiveLocalWrite { error("simulated import failure") }
            fail("expected failure")
        } catch (_: IllegalStateException) { }
        assertTrue(subject.request(SyncTrigger.MANUAL).single().succeeded)
    }

    @Test fun `cancelled import releases actor lock`() = runTest {
        val subject = actor()
        val entered = CompletableDeferred<Unit>()
        val importing = async { subject.withExclusiveLocalWrite { entered.complete(Unit); CompletableDeferred<Unit>().await() } }
        entered.await()
        importing.cancel()
        importing.join()
        assertTrue(subject.request(SyncTrigger.MANUAL).single().succeeded)
    }
}
