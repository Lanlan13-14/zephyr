package one.zephyr.mobile.app

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.feature.sessions.TerminalHost
import one.zephyr.mobile.feature.sessions.TerminalOpenOutcome
import one.zephyr.mobile.feature.sessions.TerminalOpenRequest
import one.zephyr.mobile.feature.sessions.TerminalTransport
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.Protocol

internal data class PrimaryPtyCandidate(val sessionId: String, val connectionId: String, val name: String)

/** Handoff only routes an explicit picker selection. It can never silently replace direct SSH.
 * Output uses Flow backpressure and preserves bytes; no DROP_OLDEST or fake echo renderer. */
internal class PrimaryPtyTerminalHost(
    private val ownerUserId: String,
    private val owned: TerminalHost,
    private val request: suspend (JsonObject) -> JsonObject,
) : TerminalHost by owned {
    constructor(account: AccountContainer, owned: TerminalHost) : this(account.binding.userId, owned, account::ptyRequest)
    private class Lease(val candidate: PrimaryPtyCandidate) {
        var prepared: JsonObject? = null
        @Volatile var epoch: Long? = null
        var afterSeq = 0L
        var inputSeq = 0L
        @Volatile var closed = false
        var snapshot: ByteArray? = null
        val applied = CompletableDeferred<Unit>()
        val inputMutex = Mutex()
    }
    private val leases = ConcurrentHashMap<String, Lease>()
    private suspend fun rpc(op: String, build: JsonObjectBuilder.() -> Unit = {}): JsonObject {
        val result = request(buildJsonObject { put("op", op); build() })
        if (result["ok"]?.jsonPrimitive?.booleanOrNull != true) {
            error(result["error"]?.jsonObject?.get("code")?.jsonPrimitive?.content ?: "handoff_failed")
        }
        return result
    }
    suspend fun candidates(): List<PrimaryPtyCandidate> = rpc("handoff.list")["sessions"]!!.jsonArray.map { value ->
        val row = value.jsonObject
        PrimaryPtyCandidate(row["sessionId"]!!.jsonPrimitive.content, row["connectionId"]!!.jsonPrimitive.content, row["name"]!!.jsonPrimitive.content)
    }
    fun select(candidate: PrimaryPtyCandidate): String = UUID.randomUUID().toString().also { leases[it] = Lease(candidate) }
    fun displayConnection(localId: String): Connection? = leases[localId]?.candidate?.let { candidate ->
        Connection(id = candidate.connectionId, ownerUserId = ownerUserId, protocol = Protocol.SSH,
            name = candidate.name, host = "主端 PTY · trusted-primary", port = 22, ephemeral = true)
    }
    override fun primaryPtyCommitted(sessionId: String): Boolean = leases[sessionId]?.epoch != null
    override fun isPrimaryPty(sessionId: String): Boolean = leases.containsKey(sessionId)
    override val isAvailable: Boolean get() = owned.isAvailable
    override suspend fun open(request: TerminalOpenRequest): TerminalOpenOutcome {
        val lease = leases[request.sessionId] ?: return owned.open(request)
        request.wipe()
        return try {
            check(!lease.closed && lease.prepared == null) { "handoff_reselect_required" }
            val result = rpc("handoff.prepare") { put("sessionId", lease.candidate.sessionId) }
            lease.prepared = result
            lease.snapshot = result["snapshot"]!!.jsonObject["data"]!!.jsonPrimitive.content.toByteArray(Charsets.UTF_8)
            TerminalOpenOutcome.Opened(request.sessionId, "主端 SSH 接力 · trusted-primary")
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            TerminalOpenOutcome.Failed(MobileError.local("handoff_failed", error.message ?: "主端接力失败", false))
        }
    }
    override fun initialSize(sessionId: String): Pair<Int, Int>? = leases[sessionId]?.prepared?.get("snapshot")?.jsonObject?.let {
        it["cols"]!!.jsonPrimitive.int to it["rows"]!!.jsonPrimitive.int
    }
    override fun requiresRenderAck(sessionId: String): Boolean = leases[sessionId]?.let { !it.applied.isCompleted } ?: owned.requiresRenderAck(sessionId)
    override suspend fun outputApplied(sessionId: String, bytes: ByteArray) {
        val lease = leases[sessionId] ?: return owned.outputApplied(sessionId, bytes)
        if (lease.snapshot === bytes) lease.applied.complete(Unit)
    }
    override fun output(sessionId: String): Flow<ByteArray> {
        val lease = leases[sessionId] ?: return owned.output(sessionId)
        return flow {
            try {
                val prepared = checkNotNull(lease.prepared)
                emit(checkNotNull(lease.snapshot))
                lease.applied.await()
                val snapshot = prepared["snapshot"]!!.jsonObject
                var result = rpc("handoff.commit") {
                    put("prepareId", prepared["prepareId"]!!.jsonPrimitive.content)
                    put("snapshotHash", snapshot["snapshotHash"]!!.jsonPrimitive.content)
                    put("appliedSequence", snapshot["outputSequence"]!!.jsonPrimitive.long)
                }
                lease.epoch = result["sessionEpoch"]!!.jsonPrimitive.long
                lease.snapshot = null
                emit(ByteArray(0)) // notify the controller that the ownership CAS, not just prepare, succeeded
                while (!lease.closed) {
                    for (frame in result["frames"]!!.jsonArray) {
                        emit(Base64.getDecoder().decode(frame.jsonObject["data"]!!.jsonPrimitive.content))
                    }
                    lease.afterSeq = result["nextSeq"]!!.jsonPrimitive.long
                    if (result["hasMore"]!!.jsonPrimitive.boolean != true) delay(60)
                    result = rpc("pty.read") {
                        put("sessionId", lease.candidate.sessionId); put("sessionEpoch", checkNotNull(lease.epoch)); put("afterSeq", lease.afterSeq)
                    }
                }
            } finally {
                lease.closed = true
                lease.snapshot?.fill(0)
                lease.snapshot = null
            }
        }
    }
    override fun transportFor(sessionId: String): TerminalTransport {
        val lease = leases[sessionId] ?: return owned.transportFor(sessionId)
        return object : TerminalTransport {
            override suspend fun write(bytes: ByteArray) {
                lease.inputMutex.withLock {
                    check(!lease.closed && lease.epoch != null) { "snapshot_not_applied" }
                    check(bytes.size <= 65536) { "invalid_input" }
                    val sequence = ++lease.inputSeq
                    try {
                        rpc("pty.input") {
                            put("sessionId", lease.candidate.sessionId); put("sessionEpoch", checkNotNull(lease.epoch))
                            put("inputSeq", sequence); put("data", Base64.getEncoder().encodeToString(bytes))
                        }
                    } catch (error: Exception) { lease.closed = true; throw error }
                }
            }
            override suspend fun resize(columns: Int, rows: Int, widthPx: Int, heightPx: Int) {
                if (lease.epoch == null || lease.closed) return
                rpc("pty.resize") {
                    put("sessionId", lease.candidate.sessionId); put("sessionEpoch", checkNotNull(lease.epoch))
                    put("cols", columns.coerceIn(20, 500)); put("rows", rows.coerceIn(2, 200))
                }
            }
        }
    }
    override suspend fun close(sessionId: String) {
        val lease = leases[sessionId] ?: return owned.close(sessionId)
        lease.closed = true
        lease.applied.cancel()
        // Detach only. Destroying the primary PTY is a separate capability, never inferred from UI close.
        if (lease.epoch == null) lease.prepared?.let { prepared ->
            runCatching { rpc("handoff.abort") { put("prepareId", prepared["prepareId"]!!.jsonPrimitive.content) } }
        }
    }
    override suspend fun measureLatency(sessionId: String): Long? = if (isPrimaryPty(sessionId)) null else owned.measureLatency(sessionId)
    override suspend fun exec(sessionId: String, command: String) = if (isPrimaryPty(sessionId)) Result.failure(IllegalStateException("PTY-only handoff")) else owned.exec(sessionId, command)
    override suspend fun listDirectory(sessionId: String, path: String) = if (isPrimaryPty(sessionId)) Result.failure(IllegalStateException("PTY-only handoff")) else owned.listDirectory(sessionId, path)
    override fun execStream(sessionId: String, command: String) = if (isPrimaryPty(sessionId)) kotlinx.coroutines.flow.emptyFlow() else owned.execStream(sessionId, command)
    override fun execStreamIsolated(sessionId: String, connectionId: String, command: String) = if (isPrimaryPty(sessionId)) kotlinx.coroutines.flow.emptyFlow() else owned.execStreamIsolated(sessionId, connectionId, command)
}
