package one.zephyr.mobile.app

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.network.MobileJson

/** Loopback-only HTTP/1.1 platform bridge for the embedded Go runtime. */
internal class AndroidAiPlatformHost(
    private val account: AccountContainer,
    private val exec: LiveSshExecPort,
    private val workspace: LocalAiWorkspace,
) : Closeable {
    data class Endpoint(val url: String, val token: String)
    private val token = randomToken()
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val executor = Executors.newFixedThreadPool(3) { Thread(it, "one-ai-platform").apply { isDaemon = true } }
    @Volatile private var closed = false
    val endpoint = Endpoint("http://127.0.0.1:${server.localPort}", token)

    init { executor.execute { acceptLoop() } }

    private fun acceptLoop() {
        while (!closed) runCatching { server.accept() }.onSuccess { socket -> executor.execute { socket.use(::handle) } }
    }

    private fun handle(socket: Socket) {
        val input = BufferedInputStream(socket.getInputStream())
        val output = BufferedOutputStream(socket.getOutputStream())
        val requestLine = readLine(input)?.split(' ') ?: return
        if (requestLine.size < 2) return
        val headers = linkedMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: return
            if (line.isEmpty()) break
            val split = line.indexOf(':')
            if (split > 0) headers[line.substring(0, split).trim().lowercase()] = line.substring(split + 1).trim()
        }
        if (!socket.inetAddress.isLoopbackAddress || !MessageDigest.isEqual(headers["x-ai-host-admin"].orEmpty().toByteArray(), token.toByteArray())) {
            return respond(output, 403, error("unauthorized", "unauthorized"))
        }
        val length = headers["content-length"]?.toIntOrNull()?.coerceIn(0, MAX_BODY) ?: 0
        val body = input.readNBytes(length).toString(Charsets.UTF_8)
        val path = requestLine[1].substringBefore('?')
        when (requestLine[0] to path) {
            "GET" to "/internal/ai-host/v1/tools" -> respond(output, 200, tools())
            "POST" to "/internal/ai-host/v1/call" -> respond(output, 200, runBlocking { call(body) })
            else -> respond(output, 404, error("not_found", "not found"))
        }
    }

    private fun tools(): JsonObject = JsonObject(mapOf("tools" to JsonArray(listOf(
        tool("connection_list_v1", "列出本机 Zephyr 连接资产。", listOf("query"), true, "low"),
        tool("remote_execute", "在指定 SSH 连接执行非交互命令。", listOf("connectionId", "command"), false, "high"),
        tool("workspace_list_v1", "列出本机 AI 会话工作区。", listOf("dir"), true, "low"),
        tool("workspace_read_v1", "读取本机 AI 工作区文本。", listOf("path"), true, "low"),
        tool("workspace_write_v1", "写入本机 AI 工作区或 outputs。", listOf("path", "content"), false, "high"),
        tool("session_sandbox_status_v1", "查看本机受限沙箱能力。", emptyList(), true, "low"),
        tool("session_exec_v1", "在本机会话沙箱运行白名单命令；无 shell、默认无网络。", listOf("command", "args"), false, "high"),
    ))))

    private suspend fun call(raw: String): JsonObject {
        val root = runCatching { MobileJson.instance.parseToJsonElement(raw) as JsonObject }.getOrNull()
            ?: return error("invalid_tool_arguments", "AI 工具参数无效")
        val name = root.string("tool")
        val args = root["args"] as? JsonObject ?: JsonObject(emptyMap())
        val result: JsonElement = when (name) {
            "connection_list_v1" -> {
                val q = args.string("query")
                val rows = if (q.isBlank()) account.connections.all(account.binding.userId) else account.connections.search(q, account.binding.userId)
                JsonObject(mapOf("connections" to JsonArray(rows.map { c -> JsonObject(mapOf("id" to JsonPrimitive(c.id), "name" to JsonPrimitive(c.name), "protocol" to JsonPrimitive(c.protocol.wireName), "host" to JsonPrimitive(c.host), "port" to JsonPrimitive(c.port))) })))
            }
            "remote_execute" -> {
                val id = args.string("connectionId"); val command = args.string("command")
                if (id.isBlank() || command.isBlank()) return error("invalid_tool_arguments", "连接和命令不能为空")
                JsonPrimitive(exec.exec(id, command, args.string("timeoutSeconds").toIntOrNull() ?: 30).toString())
            }
            "workspace_list_v1" -> anyJson(workspace.list(args.string("dir")))
            "workspace_read_v1" -> anyJson(workspace.read(args.string("path")))
            "workspace_write_v1" -> anyJson(workspace.write(args.string("path"), args.string("content")))
            "session_sandbox_status_v1" -> anyJson(workspace.status())
            "session_exec_v1" -> anyJson(workspace.exec(args.string("command"), args.array("args")))
            else -> return error("unknown_tool", "工具不存在")
        }
        return JsonObject(mapOf("ok" to JsonPrimitive(true), "result" to result))
    }

    private fun anyJson(value: Any?): JsonElement = when (value) {
        null -> kotlinx.serialization.json.JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to anyJson(v) })
        is Iterable<*> -> JsonArray(value.map(::anyJson))
        else -> JsonPrimitive(value.toString())
    }

    private fun tool(name: String, description: String, required: List<String>, readOnly: Boolean, risk: String): JsonObject = JsonObject(mapOf(
        "name" to JsonPrimitive(name), "description" to JsonPrimitive(description),
        "parameters" to JsonObject(mapOf("type" to JsonPrimitive("object"), "properties" to JsonObject(required.associateWith { key -> JsonObject(mapOf("type" to JsonPrimitive(if (key == "args") "array" else "string"))) }), "required" to JsonArray(required.map(::JsonPrimitive)), "additionalProperties" to JsonPrimitive(true))),
        "readOnly" to JsonPrimitive(readOnly), "risk" to JsonPrimitive(risk), "parallelSafe" to JsonPrimitive(readOnly),
    ))
    private fun error(code: String, text: String) = JsonObject(mapOf("ok" to JsonPrimitive(false), "code" to JsonPrimitive(code), "error" to JsonPrimitive(text)))
    private fun respond(out: BufferedOutputStream, status: Int, body: JsonObject) { val bytes = body.toString().toByteArray(); out.write("HTTP/1.1 $status ${if (status < 300) "OK" else "Error"}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray()); out.write(bytes); out.flush(); bytes.fill(0) }
    private fun readLine(input: BufferedInputStream): String? { val out = java.io.ByteArrayOutputStream(); while (out.size() < 16_384) { val b = input.read(); if (b < 0) return null; if (b == 10) break; if (b != 13) out.write(b) }; return out.toString("UTF-8") }
    private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.content.orEmpty()
    private fun JsonObject.array(key: String) = (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
    override fun close() { closed = true; server.close(); executor.shutdownNow() }
    private fun randomToken(): String { val b = ByteArray(32).also(SecureRandom()::nextBytes); return try { android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE) } finally { b.fill(0) } }

    companion object {
        private const val MAX_BODY = 16 * 1024 * 1024
    }
}
