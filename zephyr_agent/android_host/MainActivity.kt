package com.zephyr.zephyr_agent

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.annotation.NonNull
import androidx.documentfile.provider.DocumentFile
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.UUID

class MainActivity : FlutterActivity() {
    private val channelName = "com.zephyr.agent/saf"
    private val requestOpenTree = 0x5A13
    private var pendingSelectResult: MethodChannel.Result? = null
    private val handles = mutableMapOf<String, SafHandle>()

    data class SafHandle(
        val uri: Uri,
        val mode: String,
        val pfd: ParcelFileDescriptor? = null,
    )

    override fun configureFlutterEngine(@NonNull flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "selectDirectory" -> selectDirectory(result)
                    "list" -> list(call, result)
                    "stat" -> stat(call, result)
                    "open" -> open(call, result)
                    "read" -> read(call, result)
                    "write" -> write(call, result)
                    "close" -> close(call, result)
                    "mkdir" -> mkdir(call, result)
                    "delete" -> delete(call, result)
                    "rename" -> rename(call, result)
                    "truncate" -> truncate(call, result)
                    else -> result.notImplemented()
                }
            } catch (e: SafException) {
                result.error(e.code, e.message, null)
            } catch (e: Exception) {
                result.error("io_error", e.message ?: e.javaClass.simpleName, null)
            }
        }
    }

    private fun selectDirectory(result: MethodChannel.Result) {
        if (pendingSelectResult != null) {
            result.error("busy", "Directory picker already active", null)
            return
        }
        pendingSelectResult = result
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        }
        startActivityForResult(intent, requestOpenTree)
    }

    @Deprecated("Deprecated in Android API, still supported by FlutterActivity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != requestOpenTree) return
        val result = pendingSelectResult ?: return
        pendingSelectResult = null
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            result.success(null)
            return
        }
        val uri = data.data!!
        val flags = data.flags and (
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        contentResolver.takePersistableUriPermission(uri, flags)
        val root = DocumentFile.fromTreeUri(this, uri)
        result.success(
            mapOf(
                "uri" to uri.toString(),
                "name" to (root?.name ?: "Android Share"),
            )
        )
    }

    private fun list(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val path = call.argument<String>("path") ?: "/"
        val dir = resolve(root, path) ?: throw SafException("not_found", "Directory not found: $path")
        if (!dir.isDirectory) throw SafException("not_directory", "Not a directory: $path")
        val prefix = normalizeVirtualPath(path).trimEnd('/')
        val entries = dir.listFiles().mapNotNull { child ->
            val name = child.name ?: return@mapNotNull null
            mapOf(
                "name" to name,
                "path" to if (prefix.isEmpty()) "/$name" else "$prefix/$name",
                "isDir" to child.isDirectory,
                "size" to if (child.isDirectory) 0L else child.length(),
                "mtime" to child.lastModified(),
            )
        }
        result.success(entries)
    }

    private fun stat(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val path = call.argument<String>("path") ?: "/"
        val doc = resolve(root, path) ?: throw SafException("not_found", "Not found: $path")
        result.success(fileMap(doc, normalizeVirtualPath(path)))
    }

    private fun open(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val path = call.argument<String>("path") ?: throw SafException("invalid_path", "Missing path")
        val mode = call.argument<String>("mode") ?: "read"
        val doc = if (mode == "write") {
            resolveOrCreateFile(root, path)
        } else {
            resolve(root, path) ?: throw SafException("not_found", "File not found: $path")
        }
        if (doc.isDirectory) throw SafException("is_directory", "Cannot open directory as file")
        val handle = "h_${UUID.randomUUID().toString().replace("-", "").take(12)}"
        val pfd = if (mode == "write") contentResolver.openFileDescriptor(doc.uri, "rw") else null
        handles[handle] = SafHandle(doc.uri, mode, pfd)
        result.success(handle)
    }

    private fun read(call: MethodCall, result: MethodChannel.Result) {
        val handleId = call.argument<String>("handle") ?: throw SafException("invalid_parameter", "Missing handle")
        val offset = numberArg(call, "offset").toLong()
        val length = numberArg(call, "length").toInt().coerceAtLeast(0)
        val handle = handles[handleId] ?: throw SafException("not_found", "Invalid handle")
        val input = contentResolver.openInputStream(handle.uri) ?: throw SafException("io_error", "Cannot open input stream")
        input.use { stream ->
            var skipped = 0L
            while (skipped < offset) {
                val step = stream.skip(offset - skipped)
                if (step <= 0) break
                skipped += step
            }
            val buffer = ByteArray(length)
            val read = stream.read(buffer)
            result.success(if (read <= 0) ByteArray(0) else buffer.copyOf(read))
        }
    }

    private fun write(call: MethodCall, result: MethodChannel.Result) {
        val handleId = call.argument<String>("handle") ?: throw SafException("invalid_parameter", "Missing handle")
        val offset = numberArg(call, "offset").toLong()
        val data = call.argument<ByteArray>("data") ?: ByteArray(0)
        val handle = handles[handleId] ?: throw SafException("not_found", "Invalid handle")
        val pfd = handle.pfd ?: contentResolver.openFileDescriptor(handle.uri, "rw")
        val stream = FileOutputStream(pfd!!.fileDescriptor)
        val channel = stream.channel
        channel.position(offset)
        channel.write(ByteBuffer.wrap(data))
        channel.force(true)
        result.success(data.size)
    }

    private fun close(call: MethodCall, result: MethodChannel.Result) {
        val handleId = call.argument<String>("handle") ?: return result.success(null)
        val handle = handles.remove(handleId)
        handle?.pfd?.close()
        result.success(null)
    }

    private fun mkdir(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val path = call.argument<String>("path") ?: throw SafException("invalid_path", "Missing path")
        val parentPath = parentOf(path)
        val name = leafOf(path)
        val parent = resolve(root, parentPath) ?: throw SafException("not_found", "Parent not found: $parentPath")
        val existing = parent.findFile(name)
        if (existing != null) {
            if (!existing.isDirectory) throw SafException("already_exists", "File exists: $path")
            result.success(null)
            return
        }
        parent.createDirectory(name) ?: throw SafException("io_error", "Failed to create directory")
        result.success(null)
    }

    private fun delete(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val path = call.argument<String>("path") ?: throw SafException("invalid_path", "Missing path")
        val doc = resolve(root, path) ?: throw SafException("not_found", "Not found: $path")
        if (!doc.delete()) throw SafException("io_error", "Delete failed: $path")
        result.success(null)
    }

    private fun rename(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val oldPath = call.argument<String>("oldPath") ?: throw SafException("invalid_path", "Missing oldPath")
        val newPath = call.argument<String>("newPath") ?: throw SafException("invalid_path", "Missing newPath")
        if (parentOf(oldPath) != parentOf(newPath)) {
            throw SafException("unsupported", "SAF rename across directories is not supported yet")
        }
        val doc = resolve(root, oldPath) ?: throw SafException("not_found", "Not found: $oldPath")
        if (!doc.renameTo(leafOf(newPath))) throw SafException("io_error", "Rename failed")
        result.success(null)
    }

    private fun truncate(call: MethodCall, result: MethodChannel.Result) {
        val root = root(call)
        val path = call.argument<String>("path") ?: throw SafException("invalid_path", "Missing path")
        val size = numberArg(call, "size").toLong()
        val doc = resolve(root, path) ?: throw SafException("not_found", "Not found: $path")
        contentResolver.openFileDescriptor(doc.uri, "rw")?.use { pfd ->
            FileOutputStream(pfd.fileDescriptor).channel.truncate(size)
        } ?: throw SafException("io_error", "Cannot open file")
        result.success(null)
    }

    private fun root(call: MethodCall): DocumentFile {
        val uriString = call.argument<String>("rootUri") ?: throw SafException("invalid_path", "Missing rootUri")
        val uri = Uri.parse(uriString)
        return DocumentFile.fromTreeUri(this, uri) ?: throw SafException("not_found", "Invalid root uri")
    }

    private fun resolve(root: DocumentFile, path: String): DocumentFile? {
        val normalized = normalizeVirtualPath(path)
        if (normalized == "/") return root
        var current = root
        for (segment in segments(normalized)) {
            current = current.findFile(segment) ?: return null
        }
        return current
    }

    private fun resolveOrCreateFile(root: DocumentFile, path: String): DocumentFile {
        val existing = resolve(root, path)
        if (existing != null) return existing
        val parentPath = parentOf(path)
        val name = leafOf(path)
        val parent = resolve(root, parentPath) ?: throw SafException("not_found", "Parent not found: $parentPath")
        return parent.createFile("application/octet-stream", name)
            ?: throw SafException("io_error", "Failed to create file: $path")
    }

    private fun fileMap(doc: DocumentFile, virtualPath: String): Map<String, Any?> {
        return mapOf(
            "name" to (if (virtualPath == "/") (doc.name ?: "Android Share") else leafOf(virtualPath)),
            "path" to virtualPath,
            "isDir" to doc.isDirectory,
            "size" to if (doc.isDirectory) 0L else doc.length(),
            "mtime" to doc.lastModified(),
            "canRead" to doc.canRead(),
            "canWrite" to doc.canWrite(),
        )
    }

    private fun normalizeVirtualPath(path: String): String {
        if (path.indexOf('\u0000') >= 0) throw SafException("invalid_path", "NUL is not allowed")
        val parts = path.replace('\\', '/').split('/').filter { it.isNotBlank() }
        if (parts.any { it == "." || it == ".." || it.contains(':') }) {
            throw SafException("invalid_path", "Unsafe path: $path")
        }
        return if (parts.isEmpty()) "/" else "/" + parts.joinToString("/")
    }

    private fun segments(path: String): List<String> = normalizeVirtualPath(path).trim('/').split('/').filter { it.isNotEmpty() }
    private fun parentOf(path: String): String {
        val s = segments(path)
        return if (s.size <= 1) "/" else "/" + s.dropLast(1).joinToString("/")
    }
    private fun leafOf(path: String): String {
        val s = segments(path)
        if (s.isEmpty()) throw SafException("invalid_path", "Missing file name")
        return s.last()
    }

    private fun numberArg(call: MethodCall, key: String): Number {
        return call.argument<Number>(key) ?: throw SafException("invalid_parameter", "Missing $key")
    }

    class SafException(val code: String, override val message: String) : Exception(message)
}
