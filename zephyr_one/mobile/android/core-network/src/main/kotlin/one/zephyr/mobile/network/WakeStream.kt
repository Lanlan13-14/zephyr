package one.zephyr.mobile.network

import java.io.IOException
import okio.BufferedSource

/** Payload-free hint from the authenticated, owner-scoped mobile wake stream. */
data class WakeStreamEvent(
    val cursor: Long,
    val epoch: String,
    val reason: String,
    val eventId: String,
)

/** Why a wake stream ended and which server delay should be preferred before reconnecting. */
data class WakeStreamOutcome(
    val connected: Boolean = false,
    val retryAfterMillis: Long? = null,
    val serverRetryMillis: Long? = null,
    val failureCode: String? = null,
)

/** Signs the exact, server-issued proof challenge used to authorise the SSE request. */
fun interface WakeProofSigner {
    fun sign(challenge: WakeProofChallenge): String
}

typealias WakeProofChallenge = DeviceProofChallenge

/** Injectable transport used by the app coordinator and deterministic unit tests. */
fun interface WakeStreamTransport {
    suspend fun open(lastEventId: String?, onWake: (WakeStreamEvent) -> Unit): WakeStreamOutcome
}

class MobileWakeStreamTransport(
    private val client: MobileApiClient,
    private val proofSigner: WakeProofSigner,
) : WakeStreamTransport {
    override suspend fun open(
        lastEventId: String?,
        onWake: (WakeStreamEvent) -> Unit,
    ): WakeStreamOutcome = client.openWakeStream(lastEventId, proofSigner, onWake)
}

@kotlinx.serialization.Serializable
private data class WakePayloadDto(
    val cursor: Long,
    val epoch: String,
    val reason: String,
)

/** Small, bounded SSE parser: wake frames never need arbitrary-sized lines or accumulated data. */
internal class WakeSseParser(private val onWake: (WakeStreamEvent) -> Unit) {
    private var eventType = "message"
    private var eventId: String? = null
    private val data = StringBuilder()

    var retryMillis: Long? = null
        private set

    fun accept(line: String) {
        if (line.isEmpty()) {
            dispatch()
            eventType = "message"
            data.clear()
            return
        }
        if (line.startsWith(':')) return

        val separator = line.indexOf(':')
        val field = if (separator < 0) line else line.substring(0, separator)
        val rawValue = if (separator < 0) "" else line.substring(separator + 1)
        val value = rawValue.removePrefix(" ")
        when (field) {
            "event" -> eventType = value
            "id" -> if ('\u0000' !in value && value.length <= MAX_EVENT_ID_CHARS) eventId = value
            "retry" -> value.toLongOrNull()
                ?.takeIf { it in MIN_RETRY_MILLIS..MAX_RETRY_MILLIS }
                ?.let { retryMillis = it }
            "data" -> {
                if (data.isNotEmpty()) data.append('\n')
                if (data.length + value.length > MAX_EVENT_DATA_CHARS) {
                    data.clear()
                    eventType = "discard"
                } else {
                    data.append(value)
                }
            }
        }
    }

    private fun dispatch() {
        if (eventType != "wake" || data.isEmpty()) return
        val payload = runCatching {
            MobileJson.instance.decodeFromString(WakePayloadDto.serializer(), data.toString())
        }.getOrNull() ?: return
        if (payload.cursor < 0L || !SAFE_EPOCH.matches(payload.epoch)) return
        val expectedId = payload.epoch + ":" + payload.cursor
        if (eventId != expectedId) return
        onWake(
            WakeStreamEvent(
                cursor = payload.cursor,
                epoch = payload.epoch,
                reason = payload.reason,
                eventId = expectedId,
            ),
        )
    }

    private companion object {
        const val MAX_EVENT_ID_CHARS = 160
        const val MAX_EVENT_DATA_CHARS = 16 * 1024
        const val MIN_RETRY_MILLIS = 100L
        const val MAX_RETRY_MILLIS = 5L * 60L * 1000L
        val SAFE_EPOCH = Regex("^[A-Za-z0-9._-]{1,120}$")
    }
}

internal fun readBoundedSseLine(source: BufferedSource): String? {
    if (source.exhausted()) return null
    val newline = source.indexOf('\n'.code.toByte(), 0L, MAX_SSE_LINE_BYTES + 1L)
    if (newline < 0L) {
        if (source.buffer.size > MAX_SSE_LINE_BYTES) throw IOException("SSE line exceeds limit")
        return source.readUtf8().removeSuffix("\r")
    }
    if (newline > MAX_SSE_LINE_BYTES) throw IOException("SSE line exceeds limit")
    val line = source.readUtf8(newline)
    source.skip(1L)
    return line.removeSuffix("\r")
}

private const val MAX_SSE_LINE_BYTES = 64L * 1024L
