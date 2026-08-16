package one.zephyr.mobile.app

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.repository.LocalAiCatalog
import one.zephyr.mobile.network.MobileJson

/** Local equivalent of Node's platform host: catalog + audited tool calls over loopback. */
internal class AndroidAiPlatformHost(
    private val account: AccountContainer,
    private val exec: LiveSshExecPort,
    private val workspace: LocalAiWorkspace,
) : Closeable {
    data class Endpoint(val url: String, val token: String)
    private val token = randomToken()
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply {
        executor = Executors.newFixedThreadPool(2) { Thread(it, "one-ai-platform").apply { isDaemon = true } }
        createContext("/internal/ai-host/v1/tools", ::tools)
        createContext("/internal/ai-host/v1/call", ::call)
        start()
    }
    val endpoint = Endpoint("http://127.0.0.1:${server.address.port}", token)

    private fun tools(exchange: HttpExchange) {
        if (!authorized(exchange) || exchange.requestMethod != "GET") return
        val all = listOf(
            ToolDef("connection_list_v1", "列出本机 Zephyr 连接资产。", schema("query"), true, "low", true),
            ToolDef("remote_execute", "在指定 SSH 连接执行非交互命令。", schema("connectionId", "command"), false, "high", false),
            ToolDef("workspace_list_v1", "列出本机 AI 会话工作区。", schema("dir"), true, "low", true),
            ToolDef("workspace_read_v1", "读取本机 AI 工作区文本。", schema("path"), true, "low", true),
            ToolDef("workspace_write_v1", "写入本机 AI 工作区或 outputs。", schema("path", "content"), false, "high", false),
            ToolDef("session_sandbox_status_v1", "查看本机受限沙箱能力。", schema(), true, "low", true),
            ToolDef("session_exec_v1", "在本机会话沙箱运行白名单命令；无 shell、默认无网络。", schema("command", "args"), false, "high", false),
        )
        write(exchange, 200, JsonObject(mapOf("tools" to MobileJson.instance.encodeToJsonElement(all))))
    }

    private fun call(exchange: HttpExchange) {
        if (!authorized(exchange) || exchange.requestMethod != "POST") return
        val body = runCatching { MobileJson.instance.decodeFromString(HostCall.serializer(), exchange.requestBody.reader().readText()) }
            .getOrElse { return writeError(exchange, 400, "invalid_tool_arguments", "AI 工具参数无效") }
        val result = runBlocking {
            when (body.tool) {
                "connection_list_v1" -> {
                    val q = body.args.string("query")
                    val rows = if (q.isBlank()) account.connections.all(account.binding.userId) else account.connections.search(q, account.binding.userId)
                    JsonObject(mapOf("connections" to MobileJson.instance.encodeToJsonElement(rows.map { mapOf("id" to it.id, "name" to it.name, "protocol" to it.protocol.wireName, "host" to it.host, "port" to it.port) })))
                }
                "remote_execute" -> {
                    val id = body.args.string("connectionId"); val command = body.args.string("command")
                    if (id.isBlank() || command.isBlank()) return@runBlocking null
                    val out = exec.exec(id, command, body.args.string("timeoutSeconds").toIntOrNull() ?: 30)
                    MobileJson.instance.encodeToJsonElement(out.toString())
                }
                "workspace_list_v1" -> MobileJson.instance.encodeToJsonElement(workspace.list(body.args.string("dir")))
                "workspace_read_v1" -> MobileJson.instance.encodeToJsonElement(workspace.read(body.args.string("path")))
                "workspace_write_v1" -> MobileJson.instance.encodeToJsonElement(workspace.write(body.args.string("path"), body.args.string("content")))
                "session_sandbox_status_v1" -> MobileJson.instance.encodeToJsonElement(workspace.status())
                "session_exec_v1" -> MobileJson.instance.encodeToJsonElement(workspace.exec(body.args.string("command"), body.args.array("args")))
                else -> null
            }
        } ?: return writeError(exchange, 400, "invalid_tool_arguments", "工具或参数无效")
        write(exchange, 200, JsonObject(mapOf("ok" to JsonPrimitive(true), "result" to result)))
    }

    private fun authorized(exchange: HttpExchange): Boolean {
        val allowed = exchange.remoteAddress.address.isLoopbackAddress && exchange.requestHeaders.getFirst("x-ai-host-admin") == token
        if (!allowed) writeError(exchange, 403, "unauthorized", "unauthorized")
        return allowed
    }
    private fun writeError(e: HttpExchange, status: Int, code: String, error: String) = write(e, status, JsonObject(mapOf("ok" to JsonPrimitive(false), "code" to JsonPrimitive(code), "error" to JsonPrimitive(error))))
    private fun write(e: HttpExchange, status: Int, body: JsonObject) { val bytes = body.toString().toByteArray(); e.responseHeaders.set("Content-Type", "application/json"); e.sendResponseHeaders(status, bytes.size.toLong()); e.responseBody.use { it.write(bytes) }; bytes.fill(0) }
    override fun close() { server.stop(0); (server.executor as? java.util.concurrent.ExecutorService)?.shutdownNow() }

    @Serializable private data class HostCall(val tool: String, val args: JsonObject = JsonObject(emptyMap()))
    @Serializable private data class ToolDef(val name: String, val description: String, val parameters: JsonObject, val readOnly: Boolean, val risk: String, val parallelSafe: Boolean)
    private fun schema(vararg required: String) = JsonObject(mapOf("type" to JsonPrimitive("object"), "properties" to JsonObject(required.associateWith { JsonObject(mapOf("type" to JsonPrimitive(if (it == "args") "array" else "string"))) }), "required" to MobileJson.instance.encodeToJsonElement(required.toList()), "additionalProperties" to JsonPrimitive(true)))
    private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.content.orEmpty()
    private fun JsonObject.array(key: String) = (this[key] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
    private fun randomToken(): String { val b = ByteArray(32).also(SecureRandom()::nextBytes); return try { android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE) } finally { b.fill(0) } }
}
