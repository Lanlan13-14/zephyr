package one.zephyr.mobile.network

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import one.zephyr.mobile.model.SecretRef
import one.zephyr.mobile.security.SecretStore

/** Identity of the account graph allowed to open a credential record. */
data class CredentialScope(
    val bindingKey: String,
    val generation: String,
) {
    init {
        require(bindingKey.isNotBlank()) { "bindingKey must not be blank" }
        require(generation.isNotBlank()) { "generation must not be blank" }
    }
}

/** Small persistence seam used to exercise commit failures without AndroidKeyStore in JVM tests. */
internal interface CredentialPersistence {
    fun read(): ByteArray?
    fun replace(record: ByteArray)
    fun delete()
}

private class SecretStoreCredentialPersistence(
    private val secretStore: SecretStore,
) : CredentialPersistence {
    override fun read(): ByteArray? = secretStore.get(RECORD_REF)

    override fun replace(record: ByteArray) {
        secretStore.put(RECORD_REF, record)
    }

    override fun delete() {
        secretStore.remove(RECORD_REF)
    }

    private companion object {
        val RECORD_REF = SecretRef.of("credential", "current", "bindingRecord")
    }
}

/**
 * Binding-scoped data-plane and management-plane credentials.
 *
 * Access and rotating refresh credentials deliberately share one sealed record. Replacing that
 * record is the commit point, so a process death can leave either the complete old pair or the
 * complete new pair, never a fresh access credential paired with a spent refresh credential.
 * The record repeats the binding key and generation inside the authenticated ciphertext: a stale
 * graph cannot use credentials left by a replacement graph even if it is handed the same storage.
 */
class CredentialStore internal constructor(
    private val persistence: CredentialPersistence,
    private val scope: CredentialScope,
) {

    constructor(secretStore: SecretStore, scope: CredentialScope) :
        this(SecretStoreCredentialPersistence(secretStore), scope)

    @Synchronized
    fun accessCredential(): String? = readCurrent()?.use { record -> record.access?.decodeUtf8() }

    @Synchronized
    fun refreshCredential(): String? = readCurrent()?.use { record -> record.refresh?.decodeUtf8() }

    @Synchronized
    fun sid(): String? = readCurrent()?.use { record -> record.sid?.decodeUtf8() }

    @Synchronized
    fun accessExpiresAt(): Long? = readCurrent()?.use(CredentialRecord::accessExpiresAt)

    /** True when the access credential is missing or within the skew window of expiry. */
    @Synchronized
    fun accessNeedsRefresh(nowMs: Long): Boolean {
        val record = readCurrent() ?: return true
        return record.use {
            if (it.access == null) return@use true
            val expiry = it.accessExpiresAt ?: return@use false
            nowMs >= expiry - EXPIRY_SKEW_MS
        }
    }

    /** Initial bind and refresh rotation use the same single-record commit operation. */
    @Synchronized
    fun replaceBindingCredentials(access: String, expiresAt: Long?, refresh: String) {
        replaceBindingCredentials(access.toUtf8(), expiresAt, refresh.toUtf8())
    }

    /**
     * Byte-array overload for callers that can avoid immutable Strings. The arrays remain owned by
     * the caller and are not retained; the caller should clear them after this method returns.
     */
    @Synchronized
    fun replaceBindingCredentials(access: ByteArray, expiresAt: Long?, refresh: ByteArray) {
        val previous = readCurrent()
        val next = CredentialRecord(
            bindingKey = scope.bindingKey,
            generation = scope.generation,
            access = access.copyOf(),
            accessExpiresAt = expiresAt,
            refresh = refresh.copyOf(),
            sid = previous?.sid?.copyOf(),
        )
        try {
            persist(next)
        } finally {
            previous?.close()
            next.close()
        }
    }

    @Synchronized
    fun storeSid(sid: String) {
        val previous = readCurrent()
        val next = CredentialRecord(
            bindingKey = scope.bindingKey,
            generation = scope.generation,
            access = previous?.access?.copyOf(),
            accessExpiresAt = previous?.accessExpiresAt,
            refresh = previous?.refresh?.copyOf(),
            sid = sid.toUtf8(),
        )
        try {
            persist(next)
        } finally {
            previous?.close()
            next.close()
        }
    }

    /** sid_expired only invalidates the management plane; the data plane keeps working. */
    @Synchronized
    fun clearSid() {
        val previous = readCurrent() ?: return
        val next = CredentialRecord(
            bindingKey = scope.bindingKey,
            generation = scope.generation,
            access = previous.access?.copyOf(),
            accessExpiresAt = previous.accessExpiresAt,
            refresh = previous.refresh?.copyOf(),
            sid = null,
        )
        try {
            persist(next)
        } finally {
            previous.close()
            next.close()
        }
    }

    @Synchronized
    fun clearAll() {
        val current = readCurrent() ?: return
        current.close()
        persistence.delete()
    }

    private fun readCurrent(): CredentialRecord? {
        val encoded = persistence.read() ?: return null
        return try {
            val record = CredentialRecord.decode(encoded)
            if (record.bindingKey == scope.bindingKey && record.generation == scope.generation) {
                record
            } else {
                record.close()
                null
            }
        } catch (_: Exception) {
            null
        } finally {
            encoded.fill(0)
        }
    }

    private fun persist(record: CredentialRecord) {
        val encoded = record.encode()
        try {
            persistence.replace(encoded)
        } finally {
            encoded.fill(0)
        }
    }

    private class CredentialRecord(
        val bindingKey: String,
        val generation: String,
        val access: ByteArray?,
        val accessExpiresAt: Long?,
        val refresh: ByteArray?,
        val sid: ByteArray?,
    ) : AutoCloseable {

        fun encode(): ByteArray = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(MAGIC)
                output.writeInt(VERSION)
                output.writeUTF(bindingKey)
                output.writeUTF(generation)
                output.writeNullableBytes(access)
                output.writeNullableLong(accessExpiresAt)
                output.writeNullableBytes(refresh)
                output.writeNullableBytes(sid)
            }
            bytes.toByteArray()
        }

        override fun close() {
            access?.fill(0)
            refresh?.fill(0)
            sid?.fill(0)
        }

        companion object {
            fun decode(encoded: ByteArray): CredentialRecord {
                var record: CredentialRecord? = null
                return try {
                    DataInputStream(ByteArrayInputStream(encoded)).use { input ->
                    require(input.readInt() == MAGIC) { "credential record magic mismatch" }
                    require(input.readInt() == VERSION) { "unsupported credential record version" }
                    record = CredentialRecord(
                        bindingKey = input.readUTF(),
                        generation = input.readUTF(),
                        access = input.readNullableBytes(),
                        accessExpiresAt = input.readNullableLong(),
                        refresh = input.readNullableBytes(),
                        sid = input.readNullableBytes(),
                    )
                    require(input.read() == -1) { "credential record has trailing data" }
                    checkNotNull(record)
                    }
                } catch (failure: Exception) {
                    record?.close()
                    throw failure
                }
            }
        }
    }

    private companion object {
        const val MAGIC = 0x5A314352 // Z1CR
        const val VERSION = 1
        const val MAX_FIELD_BYTES = 1 shl 20

        /** Refresh slightly early so an in-flight request does not race the expiry. */
        const val EXPIRY_SKEW_MS = 60_000L

        fun String.toUtf8(): ByteArray = toByteArray(Charsets.UTF_8)

        fun ByteArray.decodeUtf8(): String = String(this, Charsets.UTF_8)

        fun DataOutputStream.writeNullableBytes(value: ByteArray?) {
            writeInt(value?.size ?: -1)
            if (value != null) write(value)
        }

        fun DataInputStream.readNullableBytes(): ByteArray? {
            val size = readInt()
            if (size == -1) return null
            require(size in 0..MAX_FIELD_BYTES) { "credential field is too large" }
            return ByteArray(size).also(::readFully)
        }

        fun DataOutputStream.writeNullableLong(value: Long?) {
            writeBoolean(value != null)
            if (value != null) writeLong(value)
        }

        fun DataInputStream.readNullableLong(): Long? = if (readBoolean()) readLong() else null
    }
}
