package one.zephyr.mobile.feature.tools

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import one.zephyr.mobile.model.MobileApiException
import one.zephyr.mobile.model.MobileError

/** What the S42 views read, always with a capture time attached. */
data class DockerStatus(
    val engineVersion: String,
    val running: Int,
    val stopped: Int,
    val imageCount: Int,
)

/**
 * The Docker / monitoring / log boundary.
 *
 * A port, not an implementation. Every operation here is a command over an SSH channel, and ADR-002
 * in NATIVE_ENGINE_DECISIONS.md has not chosen an SSH engine, so nothing in this build can reach a
 * host. What is implemented above the port is the part a later engine choice cannot invalidate:
 * capability mapping, snapshot freshness, offline disclosure and the per-section state machine.
 *
 * Reads return [Result] rather than throwing so a failed poll degrades one card to its last snapshot
 * instead of tearing down the page.
 */
interface OpsPort {

    /** False until ADR-002 lands. The picker still lists connections; the views say why they cannot load. */
    val isAvailable: Boolean

    suspend fun dockerStatus(connectionId: String): Result<DockerStatus>

    suspend fun containers(connectionId: String): Result<List<DockerContainer>>

    suspend fun images(connectionId: String): Result<List<DockerImage>>

    suspend fun metrics(connectionId: String): Result<HostMetrics>

    /**
     * Live tail.
     *
     * A flow because a tail has no end; the caller cancels by leaving the scope. Search is applied
     * by the caller over what it has received, so a filter change does not restart the tail.
     */
    fun tail(connectionId: String, unit: String): Flow<LogLine>

    suspend fun logs(connectionId: String, unit: String, lines: Int): Result<List<LogLine>>

    /** Container lifecycle. Gated by [OpsActions.gate] before it reaches here. */
    suspend fun containerAction(
        connectionId: String,
        containerId: String,
        action: OpsAction,
    ): Result<Unit>
}

/**
 * Stands in until ADR-002 exits M0.
 *
 * Every read fails with one specific code and every tail is empty. Returning an empty container list
 * instead would be indistinguishable from a host that genuinely runs no containers, which is the
 * fake this deliberately avoids.
 */
class UnavailableOpsPort : OpsPort {

    override val isAvailable: Boolean = false

    override suspend fun dockerStatus(connectionId: String): Result<DockerStatus> = failure()

    override suspend fun containers(connectionId: String): Result<List<DockerContainer>> = failure()

    override suspend fun images(connectionId: String): Result<List<DockerImage>> = failure()

    override suspend fun metrics(connectionId: String): Result<HostMetrics> = failure()

    override fun tail(connectionId: String, unit: String): Flow<LogLine> = emptyFlow()

    override suspend fun logs(connectionId: String, unit: String, lines: Int): Result<List<LogLine>> =
        failure()

    override suspend fun containerAction(
        connectionId: String,
        containerId: String,
        action: OpsAction,
    ): Result<Unit> = failure()

    private fun <T> failure(): Result<T> = Result.failure(MobileApiException(ENGINE_UNAVAILABLE))

    companion object {
        const val CODE = "ssh_ops_engine_unavailable"

        val ENGINE_UNAVAILABLE: MobileError = MobileError.local(
            code = CODE,
            message = "SSH 引擎在此版本中尚未接入（ADR-002 M0 未关闭），无法读取 Docker、监控或日志",
            retryable = false,
        )
    }
}