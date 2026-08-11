package one.zephyr.mobile.security

import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.BadPaddingException
import one.zephyr.mobile.model.Residency
import one.zephyr.mobile.model.SecretRef

/** Raised when a caller tries to persist data that must never reach the device. */
class ResidencyViolationException(message: String) : IllegalStateException(message)

/**
 * Device-bound ciphertext which may be persisted by a crash-recovery journal.
 *
 * The bytes remain sealed to one [SecretStore.SecretScope] and one [SecretRef]. Callers cannot
 * decrypt them, and [toString] is deliberately redacted so an exception or diagnostic cannot turn
 * the recovery path into a second secret store.
 */
class OpaqueSecretBlob private constructor(private val sealed: ByteArray) {

    fun copyForPersistence(): ByteArray = sealed.copyOf()

    override fun toString(): String = "OpaqueSecretBlob([redacted])"

    companion object {
        fun fromPersistence(sealed: ByteArray): OpaqueSecretBlob = OpaqueSecretBlob(sealed.copyOf())
    }
}

/** Encryption boundary kept injectable so key migration can be tested without AndroidKeyStore. */
interface SecretCipher {
    fun seal(alias: String, plaintext: ByteArray, aad: ByteArray): ByteArray
    fun open(alias: String, blob: ByteArray, aad: ByteArray): ByteArray
    fun deleteKey(alias: String)
}

private object AndroidSecretCipher : SecretCipher {
    override fun seal(alias: String, plaintext: ByteArray, aad: ByteArray): ByteArray =
        KeystoreMasterKey.seal(KeystoreMasterKey.getOrCreate(alias), plaintext, aad)

    override fun open(alias: String, blob: ByteArray, aad: ByteArray): ByteArray =
        KeystoreMasterKey.open(KeystoreMasterKey.getOrCreate(alias), blob, aad)

    override fun deleteKey(alias: String) {
        KeystoreMasterKey.delete(alias)
    }
}

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
    private val masterKeyAlias: String = secretStoreAlias(scope),
    private val cipher: SecretCipher = AndroidSecretCipher,
) : LockSensitiveSink {

    /** Identity the blobs are bound to. A rebind to a different account cannot open old blobs. */
    data class SecretScope(
        val serverId: String,
        val userId: String,
        val deviceId: String,
        val generation: String = DEVICE_LIFETIME_GENERATION,
    ) {
        companion object {
            private const val DEVICE_LIFETIME_GENERATION = "device-lifetime"
        }
    }

    private val plaintextCache = ConcurrentHashMap<String, ByteArray>()
    private val physicalPrefix = secretStorePhysicalPrefix(scope)

    /** Recovery code must prove it is operating on the journal's exact account generation. */
    fun matchesScope(userId: String, generation: String): Boolean =
        scope.userId == userId && scope.generation == generation

    /** Full binding identity required by cross-store recovery journals. */
    fun matchesScope(serverId: String, userId: String, deviceId: String, generation: String): Boolean =
        scope.serverId == serverId && scope.userId == userId && scope.deviceId == deviceId &&
            scope.generation == generation

    fun put(ref: SecretRef, plaintext: ByteArray, residency: Residency = Residency.OWNED) {
        if (!residency.allowsLocalPersistence) {
            throw ResidencyViolationException(
                "refusing to persist shared-to-me secret " + ref.value + "; shared resources are online-only",
            )
        }
        val canonical = ref.canonical()
        blobs.write(
            physicalRef(canonical),
            cipher.seal(masterKeyAlias, plaintext, aadFor(canonical)),
        )
        deleteLegacyRefs(canonical)
        plaintextCache[canonical.value] = plaintext.copyOf()
    }

    fun putText(ref: SecretRef, plaintext: String, residency: Residency = Residency.OWNED) {
        val bytes = plaintext.toByteArray(Charsets.UTF_8)
        try {
            put(ref, bytes, residency)
        } finally {
            bytes.fill(0)
        }
    }

    /**
     * Seals a replacement without changing the live ref.
     *
     * This is the prepare half of the cross-store journal: the resulting bytes are safe to place
     * in the SQLCipher database, while the plaintext remains owned by the caller and can be zeroed
     * immediately after this method returns.
     */
    fun sealOpaque(
        ref: SecretRef,
        plaintext: ByteArray,
        residency: Residency = Residency.OWNED,
    ): OpaqueSecretBlob {
        if (!residency.allowsLocalPersistence) {
            throw ResidencyViolationException("refusing to stage a shared-to-me secret")
        }
        val canonical = ref.canonical()
        return OpaqueSecretBlob.fromPersistence(
            cipher.seal(masterKeyAlias, plaintext, aadFor(canonical)),
        )
    }

    /** Returns the current device-bound ciphertext without exposing or caching its plaintext. */
    fun snapshotOpaque(ref: SecretRef): OpaqueSecretBlob? {
        val canonical = ref.canonical()
        var sealed = blobs.read(physicalRef(canonical))
        if (sealed == null) {
            val migrated = migrateLegacy(canonical) ?: return null
            try {
                sealed = blobs.read(physicalRef(canonical))
                    ?: error("secret migration did not persist its replacement")
            } finally {
                migrated.fill(0)
            }
        }
        return OpaqueSecretBlob.fromPersistence(sealed)
    }

    /**
     * Atomically installs a prepared ciphertext, or removes the ref when [replacement] is null.
     *
     * The ciphertext is authenticated against this store's scope and the target ref before the
     * current value is touched. A journal copied from another account generation therefore fails
     * closed instead of making the new account's secret unreadable.
     */
    fun restoreOpaque(ref: SecretRef, replacement: OpaqueSecretBlob?) {
        val canonical = ref.canonical()
        plaintextCache.remove(canonical.value)?.fill(0)
        if (replacement == null) {
            blobs.delete(physicalRef(canonical))
            deleteLegacyRefs(canonical)
            return
        }

        val sealed = replacement.copyForPersistence()
        val plaintext = cipher.open(masterKeyAlias, sealed, aadFor(canonical))
        try {
            blobs.write(physicalRef(canonical), sealed)
            deleteLegacyRefs(canonical)
        } finally {
            plaintext.fill(0)
            sealed.fill(0)
        }
    }

    /** Constant-time verification used before a journal state transition is finalised. */
    fun opaqueMatches(ref: SecretRef, expected: OpaqueSecretBlob?): Boolean {
        val current = snapshotOpaque(ref)
        if (current == null || expected == null) return current == null && expected == null
        val currentBytes = current.copyForPersistence()
        val expectedBytes = expected.copyForPersistence()
        return try {
            MessageDigest.isEqual(currentBytes, expectedBytes)
        } finally {
            currentBytes.fill(0)
            expectedBytes.fill(0)
        }
    }

    /** @return a copy the caller owns and should zero, or null when the ref has no stored secret. */
    fun get(ref: SecretRef): ByteArray? {
        val canonical = ref.canonical()
        plaintextCache[canonical.value]?.let { return it.copyOf() }
        val physical = physicalRef(canonical)
        val currentBlob = blobs.read(physical)
        val plaintext = if (currentBlob != null) {
            cipher.open(masterKeyAlias, currentBlob, aadFor(canonical))
        } else {
            migrateLegacy(canonical) ?: return null
        }
        deleteLegacyRefs(canonical)
        plaintextCache[canonical.value] = plaintext.copyOf()
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

    fun has(ref: SecretRef): Boolean {
        val canonical = ref.canonical()
        if (plaintextCache.containsKey(canonical.value) || blobs.read(physicalRef(canonical)) != null) {
            deleteLegacyRefs(canonical)
            return true
        }
        val migrated = migrateLegacy(canonical) ?: return false
        try {
            plaintextCache[canonical.value] = migrated.copyOf()
            deleteLegacyRefs(canonical)
        } finally {
            migrated.fill(0)
        }
        return true
    }

    fun remove(ref: SecretRef) {
        val canonical = ref.canonical()
        plaintextCache.remove(canonical.value)?.fill(0)
        blobs.delete(physicalRef(canonical))
        deleteLegacyRefs(canonical)
    }

    /**
     * Logical refs owned by this exact account scope.
     *
     * The physical prefix includes server, user, device and binding generation, so callers can
     * reconcile a snapshot without seeing another account's refs or the unscoped device-identity
     * records that share the same blob directory. Values are refs only; no ciphertext or plaintext
     * leaves the store.
     */
    fun ownedRefs(): List<SecretRef> =
        blobs.listRefs()
            .asSequence()
            .mapNotNull { physical ->
                physical.value
                    .takeIf { it.startsWith(physicalPrefix) }
                    ?.removePrefix(physicalPrefix)
                    ?.let(::SecretRef)
                    ?.canonical()
            }
            .distinctBy(SecretRef::value)
            .toList()

    /** Purge every secret for an entity, used by tombstone application and ACL revocation. */
    fun removeEntity(entityType: String, entityId: String) {
        for (ref in blobs.listRefs()) {
            when {
                ref.value.startsWith(physicalPrefix) -> {
                    val logical = SecretRef(ref.value.removePrefix(physicalPrefix))
                    if (logical.belongsTo(entityType, entityId)) blobs.delete(ref)
                }
                !ref.value.startsWith(SCOPED_REF_PREFIX) && ref.belongsTo(entityType, entityId) ->
                    deleteUnscopedIfOwned(ref)
            }
        }
        for (key in plaintextCache.keys.toList()) {
            if (SecretRef(key).belongsTo(entityType, entityId)) {
                plaintextCache.remove(key)?.fill(0)
            }
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
        for (ref in blobs.listRefs()) {
            when {
                ref.value.startsWith(physicalPrefix) -> blobs.delete(ref)
                !ref.value.startsWith(SCOPED_REF_PREFIX) -> deleteUnscopedIfOwned(ref)
            }
        }
        cipher.deleteKey(masterKeyAlias)
    }

    override fun onLocked() {
        evictPlaintextCache()
    }

    private fun physicalRef(logicalRef: SecretRef): SecretRef =
        SecretRef(physicalPrefix + logicalRef.value)

    /**
     * Moves one old blob only after its AAD proves it belongs to this account and the replacement
     * has been durably written. A legacy unscoped ref may collide across accounts, so existence is
     * never sufficient proof for deletion.
     */
    private fun migrateLegacy(canonical: SecretRef): ByteArray? {
        val candidates = buildList {
            canonical.legacyValueOrNull()
                ?.takeIf { it != canonical.value }
                ?.let { legacy ->
                    add(
                        LegacyCandidate(
                            physical = SecretRef(physicalPrefix + legacy),
                            alias = masterKeyAlias,
                            aad = aadFor(SecretRef(legacy)),
                        ),
                    )
                }
            for (unscoped in unscopedLegacyCandidates(canonical)) {
                add(
                    LegacyCandidate(
                        physical = unscoped,
                        alias = KeystoreMasterKey.ALIAS_SECRET_STORE,
                        aad = legacyAadFor(unscoped),
                    ),
                )
            }
        }

        for (candidate in candidates) {
            val blob = blobs.read(candidate.physical) ?: continue
            val plaintext = try {
                cipher.open(candidate.alias, blob, candidate.aad)
            } catch (error: Exception) {
                if (error.isLegacyAuthenticationRejection()) continue
                throw error
            }
            try {
                val replacement = cipher.seal(masterKeyAlias, plaintext, aadFor(canonical))
                blobs.write(physicalRef(canonical), replacement)
                blobs.delete(candidate.physical)
                return plaintext
            } catch (error: Exception) {
                plaintext.fill(0)
                throw error
            }
        }
        return null
    }

    private fun deleteScopedLegacyRef(canonical: SecretRef) {
        canonical.legacyValueOrNull()
            ?.takeIf { it != canonical.value }
            ?.let { blobs.delete(SecretRef(physicalPrefix + it)) }
    }

    private fun deleteLegacyRefs(canonical: SecretRef) {
        deleteScopedLegacyRef(canonical)
        for (candidate in unscopedLegacyCandidates(canonical)) deleteUnscopedIfOwned(candidate)
    }

    private fun unscopedLegacyCandidates(canonical: SecretRef): List<SecretRef> =
        buildList {
            add(canonical)
            canonical.legacyValueOrNull()
                ?.takeIf { it != canonical.value }
                ?.let { add(SecretRef(it)) }
        }

    private fun deleteUnscopedIfOwned(candidate: SecretRef) {
        val blob = blobs.read(candidate) ?: return
        val plaintext = try {
            cipher.open(
                KeystoreMasterKey.ALIAS_SECRET_STORE,
                blob,
                legacyAadFor(candidate),
            )
        } catch (error: Exception) {
            if (error.isLegacyAuthenticationRejection()) return
            throw error
        }
        plaintext.fill(0)
        blobs.delete(candidate)
    }

    private fun aadFor(ref: SecretRef): ByteArray =
        (
            "zephyr-one-secretstore-v1\u0000" + scope.serverId +
                "\u0000" + scope.userId +
                "\u0000" + scope.deviceId +
                "\u0000" + scope.generation +
                "\u0000" + ref.value
            ).toByteArray(Charsets.UTF_8)

    private fun legacyAadFor(ref: SecretRef): ByteArray =
        (
            "zephyr-one-secretstore-v1\u0000" + scope.serverId +
                "\u0000" + scope.userId +
                "\u0000" + scope.deviceId +
                "\u0000" + ref.value
            ).toByteArray(Charsets.UTF_8)

    private data class LegacyCandidate(
        val physical: SecretRef,
        val alias: String,
        val aad: ByteArray,
    )

    private companion object {
        const val SCOPED_REF_PREFIX = "__secretScope/"
    }
}

private fun Exception.isLegacyAuthenticationRejection(): Boolean =
    this is BadPaddingException || this is IllegalArgumentException

internal fun secretStoreAlias(scope: SecretStore.SecretScope): String =
    KeystoreMasterKey.ALIAS_SECRET_STORE + "." + scopeDigest(scope)

internal fun secretStorePhysicalPrefix(scope: SecretStore.SecretScope): String =
    "__secretScope/" + scopeDigest(scope) + "/"

private fun scopeDigest(scope: SecretStore.SecretScope): String =
    MessageDigest.getInstance("SHA-256")
        .digest(
            (
                scope.serverId + "\u0000" + scope.userId + "\u0000" + scope.deviceId +
                    "\u0000" + scope.generation
                )
                .toByteArray(Charsets.UTF_8),
        )
        .take(16)
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
