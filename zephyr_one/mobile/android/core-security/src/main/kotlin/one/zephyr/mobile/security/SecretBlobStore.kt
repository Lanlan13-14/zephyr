package one.zephyr.mobile.security

import java.io.File
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
class FileSecretBlobStore(private val root: File) : SecretBlobStore {

    init {
        if (!root.exists()) root.mkdirs()
    }

    override fun read(ref: SecretRef): ByteArray? {
        val file = fileFor(ref)
        return if (file.isFile) file.readBytes() else null
    }

    override fun write(ref: SecretRef, blob: ByteArray) {
        val file = fileFor(ref)
        file.parentFile?.mkdirs()
        // Write-then-rename so a crash cannot leave a half-written envelope that would decrypt
        // to garbage and be reported as tampering.
        val temp = File(file.parentFile, file.name + ".tmp")
        temp.writeBytes(blob)
        if (!temp.renameTo(file)) {
            file.writeBytes(blob)
            temp.delete()
        }
    }

    override fun delete(ref: SecretRef) {
        fileFor(ref).delete()
    }

    override fun listRefs(): List<SecretRef> =
        root.walkTopDown()
            .filter { it.isFile && it.extension == "bin" }
            .mapNotNull { file -> decodeName(file.nameWithoutExtension)?.let(::SecretRef) }
            .toList()

    override fun deleteAll() {
        root.deleteRecursively()
        root.mkdirs()
    }

    private fun fileFor(ref: SecretRef): File = File(root, encodeName(ref.value) + ".bin")

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
