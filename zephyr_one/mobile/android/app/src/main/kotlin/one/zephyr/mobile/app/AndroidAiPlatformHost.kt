package one.zephyr.mobile.app

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import one.zephyr.mobile.app.di.AccountContainer
import one.zephyr.mobile.data.repository.LocalAiMemory
import one.zephyr.mobile.data.repository.LocalAiPlan
import one.zephyr.mobile.data.repository.LocalAiPlanStep
import one.zephyr.mobile.feature.notes.SftpPort
import one.zephyr.mobile.network.MobileJson

/** Loopback-only HTTP/1.1 platform bridge for the embedded Go runtime. */
internal class AndroidAiPlatformHost(
    private val account: AccountContainer,
    private val exec: LiveSshExecPort,
    private val workspace: LocalAiWorkspace,
    private val sftp: SftpPort? = null,
) : Closeable {
    data class Endpoint(val url: String, val token: String)

    private data class ActiveHost(
        val token: String,
        val server: ServerSocket,
        val executor: java.util.concurrent.ExecutorService,
        val endpoint: Endpoint,
    )

    private val lifecycleLock = Any()
    @Volatile private var active: ActiveHost? = null
    @Volatile private var closed = false
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    /**
     * Starts the loopback bridge on demand.
     *
     * BoundAiWorkspace is part of the application's first composition. Binding a ServerSocket in
     * this object's constructor therefore performed network I/O on Android's main thread and could
     * throw NetworkOnMainThreadException before the first frame. Runtime startup owns an IO
     * dispatcher, so keep construction inert and bind only from that path.
     */
    fun ensureStarted(): Endpoint = synchronized(lifecycleLock) {
        check(!closed) { "本机 AI 平台 Host 已关闭" }
        active?.let { return@synchronized it.endpoint }

        val token = randomToken()
        val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        val executor = Executors.newFixedThreadPool(3) {
            Thread(it, "one-ai-platform").apply { isDaemon = true }
        }
        val started = ActiveHost(
            token = token,
            server = server,
            executor = executor,
            endpoint = Endpoint("http://127.0.0.1:${server.localPort}", token),
        )
        active = started
        executor.execute { acceptLoop(started) }
        started.endpoint
    }

    private fun acceptLoop(host: ActiveHost) {
        while (!closed && !host.server.isClosed) {
            runCatching { host.server.accept() }
                .onSuccess { socket -> host.executor.execute { socket.use { handle(it, host.token) } } }
        }
    }

    private fun handle(socket: Socket, token: String) {
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

    private fun tools(): JsonObject {
        val catalog = mutableListOf(
            tool("connection_list_v1", "列出本机 Zephyr 连接资产。", listOf("query"), true, "low"),
            tool("remote_execute", "在指定 SSH 连接执行非交互命令。", listOf("connectionId", "command"), false, "high"),
            tool("workspace_list_v1", "列出本机 AI 会话工作区。", listOf("dir"), true, "low"),
            tool("workspace_read_v1", "读取本机 AI 工作区文本。", listOf("path"), true, "low"),
            tool("workspace_write_v1", "写入本机 AI 工作区或 outputs。", listOf("path", "content"), false, "high"),
            tool("session_sandbox_status_v1", "查看本机受限沙箱能力。", emptyList(), true, "low"),
            tool("session_exec_v1", "在本机会话沙箱运行白名单命令；无 shell、默认无网络。", listOf("command", "args"), false, "high"),
        )
        // Notes and snippets are gated per-entity by aiReadEnabled/aiWriteEnabled, mirroring the
        // server-side re-authorization rule: the model only ever sees entities the user exposed.
        catalog += tool("note_list_v1", "列出对本机 AI 可见的笔记（aiReadEnabled）。", emptyList(), true, "low")
        catalog += tool("note_get_v1", "读取一篇对 AI 可见笔记的正文。", listOf("noteId"), true, "low")
        catalog += tool("note_write_v1", "新建或更新一篇笔记（需 aiWriteEnabled）。", listOf("title", "content"), false, "high")
        catalog += tool("snippet_list_v1", "列出代码片段/常用命令。", emptyList(), true, "low")
        catalog += tool("snippet_get_v1", "读取一个代码片段的命令体。", listOf("snippetId"), true, "low")
        // SFTP parity with the desktop catalog, through the same ManagedSsh session pool the
        // interactive file browser uses. Write operations are high risk and ask-gated.
        if (sftp != null) {
            catalog += tool("sftp_list_v1", "列出远程目录内容。", listOf("connectionId", "path"), true, "low")
            catalog += tool("sftp_stat_v1", "读取远程文件/目录元数据。", listOf("connectionId", "path"), true, "low")
            catalog += tool("sftp_read_text_v1", "读取远程文本文件（有大小上限）。", listOf("connectionId", "path"), true, "low")
            catalog += tool("sftp_write_text_v1", "写入远程文本文件。", listOf("connectionId", "path", "content"), false, "high")
            catalog += tool("sftp_mkdir_v1", "创建远程目录。", listOf("connectionId", "path"), false, "high")
            catalog += tool("sftp_rename_v1", "重命名/移动远程路径。", listOf("connectionId", "oldPath", "newPath"), false, "high")
            catalog += tool("sftp_delete_v1", "删除远程文件或目录。", listOf("connectionId", "path"), false, "high")
        }
        catalog += tool("web_search", "搜索公开网页（DuckDuckGo HTML）。", listOf("query"), true, "low")
        catalog += tool("fetch_url", "抓取公开 http/https 页面正文。", listOf("url"), true, "low")
        catalog += tool("memory_search", "搜索本机长期 Memory。", listOf("query"), true, "low")
        catalog += tool("memory_save", "保存一条本机长期 Memory。", listOf("title", "content"), false, "high")
        catalog += tool("list_env_vars", "列出对本机 AI 可见的环境变量元数据，不含值。", emptyList(), true, "low")
        catalog += tool("get_env_var", "读取一条已对 AI 暴露值的环境变量。", listOf("name"), false, "high")
        catalog += tool("plan_task", "创建一条本机任务计划。", listOf("title"), false, "low")
        catalog += tool("plan_update", "更新本机任务计划状态或步骤。", listOf("id"), false, "high")
        catalog += tool("plan_delete", "删除一条本机任务计划。", listOf("id"), false, "high")
        return JsonObject(mapOf("tools" to JsonArray(catalog)))
    }

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
            "note_list_v1" -> noteList()
            "note_get_v1" -> noteGet(args.string("noteId"))
            "note_write_v1" -> noteWrite(args)
            "snippet_list_v1" -> snippetList()
            "snippet_get_v1" -> snippetGet(args.string("snippetId"))
            "sftp_list_v1" -> sftpList(args)
            "sftp_stat_v1" -> sftpStat(args)
            "sftp_read_text_v1" -> sftpRead(args)
            "sftp_write_text_v1" -> sftpWrite(args)
            "sftp_mkdir_v1" -> sftpMkdir(args)
            "sftp_rename_v1" -> sftpRename(args)
            "sftp_delete_v1" -> sftpDelete(args)
            "web_search" -> webSearch(args)
            "fetch_url" -> fetchUrl(args)
            "memory_search" -> memorySearch(args)
            "memory_save" -> memorySave(args)
            "list_env_vars" -> listEnvVars()
            "get_env_var" -> getEnvVar(args)
            "plan_task" -> planTask(args)
            "plan_update" -> planUpdate(args)
            "plan_delete" -> planDelete(args)
            else -> return error("unknown_tool", "工具不存在")
        }
        return JsonObject(mapOf("ok" to JsonPrimitive(true), "result" to result))
    }

    // -- notes & snippets (gated by the per-entity AI flags, mirroring server re-authorization) --

    private suspend fun visibleNotes(): List<one.zephyr.mobile.model.Note> =
        account.notes.searchNotes("", account.binding.userId).filter { it.deletedAt == null && it.aiReadEnabled }

    private fun noteSummary(n: one.zephyr.mobile.model.Note): JsonObject = JsonObject(mapOf(
        "noteId" to JsonPrimitive(n.noteId),
        "title" to JsonPrimitive(n.title),
        "groupPath" to JsonPrimitive(n.groupPath),
        "tags" to JsonArray(n.tags.map(::JsonPrimitive)),
        "updatedAt" to JsonPrimitive(n.updatedAt),
        "aiWriteEnabled" to JsonPrimitive(n.aiWriteEnabled),
    ))

    private suspend fun noteList(): JsonElement =
        JsonObject(mapOf("notes" to JsonArray(visibleNotes().map(::noteSummary))))

    private suspend fun noteGet(noteId: String): JsonElement {
        if (noteId.isBlank()) return error("invalid_tool_arguments", "noteId 不能为空")
        val note = visibleNotes().firstOrNull { it.noteId == noteId }
            ?: return error("not_found", "笔记不存在或未对 AI 开放读取")
        return JsonObject(mapOf(
            "noteId" to JsonPrimitive(note.noteId),
            "title" to JsonPrimitive(note.title),
            "content" to JsonPrimitive(note.content),
            "tags" to JsonArray(note.tags.map(::JsonPrimitive)),
        ))
    }

    private suspend fun noteWrite(args: JsonObject): JsonElement {
        val title = args.string("title"); val content = args.string("content")
        if (title.isBlank()) return error("invalid_tool_arguments", "title 不能为空")
        val noteId = args.string("noteId")
        val owner = account.binding.userId
        val existing = if (noteId.isBlank()) null else account.notes.searchNotes("", owner)
            .firstOrNull { it.noteId == noteId && it.deletedAt == null }
        if (existing != null && !existing.aiWriteEnabled) {
            return error("permission_denied", "该笔记未对 AI 开放写入")
        }
        val now = System.currentTimeMillis()
        val next = (existing ?: one.zephyr.mobile.model.Note(
            noteId = "note-" + java.util.UUID.randomUUID().toString(),
            ownerUserId = owner,
            title = title,
            aiReadEnabled = true,
            aiWriteEnabled = true,
        )).copy(title = title, content = content, updatedAt = now)
        // Mask names must match ResourceMappers.noteValues / the entity registry exactly: an entry
        // the server does not publish is rejected. A new note needs the full editable set; an update
        // only the fields the model is allowed to touch (content/title).
        val mask = if (existing == null) {
            listOf("title", "content", "groupPath", "tags", "linkedConnectionIds", "allowAiRead", "allowAiWrite")
        } else {
            listOf("title", "content")
        }
        return try {
            account.notes.saveNote(next, mask, owner, createdLocally = existing == null)
            JsonObject(mapOf("noteId" to JsonPrimitive(next.noteId), "saved" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("note_write_failed", failure.message ?: "笔记保存失败")
        }
    }

    private suspend fun visibleSnippets(): List<one.zephyr.mobile.model.Snippet> =
        account.notes.observeSnippets(account.binding.userId).firstOrNull()
            .orEmpty()
            .filter { it.deletedAt == null }

    private suspend fun snippetList(): JsonElement = JsonObject(mapOf("snippets" to JsonArray(visibleSnippets().map { s ->
        JsonObject(mapOf(
            "snippetId" to JsonPrimitive(s.id),
            "name" to JsonPrimitive(s.name),
            "group" to JsonPrimitive(s.group),
        ))
    })))

    private suspend fun snippetGet(snippetId: String): JsonElement {
        if (snippetId.isBlank()) return error("invalid_tool_arguments", "snippetId 不能为空")
        val snippet = visibleSnippets().firstOrNull { it.id == snippetId }
            ?: return error("not_found", "片段不存在")
        return JsonObject(mapOf(
            "snippetId" to JsonPrimitive(snippet.id),
            "name" to JsonPrimitive(snippet.name),
            "command" to JsonPrimitive(snippet.command),
        ))
    }

    // -- note trash / restore (aiWriteEnabled-gated, mirroring the note_write rule) --------------

    private suspend fun noteDelete(noteId: String): JsonElement {
        if (noteId.isBlank()) return error("invalid_tool_arguments", "noteId 不能为空")
        val owner = account.binding.userId
        val note = account.notes.searchNotes("", owner).firstOrNull { it.noteId == noteId && it.deletedAt == null }
            ?: return error("not_found", "笔记不存在")
        if (!note.aiWriteEnabled) return error("permission_denied", "该笔记未对 AI 开放写入")
        return try {
            account.notes.trashNote(note, owner)
            JsonObject(mapOf("noteId" to JsonPrimitive(noteId), "trashed" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("note_delete_failed", failure.message ?: "删除失败")
        }
    }

    private suspend fun noteRestore(noteId: String): JsonElement {
        if (noteId.isBlank()) return error("invalid_tool_arguments", "noteId 不能为空")
        val owner = account.binding.userId
        // Trashed rows are invisible to searchNotes (deletedAt IS NULL), so read the trash query.
        val note = account.notes.observeTrashedNotes(owner).firstOrNull()?.firstOrNull { it.noteId == noteId }
            ?: return error("not_found", "回收站里没有这篇笔记")
        if (!note.aiWriteEnabled) return error("permission_denied", "该笔记未对 AI 开放写入")
        return try {
            account.notes.restoreNote(note, owner)
            JsonObject(mapOf("noteId" to JsonPrimitive(noteId), "restored" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("note_restore_failed", failure.message ?: "恢复失败")
        }
    }

    // -- snippet write / delete -------------------------------------------------------------------

    private suspend fun snippetWrite(args: JsonObject): JsonElement {
        val name = args.string("name"); val command = args.string("command")
        if (name.isBlank() || command.isBlank()) return error("invalid_tool_arguments", "name 和 command 不能为空")
        val owner = account.binding.userId
        val existingId = args.string("snippetId")
        val existing = if (existingId.isBlank()) null else visibleSnippets().firstOrNull { it.id == existingId }
        val next = (existing ?: one.zephyr.mobile.model.Snippet(
            id = "snippet-" + java.util.UUID.randomUUID().toString(),
            ownerUserId = owner,
            name = name,
            command = command,
        )).copy(
            name = name,
            command = command,
            group = args.string("group").ifBlank { existing?.group.orEmpty() },
            autoRun = (args["autoRun"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: (existing?.autoRun ?: false),
        )
        val mask = if (existing == null) listOf("name", "command", "group", "autoRun") else listOf("name", "command", "group", "autoRun")
        return try {
            account.notes.saveSnippet(next, mask, owner, createdLocally = existing == null)
            JsonObject(mapOf("snippetId" to JsonPrimitive(next.id), "saved" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("snippet_write_failed", failure.message ?: "片段保存失败")
        }
    }

    private suspend fun snippetDelete(snippetId: String): JsonElement {
        if (snippetId.isBlank()) return error("invalid_tool_arguments", "snippetId 不能为空")
        val owner = account.binding.userId
        val snippet = visibleSnippets().firstOrNull { it.id == snippetId } ?: return error("not_found", "片段不存在")
        return try {
            account.notes.deleteSnippet(snippet, owner)
            JsonObject(mapOf("snippetId" to JsonPrimitive(snippetId), "deleted" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("snippet_delete_failed", failure.message ?: "删除失败")
        }
    }

    // -- proxies / ssh keys / jump hosts ----------------------------------------------------------

    private suspend fun proxyList(): JsonElement = JsonObject(mapOf("proxies" to JsonArray(
        account.resources.observeProxies(account.binding.userId).firstOrNull().orEmpty()
            .filter { it.deletedAt == null }
            .map { p -> JsonObject(mapOf(
                "proxyId" to JsonPrimitive(p.id), "name" to JsonPrimitive(p.name),
                "type" to JsonPrimitive(p.type.wireName), "host" to JsonPrimitive(p.host), "port" to JsonPrimitive(p.port),
            )) },
    )))

    private suspend fun proxyWrite(args: JsonObject): JsonElement {
        val name = args.string("name"); val host = args.string("host")
        val port = args.string("port").toIntOrNull() ?: 1080
        if (name.isBlank() || host.isBlank()) return error("invalid_tool_arguments", "name 和 host 不能为空")
        val owner = account.binding.userId
        val existingId = args.string("proxyId")
        val existing = if (existingId.isBlank()) null else account.resources.findProxy(existingId)
        val next = (existing ?: one.zephyr.mobile.model.Proxy(
            id = "proxy-" + java.util.UUID.randomUUID().toString(), ownerUserId = owner, name = name, host = host, port = port,
        )).copy(name = name, host = host, port = port, username = args.string("username").ifBlank { existing?.username.orEmpty() })
        val password = args.string("password")
        val secret = if (password.isBlank()) one.zephyr.mobile.model.SecretState.Unchanged else one.zephyr.mobile.model.SecretState.Replace(password)
        return try {
            account.resources.saveProxy(next, listOf("name", "host", "port", "type", "username"), secret, owner, createdLocally = existing == null)
            JsonObject(mapOf("proxyId" to JsonPrimitive(next.id), "saved" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("proxy_write_failed", failure.message ?: "代理保存失败")
        }
    }

    private suspend fun resourceDelete(entityType: String, id: String, label: String): JsonElement {
        if (id.isBlank()) return error("invalid_tool_arguments", "id 不能为空")
        val owner = account.binding.userId
        val dependents = account.connections.dependentsOf(id, owner)
        if (dependents.isNotEmpty()) {
            return error("forbidden_dependency", label + "仍被 " + dependents.joinToString("、") { it.name } + " 使用，先改这些连接的路由再删除")
        }
        return try {
            account.resources.delete(entityType, id, owner)
            JsonObject(mapOf("deleted" to JsonPrimitive(true), "id" to JsonPrimitive(id)))
        } catch (failure: Exception) {
            error("delete_failed", failure.message ?: "删除失败")
        }
    }

    private suspend fun proxyDelete(id: String) = resourceDelete(one.zephyr.mobile.model.Proxy.ENTITY_TYPE, id, "代理")

    private suspend fun sshKeyList(): JsonElement = JsonObject(mapOf("sshKeys" to JsonArray(
        account.resources.observeSshKeys(account.binding.userId).firstOrNull().orEmpty()
            .filter { it.deletedAt == null }
            .map { k -> JsonObject(mapOf(
                "sshKeyId" to JsonPrimitive(k.id), "name" to JsonPrimitive(k.name), "remark" to JsonPrimitive(k.remark),
                "hasPrivateKey" to JsonPrimitive(k.privateKey.hasValue), "hasPassphrase" to JsonPrimitive(k.passphrase.hasValue),
            )) },
    )))

    private suspend fun sshKeyWrite(args: JsonObject): JsonElement {
        val name = args.string("name")
        if (name.isBlank()) return error("invalid_tool_arguments", "name 不能为空")
        val owner = account.binding.userId
        val existingId = args.string("sshKeyId")
        val existing = if (existingId.isBlank()) null else account.resources.findSshKey(existingId)
        val privateKey = args.string("privateKey")
        // A create needs material; an update with a blank key keeps the stored one.
        if (existing == null && privateKey.isBlank()) return error("invalid_tool_arguments", "新建密钥必须提供 privateKey")
        val next = (existing ?: one.zephyr.mobile.model.SshKey(
            id = "key-" + java.util.UUID.randomUUID().toString(), ownerUserId = owner, name = name,
        )).copy(name = name, remark = args.string("remark").ifBlank { existing?.remark.orEmpty() })
        val keySecret = if (privateKey.isBlank()) one.zephyr.mobile.model.SecretState.Unchanged else one.zephyr.mobile.model.SecretState.Replace(privateKey)
        val pass = args.string("passphrase")
        val passSecret = if (pass.isBlank()) one.zephyr.mobile.model.SecretState.Unchanged else one.zephyr.mobile.model.SecretState.Replace(pass)
        return try {
            account.resources.saveSshKey(next, listOf("name", "remark"), keySecret, passSecret, owner, createdLocally = existing == null)
            JsonObject(mapOf("sshKeyId" to JsonPrimitive(next.id), "saved" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("ssh_key_write_failed", failure.message ?: "密钥保存失败")
        }
    }

    private suspend fun sshKeyDelete(id: String) = resourceDelete(one.zephyr.mobile.model.SshKey.ENTITY_TYPE, id, "SSH 密钥")

    private suspend fun jumpHostList(): JsonElement = JsonObject(mapOf("jumpHosts" to JsonArray(
        account.resources.observeJumpHosts(account.binding.userId).firstOrNull().orEmpty()
            .filter { it.deletedAt == null }
            .map { h -> JsonObject(mapOf(
                "jumpHostId" to JsonPrimitive(h.id), "name" to JsonPrimitive(h.name), "connectionId" to JsonPrimitive(h.connectionId),
            )) },
    )))

    private suspend fun jumpHostWrite(args: JsonObject): JsonElement {
        val name = args.string("name"); val connectionId = args.string("connectionId")
        if (name.isBlank() || connectionId.isBlank()) return error("invalid_tool_arguments", "name 和 connectionId 不能为空")
        val owner = account.binding.userId
        if (account.connections.find(connectionId) == null) return error("invalid_tool_arguments", "目标连接不存在")
        val existingId = args.string("jumpHostId")
        val existing = if (existingId.isBlank()) null else account.resources.findJumpHost(existingId)
        val next = (existing ?: one.zephyr.mobile.model.JumpHost(
            id = "jump-" + java.util.UUID.randomUUID().toString(), ownerUserId = owner, name = name, connectionId = connectionId,
        )).copy(name = name, connectionId = connectionId)
        return try {
            account.resources.saveJumpHost(next, listOf("name", "connectionId"), owner, createdLocally = existing == null)
            JsonObject(mapOf("jumpHostId" to JsonPrimitive(next.id), "saved" to JsonPrimitive(true)))
        } catch (failure: Exception) {
            error("jump_host_write_failed", failure.message ?: "JumpHost 保存失败")
        }
    }

    private suspend fun jumpHostDelete(id: String) = resourceDelete(one.zephyr.mobile.model.JumpHost.ENTITY_TYPE, id, "JumpHost")

    // -- connection read / test -------------------------------------------------------------------

    private suspend fun connectionGet(connectionId: String): JsonElement {
        if (connectionId.isBlank()) return error("invalid_tool_arguments", "connectionId 不能为空")
        val c = account.connections.find(connectionId) ?: return error("not_found", "连接不存在")
        return JsonObject(mapOf(
            "connectionId" to JsonPrimitive(c.id), "name" to JsonPrimitive(c.name),
            "protocol" to JsonPrimitive(c.protocol.wireName), "host" to JsonPrimitive(c.host),
            "port" to JsonPrimitive(c.port), "username" to JsonPrimitive(c.username),
            "remark" to JsonPrimitive(c.remark), "tags" to JsonArray(c.tags.map(::JsonPrimitive)),
        ))
    }

    private suspend fun connectionTest(connectionId: String): JsonElement {
        if (connectionId.isBlank()) return error("invalid_tool_arguments", "connectionId 不能为空")
        if (account.connections.find(connectionId) == null) return error("not_found", "连接不存在")
        return error("not_supported", "连接测试需要交互式会话上下文，请改用 connection_list_v1 核对配置后在终端打开")
    }

    // -- SFTP, via the same session pool as the interactive browser --

    private fun requireSftp(): SftpPort? = sftp

    private suspend fun <T> withSftp(args: JsonObject, block: suspend (one.zephyr.mobile.feature.notes.SftpSessionHandle) -> T): T {
        val port = requireSftp() ?: throw IllegalStateException("本机 SFTP 不可用")
        val connectionId = args.string("connectionId")
        require(connectionId.isNotBlank()) { "connectionId 不能为空" }
        val handle = port.open(connectionId)
        try {
            return block(handle)
        } finally {
            runCatching { port.close(handle) }
        }
    }

    private suspend fun sftpList(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            val path = args.string("path").ifBlank { "/" }
            val entries = requireSftp()!!.list(h, path)
            JsonObject(mapOf("entries" to JsonArray(entries.map { e ->
                JsonObject(mapOf(
                    "name" to JsonPrimitive(e.name),
                    "path" to JsonPrimitive(e.path),
                    "directory" to JsonPrimitive(e.isDirectory),
                    "size" to JsonPrimitive(e.sizeBytes),
                ))
            })))
        }
    }

    private suspend fun sftpStat(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            val stat = requireSftp()!!.stat(h, args.string("path"))
            if (stat == null) error("not_found", "远程路径不存在") else JsonObject(mapOf(
                "path" to JsonPrimitive(stat.path),
                "directory" to JsonPrimitive(stat.isDirectory),
                "size" to JsonPrimitive(stat.sizeBytes),
            ))
        }
    }

    private suspend fun sftpRead(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            val read = requireSftp()!!.read(h, args.string("path"), MAX_SFTP_READ)
            JsonObject(mapOf(
                "path" to JsonPrimitive(args.string("path")),
                "content" to JsonPrimitive(read.bytes.toString(Charsets.UTF_8)),
                "size" to JsonPrimitive(read.bytes.size),
                "truncated" to JsonPrimitive(read.truncated),
            ))
        }
    }

    private suspend fun sftpWrite(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            val content = args.string("content")
            require(content.toByteArray(Charsets.UTF_8).size <= MAX_SFTP_WRITE) { "写入内容超过上限" }
            val receipt = requireSftp()!!.upload(h, args.string("path"), content.toByteArray(Charsets.UTF_8))
            JsonObject(mapOf("path" to JsonPrimitive(receipt.path), "sha256" to JsonPrimitive(receipt.sha256)))
        }
    }

    private suspend fun sftpMkdir(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            requireSftp()!!.createDirectory(h, args.string("path"))
            JsonObject(mapOf("created" to JsonPrimitive(true)))
        }
    }

    private suspend fun sftpRename(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            requireSftp()!!.rename(h, args.string("oldPath"), args.string("newPath"))
            JsonObject(mapOf("renamed" to JsonPrimitive(true)))
        }
    }

    private suspend fun sftpDelete(args: JsonObject): JsonElement = runSftp(args) {
        withSftp(args) { h ->
            requireSftp()!!.delete(h, args.string("path"), args["recursive"]?.let { (it as? JsonPrimitive)?.content == "true" } ?: false)
            JsonObject(mapOf("deleted" to JsonPrimitive(true)))
        }
    }

    private suspend fun webSearch(args: JsonObject): JsonElement {
        val query = args.string("query").trim()
        if (query.isEmpty()) return error("invalid_tool_arguments", "query 不能为空")
        val maxResults = args.string("maxResults").toIntOrNull()?.coerceIn(1, 12) ?: 6
        return try {
            JsonArray(AndroidAiWebTools.search(http, query, maxResults).map { hit ->
                JsonObject(
                    mapOf(
                        "title" to JsonPrimitive(hit.title),
                        "url" to JsonPrimitive(hit.url),
                        "snippet" to JsonPrimitive(hit.snippet),
                    ),
                )
            })
        } catch (failure: Exception) {
            error("web_search_failed", failure.message ?: "网页搜索失败")
        }
    }

    private suspend fun fetchUrl(args: JsonObject): JsonElement {
        val url = args.string("url").trim()
        if (url.isEmpty()) return error("invalid_tool_arguments", "url 不能为空")
        val maxChars = args.string("maxChars").toIntOrNull()?.coerceIn(1000, 120_000) ?: 24_000
        return try {
            JsonObject(mapOf("text" to JsonPrimitive(AndroidAiWebTools.fetch(http, url, maxChars))))
        } catch (failure: Exception) {
            error("fetch_url_failed", failure.message ?: "抓取失败")
        }
    }

    private suspend fun memorySearch(args: JsonObject): JsonElement {
        val query = args.string("query").trim().lowercase()
        val catalog = account.localAi.load()
        val hits = catalog.memories.filter { it.enabled }.filter { memory ->
            query.isEmpty() ||
                memory.title.lowercase().contains(query) ||
                memory.content.lowercase().contains(query) ||
                memory.tags.any { it.lowercase().contains(query) }
        }.take(catalog.context.memoryItems.coerceAtLeast(1))
        return JsonArray(
            hits.map { memory ->
                JsonObject(
                    mapOf(
                        "id" to JsonPrimitive(memory.id),
                        "title" to JsonPrimitive(memory.title),
                        "scope" to JsonPrimitive(memory.scope),
                        "content" to JsonPrimitive(memory.content.take(4_000)),
                    ),
                )
            },
        )
    }

    private suspend fun memorySave(args: JsonObject): JsonElement {
        val title = args.string("title").trim()
        val content = args.string("content").trim()
        if (title.isEmpty() || content.isEmpty()) return error("invalid_tool_arguments", "title 和 content 不能为空")
        val item = LocalAiMemory(
            title = title.take(200),
            content = content.take(16_000),
            scope = args.string("scope").ifBlank { "global" },
            project = args.string("project"),
            tags = args.array("tags"),
            enabled = true,
        )
        account.localAi.upsertMemory(item)
        return JsonObject(mapOf("saved" to JsonPrimitive(true), "title" to JsonPrimitive(item.title)))
    }

    private suspend fun listEnvVars(): JsonElement {
        val catalog = account.localAi.load()
        return JsonArray(
            catalog.environment.filter { it.enabled && it.visibleToAi }.map { env ->
                JsonObject(
                    mapOf(
                        "id" to JsonPrimitive(env.id),
                        "name" to JsonPrimitive(env.name),
                        "description" to JsonPrimitive(env.description),
                        "valueVisibleToAi" to JsonPrimitive(env.valueVisibleToAi),
                    ),
                )
            },
        )
    }

    private suspend fun getEnvVar(args: JsonObject): JsonElement {
        val name = args.string("name").trim()
        if (name.isEmpty()) return error("invalid_tool_arguments", "name 不能为空")
        val catalog = account.localAi.load()
        val env = catalog.environment.firstOrNull { it.enabled && it.visibleToAi && it.name.equals(name, ignoreCase = true) }
            ?: return error("env_not_found", "环境变量不存在或未对 AI 可见")
        if (!env.valueVisibleToAi) return error("env_value_hidden", "该变量值未对 AI 开放")
        val chars = account.localAi.environmentValue(env.id) ?: return error("env_empty", "环境变量没有值")
        return try {
            JsonObject(mapOf("name" to JsonPrimitive(env.name), "value" to JsonPrimitive(String(chars))))
        } finally {
            chars.fill('\u0000')
        }
    }

    private suspend fun planTask(args: JsonObject): JsonElement {
        val title = args.string("title").trim()
        if (title.isEmpty()) return error("invalid_tool_arguments", "title 不能为空")
        val steps = args.array("steps").ifEmpty {
            args.string("steps").lineSequence().map(String::trim).filter(String::isNotEmpty).toList()
        }
        val plan = LocalAiPlan(
            id = UUID.randomUUID().toString(),
            title = title.take(200),
            status = "planned",
            risk = args.string("risk"),
            note = args.string("note"),
            steps = steps.mapIndexed { index, step -> LocalAiPlanStep(id = "${index + 1}", title = step) },
        )
        account.localAi.upsertPlan(plan)
        return JsonObject(mapOf("id" to JsonPrimitive(plan.id), "title" to JsonPrimitive(plan.title), "status" to JsonPrimitive(plan.status)))
    }

    private suspend fun planUpdate(args: JsonObject): JsonElement {
        val id = args.string("id").trim()
        if (id.isEmpty()) return error("invalid_tool_arguments", "id 不能为空")
        val catalog = account.localAi.load()
        val current = catalog.plans.firstOrNull { it.id == id } ?: return error("plan_not_found", "计划不存在")
        val next = current.copy(
            title = args.string("title").ifBlank { current.title },
            status = args.string("status").ifBlank { current.status },
            risk = args.string("risk").ifBlank { current.risk },
            note = args.string("note").ifBlank { current.note },
            updatedAt = System.currentTimeMillis(),
        )
        account.localAi.upsertPlan(next)
        return JsonObject(mapOf("id" to JsonPrimitive(next.id), "status" to JsonPrimitive(next.status)))
    }

    private suspend fun planDelete(args: JsonObject): JsonElement {
        val id = args.string("id").trim()
        if (id.isEmpty()) return error("invalid_tool_arguments", "id 不能为空")
        account.localAi.deletePlan(id)
        return JsonObject(mapOf("deleted" to JsonPrimitive(true), "id" to JsonPrimitive(id)))
    }

    private suspend fun runSftp(args: JsonObject, block: suspend () -> JsonElement): JsonElement {
        if (sftp == null) return error("sftp_unavailable", "本机 SFTP 不可用")
        return try {
            block()
        } catch (failure: IllegalArgumentException) {
            error("invalid_tool_arguments", failure.message ?: "SFTP 参数无效")
        } catch (failure: Exception) {
            error("sftp_failed", failure.message ?: "SFTP 操作失败")
        }
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
    override fun close() {
        val host = synchronized(lifecycleLock) {
            if (closed) return
            closed = true
            active.also { active = null }
        }
        host?.server?.close()
        host?.executor?.shutdownNow()
    }
    private fun randomToken(): String { val b = ByteArray(32).also(SecureRandom()::nextBytes); return try { android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE) } finally { b.fill(0) } }

    companion object {
        private const val MAX_BODY = 16 * 1024 * 1024
        private const val MAX_SFTP_READ = 4L * 1024 * 1024
        private const val MAX_SFTP_WRITE = 1024 * 1024
    }
}
