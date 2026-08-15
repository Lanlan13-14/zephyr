package one.zephyr.mobile.app

import kotlinx.coroutines.withTimeoutOrNull
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.feature.tools.ExecOutcome
import one.zephyr.mobile.feature.tools.SshExecPort
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.protocol.ssh.SshEngine

/** Runs batch commands over the already-authenticated local SSH session for each connection. */
internal class LiveSshExecPort(
    private val engine: SshEngine,
    private val sessions: SessionRegistry,
) : SshExecPort {
    override val isAvailable: Boolean get() = engine.isAvailable

    override suspend fun exec(connectionId: String, command: String, timeoutSeconds: Int): ExecOutcome {
        val live = sessions.rows.value.firstOrNull {
            it.connectionId == connectionId && it.transport == SessionTransport.CONNECTED
        } ?: return ExecOutcome.Failed(
            MobileError.local("session_not_connected", "请先连接该 SSH 主机后再执行", true),
        )
        val result = withTimeoutOrNull(timeoutSeconds.coerceAtLeast(1) * 1_000L) {
            engine.exec(live.sessionId, command)
        } ?: return ExecOutcome.TimedOut
        return result.fold(
            onSuccess = { value ->
                ExecOutcome.Completed(
                    exitCode = value.exitCode,
                    stdout = value.stdout.toString(Charsets.UTF_8),
                    stderr = value.stderr.toString(Charsets.UTF_8),
                )
            },
            onFailure = { failure ->
                ExecOutcome.Failed(
                    MobileError.local(
                        code = "ssh_exec_failed",
                        message = failure.message ?: "SSH 远程执行失败",
                        retryable = true,
                    ),
                )
            },
        )
    }
}
