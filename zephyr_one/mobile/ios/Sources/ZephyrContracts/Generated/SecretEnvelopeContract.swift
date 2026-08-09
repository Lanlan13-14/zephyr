// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

import Foundation

/// Device envelope constants frozen by DATA_AND_MIGRATION.md section 5.2.
public enum SecretEnvelopeContract {
    public static let version = 1
    public static let alg = "ML-KEM-768+HKDF-SHA256+AES-256-GCM"
    public static let kem = "ML-KEM-768"
    public static let aead = "AES-256-GCM"
    public static let ivBytes = 12
    public static let tagBytes = 16
    public static let derivedKeyBytes = 32
    public static let hkdfSaltInput = "zephyr-mobile-envelope-v1"
    public static let secretAadPrefix = "zephyr-mobile-secret-v1"
    public static let sharedAadPrefix = "shared-use-v1"
    public static let secretAadFields: [String] = ["prefix", "serverId", "userId", "deviceId", "entityType", "entityId", "fieldName", "entityRevision", "keyVersion"]
    public static let sharedAadFields: [String] = ["prefix", "serverId", "userId", "deviceId", "sessionId", "resourceId", "resourceRevision", "purpose", "expiresAt", "clientNonce"]
    public static let aadSeparator: UInt8 = 0x00

    /// Purposes a shared single-use envelope may carry.
    public static let sharedPurposes: [String] = ["ssh", "telnet", "rdp", "vnc"]

    /// Keys that must never appear inside a decrypted shared payload.
    public static let forbiddenSharedPayloadKeys: [String] = ["clientToken", "aiProviderApiKey", "aiEnvValue", "serverDataKey", "ownerSid", "refreshCredential"]
}
