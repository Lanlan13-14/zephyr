package one.zephyr.mobile.sync

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import one.zephyr.mobile.contracts.SyncContract
import one.zephyr.mobile.network.WakeStreamEvent
import one.zephyr.mobile.network.WakeStreamOutcome
import one.zephyr.mobile.network.WakeStreamTransport

/** Complete ownership boundary for one live wake stream. */
data class WakeBindingIdentity(
    val serverId: String,
    val userId: String,
    val deviceId: String,
    val generation: String,
) {
    init {
        require(serverId.isNotBlank())
        require(userId.isNotBlank())
        require(deviceId.isNotBlank())
        require(generation.isNotBlank())
    }
}

/** Injectable delay used to make reconnect behaviour deterministic in tests. */
fun interface WakeDelay {
    suspend fun sleep(milliseconds: Long)
}

object WakeReconnectPolicy {
    const val MAX_DELAY_MILLIS = 15L * 60L * 1_000L

    fun delayMillis(
        outcome: WakeStreamOutcome,
        consecutiveFailures: Int,
        jitter: Double,
    ): Long {
        outcome.retryAfterMillis?.let { return it.coerceIn(MIN_DELAY_MILLIS, MAX_DELAY_MILLIS) }
        outcome.serverRetryMillis?.let { return it.coerceIn(MIN_DELAY_MILLIS, MAX_DELAY_MILLIS) }

        val steps = SyncContract.retryBackoffMs
        val base = steps[consecutiveFailures.coerceIn(0, steps.lastIndex)]
        val safeJitter = jitter.takeIf(Double::isFinite)?.coerceIn(0.5, 1.5) ?: 1.0
        return (base.toDouble() * safeJitter).toLong().coerceAtMost(MAX_DELAY_MILLIS)
    }

    private const val MIN_DELAY_MILLIS = 100L
}

/**
 * Foreground SSE coordinator for exactly one binding generation.
 *
 * Wake cursors are used only to coalesce hints. They never advance local state; [requestSync]
 * always performs the authenticated change-feed pull and validates the real server response.
 * Android cannot keep an arbitrary socket alive in the background, so the stream is cancelled
 * there and periodic/expedited WorkManager work remains the correctness fallback.
 */
class WakeCoordinator(
    val identity: WakeBindingIdentity,
    private val transport: WakeStreamTransport,
    private val currentIdentity: () -> WakeBindingIdentity?,
    private val appliedCursor: suspend () -> Long,
    private val requestSync: suspend () -> Boolean,
    private val onTerminal: suspend (String) -> Unit,
    private val wakeDelay: WakeDelay = WakeDelay { delay(it) },
    private val jitter: () -> Double = { kotlin.random.Random.nextDouble(0.5, 1.5) },
) {
    private data class ReceivedWake(val attempt: Long, val event: WakeStreamEvent)

    private val lock = Any()
    private val stateChanges = Channel<Unit>(Channel.CONFLATED)
    private val wakeEvents = Channel<ReceivedWake>(Channel.CONFLATED)
    private val attemptSequence = AtomicLong(0L)

    private var managerJob: Job? = null
    private var foreground = false
    private var connected = false
    private var invalidated = false
    private var lifecycleVersion = 0L
    private var currentAttempt = 0L
    private var lastEventId: String? = null
    private var lastEpoch: String? = null
    private var highestWakeCursor = -1L

    fun start(scope: CoroutineScope) {
        synchronized(lock) {
            check(managerJob == null) { "wake coordinator is already started" }
            check(!invalidated) { "wake coordinator cannot restart after teardown" }
            managerJob = scope.launch { manageStreamAndEvents() }
        }
        stateChanges.trySend(Unit)
    }

    fun onForegroundChanged(isForeground: Boolean) {
        synchronized(lock) {
            if (invalidated || foreground == isForeground) return
            foreground = isForeground
            lifecycleVersion += 1
            if (!isForeground) invalidateAttemptLocked()
        }
        stateChanges.trySend(Unit)
    }

    fun onNetworkChanged(isConnected: Boolean) {
        synchronized(lock) {
            if (invalidated || connected == isConnected) return
            connected = isConnected
            lifecycleVersion += 1
            if (!isConnected) invalidateAttemptLocked()
        }
        stateChanges.trySend(Unit)
    }

    /** Cancels and joins the socket and event consumer. This generation can never restart. */
    suspend fun stopAndJoin() {
        val job = synchronized(lock) {
            if (!invalidated) {
                invalidated = true
                foreground = false
                connected = false
                invalidateAttemptLocked()
            }
            managerJob.also {
                managerJob = null
            }
        }
        stateChanges.trySend(Unit)
        job?.cancelAndJoin()
    }

    /** Test/diagnostic surface; it contains no account or cursor data beyond the opaque SSE id. */
    internal fun resumeEventId(): String? = synchronized(lock) { lastEventId }

    private suspend fun manageStreamAndEvents() = coroutineScope {
        val eventConsumer = launch { consumeWakeEvents() }
        var stream: Job? = null
        var streamLifecycleVersion = -1L
        try {
            while (currentCoroutineContext().isActive) {
                val (shouldRun, observedLifecycleVersion) = synchronized(lock) {
                    shouldRunLocked() to lifecycleVersion
                }
                if (stream != null && (!shouldRun || streamLifecycleVersion != observedLifecycleVersion)) {
                    stream.cancelAndJoin()
                    stream = null
                }
                if (shouldRun && (stream == null || stream.isCompleted)) {
                    streamLifecycleVersion = observedLifecycleVersion
                    stream = launch { runStreamLoop() }
                }
                stateChanges.receive()
            }
        } finally {
            synchronized(lock) { invalidateAttemptLocked() }
            stream?.cancelAndJoin()
            eventConsumer.cancelAndJoin()
        }
    }

    private suspend fun runStreamLoop() {
        var consecutiveFailures = 0
        while (currentCoroutineContext().isActive && shouldRun()) {
            val attempt = synchronized(lock) {
                if (!shouldRunLocked()) return
                attemptSequence.incrementAndGet().also { currentAttempt = it }
            }
            val resumeId = synchronized(lock) { lastEventId }
            val attemptOpen = AtomicBoolean(true)
            val outcome = try {
                transport.open(resumeId) { event ->
                    if (attemptOpen.get() && accepts(attempt)) {
                        wakeEvents.trySend(ReceivedWake(attempt, event))
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                WakeStreamOutcome(failureCode = "wake_transport_failed")
            } finally {
                attemptOpen.set(false)
            }

            if (!currentCoroutineContext().isActive || !shouldRun()) return
            val terminalCode = outcome.failureCode?.takeIf(::isTerminalWakeFailure)
            if (terminalCode != null) {
                synchronized(lock) {
                    invalidated = true
                    foreground = false
                    connected = false
                    invalidateAttemptLocked()
                }
                // Marked invalid before the callback: no late frame can schedule more network work.
                onTerminal(terminalCode)
                stateChanges.trySend(Unit)
                return
            }

            consecutiveFailures = if (outcome.connected) {
                0
            } else {
                (consecutiveFailures + 1).coerceAtMost(SyncContract.retryBackoffMs.lastIndex)
            }
            val delayMillis = WakeReconnectPolicy.delayMillis(
                outcome = outcome,
                consecutiveFailures = (consecutiveFailures - 1).coerceAtLeast(0),
                jitter = jitter(),
            )
            wakeDelay.sleep(delayMillis)
        }
    }

    private suspend fun consumeWakeEvents() {
        for (received in wakeEvents) {
            if (!accepts(received.attempt)) continue
            val cursorFloor = runCatching { appliedCursor() }.getOrNull() ?: continue
            val shouldSync = synchronized(lock) {
                if (!acceptsLocked(received.attempt)) return@synchronized false
                val event = received.event
                val epochChanged = lastEpoch?.let { it != event.epoch } ?: false
                if (epochChanged) highestWakeCursor = cursorFloor

                val floor = maxOf(cursorFloor, highestWakeCursor)
                val isNewHint = epochChanged || event.reason == REASON_EPOCH_CHANGED || event.cursor > floor
                if (epochChanged || event.cursor >= highestWakeCursor) {
                    lastEpoch = event.epoch
                    lastEventId = event.eventId
                    highestWakeCursor = maxOf(highestWakeCursor, event.cursor)
                }
                isNewHint
            }
            if (shouldSync && accepts(received.attempt)) {
                val succeeded = try {
                    requestSync()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    false
                }
                if (!succeeded) {
                    val durableCursor = runCatching { appliedCursor() }.getOrNull() ?: continue
                    synchronized(lock) {
                        if (acceptsLocked(received.attempt)) highestWakeCursor = durableCursor
                    }
                }
            }
        }
    }

    private fun accepts(attempt: Long): Boolean = synchronized(lock) { acceptsLocked(attempt) }

    private fun acceptsLocked(attempt: Long): Boolean =
        shouldRunLocked() && currentAttempt == attempt && currentIdentity() == identity

    private fun shouldRun(): Boolean = synchronized(lock) { shouldRunLocked() }

    private fun shouldRunLocked(): Boolean =
        managerJob != null && !invalidated && foreground && connected

    private fun invalidateAttemptLocked() {
        currentAttempt = attemptSequence.incrementAndGet()
    }

    companion object {
        private const val REASON_EPOCH_CHANGED = "epoch_changed"

        fun isTerminalWakeFailure(code: String): Boolean = code in TERMINAL_FAILURES

        private val TERMINAL_FAILURES = setOf(
            "client_revoked",
            "device_revoked",
            "account_unavailable",
        )
    }
}
