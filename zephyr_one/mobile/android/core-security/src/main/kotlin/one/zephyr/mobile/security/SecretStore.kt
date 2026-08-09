package one.zephyr.mobile.security

import java.util.concurrent.ConcurrentHashMap
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef

/** Raised when a caller tries to persist data that must never reach the device. */
class ResidencyViolationException(message: String) : IllegalStateException(message)

/**
 * Local secret storage for the bound account's own data.
 *
 * Rules enforced here rather than by convention:
 *  - only [Residency.OWNED] material may be written (SHARED_RESOURCE_RESIDENCY.md 3);
 *  - the plaintext cache is memory-only and is dropped whenever the app locks;
 *  - the sealed blob is bound to its ref, the bound user and the server profile, so restoring
 *    another account's blobs or moving a blob between refs fails closed.
 */
class SecretStore(
    private val blobs: SecretBlobStore,
    private val scope: SecretScope,
    private val masterKeyAlias: String = KeystoreMasterKey.ALIAS_SECRET_STORE,
) {

    /** Identity the blobs are bound to. A rebind to a different account cannot open old blobs. */
    data class SecretScope(val serverId: String, val userId: String, val deviceId: String)

    private val plaintextCache = ConcurrentHashMap<String, ByteArray>()

    fun put(ref: SecretRef, plaintext: ByteArray, residency: Residency = Residency.OWNED) {
        if (!residency.allowsLocalPersistence) {
            throw ResidencyViolationException(
                "refusing to persist shared-to-me secret " + ref.value + "; shared resources are online-only",
            )
        }
        val key = KeystoreMasterKey.getOrCreate(masterKeyAlias)
        blobs.write(ref, KeystoreMasterKey.seal(key, plaintext, aadFor(ref)))
        plaintextCache[ref.value] = plaintext.copyOf()
    }

    fun putText(ref: SecretRef, plaintext: String, residency: Residency = Residency.OWNED) {
        val bytes = plaintext.toByteArray(Charsets.UTF_8)
        try {
            put(ref, bytes, residency)
        } finally {
            bytes.fill(0)
        }
    }

    /** @return a copy the caller owns and should zero, or null when the ref has no stored secret. */
    fun get(ref: SecretRef): ByteArray? {
        plaintextCache[ref.value]?.let { return it.copyOf() }
        val blob = blobs.read(ref) ?: return null
        val key = KeystoreMasterKey.getOrCreate(masterKeyAlias)
        val plaintext = KeystoreMasterKey.open(key, blob, aadFor(ref))
        plaintextCache[ref.value] = plaintext.copyOf()
        return plaintext
    }

    fun getText(ref: SecretRef): String? {
        val bytes = get(ref) ?: return null
        return try {
            String(bytes, Charsets.UTF_8)
        } finally {
            bytes.fill(0)
        }
    }

    fun has(ref: SecretRef): Boolean = plaintextCache.containsKey(ref.value) || blobs.read(ref) != null

    fun remove(ref: SecretRef) {
        plaintextCache.remove(ref.value)?.fill(0)
        blobs.delete(ref)
    }

    /** Purge every secret for an entity, used by tombstone application and ACL revocation. */
    fun removeEntity(entityType: String, entityId: String) {
        val prefix = entityType + "/" + entityId + "/"
        for (ref in blobs.listRefs()) {
            if (ref.value.startsWith(prefix)) remove(ref)
        }
    }

    /** Called when the app locks: ciphertext stays, plaintext does not. */
    fun evictPlaintextCache() {
        val keys = plaintextCache.keys.toList()
        for (key in keys) plaintextCache.remove(key)?.fill(0)
    }

    /** Unbind / device revoke: the store and its wrapping key both go away. */
    fun wipe() {
        evictPlaintextCache()
        blobs.deleteAll()
        KeystoreMasterKey.delete(masterKeyAlias)
    }

    private fun aadFor(ref: SecretRef): ByteArray =
        (
            "zephyr-one-secretstore-v1\u0000" + scope.serverId +
                "\u0000" + scope.userId +
                "\u0000" + scope.deviceId +
                "\u0000" + ref.value
            ).toByteArray(Charsets.UTF_8)
}
