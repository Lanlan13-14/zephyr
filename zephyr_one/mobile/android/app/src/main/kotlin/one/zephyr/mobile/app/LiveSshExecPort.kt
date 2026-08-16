package one.zephyr.mobile.app

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import one.zephyr.mobile.data.session.SessionRegistry
import one.zephyr.mobile.data.session.SessionTransport
import one.zephyr.mobile.feature.tools.ExecOutcome
import one.zephyr.mobile.feature.tools.RemoteShellChunk
import one.zephyr.mobile.feature.tools.SshExecPort
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshExecEvent


/** Reuses a live terminal session or automatically opens a managed SSH session. */
internal class LiveSshExecPort(
    private val engine: SshEngine,
    private val sessions: SessionRegistry,
    private val managed: ManagedSshSessionPool,
) : SshExecPort {
    override val isAvailable: Boolean get() = engine.isAvailable

    override suspend fun exec(connectionId: String, command: String, timeoutSeconds: Int): ExecOutcome {
        val existing = sessions.rows.value.firstOrNull {
            it.connectionId == connectionId && it.transport == SessionTransport.CONNECTED
        }
        val outcome = withTimeoutOrNull(timeoutSeconds.coerceAtLeast(1) * 1_000L) {
            if (existing != null) {
                engine.exec(existing.sessionId, command)
            } else {
                managed.withSession(connectionId) { sessionId ->
                    engine.exec(sessionId, command)
                }.getOrElse { return@withTimeoutOrNull Result.failure(it) }
            }
        } ?: return ExecOutcome.TimedOut
        return outcome.fold(
            onSuccess = { value ->
                ExecOutcome.Completed(
                    exitCode = value.exitCode,
                    stdout = value.stdout.toString(Charsets.UTF_8),
                    stderr = value.stderr.toString(Charsets.UTF_8),
                )
            },
            onFailure = { failure ->
                val connecting = existing == null
                ExecOutcome.Failed(
                    MobileError.local(
                        code = if (connecting) "ssh_connect_failed" else "ssh_exec_failed",
                        message = if (connecting) {
                            "自动连接失败：${failure.message ?: "无法建立 SSH"}"
                        } else {
                            failure.message ?: "SSH 远程执行失败"
                        },
                        retryable = true,
                    ),
                )
            },
        )
    }

    override fun execStream(connectionId: String, command: String): Flow<RemoteShellChunk> = callbackFlow {
        val existing = sessions.rows.value.firstOrNull {
            it.connectionId == connectionId && it.transport == SessionTransport.CONNECTED
        }
        val lease = if (existing == null) managed.acquire(connectionId) else null
        val sessionId = existing?.sessionId ?: lease!!.sessionId
        val job = launch {
            try {
                engine.execStream(sessionId, command).collect { event ->
                    when (event) {
                        is SshExecEvent.Stdout -> trySend(RemoteShellChunk.Output(event.bytes.toString(Charsets.UTF_8)))
                        is SshExecEvent.Stderr -> trySend(RemoteShellChunk.Output(event.bytes.toString(Charsets.UTF_8)))
                        is SshExecEvent.Closed -> trySend(RemoteShellChunk.Closed(event.exitCode))
                    }
                }
            } finally {
                close()
            }
        }
        awaitClose {
            job.cancel()
            launch { lease?.close() }
        }
    }
}
