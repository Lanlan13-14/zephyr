// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

package one.zephyr.mobile.contracts

/** Device envelope constants frozen by DATA_AND_MIGRATION.md section 5.2. */
object SecretEnvelopeContract {
    const val VERSION: Int = 1
    const val ALG: String = "ML-KEM-768+HKDF-SHA256+AES-256-GCM"
    const val KEM: String = "ML-KEM-768"
    const val AEAD: String = "AES-256-GCM"
    const val IV_BYTES: Int = 12
    const val TAG_BYTES: Int = 16
    const val DERIVED_KEY_BYTES: Int = 32
    const val HKDF_SALT_INPUT: String = "zephyr-mobile-envelope-v1"
    const val SECRET_AAD_PREFIX: String = "zephyr-mobile-secret-v1"
    const val SHARED_AAD_PREFIX: String = "shared-use-v1"
    val secretAadFields: List<String> = listOf("prefix", "serverId", "userId", "deviceId", "entityType", "entityId", "fieldName", "entityRevision", "keyVersion")
    val sharedAadFields: List<String> = listOf("prefix", "serverId", "userId", "deviceId", "sessionId", "resourceId", "resourceRevision", "purpose", "expiresAt", "clientNonce")
    const val AAD_SEPARATOR: Byte = 0x00

    /** Purposes a shared single-use envelope may carry. */
    val sharedPurposes: List<String> = listOf("ssh", "telnet", "rdp", "vnc")

    /** Keys that must never appear inside a decrypted shared payload. */
    val forbiddenSharedPayloadKeys: List<String> = listOf("clientToken", "aiProviderApiKey", "aiEnvValue", "serverDataKey", "ownerSid", "refreshCredential")
}
