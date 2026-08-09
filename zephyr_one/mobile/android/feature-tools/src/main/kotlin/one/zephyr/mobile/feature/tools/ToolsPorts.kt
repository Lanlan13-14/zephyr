package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.model.MobileApiException
import one.zephyr.mobile.model.MobileError

/**
 * The remote-operation seams for S41/S42.
 *
 * NATIVE_ENGINE_DECISIONS.md ADR-002 has not exited its M0 spike, so no SSH transport exists in this
 * build: batch execution, Docker, metrics and log tailing all need `exec` on a live channel. Rather
 * than write an engine that pretends to connect, this module states its requirements as four narrow
 * ports and implements the whole scheduler, state machine and UI against them. Binding them is the
 * app module's job once ADR-002 lands, and [UnavailableRemotePorts] is what ships until then.
 *
 * The ports are split by capability rather than by screen because SCREEN_CATALOG.md 17 maps
 * capability to permitted operation: `observe` may only read, `control` may only start/stop/restart,
 * and only `execute` may run an arbitrary command. A single fat port would let a read-only screen
 * reach a write call by accident.
 */

/** One command run against one host. [ExecOutcome] is the only thing a caller may branch on. */
interface SshExecPort {

    /** True once a concrete engine is linked. Every call site must branch on it first. */
    val isAvailable: Boolean

    /**
     * Runs [command] on [connectionId] and waits at most [timeoutSeconds].
     *
     * Requires `execute` on the connection. The caller has already gated; the implementation is
     * expected to re-check server-side, because a client-side gate is presentation only
     * (ZEPHYR_PARITY.md 4.2).
     */
    suspend fun exec(connectionId: String, command: String, timeoutSeconds: Int): ExecOutcome
}

/**
 * The result of one exec attempt.
 *
 * Timeout and transport failure are separate branches from a non-zero exit code on purpose: a
 * command that ran and returned 1 is a different operational fact from one that never ran, and
 * MOBILE_EXPERIENCE.md 6 forbids collapsing both into "失败".
 */
sealed interface ExecOutcome {

    /** The command ran to completion. A non-zero [exitCode] is still a completed run. */
    data class Completed(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    ) : ExecOutcome

    /** The command was still running when the clamped timeout elapsed. */
    data object TimedOut : ExecOutcome

    /** The command never ran: no route, refused auth, engine missing. */
    data class Failed(val error: MobileError) : ExecOutcome
}

/**
 * Docker inspection and lifecycle (SCREEN_CATALOG.md 17).
 *
 * Reads need `observe`; [start]/[stop]/[restart] need `control`. Arbitrary `docker exec` is
 * deliberately absent: that is an [SshExecPort] concern gated on `execute`.
 */
interface DockerPort {

    val isAvailable: Boolean

    suspend fun snapshot(connectionId: String): Result<DockerSnapshot>

    suspend fun containerLogs(connectionId: String, containerId: String, lines: Int): Result<String>

    suspend fun start(connectionId: String, containerId: String): Result<Unit>

    suspend fun stop(connectionId: String, containerId: String): Result<Unit>

    suspend fun restart(connectionId: String, containerId: String): Result<Unit>
}

/**
 * Host metrics (SCREEN_CATALOG.md 17).
 *
 * Read-only, so `observe` is sufficient. [MetricsSnapshot.capturedAt] is mandatory because the
 * offline rule forbids presenting an old sample as live.
 */
interface MetricsPort {

    val isAvailable: Boolean

    suspend fun sample(connectionId: String): Result<MetricsSnapshot>
}

/**
 * Service log tail, search and export (SCREEN_CATALOG.md 17).
 *
 * Reading needs `observe`. Export is a separate, explicit user action so it can be audited rather
 * than happening as a side effect of viewing.
 */
interface LogPort {

    val isAvailable: Boolean

    suspend fun tail(connectionId: String, unit: String, lines: Int): Result<List<LogLine>>

    /** Server-side filter, so a large journal is not shipped to the device to be grepped. */
    suspend fun search(connectionId: String, unit: String, query: String, lines: Int): Result<List<LogLine>>

    /** Returns the text the caller hands to the system save picker. */
    suspend fun export(connectionId: String, unit: String, lines: Int): Result<String>
}

data class DockerSnapshot(
    val daemonRunning: Boolean,
    val version: String,
    val containers: List<DockerContainer>,
    val images: List<DockerImage>,
    val capturedAt: Long,
)

data class DockerContainer(
    val id: String,
    val name: String,
    val image: String,
    val state: String,
    val status: String,
) {
    /** Drives which lifecycle action is offered; the label is never derived from colour alone. */
    val isRunning: Boolean get() = state.equals("running", ignoreCase = true)
}

data class DockerImage(
    val id: String,
    val repository: String,
    val tag: String,
    val sizeBytes: Long,
)

/**
 * One metrics sample.
 *
 * Percentages are 0..100 floats and byte counts are absolute, so the UI can render both a readable
 * percentage and the underlying numbers (SCREEN_CATALOG.md 26 forbids progress with no readable
 * value).
 */
data class MetricsSnapshot(
    val cpuPercent: Float,
    val memoryUsedBytes: Long,
    val memoryTotalBytes: Long,
    val diskUsedBytes: Long,
    val diskTotalBytes: Long,
    val networkRxBytesPerSec: Long,
    val networkTxBytesPerSec: Long,
    val loadAverage1m: Float,
    val uptimeSeconds: Long,
    val capturedAt: Long,
) {
    val memoryPercent: Float
        get() = if (memoryTotalBytes <= 0L) 0f else memoryUsedBytes.toFloat() / memoryTotalBytes * 100f

    val diskPercent: Float
        get() = if (diskTotalBytes <= 0L) 0f else diskUsedBytes.toFloat() / diskTotalBytes * 100f
}

data class LogLine(
    val timestamp: Long,
    val level: String,
    val message: String,
)

/**
 * What ships until ADR-002 lands.
 *
 * Every call fails with `engine_unavailable` rather than returning empty data. Empty data would be
 * indistinguishable from "the host has no containers", and a user would draw a false conclusion
 * about a production machine from a missing engine.
 */
object UnavailableRemotePorts : SshExecPort, DockerPort, MetricsPort, LogPort {

    override val isAvailable: Boolean = false

    override suspend fun exec(connectionId: String, command: String, timeoutSeconds: Int): ExecOutcome =
        ExecOutcome.Failed(engineUnavailable())

    override suspend fun snapshot(connectionId: String): Result<DockerSnapshot> = failure()

    override suspend fun containerLogs(connectionId: String, containerId: String, lines: Int): Result<String> = failure()

    override suspend fun start(connectionId: String, containerId: String): Result<Unit> = failure()

    override suspend fun stop(connectionId: String, containerId: String): Result<Unit> = failure()

    override suspend fun restart(connectionId: String, containerId: String): Result<Unit> = failure()

    override suspend fun sample(connectionId: String): Result<MetricsSnapshot> = failure()

    override suspend fun tail(connectionId: String, unit: String, lines: Int): Result<List<LogLine>> = failure()

    override suspend fun search(
        connectionId: String,
        unit: String,
        query: String,
        lines: Int,
    ): Result<List<LogLine>> = failure()

    override suspend fun export(connectionId: String, unit: String, lines: Int): Result<String> = failure()

    private fun <T> failure(): Result<T> = Result.failure(MobileApiException(engineUnavailable()))

    /**
     * A fresh error per call rather than a shared constant, so a caller that stores one alongside a
     * requestId cannot mutate the instance another screen is showing.
     */
    fun engineUnavailable(): MobileError = MobileError.local(
        code = CODE_ENGINE_UNAVAILABLE,
        message = "SSH 引擎在此版本中尚未接入（ADR-002 M0 未完成），远程操作不可用",
        retryable = false,
    )

    const val CODE_ENGINE_UNAVAILABLE = "engine_unavailable"
}
