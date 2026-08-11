package one.zephyr.mobile.security

import android.system.Os
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.SecretRef

/**
 * Storage port for wrapped secret blobs.
 *
 * Business rows never hold ciphertext (DATA_AND_MIGRATION.md 5.1): they hold a [SecretRef] and the
 * bytes live here. Keeping this a port rather than a Room table means core-data can depend on
 * core-security without core-security depending on the database.
 */
interface SecretBlobStore {
    fun read(ref: SecretRef): ByteArray?
    fun write(ref: SecretRef, blob: ByteArray)
    fun delete(ref: SecretRef)
    fun listRefs(): List<SecretRef>
    fun deleteAll()
}

/**
 * File-backed blob store rooted in the app's private no-backup directory.
 *
 * no-backup is deliberate: LOCAL_SECURITY.md forbids device secrets from entering any cloud or
 * adb backup, and the wrapped blobs are useless off-device anyway because the unwrapping key is
 * non-exportable Keystore material.
 */
class FileSecretBlobStore internal constructor(
    private val root: File,
    private val deleteFile: (File) -> Boolean,
) : SecretBlobStore {

    constructor(root: File) : this(root, deleteFile = { file -> file.delete() })

    private val unreadableRefs = ConcurrentHashMap.newKeySet<String>()
    private val ioLock = Any()

    init {
        if (!root.exists()) root.mkdirs()
    }

    override fun read(ref: SecretRef): ByteArray? = synchronized(ioLock) {
        if (isDenied(ref)) return@synchronized null
        val file = fileFor(ref)
        if (file.isFile) file.readBytes() else null
    }

    override fun write(ref: SecretRef, blob: ByteArray) {
        synchronized(ioLock) {
            val file = fileFor(ref)
            file.parentFile?.mkdirs()
            // rename(2) is the commit point and replaces an existing destination atomically. Sync the
            // temporary file first so a completed rotation cannot point at a half-durable envelope.
            val temp = File(file.parentFile, file.name + ".tmp-" + Thread.currentThread().id + "-" + System.nanoTime())
            try {
                FileOutputStream(temp).use { output ->
                    output.write(blob)
                    output.fd.sync()
                }
                Os.rename(temp.absolutePath, file.absolutePath)
                clearDeleteMarker(ref)
                unreadableRefs.remove(ref.value)
            } finally {
                temp.delete()
            }
        }
    }

    override fun delete(ref: SecretRef) {
        synchronized(ioLock) {
            val file = fileFor(ref)
            unreadableRefs.add(ref.value)
            if (!file.exists()) {
                clearDeleteMarker(ref)
                return@synchronized
            }

            // Persist the deny marker before touching the blob. If deletion fails, the exception must
            // abort the surrounding mirror transaction while this process and a restarted one both
            // refuse to read the old ciphertext.
            persistDeleteMarker(ref)
            val deleted = deleteFile(file)
            if (!deleted) {
                throw IOException("failed to delete secret blob")
            }
            clearDeleteMarker(ref)
            unreadableRefs.remove(ref.value)
        }
    }

    override fun listRefs(): List<SecretRef> = synchronized(ioLock) {
        root.walkTopDown()
            .filter { it.isFile && it.extension == "bin" }
            .mapNotNull { file -> decodeName(file.nameWithoutExtension)?.let(::SecretRef) }
            .filterNot(::isDenied)
            .toList()
    }

    override fun deleteAll() {
        root.deleteRecursively()
        root.mkdirs()
    }

    private fun fileFor(ref: SecretRef): File = File(root, encodeName(ref.value) + ".bin")

    private fun markerFor(ref: SecretRef): File = File(root, encodeName(ref.value) + ".deny")

    private fun isDenied(ref: SecretRef): Boolean =
        unreadableRefs.contains(ref.value) || markerFor(ref).isFile

    private fun persistDeleteMarker(ref: SecretRef) {
        val marker = markerFor(ref)
        try {
            FileOutputStream(marker).use { output -> output.fd.sync() }
        } catch (error: Exception) {
            throw IOException("failed to deny reads for secret blob deletion", error)
        }
    }

    private fun clearDeleteMarker(ref: SecretRef) {
        val marker = markerFor(ref)
        if (marker.exists() && !marker.delete()) {
            throw IOException("failed to clear secret blob deletion marker")
        }
    }

    /**
     * Refs contain '/' separators and arbitrary entity ids, so they are encoded rather than used
     * as paths directly. This also prevents a hostile entity id from escaping the root.
     */
    private fun encodeName(value: String): String =
        Base64Codec.encodeUrlNoPad(value.toByteArray(Charsets.UTF_8))

    private fun decodeName(encoded: String): String? = runCatching {
        String(Base64Codec.decodeUrlNoPad(encoded), Charsets.UTF_8)
    }.getOrNull()
}
