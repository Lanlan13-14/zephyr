package one.zephyr.mobile.security

import one.zephyr.mobile.contracts.SecretEnvelopeContract

/**
 * Additional authenticated data for device envelopes.
 *
 * Frozen by DATA_AND_MIGRATION.md section 5.2: UTF-8 fields joined by a single NUL, integers as
 * decimal ASCII with no leading zeros. This binding is the only thing preventing a stolen
 * ciphertext from being replayed against a different device, entity, field or revision, so the
 * byte layout is verified against contracts/generated/aad-vectors.json in unit tests.
 */
object MobileAad {

    /** Inputs for a secret envelope belonging to the bound account's own data. */
    data class SecretInput(
        val serverId: String,
        val userId: String,
        val deviceId: String,
        val entityType: String,
        val entityId: String,
        val fieldName: String,
        val entityRevision: Long,
        val keyVersion: Int,
    )

    /**
     * Inputs for a single-use envelope covering another user's shared resource.
     * Every field is part of the AAD so the envelope cannot be replayed across
     * device, session, resource, purpose or expiry.
     */
    data class SharedInput(
        val serverId: String,
        val userId: String,
        val deviceId: String,
        val sessionId: String,
        val resourceId: String,
        val resourceRevision: Long,
        val purpose: String,
        val expiresAt: Long,
        val clientNonce: String,
    )

    fun secretAad(input: SecretInput): ByteArray = join(
        listOf(
            SecretEnvelopeContract.SECRET_AAD_PREFIX,
            requireText(input.serverId, "serverId"),
            requireText(input.userId, "userId"),
            requireText(input.deviceId, "deviceId"),
            requireText(input.entityType, "entityType"),
            requireText(input.entityId, "entityId"),
            requireText(input.fieldName, "fieldName"),
            decimal(input.entityRevision, "entityRevision"),
            decimal(input.keyVersion.toLong(), "keyVersion"),
        ),
    )

    fun sharedAad(input: SharedInput): ByteArray {
        require(SecretEnvelopeContract.sharedPurposes.contains(input.purpose)) {
            "unsupported shared purpose " + input.purpose
        }
        return join(
            listOf(
                SecretEnvelopeContract.SHARED_AAD_PREFIX,
                requireText(input.serverId, "serverId"),
                requireText(input.userId, "userId"),
                requireText(input.deviceId, "deviceId"),
                requireText(input.sessionId, "sessionId"),
                requireText(input.resourceId, "resourceId"),
                decimal(input.resourceRevision, "resourceRevision"),
                input.purpose,
                decimal(input.expiresAt, "expiresAt"),
                requireText(input.clientNonce, "clientNonce"),
            ),
        )
    }

    /** HKDF salt is the digest of a fixed label, not a per-message value. */
    fun hkdfSalt(): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(SecretEnvelopeContract.HKDF_SALT_INPUT.toByteArray(Charsets.UTF_8))

    /**
     * Constant-time comparison. Callers must reject an envelope before attempting decryption when
     * the rebuilt AAD does not match, so timing must not leak how much of it matched.
     */
    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
        return diff == 0
    }

    private fun requireText(value: String, field: String): String {
        require(value.isNotEmpty()) { field + " must be non-empty; NUL separators cannot collapse" }
        require(!value.contains('\u0000')) { field + " must not contain the AAD separator" }
        return value
    }

    private fun decimal(value: Long, field: String): String {
        require(value >= 0) { field + " must be a non-negative integer" }
        return value.toString()
    }

    private fun join(parts: List<String>): ByteArray {
        val encoded = parts.map { it.toByteArray(Charsets.UTF_8) }
        val total = encoded.sumOf { it.size } + (encoded.size - 1)
        val out = ByteArray(total)
        var offset = 0
        encoded.forEachIndexed { index, bytes ->
            if (index > 0) {
                out[offset] = SecretEnvelopeContract.AAD_SEPARATOR
                offset += 1
            }
            bytes.copyInto(out, offset)
            offset += bytes.size
        }
        return out
    }
}
