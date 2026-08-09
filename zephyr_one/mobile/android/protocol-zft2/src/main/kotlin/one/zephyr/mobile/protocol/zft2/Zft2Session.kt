package one.zephyr.mobile.protocol.zft2

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import one.zephyr.mobile.contracts.Zft2Contract
import one.zephyr.mobile.contracts.Zft2Op

/**
 * The transport this session speaks over.
 *
 * Declared as a port so the ZFT2 state machine stays pure JVM and unit-testable: the real
 * implementation is an OkHttp WebSocket in the app module, and the tests use an in-memory fake.
 * Nothing here knows about OkHttp, Android or a URL.
 */
interface Zft2Wire {
    suspend fun sendBinary(bytes: ByteArray)
    suspend fun sendText(text: String)
    fun close(code: Int, reason: String)
}

/** What the peer is told about this device during `hello`. */
data class Zft2Identity(
    val deviceId: String,
    val deviceName: String,
    val platform: String,
    val appVersion: String,
    /**
     * A file-bridge lease or a legacy Client Token.
     *
     * DEVELOPMENT.md 13.6: `/agent/files` accepts both, and the lease is preferred because it is
     * bound to userId/deviceId/tokenId/share policy and dies with the device or token. The session
     * only forwards it; minting and refreshing belong to the feature layer.
     */
    val credential: String,
)

enum class Zft2SessionState { IDLE, AUTHENTICATING, ONLINE, OFFLINE, FAILED }

/**
 * Why the session stopped, so the feature layer can decide between retrying and asking the user.
 *
 * An auth failure must not be retried on a timer: DEVELOPMENT.md 13.5 wants the binding state and
 * the lease re-verified first, and a tight reconnect loop against a revoked token is how a device
 * gets rate-limited.
 */
enum class Zft2StopReason { NONE, LOCAL_STOP, TRANSPORT_CLOSED, AUTH_REJECTED, PROTOCOL_VIOLATION, HEARTBEAT_TIMEOUT }

/**
 * The provider side of one `/agent/files` connection.
 *
 * Mobile answers; the main end asks. Three request shapes arrive on the same socket and all three
 * are implemented because the main end picks per call site:
 *
 * - binary ZFT2 frames (`callAgentV2`) — the primary path, used by Web RDP file redirection;
 * - JSON-RPC `{id, type:"request", method, params}` (`callAgent`) — still used by the AI device
 *   tools in `ai-agent-device-tools.js`;
 * - JSON-RPC `readBinary`, whose reply is a `ZFB1` binary frame rather than JSON.
 *
 * Implementing only ZFT2 would leave the AI file tools broken against a mobile provider, which is
 * why the text path is not treated as legacy.
 */
class Zft2Session(
    private val wire: Zft2Wire,
    private val dispatcher: Zft2Dispatcher,
    private val config: Zft2ProviderConfig,
    private val identity: Zft2Identity,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }

    private val _state = MutableStateFlow(Zft2SessionState.IDLE)
    val state: StateFlow<Zft2SessionState> = _state.asStateFlow()

    private val _transferredBytes = MutableStateFlow(0L)

    /** Surfaced by the file-sync UI, which must show transferred bytes (DEVELOPMENT.md 13.2). */
    val transferredBytes: StateFlow<Long> = _transferredBytes.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    var stopReason: Zft2StopReason = Zft2StopReason.NONE
        private set

    var agentId: String? = null
        private set

    /** Server-chosen heartbeat period; 15 s is the main end's constant and the safe default. */
    private var heartbeatIntervalMs: Long = 15_000L

    private var heartbeatJob: Job? = null
    private var missedHeartbeats = 0

    /** requestId -> running job, for CANCEL and for the in-flight window. */
    private val inflight = LinkedHashMap<Long, Job>()

    /** requestIds whose response must be swallowed because a CANCEL arrived. */
    private val cancelled = LinkedHashSet<Long>()

    /** Tracks which in-flight ids are safe to interrupt, recorded when the frame is admitted. */
    private val sideEffectFree = LinkedHashSet<Long>()

    private val stateLock = Mutex()

    /**
     * One mutex per serialisation key with a reference count.
     *
     * The count is what stops a long-lived session from accumulating one mutex per path ever
     * touched; dropping the entry only when the last waiter leaves keeps two frames on the same
     * path sharing the same mutex, which is the whole point.
     */
    private val pathLocks = HashMap<String, PathLock>()

    private class PathLock(val mutex: Mutex = Mutex()) {
        var waiters: Int = 0
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    /** Sends `hello` and waits for the peer's `hello_ack` to arrive via [onText]. */
    suspend fun start() {
        stopReason = Zft2StopReason.NONE
        _lastError.value = null
        _state.value = Zft2SessionState.AUTHENTICATING
        wire.sendText(json.encodeToString(JsonObject.serializer(), buildHello()))
    }

    /**
     * Capabilities are derived from [config], never hardcoded.
     *
     * `readOnly` has already been narrowed to the strictest of profile, connection and server
     * (DEVELOPMENT.md 13.2), so advertising `write:false` here and refusing writes in the
     * dispatcher are two views of the same decision rather than two places to keep in sync.
     */
    internal fun buildHello(): JsonObject = buildJsonObject {
        put("type", JsonPrimitive("hello"))
        put("protocolVersion", JsonPrimitive(Zft2Contract.VERSION))
        put("token", JsonPrimitive(identity.credential))
        put("deviceId", JsonPrimitive(identity.deviceId))
        put("deviceName", JsonPrimitive(identity.deviceName))
        put("platform", JsonPrimitive(identity.platform))
        put("appVersion", JsonPrimitive(identity.appVersion))
        put(
            "capabilities",
            buildJsonObject {
                put("read", JsonPrimitive(true))
                put("write", JsonPrimitive(!config.readOnly))
                put("delete", JsonPrimitive(!config.readOnly))
                put("rename", JsonPrimitive(!config.readOnly))
                put("mkdir", JsonPrimitive(!config.readOnly))
                put("truncate", JsonPrimitive(!config.readOnly))
                put("binary", JsonPrimitive(true))
                put("binaryRead", JsonPrimitive(true))
                put("binaryWrite", JsonPrimitive(true))
                put("cancel", JsonPrimitive(true))
                put("creditFlow", JsonPrimitive(true))
                put("maxInflight", JsonPrimitive(Zft2Codec.clampInflight(config.maxInflight)))
                put("maxChunkSize", JsonPrimitive(config.maxChunkBytes))
            },
        )
        put(
            "share",
            buildJsonObject {
                put("name", JsonPrimitive(config.shareName))
                put("readOnly", JsonPrimitive(config.readOnly))
            },
        )
    }

    /** Stops the session locally: releases handles, tells the peer, then closes the socket. */
    suspend fun stop(reason: Zft2StopReason = Zft2StopReason.LOCAL_STOP, detail: String = "stopped") {
        stopReason = reason
        heartbeatJob?.cancel()
        heartbeatJob = null

        val running = stateLock.withLock {
            val copy = inflight.values.toList()
            inflight.clear()
            cancelled.clear()
            sideEffectFree.clear()
            copy
        }
        running.forEach { it.cancel() }

        // Best effort: tell the main end we are going away so it drops the agent from its list
        // immediately instead of waiting three missed heartbeats.
        if (_state.value == Zft2SessionState.ONLINE) {
            runCatchingWire {
                wire.sendText(
                    json.encodeToString(
                        JsonObject.serializer(),
                        buildJsonObject {
                            put("type", JsonPrimitive("auto_shutdown"))
                            put("reason", JsonPrimitive(detail))
                        },
                    ),
                )
            }
        }

        runCatching { dispatcher.releaseAll() }
        _state.value = if (reason == Zft2StopReason.LOCAL_STOP) Zft2SessionState.OFFLINE else Zft2SessionState.FAILED
        runCatching { wire.close(NORMAL_CLOSURE, detail) }
    }

    /** Called by the transport when the socket dropped without a local stop. */
    suspend fun onTransportClosed(detail: String) {
        if (stopReason == Zft2StopReason.NONE) stopReason = Zft2StopReason.TRANSPORT_CLOSED
        heartbeatJob?.cancel()
        heartbeatJob = null
        val running = stateLock.withLock {
            val copy = inflight.values.toList()
            inflight.clear()
            cancelled.clear()
            sideEffectFree.clear()
            copy
        }
        running.forEach { it.cancel() }
        // Handles are released even though the socket is already gone: they are local file
        // descriptors, and DEVELOPMENT.md 13.4 requires disconnect to close all of them.
        runCatching { dispatcher.releaseAll() }
        _lastError.value = detail
        _state.value = Zft2SessionState.OFFLINE
    }

    // ---- inbound ---------------------------------------------------------------------------------

    /** Feed one text frame. */
    suspend fun onText(text: String) {
        val message = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        when (message.stringOrNull("type")) {
            "hello_ack" -> onHelloAck(message)
            "request" -> onJsonRequest(message)
            "pong" -> missedHeartbeats = 0
            // Unknown types are ignored rather than fatal: the main end may add a message type, and
            // an older client must not drop a working session over it.
            else -> Unit
        }
    }

    /**
     * Feed one binary frame.
     *
     * Dispatch is by magic, not by arrival order: the same socket carries ZFT2 frames and, in the
     * legacy direction, could carry anything else. A frame that is not ZFT2 is dropped rather than
     * guessed at.
     */
    suspend fun onBinary(bytes: ByteArray) {
        if (bytes.size < 4 || !hasZft2Magic(bytes)) return
        // Decoded against the *protocol* maxima, not the negotiated chunk size. A peer that ignores
        // hello.maxChunkSize must still produce a decodable frame so it can be answered with
        // payload_too_large; the negotiated cap is enforced in the dispatcher. Decoding at the
        // negotiated cap instead would turn an oversized write into an undecodable frame and kill an
        // otherwise healthy session.
        val frame = try {
            Zft2Codec.decode(bytes, Zft2Contract.MAX_META_BYTES, Zft2Contract.MAX_PAYLOAD_BYTES)
        } catch (failure: Zft2Exception) {
            // Structurally broken: bad magic, truncated header or a length that disagrees with the
            // WebSocket message size. There is no trustworthy requestId to answer, and a peer
            // emitting these is malfunctioning, so the session ends.
            _lastError.value = failure.code
            stop(Zft2StopReason.PROTOCOL_VIOLATION, failure.code)
            return
        }

        // Responses are never expected: this side only ever answers.
        if (frame.isResponse) return

        if (frame.operation == Zft2Op.CANCEL) {
            onCancel(frame)
            return
        }

        val window = Zft2Codec.clampInflight(config.maxInflight)
        val admitted = stateLock.withLock {
            if (inflight.size >= window || inflight.containsKey(frame.requestId)) false else true
        }
        if (!admitted) {
            // Back-pressure, not failure: the main end's callBinaryV2 polls for a free slot, so a
            // `busy` reply makes it wait rather than fail the transfer.
            runCatchingWire { wire.sendBinary(Zft2Codec.encodeError(frame, "busy", "Provider request window is full")) }
            return
        }

        val job = scope.launch { runFrame(frame) }
        stateLock.withLock {
            inflight[frame.requestId] = job
            // Recorded at admission because by the time a CANCEL arrives the frame object is no
            // longer reachable from the cancel path.
            if (frame.operation in SIDE_EFFECT_FREE_OPS) sideEffectFree.add(frame.requestId)
        }
        job.invokeOnCompletion {
            scope.launch {
                stateLock.withLock {
                    inflight.remove(frame.requestId)
                    cancelled.remove(frame.requestId)
                    sideEffectFree.remove(frame.requestId)
                }
            }
        }
    }

    private suspend fun runFrame(frame: Zft2Frame) {
        val key = dispatcher.queueKey(frame)
        try {
            val response = if (key == null) dispatcher.dispatch(frame) else withPathLock(key) { dispatcher.dispatch(frame) }
            if (!isCancelled(frame.requestId)) {
                wire.sendBinary(response)
                creditTransfer(frame, response)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            if (isCancelled(frame.requestId)) return
            val code = (failure as? Zft2Exception)?.code ?: "internal_error"
            // Only the code and a short message cross the wire. A platform exception message can
            // contain a content URI or an absolute host path, which the peer has no business seeing.
            val message = if (failure is Zft2Exception) failure.message ?: code else "File operation failed"
            _lastError.value = code
            runCatchingWire { wire.sendBinary(Zft2Codec.encodeError(frame, code, message)) }
        }
    }

    /**
     * Applies a CANCEL.
     *
     * Side-effect-free ops are cancelled for real; anything that can mutate the filesystem is left
     * to finish with its response suppressed. Interrupting a write or a close mid-flush would leave
     * a half-written file that neither side can reason about, and the peer has already stopped
     * waiting either way. The Dart agent suppresses in all cases; hard-cancelling reads is a
     * deliberate improvement, safe because a read changes nothing.
     */
    private suspend fun onCancel(frame: Zft2Frame) {
        val target = frame.meta.longOr("targetRequestId", -1L)
        if (target < 0L) return
        val job = stateLock.withLock {
            if (!inflight.containsKey(target)) return@withLock null
            cancelled.add(target)
            inflight[target]
        }
        if (job != null && isSideEffectFree(target)) job.cancel()
    }

    private suspend fun isCancelled(requestId: Long): Boolean = stateLock.withLock { cancelled.contains(requestId) }

    private suspend fun isSideEffectFree(requestId: Long): Boolean = stateLock.withLock { sideEffectFree.contains(requestId) }

    /** Counts real file bytes only, so the UI figure is not inflated by frame metadata. */
    private fun creditTransfer(frame: Zft2Frame, response: ByteArray) {
        val payloadBytes = when (frame.operation) {
            Zft2Op.READ -> {
                val metaLength = Zft2Codec.readU32(response, 12)
                (response.size - Zft2Contract.HEADER_BYTES - metaLength).coerceAtLeast(0L).toInt()
            }
            Zft2Op.WRITE -> frame.payload.size
            else -> 0
        }
        if (payloadBytes > 0) _transferredBytes.value += payloadBytes
    }

    // ---- JSON-RPC path ---------------------------------------------------------------------------

    private suspend fun onHelloAck(message: JsonObject) {
        if (message.booleanOr("ok", false)) {
            agentId = message.stringOrNull("agentId")
            heartbeatIntervalMs = message.longOr("heartbeatIntervalMs", 15_000L).coerceIn(1_000L, 300_000L)
            missedHeartbeats = 0
            _state.value = Zft2SessionState.ONLINE
            startHeartbeat()
        } else {
            val error = message["error"] as? JsonObject
            _lastError.value = error?.stringOrNull("code") ?: "unauthorized"
            // No reconnect: the credential is the problem, and retrying it cannot fix it.
            stop(Zft2StopReason.AUTH_REJECTED, error?.stringOrNull("message") ?: "authentication failed")
        }
    }

    private suspend fun onJsonRequest(message: JsonObject) {
        val id = message.stringOrNull("id") ?: return
        val method = message.stringOrNull("method") ?: return
        val params = (message["params"] as? JsonObject) ?: JsonObject(emptyMap())

        if (config.readOnly && method in MUTATING_METHODS) {
            sendJsonError(id, "read_only", "Share is read-only")
            return
        }

        try {
            if (method == "readBinary") {
                val handle = params.requireString("handle")
                val offset = params.longOr("offset", 0L)
                val length = params.intOr("length", DEFAULT_READ_BYTES).coerceIn(0, config.maxChunkBytes)
                val data = dispatcher.readForRpc(handle, offset, length)
                _transferredBytes.value += data.size
                wire.sendBinary(encodeZfb1(id, data))
                return
            }
            val result = dispatcher.dispatchRpc(method, params)
            sendJsonResult(id, result)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Throwable) {
            val code = (failure as? Zft2Exception)?.code ?: "internal_error"
            val message2 = if (failure is Zft2Exception) failure.message ?: code else "File operation failed"
            _lastError.value = code
            sendJsonError(id, code, message2)
        }
    }

    private suspend fun sendJsonResult(id: String, result: JsonObject) {
        wire.sendText(
            json.encodeToString(
                JsonObject.serializer(),
                buildJsonObject {
                    put("id", JsonPrimitive(id))
                    put("type", JsonPrimitive("response"))
                    put("ok", JsonPrimitive(true))
                    put("result", result)
                },
            ),
        )
    }

    private suspend fun sendJsonError(id: String, code: String, message: String) {
        wire.sendText(
            json.encodeToString(
                JsonObject.serializer(),
                buildJsonObject {
                    put("id", JsonPrimitive(id))
                    put("type", JsonPrimitive("response"))
                    put("ok", JsonPrimitive(false))
                    put(
                        "error",
                        buildJsonObject {
                            put("code", JsonPrimitive(code))
                            put("message", JsonPrimitive(message))
                        },
                    )
                },
            ),
        )
    }

    // ---- heartbeat -------------------------------------------------------------------------------

    /**
     * The provider drives the heartbeat.
     *
     * The main end increments a miss counter on its own timer and unregisters the agent after three
     * misses, so a silent provider looks offline in the UI even though the socket is fine.
     */
    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (true) {
                delay(heartbeatIntervalMs)
                if (_state.value != Zft2SessionState.ONLINE) break
                missedHeartbeats++
                if (missedHeartbeats >= HEARTBEAT_MISS_LIMIT) {
                    // Handed to a sibling coroutine on purpose: stop() cancels heartbeatJob, and
                    // calling it from inside that job would cancel this coroutine at stop()'s first
                    // suspension point and abandon the handle release half-done.
                    scope.launch { stop(Zft2StopReason.HEARTBEAT_TIMEOUT, "heartbeat timeout") }
                    break
                }
                runCatchingWire {
                    wire.sendText(
                        json.encodeToString(
                            JsonObject.serializer(),
                            buildJsonObject {
                                put("type", JsonPrimitive("ping"))
                                put("time", JsonPrimitive(now()))
                            },
                        ),
                    )
                }
            }
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private suspend fun <T> withPathLock(key: String, block: suspend () -> T): T {
        val lock = stateLock.withLock {
            val existing = pathLocks.getOrPut(key) { PathLock() }
            existing.waiters++
            existing
        }
        try {
            return lock.mutex.withLock { block() }
        } finally {
            stateLock.withLock {
                lock.waiters--
                if (lock.waiters <= 0) pathLocks.remove(key)
            }
        }
    }

    /** A failed send is not worth failing the operation over; the socket teardown will follow. */
    private inline fun runCatchingWire(block: () -> Unit) {
        try {
            block()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (ignored: Throwable) {
            // Intentionally swallowed: onTransportClosed will run.
        }
    }

    internal fun encodeZfb1(id: String, payload: ByteArray): ByteArray {
        val idBytes = id.toByteArray(Charsets.UTF_8)
        if (idBytes.size > 0xFFFF) throw Zft2Exception("invalid_argument", "Request id too long")
        val out = ByteArray(ZFB1_HEADER_BYTES + idBytes.size + payload.size)
        ZFB1_MAGIC.copyInto(out, 0)
        out[4] = ((idBytes.size shr 8) and 0xFF).toByte()
        out[5] = (idBytes.size and 0xFF).toByte()
        idBytes.copyInto(out, ZFB1_HEADER_BYTES)
        payload.copyInto(out, ZFB1_HEADER_BYTES + idBytes.size)
        return out
    }

    private fun hasZft2Magic(bytes: ByteArray): Boolean {
        for (index in 0 until 4) if (bytes[index] != Zft2Contract.MAGIC[index]) return false
        return true
    }

    internal companion object {
        const val NORMAL_CLOSURE = 1000
        const val HEARTBEAT_MISS_LIMIT = 3
        const val DEFAULT_READ_BYTES = 256 * 1024
        const val ZFB1_HEADER_BYTES = 6

        /** `ZFB1`: the legacy binary-read envelope the main end still accepts. */
        val ZFB1_MAGIC: ByteArray = byteArrayOf(0x5A, 0x46, 0x42, 0x31)

        /** Ops with no filesystem side effect, therefore safe to interrupt on CANCEL. */
        val SIDE_EFFECT_FREE_OPS = setOf(Zft2Op.READ, Zft2Op.STAT, Zft2Op.LIST, Zft2Op.PING)

        /**
         * Mirrors the Dart agent's list exactly. It names `write` rather than `writeBinary`
         * because this is the JSON-RPC surface, where the base64 `write` method is the mutating one.
         */
        val MUTATING_METHODS = setOf("write", "mkdir", "delete", "rename", "truncate")
    }
}
