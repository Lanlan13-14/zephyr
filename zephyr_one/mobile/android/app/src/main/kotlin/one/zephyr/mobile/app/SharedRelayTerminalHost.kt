package one.zephyr.mobile.app

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.feature.sessions.TerminalHost
import one.zephyr.mobile.feature.sessions.TerminalOpenOutcome
import one.zephyr.mobile.feature.sessions.TerminalOpenRequest
import one.zephyr.mobile.feature.sessions.TerminalTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.SharedResourceClient

/** SSH relay host for shared-to-me connections. Credentials stay on the main end. */
internal class SharedRelayTerminalHost(
    private val account: AccountContainer,
    private val owned: TerminalHost,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build(),
) : TerminalHost {

    private data class Relay(
        val serverSessionId: String,
        val socket: WebSocket,
        val output: MutableSharedFlow<ByteArray>,
        val closure: MutableSharedFlow<Throwable>,
        val ready: CompletableDeferred<TerminalOpenOutcome>,
    )

    private val relays = ConcurrentHashMap<String, Relay>()
    override val isAvailable: Boolean get() = owned.isAvailable

    override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome {
        val shared = account.sharedResources.find(Connection.ENTITY_TYPE, request.connectionId)
        if (shared == null || request.protocol != Protocol.SSH) return owned.open(request)
        request.wipe()
        val nonce = UUID.randomUUID().toString()
        val minted = account.sharedResourceClient.openRelaySession(
            connectionId = shared.resourceId,
            clientSessionNonce = nonce,
            requestedChannels = listOf("terminal", "resize"),
        )
        val session = when (minted) {
            is ApiResult.Success -> minted.value
            is ApiResult.Failure -> return TerminalOpenOutcome.Failed(minted.error)
        }
        if (session.relayUrl.isBlank() || session.credential.isBlank()) {
            return TerminalOpenOutcome.Failed(
                MobileError.local("shared_relay_unavailable", "主端未返回可用的共享 Relay", true),
            )
        }
        return connectRelay(request.sessionId, session)
    }

    private suspend fun connectRelay(
        localSessionId: String,
        session: one.zephyr.mobile.network.RelaySession,
    ): TerminalOpenOutcome {
        val output = MutableSharedFlow<ByteArray>(extraBufferCapacity = 128, onBufferOverflow = BufferOverflow.DROP_OLDEST)
        val closure = MutableSharedFlow<Throwable>(extraBufferCapacity = 1)
        val ready = CompletableDeferred<TerminalOpenOutcome>()
        val listener = listener(localSessionId, session.sessionId, output, closure, ready)
        val socket = client.newWebSocket(
            Request.Builder()
                .url(relayUrl(session.relayUrl))
                .header("Sec-WebSocket-Protocol", "zephyr-shared-relay-v1, ${session.credential}")
                .build(),
            listener,
        )
        relays[localSessionId] = Relay(session.sessionId, socket, output, closure, ready)
        return try {
            ready.await()
        } catch (cancelled: Throwable) {
            socket.cancel()
            relays.remove(localSessionId)
            runCatching { account.sharedResourceClient.closeSession(session.sessionId) }
            throw cancelled
        }
    }

    private fun listener(
        localSessionId: String,
        serverSessionId: String,
        output: MutableSharedFlow<ByteArray>,
        closure: MutableSharedFlow<Throwable>,
        ready: CompletableDeferred<TerminalOpenOutcome>,
    ) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = Unit

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            output.tryEmit(bytes.toByteArray())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val type = JSON_TYPE.find(text)?.groupValues?.getOrNull(1).orEmpty()
            when (type) {
                "ready" -> ready.complete(TerminalOpenOutcome.Opened(localSessionId, "Zephyr shared relay"))
                "error" -> fail(
                    localSessionId,
                    serverSessionId,
                    ready,
                    closure,
                    JSON_CODE.find(text)?.groupValues?.getOrNull(1) ?: "shared_relay_unavailable",
                    JSON_MESSAGE.find(text)?.groupValues?.getOrNull(1) ?: "共享 Relay 连接失败",
                )
                "revoked" -> fail(localSessionId, serverSessionId, ready, closure, "shared_grant_revoked", "共享授权已撤销")
                "close" -> fail(localSessionId, serverSessionId, ready, closure, "shared_relay_closed", "共享 Relay 已关闭")
            }
        }

        override fun onFailure(webSocket: WebSocket, throwable: Throwable, response: Response?) {
            fail(localSessionId, serverSessionId, ready, closure, "shared_relay_unavailable", "共享 Relay 连接失败")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            fail(localSessionId, serverSessionId, ready, closure, "shared_relay_closed", "共享 Relay 已关闭")
        }
    }

    private fun fail(
        localSessionId: String,
        serverSessionId: String,
        ready: CompletableDeferred<TerminalOpenOutcome>,
        closure: MutableSharedFlow<Throwable>,
        code: String,
        message: String,
    ) {
        val error = MobileError.local(code, message, false)
        ready.complete(TerminalOpenOutcome.Failed(error))
        closure.tryEmit(one.zephyr.mobile.model.MobileApiException(error))
        relays.remove(localSessionId)
        // Best effort; server expiry/revoke is still authoritative.
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            runCatching { account.sharedResourceClient.closeSession(serverSessionId) }
        }
    }

    override fun output(sessionId: String): Flow<ByteArray> = relays[sessionId]?.output ?: owned.output(sessionId)

    override fun closure(sessionId: String): Flow<Throwable> = relays[sessionId]?.closure ?: owned.closure(sessionId)

    override fun transportFor(sessionId: String): TerminalTransport {
        val relay = relays[sessionId] ?: return owned.transportFor(sessionId)
        return object : TerminalTransport {
            override suspend fun write(bytes: ByteArray) {
                val text = bytes.toString(Charsets.UTF_8)
                if (!relay.socket.send("{\"type\":\"input\",\"data\":${quote(text)}}")) {
                    throw IllegalStateException("shared relay write failed")
                }
            }

            override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) {
                relay.socket.send("{\"type\":\"resize\",\"cols\":$columns,\"rows\":$rows}")
            }
        }
    }

    override suspend fun close(sessionId: String) {
        val relay = relays.remove(sessionId)
        if (relay == null) return owned.close(sessionId)
        relay.socket.close(1000, "client-close")
        runCatching { account.sharedResourceClient.closeSession(relay.serverSessionId) }
    }

    override suspend fun measureLatency(sessionId: String): Long? =
        if (relays.containsKey(sessionId)) null else owned.measureLatency(sessionId)

    override suspend fun listDirectory(sessionId: String, path: String) =
        if (relays.containsKey(sessionId)) Result.failure(IllegalStateException("共享 Relay 不开放 SFTP"))
        else owned.listDirectory(sessionId, path)

    override suspend fun exec(sessionId: String, command: String) =
        if (relays.containsKey(sessionId)) Result.failure(IllegalStateException("共享 Relay 不开放 exec"))
        else owned.exec(sessionId, command)

    override fun execStream(sessionId: String, command: String) =
        if (relays.containsKey(sessionId)) emptyFlow() else owned.execStream(sessionId, command)

    override suspend fun trustHostKey(sessionId: String) {
        if (!relays.containsKey(sessionId)) owned.trustHostKey(sessionId)
    }

    private fun relayUrl(raw: String): String = if (raw.startsWith("/")) {
        account.endpoint.baseUrl.replaceFirst("https://", "wss://").trimEnd('/') + raw
    } else raw

    private fun quote(value: String): String = kotlinx.serialization.json.JsonPrimitive(value).toString()

    private companion object {
        val JSON_TYPE = Regex("\\\"type\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
        val JSON_CODE = Regex("\\\"code\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"")
        val JSON_MESSAGE = Regex("\\\"message\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"")
    }
}
