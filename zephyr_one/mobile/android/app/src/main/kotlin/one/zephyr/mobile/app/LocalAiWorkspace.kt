package one.zephyr.mobile.app

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import one.zephyr.mobile.data.repository.LocalAiRepository

/**
 * Android L2 sandbox: session-root confinement, no shell, fixed applet whitelist, timeout and caps.
 * Android app UID/network sandbox is the outer boundary; network-capable commands are not packaged.
 */
internal class LocalAiWorkspace(
    root: File,
    private val repository: LocalAiRepository,
) {
    private val root = root.apply { mkdirs(); setReadable(false, false); setReadable(true, true); setWritable(false, false); setWritable(true, true) }
    private val uploads = File(root, "uploads").apply { mkdirs() }
    private val workspace = File(root, "workspace").apply { mkdirs() }
    private val outputs = File(root, "outputs").apply { mkdirs() }
    private val audit = File(outputs, ".exec-audit.ndjson")

    suspend fun list(dir: String): List<Map<String, Any>> = withContext(Dispatchers.IO) {
        val target = confined(dir.ifBlank { "workspace" }, write = false)
        target.listFiles()?.sortedWith(compareBy<File> { !it.isDirectory }.thenBy { it.name.lowercase() })?.map {
            mapOf("name" to it.name, "path" to relative(it), "directory" to it.isDirectory, "size" to if (it.isFile) it.length() else 0L, "modifiedAt" to it.lastModified())
        }.orEmpty()
    }

    suspend fun read(path: String): Map<String, Any> = withContext(Dispatchers.IO) {
        val file = confined(path, write = false); require(file.isFile) { "文件不存在" }; require(file.length() <= MAX_READ) { "文件超过读取上限" }
        mapOf("path" to relative(file), "content" to file.readText(), "size" to file.length(), "sha256" to sha256(file))
    }

    suspend fun importUpload(name: String, bytes: ByteArray): Map<String, Any> = withContext(Dispatchers.IO) {
        require(bytes.size <= 12 * 1024 * 1024) { "单文件不能超过 12MB" }
        val safe = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
        val file = confined("uploads/$safe", write = true)
        FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
        mapOf("path" to relative(file), "size" to file.length(), "sha256" to sha256(file))
    }

    suspend fun write(path: String, content: String): Map<String, Any> = withContext(Dispatchers.IO) {
        require(content.toByteArray().size <= MAX_WRITE) { "单次写入超过 1MB" }
        val file = confined(path, write = true); require(relative(file).startsWith("workspace/") || relative(file).startsWith("outputs/")) { "只允许写 workspace/ 或 outputs/" }
        file.parentFile?.mkdirs(); val temp = File(file.parentFile, file.name + ".tmp")
        FileOutputStream(temp).use { it.write(content.toByteArray()); it.fd.sync() }; Os.rename(temp.absolutePath, file.absolutePath)
        mapOf("path" to relative(file), "size" to file.length(), "sha256" to sha256(file))
    }

    suspend fun status(): Map<String, Any> {
        val cfg = repository.load().sandbox
        return mapOf("enabled" to cfg.enabled, "isolation" to "android-app-uid+argv-whitelist+path-confinement", "networkDefault" to false, "workspaceQuotaMb" to cfg.workspaceQuotaMb, "timeoutSeconds" to cfg.timeoutSeconds, "allowedCommands" to cfg.allowedCommands.filter(ALLOWED::contains), "environments" to mapOf("text" to "supported", "python" to "not-packaged", "node" to "not-packaged", "go" to "not-packaged", "rust" to "not-packaged", "ffmpeg" to "not-packaged"))
    }

    suspend fun exec(command: String, args: List<String>): Map<String, Any> = withContext(Dispatchers.IO) {
        val cfg = repository.load().sandbox
        require(cfg.enabled) { "本机沙箱已停用" }
        require(command in ALLOWED && command in cfg.allowedCommands) { "命令不在沙箱白名单" }
        require(args.size <= 128 && args.all { it.length <= 8192 && !it.contains('\u0000') }) { "参数无效" }
        val binary = resolveBinary(command) ?: error("设备没有可用的 $command")
        val safeArgs = args.map { arg -> if (looksLikePath(arg)) relative(confined(arg, write = false)) else arg }
        val started = System.currentTimeMillis()
        val process = ProcessBuilder(listOf(binary.absolutePath) + safeArgs).directory(root).redirectErrorStream(false).start()
        val timeout = cfg.timeoutSeconds.coerceIn(1, 300)
        val done = process.waitFor(timeout.toLong(), TimeUnit.SECONDS)
        if (!done) process.destroyForcibly()
        val stdout = process.inputStream.readNBytes(MAX_STDOUT).toString(Charsets.UTF_8)
        val stderr = process.errorStream.readNBytes(MAX_STDERR).toString(Charsets.UTF_8)
        val out = mapOf("command" to command, "args" to safeArgs, "exitCode" to if (done) process.exitValue() else -1, "timedOut" to !done, "stdout" to stdout, "stderr" to stderr, "durationMs" to System.currentTimeMillis() - started)
        val auditLine = "{\"ts\":$started,\"command\":${jsonString(command)},\"exitCode\":${if (done) process.exitValue() else -1},\"timedOut\":${!done}}"
        FileOutputStream(audit, true).bufferedWriter().use { writer -> writer.append(auditLine).appendLine() }
        out
    }

    private fun jsonString(value: String): String = buildString {
        append('"')
        value.forEach { ch ->
            when (ch) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (ch.code < 0x20) append("\\u%04x".format(ch.code)) else append(ch)
            }
        }
        append('"')
    }

    private fun confined(path: String, write: Boolean): File {
        require(path.isNotBlank() && !File(path).isAbsolute && !path.split('/').contains("..")) { "路径必须是会话相对路径" }
        val candidate = File(root, path).canonicalFile
        require(candidate.path == root.canonicalPath || candidate.path.startsWith(root.canonicalPath + File.separator)) { "路径越界" }
        if (!write) require(candidate.exists()) { "路径不存在" }
        return candidate
    }
    private fun relative(file: File) = file.canonicalFile.relativeTo(root.canonicalFile).invariantSeparatorsPath
    private fun looksLikePath(arg: String) = arg.contains('/') || arg.startsWith("workspace") || arg.startsWith("uploads") || arg.startsWith("outputs")
    private fun resolveBinary(name: String): File? = listOf("/system/bin/$name", "/system/xbin/$name").map(::File).firstOrNull { it.isFile && it.canExecute() }
    private fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }

    companion object {
        private const val MAX_READ = 4L * 1024 * 1024
        private const val MAX_WRITE = 1024 * 1024
        private const val MAX_STDOUT = 1024 * 1024
        private const val MAX_STDERR = 512 * 1024
        private val ALLOWED = setOf("cat", "grep", "sed", "awk", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "sha256sum")
    }
}
