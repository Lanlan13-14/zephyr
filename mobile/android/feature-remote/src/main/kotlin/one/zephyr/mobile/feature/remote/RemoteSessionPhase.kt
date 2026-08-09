package one.zephyr.mobile.feature.remote

import one.zephyr.mobile.model.MobileError

/**
 * The connect pipeline from REMOTE_DESKTOP_EXPERIENCE.md 13.
 *
 * Modelled as distinct phases rather than a boolean "connecting" because the spec requires a specific
 * error and an elapsed time per phase. A single flag cannot tell the user whether a 20-second wait was
 * DNS, TCP, TLS or a server that accepted the connection and never sent a frame, and those four have
 * four different fixes.
 */
enum class RemotePhase(val label: String) {
    RESOLVING("解析主机"),
    CONNECTING("建立连接"),
    SECURING("TLS / 证书"),
    AUTHENTICATING("认证"),
    NEGOTIATING("协商能力"),
    FIRST_FRAME("等待首帧"),
    CONNECTED("已连接"),

    /** Connected, but below the negotiated quality target: still usable, so it is not an error. */
    DEGRADED("质量降级"),
    RECONNECTING("重连中"),
    DISCONNECTED("已断开"),
    ;

    /** True once pixels can be on screen. */
    val hasSurface: Boolean get() = this == CONNECTED || this == DEGRADED

    val isProgressing: Boolean
        get() = this == RESOLVING || this == CONNECTING || this == SECURING ||
            this == AUTHENTICATING || this == NEGOTIATING || this == FIRST_FRAME || this == RECONNECTING

    val isTerminal: Boolean get() = this == DISCONNECTED
}

/**
 * Live status for one remote session.
 *
 * @param phaseSince when the current phase started, so the UI can show elapsed time per phase rather
 *   than one total that hides where the time went.
 * @param attempt 1 for the first connect. Incremented by a reconnect so the UI can say which attempt
 *   is running instead of looping silently.
 */
data class RemoteSessionStatus(
    val phase: RemotePhase = RemotePhase.DISCONNECTED,
    val phaseSince: Long = 0L,
    val attempt: Int = 0,
    val error: MobileError? = null,
    /** Filled once the server states its framebuffer size. */
    val remoteWidthPx: Int = 0,
    val remoteHeightPx: Int = 0,
    val negotiatedLabel: String? = null,
    val latencyMs: Long? = null,
    val fps: Int? = null,
    val droppedFrames: Int = 0,
) {
    fun elapsedMs(nowMs: Long): Long = if (phaseSince <= 0L) 0L else (nowMs - phaseSince).coerceAtLeast(0L)

    val hasSurface: Boolean get() = phase.hasSurface

    fun advance(next: RemotePhase, nowMs: Long): RemoteSessionStatus =
        if (next == phase) this else copy(phase = next, phaseSince = nowMs, error = null)
}

/**
 * Timeouts and the auto-reconnect decision.
 *
 * The two timeouts are separate values because section 13 requires it: a TCP connect that never
 * completes is a routing problem, while a server that completes the handshake and sends no frame is
 * usually a display/session problem on the far side, and collapsing them into one number would report
 * the wrong one.
 */
object RemotePhasePolicy {

    const val RESOLVE_TIMEOUT_MS = 10_000L
    const val CONNECT_TIMEOUT_MS = 20_000L
    const val SECURE_TIMEOUT_MS = 15_000L
    const val AUTH_TIMEOUT_MS = 30_000L
    const val NEGOTIATE_TIMEOUT_MS = 20_000L

    /** Deliberately generous: an RDP session that has to start a Windows shell can be slow. */
    const val FIRST_FRAME_TIMEOUT_MS = 30_000L

    fun timeoutMs(phase: RemotePhase): Long? = when (phase) {
        RemotePhase.RESOLVING -> RESOLVE_TIMEOUT_MS
        RemotePhase.CONNECTING -> CONNECT_TIMEOUT_MS
        RemotePhase.SECURING -> SECURE_TIMEOUT_MS
        RemotePhase.AUTHENTICATING -> AUTH_TIMEOUT_MS
        RemotePhase.NEGOTIATING -> NEGOTIATE_TIMEOUT_MS
        RemotePhase.FIRST_FRAME -> FIRST_FRAME_TIMEOUT_MS
        // A live or finished session has nothing left to time out.
        else -> null
    }

    fun hasTimedOut(status: RemoteSessionStatus, nowMs: Long): Boolean {
        val limit = timeoutMs(status.phase) ?: return false
        return status.elapsedMs(nowMs) >= limit
    }

    fun timeoutError(phase: RemotePhase): MobileError = MobileError.local(
        code = if (phase == RemotePhase.FIRST_FRAME) FIRST_FRAME_TIMEOUT else PHASE_TIMEOUT,
        message = phase.label + "超时",
        // Retryable: a timeout is the one failure where trying again is a reasonable next step.
        retryable = true,
    )

    /**
     * Whether the session may dial again without asking.
     *
     * Section 13 allows an automatic reconnect after a network change but requires a revoked
     * credential, ACL or token to stop and be handled. The list is by error code rather than by a
     * flag on the error because the codes are frozen in the error registry and a new transport error
     * defaulting to "retry" is the safer failure than one defaulting to "give up".
     */
    fun canAutoReconnect(error: MobileError?): Boolean {
        val code = error?.code ?: return true
        if (code in STOP_CODES) return false
        return error.retryable
    }

    /** Codes where retrying would loop against a decision only the user or the server can change. */
    val STOP_CODES = setOf(
        "resource_revoked",
        "capability_denied",
        "grant_expired",
        "sid_expired",
        "token_revoked",
        "auth_failed",
        "rfb_auth_failed",
        "rfb_too_many_attempts",
        "rfb_no_supported_security",
        "certificate_changed",
        "rdp_engine_unavailable",
        "vnc_engine_unavailable",
        "engine_unavailable",
    )

    const val PHASE_TIMEOUT = "remote_phase_timeout"
    const val FIRST_FRAME_TIMEOUT = "remote_first_frame_timeout"

    /**
     * Backoff for an automatic reconnect.
     *
     * Same shape as the sync backoff so a flapping link cannot produce two different retry rhythms in
     * one app, capped low because a remote desktop is an interactive session the user is watching.
     */
    fun reconnectDelayMs(attempt: Int): Long = when {
        attempt <= 1 -> 1_000L
        attempt == 2 -> 2_000L
        attempt == 3 -> 5_000L
        attempt == 4 -> 10_000L
        else -> 15_000L
    }

    const val MAX_AUTO_ATTEMPTS = 5
}
