import Foundation
import CryptoKit
import ZephyrContracts

/// A rejected AAD input, with the field that caused it.
///
/// Its own error type rather than a `precondition`: these inputs arrive from the
/// server and from persisted rows, so a malformed one must be a value the caller
/// can handle, not a crash.
public enum MobileAadError: Error, Equatable, CustomStringConvertible {
    case emptyField(String)
    case separatorInField(String)
    case negativeInteger(String)
    case unsupportedPurpose(String)

    public var description: String {
        switch self {
        case .emptyField(let field):
            return "\(field) must be non-empty; NUL separators cannot collapse"
        case .separatorInField(let field):
            return "\(field) must not contain the AAD separator"
        case .negativeInteger(let field):
            return "\(field) must be a non-negative integer"
        case .unsupportedPurpose(let purpose):
            return "unsupported shared purpose \(purpose)"
        }
    }
}

/// Additional authenticated data for device envelopes.
///
/// A port of `MobileAad.kt`, not a reinterpretation of it. The layout is frozen
/// by DATA_AND_MIGRATION.md 5.2: UTF-8 fields joined by a single NUL, integers
/// as decimal ASCII with no leading zeros.
///
/// This binding is the only thing preventing a stolen ciphertext from being
/// replayed against a different device, entity, field or revision, so "the same
/// bytes as Kotlin" is a correctness requirement rather than tidiness. Both
/// implementations are checked against `contracts/generated/aad-vectors.json`,
/// which is generated from `mobile/tools/lib/aad.mjs` -- the JS server is the
/// third party that has to agree, so no one of the three is the reference.
public enum MobileAad {

    /// Inputs for a secret envelope belonging to the bound account's own data.
    public struct SecretInput: Sendable, Equatable {
        public let serverId: String
        public let userId: String
        public let deviceId: String
        public let entityType: String
        public let entityId: String
        public let fieldName: String
        public let entityRevision: Int64
        public let keyVersion: Int

        public init(
            serverId: String,
            userId: String,
            deviceId: String,
            entityType: String,
            entityId: String,
            fieldName: String,
            entityRevision: Int64,
            keyVersion: Int
        ) {
            self.serverId = serverId
            self.userId = userId
            self.deviceId = deviceId
            self.entityType = entityType
            self.entityId = entityId
            self.fieldName = fieldName
            self.entityRevision = entityRevision
            self.keyVersion = keyVersion
        }
    }

    /// Inputs for a single-use envelope covering another user's shared resource.
    ///
    /// Every field is part of the AAD so the envelope cannot be replayed across
    /// device, session, resource, purpose or expiry.
    public struct SharedInput: Sendable, Equatable {
        public let serverId: String
        public let userId: String
        public let deviceId: String
        public let sessionId: String
        public let resourceId: String
        public let resourceRevision: Int64
        public let purpose: String
        public let expiresAt: Int64
        public let clientNonce: String

        public init(
            serverId: String,
            userId: String,
            deviceId: String,
            sessionId: String,
            resourceId: String,
            resourceRevision: Int64,
            purpose: String,
            expiresAt: Int64,
            clientNonce: String
        ) {
            self.serverId = serverId
            self.userId = userId
            self.deviceId = deviceId
            self.sessionId = sessionId
            self.resourceId = resourceId
            self.resourceRevision = resourceRevision
            self.purpose = purpose
            self.expiresAt = expiresAt
            self.clientNonce = clientNonce
        }
    }

    public static func secretAad(_ input: SecretInput) throws -> Data {
        try join([
            SecretEnvelopeContract.secretAadPrefix,
            try requireText(input.serverId, "serverId"),
            try requireText(input.userId, "userId"),
            try requireText(input.deviceId, "deviceId"),
            try requireText(input.entityType, "entityType"),
            try requireText(input.entityId, "entityId"),
            try requireText(input.fieldName, "fieldName"),
            try decimal(input.entityRevision, "entityRevision"),
            try decimal(Int64(input.keyVersion), "keyVersion"),
        ])
    }

    public static func sharedAad(_ input: SharedInput) throws -> Data {
        /* The purpose is checked against the frozen set before anything is
         * joined. An unrecognised purpose that was merely passed through would
         * produce an AAD the server can never rebuild, so the envelope would
         * fail to open with a decryption error rather than a reason. */
        guard SecretEnvelopeContract.sharedPurposes.contains(input.purpose) else {
            throw MobileAadError.unsupportedPurpose(input.purpose)
        }
        return try join([
            SecretEnvelopeContract.sharedAadPrefix,
            try requireText(input.serverId, "serverId"),
            try requireText(input.userId, "userId"),
            try requireText(input.deviceId, "deviceId"),
            try requireText(input.sessionId, "sessionId"),
            try requireText(input.resourceId, "resourceId"),
            try decimal(input.resourceRevision, "resourceRevision"),
            input.purpose,
            try decimal(input.expiresAt, "expiresAt"),
            try requireText(input.clientNonce, "clientNonce"),
        ])
    }

    /// HKDF salt is the digest of a fixed label, not a per-message value.
    public static func hkdfSalt() -> Data {
        Data(SHA256.hash(data: Data(SecretEnvelopeContract.hkdfSaltInput.utf8)))
    }

    /// Constant-time comparison.
    ///
    /// Callers must reject an envelope before attempting decryption when the
    /// rebuilt AAD does not match, so timing must not leak how much of it
    /// matched. Written as an unconditional fold over every byte for that
    /// reason: an early `return false` would leak the first differing offset.
    public static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        /* Indexed by offset from each slice's own startIndex, not by a shared
         * integer. `Data` produced by slicing keeps the parent's indices, so
         * `a[i]` and `b[i]` can address different logical positions -- a bug that
         * would make two equal AADs compare unequal only when one of them
         * happened to be a slice. */
        var diff: UInt8 = 0
        for offset in 0..<a.count {
            diff |= a[a.startIndex + offset] ^ b[b.startIndex + offset]
        }
        return diff == 0
    }

    // MARK: - field validation

    private static func requireText(_ value: String, _ field: String) throws -> String {
        guard !value.isEmpty else { throw MobileAadError.emptyField(field) }
        guard !value.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw MobileAadError.separatorInField(field)
        }
        return value
    }

    /// Decimal ASCII, no leading zeros, no sign.
    ///
    /// `String(describing:)` on a non-negative integer already produces exactly
    /// that, so the only thing to enforce is the sign -- a negative value would
    /// emit a `-`, which is not in the frozen grammar and which the server
    /// rejects rather than reinterprets.
    private static func decimal(_ value: Int64, _ field: String) throws -> String {
        guard value >= 0 else { throw MobileAadError.negativeInteger(field) }
        return String(value)
    }

    private static func join(_ parts: [String]) throws -> Data {
        var out = Data()
        for (index, part) in parts.enumerated() {
            if index > 0 { out.append(SecretEnvelopeContract.aadSeparator) }
            out.append(Data(part.utf8))
        }
        return out
    }
}
