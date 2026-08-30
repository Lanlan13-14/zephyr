package one.zephyr.mobile.sync

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import one.zephyr.mobile.network.WakeStreamEvent
import one.zephyr.mobile.network.WakeStreamOutcome
import one.zephyr.mobile.network.WakeStreamTransport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WakeCoordinatorTest {

    @Test
    fun `same account wake reaches both device scoped pulls`() = runTest {
        val firstIdentity = identity(device = "device-a")
        val secondIdentity = identity(device = "device-b")
        val firstTransport = ScriptedWakeTransport()
        val secondTransport = ScriptedWakeTransport()
        val firstPulls = AtomicInteger()
        val secondPulls = AtomicInteger()
        val first = coordinator(firstIdentity, IdentityHolder(firstIdentity), firstTransport) { firstPulls.incrementAndGet() }
        val second = coordinator(secondIdentity, IdentityHolder(secondIdentity), secondTransport) { secondPulls.incrementAndGet() }

        first.start(backgroundScope)
        second.start(backgroundScope)
        first.activate()
        second.activate()
        val firstOpen = firstTransport.nextOpen()
        val secondOpen = secondTransport.nextOpen()

        firstOpen.emit(wake(cursor = 4))
        secondOpen.emit(wake(cursor = 4))
        runCurrent()

        assertEquals(1, firstPulls.get())
        assertEquals(1, secondPulls.get())
        first.stopAndJoin()
        second.stopAndJoin()
    }

    @Test
    fun `event storm coalesces to one in flight pull and one trailing pull`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val firstStarted = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val pulls = AtomicInteger()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) {
            if (pulls.incrementAndGet() == 1) {
                firstStarted.complete(Unit)
                releaseFirst.await()
            }
        }
        coordinator.start(backgroundScope)
        coordinator.activate()
        val open = transport.nextOpen()

        open.emit(wake(cursor = 1))
        firstStarted.await()
        repeat(100) { index -> open.emit(wake(cursor = index + 2L)) }
        releaseFirst.complete(Unit)
        runCurrent()

        assertEquals(2, pulls.get())
        assertEquals("epoch-a:101", coordinator.resumeEventId())
        coordinator.stopAndJoin()
    }

    @Test
    fun `disconnect cancels socket and reconnect opens with last event id`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) { }
        coordinator.start(backgroundScope)
        coordinator.activate()
        val first = transport.nextOpen()
        first.emit(wake(cursor = 8))
        runCurrent()

        coordinator.onNetworkChanged(false)
        runCurrent()
        assertEquals(1, transport.cancellations.get())

        coordinator.onNetworkChanged(true)
        val second = transport.nextOpen()
        assertEquals("epoch-a:8", second.lastEventId)
        coordinator.stopAndJoin()
    }

    @Test
    fun `rapid disconnect reconnect still replaces invalidated socket`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) { }
        coordinator.start(backgroundScope)
        coordinator.activate()
        transport.nextOpen()

        coordinator.onNetworkChanged(false)
        coordinator.onNetworkChanged(true)
        val replacement = transport.nextOpen()

        assertEquals(null, replacement.lastEventId)
        assertEquals(1, transport.cancellations.get())
        assertEquals(2, transport.openCount.get())
        coordinator.stopAndJoin()
    }

    @Test
    fun `failed pull releases cursor coalescing floor for a repeated hint`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val attempts = AtomicInteger()
        val coordinator = WakeCoordinator(
            identity = identity,
            transport = transport,
            currentIdentity = { identity },
            appliedCursor = { 0L },
            requestSync = { attempts.incrementAndGet() > 1 },
            onTerminal = { },
            wakeDelay = WakeDelay { },
            jitter = { 1.0 },
        )
        coordinator.start(backgroundScope)
        coordinator.activate()
        val open = transport.nextOpen()

        open.emit(wake(cursor = 5))
        runCurrent()
        open.emit(wake(cursor = 5))
        runCurrent()

        assertEquals(2, attempts.get())
        coordinator.stopAndJoin()
    }

    @Test
    fun `late old generation and old attempt events are ignored`() = runTest {
        val oldIdentity = identity(generation = "old-generation")
        val holder = IdentityHolder(oldIdentity)
        val transport = ScriptedWakeTransport()
        val pulls = AtomicInteger()
        val coordinator = coordinator(oldIdentity, holder, transport) { pulls.incrementAndGet() }
        coordinator.start(backgroundScope)
        coordinator.activate()
        val oldOpen = transport.nextOpen()

        coordinator.onNetworkChanged(false)
        runCurrent()
        coordinator.onNetworkChanged(true)
        transport.nextOpen()
        oldOpen.emit(wake(cursor = 10))
        holder.value = identity(generation = "new-generation")
        oldOpen.emit(wake(cursor = 11))
        runCurrent()

        assertEquals(0, pulls.get())
        coordinator.stopAndJoin()
    }

    @Test
    fun `callback from an ended stream is ignored during reconnect delay`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val delayStarted = CompletableDeferred<Unit>()
        val holdDelay = CompletableDeferred<Unit>()
        val pulls = AtomicInteger()
        val coordinator = WakeCoordinator(
            identity = identity,
            transport = transport,
            currentIdentity = { identity },
            appliedCursor = { 0L },
            requestSync = { pulls.incrementAndGet(); true },
            onTerminal = { },
            wakeDelay = WakeDelay {
                delayStarted.complete(Unit)
                holdDelay.await()
            },
            jitter = { 1.0 },
        )
        coordinator.start(backgroundScope)
        coordinator.activate()
        val ended = transport.nextOpen()
        ended.finish(WakeStreamOutcome(connected = true))
        delayStarted.await()

        ended.emit(wake(cursor = 12))
        runCurrent()

        assertEquals(0, pulls.get())
        holdDelay.complete(Unit)
        transport.nextOpen()
        coordinator.stopAndJoin()
    }

    @Test
    fun `enabling hold alive in foreground does not reconnect`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) { }
        coordinator.start(backgroundScope)
        coordinator.activate()
        transport.nextOpen()

        coordinator.onHoldAliveChanged(true)
        runCurrent()

        assertEquals(0, transport.cancellations.get())
        assertEquals(1, transport.openCount.get())
        coordinator.stopAndJoin()
    }

    @Test
    fun `hold alive keeps the stream across backgrounding`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) { }
        coordinator.start(backgroundScope)
        coordinator.activate()
        transport.nextOpen()

        coordinator.onHoldAliveChanged(true)
        coordinator.onForegroundChanged(false)
        runCurrent()

        assertEquals(0, transport.cancellations.get())
        assertEquals(1, transport.openCount.get())
        coordinator.stopAndJoin()
    }

    @Test
    fun `turning hold alive off in background cancels the socket`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) { }
        coordinator.start(backgroundScope)
        coordinator.activate()
        coordinator.onHoldAliveChanged(true)
        transport.nextOpen()

        coordinator.onForegroundChanged(false)
        runCurrent()
        coordinator.onHoldAliveChanged(false)
        runCurrent()

        assertEquals(1, transport.cancellations.get())
        coordinator.onHoldAliveChanged(true)
        val replacement = transport.nextOpen()
        assertEquals(null, replacement.lastEventId)
        coordinator.stopAndJoin()
    }

    @Test
    fun `teardown joins transport and coordinator cannot resurrect`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val pulls = AtomicInteger()
        val coordinator = coordinator(identity, IdentityHolder(identity), transport) { pulls.incrementAndGet() }
        coordinator.start(backgroundScope)
        coordinator.activate()
        val open = transport.nextOpen()

        coordinator.stopAndJoin()
        open.emit(wake(cursor = 2))
        coordinator.onForegroundChanged(true)
        coordinator.onNetworkChanged(true)
        runCurrent()

        assertEquals(1, transport.cancellations.get())
        assertEquals(1, transport.openCount.get())
        assertEquals(0, pulls.get())
        assertTrue(runCatching { coordinator.start(backgroundScope) }.isFailure)
    }

    @Test
    fun `process restore opens a fresh stream and pulls from durable cursor`() = runTest {
        val identity = identity()
        val firstTransport = ScriptedWakeTransport()
        val first = coordinator(identity, IdentityHolder(identity), firstTransport, applied = { 6L }) { }
        first.start(backgroundScope)
        first.activate()
        firstTransport.nextOpen()
        first.stopAndJoin()

        val restoredTransport = ScriptedWakeTransport()
        val restoredPulls = AtomicInteger()
        val restored = coordinator(
            identity,
            IdentityHolder(identity),
            restoredTransport,
            applied = { 6L },
        ) { restoredPulls.incrementAndGet() }
        restored.start(backgroundScope)
        restored.activate()
        val restoredOpen = restoredTransport.nextOpen()
        assertEquals(null, restoredOpen.lastEventId)
        restoredOpen.emit(wake(cursor = 7, reason = "connected"))
        runCurrent()

        assertEquals(1, restoredPulls.get())
        restored.stopAndJoin()
    }

    @Test
    fun `terminal outcome disables late events before revocation callback`() = runTest {
        val identity = identity()
        val transport = ScriptedWakeTransport()
        val pulls = AtomicInteger()
        val terminalCodes = mutableListOf<String>()
        lateinit var open: ScriptedWakeTransport.Open
        val coordinator = WakeCoordinator(
            identity = identity,
            transport = transport,
            currentIdentity = { identity },
            appliedCursor = { 0L },
            requestSync = { pulls.incrementAndGet(); true },
            onTerminal = { code ->
                open.emit(wake(cursor = 99))
                terminalCodes += code
            },
            wakeDelay = WakeDelay { },
            jitter = { 1.0 },
        )
        coordinator.start(backgroundScope)
        coordinator.activate()
        open = transport.nextOpen()

        open.finish(WakeStreamOutcome(failureCode = "device_revoked"))
        runCurrent()

        assertEquals(listOf("device_revoked"), terminalCodes)
        assertEquals(0, pulls.get())
        assertEquals(1, transport.openCount.get())
        coordinator.stopAndJoin()
    }

    @Test
    fun `reconnect policy applies exponential jitter and server limits`() {
        assertEquals(
            2_000L,
            WakeReconnectPolicy.delayMillis(WakeStreamOutcome(), consecutiveFailures = 1, jitter = 1.0),
        )
        assertEquals(
            3_000L,
            WakeReconnectPolicy.delayMillis(WakeStreamOutcome(), consecutiveFailures = 1, jitter = 1.5),
        )
        assertEquals(
            100L,
            WakeReconnectPolicy.delayMillis(
                WakeStreamOutcome(retryAfterMillis = 1L),
                consecutiveFailures = 7,
                jitter = 1.0,
            ),
        )
        assertEquals(
            WakeReconnectPolicy.MAX_DELAY_MILLIS,
            WakeReconnectPolicy.delayMillis(
                WakeStreamOutcome(serverRetryMillis = Long.MAX_VALUE),
                consecutiveFailures = 0,
                jitter = 1.0,
            ),
        )
    }

    private fun coordinator(
        identity: WakeBindingIdentity,
        holder: IdentityHolder,
        transport: ScriptedWakeTransport,
        applied: suspend () -> Long = { 0L },
        requestSync: suspend () -> Unit,
    ) = WakeCoordinator(
        identity = identity,
        transport = transport,
        currentIdentity = { holder.value },
        appliedCursor = applied,
        requestSync = { requestSync(); true },
        onTerminal = { },
        wakeDelay = WakeDelay { },
        jitter = { 1.0 },
    )

    private fun WakeCoordinator.activate() {
        onForegroundChanged(true)
        onNetworkChanged(true)
    }

    private fun identity(
        device: String = "device-a",
        generation: String = "generation-a",
    ) = WakeBindingIdentity("server-a", "account-a", device, generation)

    private fun wake(
        cursor: Long,
        epoch: String = "epoch-a",
        reason: String = "change",
    ) = WakeStreamEvent(cursor, epoch, reason, "$epoch:$cursor")
}

private class IdentityHolder(@Volatile var value: WakeBindingIdentity?)

private class ScriptedWakeTransport : WakeStreamTransport {
    data class Open(
        val lastEventId: String?,
        private val callback: (WakeStreamEvent) -> Unit,
        private val completion: CompletableDeferred<WakeStreamOutcome>,
    ) {
        fun emit(event: WakeStreamEvent) = callback(event)
        fun finish(outcome: WakeStreamOutcome) = completion.complete(outcome)
    }

    private val opens = Channel<Open>(Channel.UNLIMITED)
    val openCount = AtomicInteger()
    val cancellations = AtomicInteger()

    override suspend fun open(lastEventId: String?, onWake: (WakeStreamEvent) -> Unit): WakeStreamOutcome {
        openCount.incrementAndGet()
        val completion = CompletableDeferred<WakeStreamOutcome>()
        opens.send(Open(lastEventId, onWake, completion))
        return try {
            completion.await()
        } finally {
            if (!completion.isCompleted) cancellations.incrementAndGet()
        }
    }

    suspend fun nextOpen(): Open = opens.receive()
}
