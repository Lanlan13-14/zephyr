package one.zephyr.mobile.app

import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import one.zephyr.mobile.feature.notes.DownloadProgress
import one.zephyr.mobile.feature.notes.RemoteEntry
import one.zephyr.mobile.feature.notes.RemoteFileRead
import one.zephyr.mobile.feature.notes.RemoteStat
import one.zephyr.mobile.feature.notes.RemoteWriteReceipt
import one.zephyr.mobile.feature.notes.SftpPort
import one.zephyr.mobile.feature.notes.SftpSessionHandle
import one.zephyr.mobile.protocol.ssh.SftpEntry
import one.zephyr.mobile.protocol.ssh.SshEngine
import one.zephyr.mobile.protocol.ssh.SshRemoteFileConflict
import one.zephyr.mobile.protocol.ssh.SshRemoteFileVersion

class SshjSftpPort(
    private val pool: ManagedSshSessionPool,
    private val engine: SshEngine,
    private val sessions: one.zephyr.mobile.data.session.SessionRegistry,
) : SftpPort {
    private data class Handle(val sessionId: String, val lease: ManagedSshLease?)
    private val handles = ConcurrentHashMap<String, Handle>()

    override suspend fun open(connectionId: String): SftpSessionHandle {
        val token = "sftp-${java.util.UUID.randomUUID()}"
        val live = sessions.rows.value.firstOrNull {
            it.connectionId == connectionId && it.transport == one.zephyr.mobile.data.session.SessionTransport.CONNECTED
        }
        handles[token] = if (live != null) {
            Handle(live.sessionId, null)
        } else {
            val lease = pool.acquire(connectionId)
            Handle(lease.sessionId, lease)
        }
        return SftpSessionHandle(token)
    }

    override suspend fun close(handle: SftpSessionHandle) {
        handles.remove(handle.token)?.lease?.close()
    }

    override suspend fun isOpen(handle: SftpSessionHandle): Boolean = handles.containsKey(handle.token)

    private fun session(handle: SftpSessionHandle): String =
        handles[handle.token]?.sessionId ?: error("SFTP 会话已关闭")

    override suspend fun canonicalPath(handle: SftpSessionHandle, path: String): String =
        engine.listDirectory(session(handle), path).getOrThrow().path

    override suspend fun list(handle: SftpSessionHandle, directory: String): List<RemoteEntry> =
        engine.listDirectory(session(handle), directory).getOrThrow().entries.map { it.remote() }

    override suspend fun stat(handle: SftpSessionHandle, path: String): RemoteStat? =
        engine.stat(session(handle), path).getOrThrow()?.let {
            RemoteStat(it.path, it.isDirectory, it.size, it.modifiedAt, null)
        }

    override suspend fun read(handle: SftpSessionHandle, path: String, maxBytes: Long): RemoteFileRead {
        val file = engine.readFile(session(handle), path, maxBytes.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()).getOrThrow()
        return RemoteFileRead(file.path, file.bytes, file.modifiedAt, sha256(file.bytes), truncated = false)
    }

    override suspend fun write(
        handle: SftpSessionHandle,
        path: String,
        bytes: ByteArray,
        expectedMtimeMs: Long?,
        expectedSha256: String?,
        force: Boolean,
    ): RemoteWriteReceipt {
        var expectedVersion: SshRemoteFileVersion? = null
        if (!force && expectedSha256 != null) {
            val current = engine.readFile(session(handle), path, EDIT_READ_LIMIT).getOrThrow()
            if (current.modifiedAt != expectedMtimeMs || sha256(current.bytes) != expectedSha256) {
                throw SshRemoteFileConflict(path, current.size, current.modifiedAt)
            }
            expectedVersion = SshRemoteFileVersion(path, current.size, current.modifiedAt)
        }
        val version = engine.writeFile(
            session(handle),
            path,
            bytes,
            expectedVersion,
        ).getOrThrow()
        return RemoteWriteReceipt(version.path, version.modifiedAt, sha256(bytes))
    }

    override suspend fun createDirectory(handle: SftpSessionHandle, path: String) {
        engine.createDirectory(session(handle), path).getOrThrow()
    }

    override suspend fun createFile(handle: SftpSessionHandle, path: String) {
        engine.createFile(session(handle), path).getOrThrow()
    }

    override suspend fun rename(handle: SftpSessionHandle, from: String, to: String) {
        engine.rename(session(handle), from, to).getOrThrow()
    }

    override suspend fun delete(handle: SftpSessionHandle, path: String, recursive: Boolean) {
        engine.delete(session(handle), path, recursive).getOrThrow()
    }

    override suspend fun upload(handle: SftpSessionHandle, path: String, bytes: ByteArray): RemoteWriteReceipt {
        val version = engine.writeFile(session(handle), path, bytes).getOrThrow()
        return RemoteWriteReceipt(version.path, version.modifiedAt, sha256(bytes))
    }

    override suspend fun download(
        handle: SftpSessionHandle,
        path: String,
        destinationUri: String,
        resumeFromBytes: Long,
        onProgress: (DownloadProgress) -> Unit,
    ): Long = throw UnsupportedOperationException("SAF download sink is not available in this adapter")

    private fun SftpEntry.remote() = RemoteEntry(
        name, path, isDirectory, size, modifiedAt, permissions.toString(8), isSymlink,
    )

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    companion object {
        private const val EDIT_READ_LIMIT = 512 * 1024
    }
}
