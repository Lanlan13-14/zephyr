import Foundation
import ZephyrContracts

/// Structured error decoded from the mobile v1 envelope. Clients branch on
/// `code` only; `message` is display text and must never drive control flow.
///
/// Ported from core-model `MobileError.kt`; the registry lookups resolve
/// against the generated ``ErrorRegistry`` so the Swift port cannot drift from
/// the frozen code table.
public struct MobileError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let requestId: String?
    public let details: [String: String]
    public let httpStatus: Int?
    public let retryAfterSeconds: Int64?

    public init(
        code: String,
        message: String,
        retryable: Bool,
        requestId: String?,
        details: [String: String] = [:],
        httpStatus: Int? = nil,
        retryAfterSeconds: Int64? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.requestId = requestId
        self.details = details
        self.httpStatus = httpStatus
        self.retryAfterSeconds = retryAfterSeconds
    }

    public var clientAction: String { ErrorRegistry.clientAction(code) }

    /// True when the registry agrees the code is retryable; unknown codes are
    /// never retried.
    public var isRegistryRetryable: Bool { ErrorRegistry.isRetryable(code) }

    public var requiresSensitiveVerification: Bool {
        code == "sensitive_verification_required" ||
            code == "sensitive_grant_expired" ||
            code == "sensitive_grant_consumed"
    }

    public var requiresRebind: Bool {
        clientAction == "rebind" || code == "token_rotated" || code == "client_revoked"
    }

    public var requiresBootstrapRestart: Bool {
        code == "cursor_expired" || code == "cursor_invalid" || code == "bootstrap_expired"
    }

    /// Shared resources vanish rather than degrade; the viewer must close and
    /// purge memory.
    public var dismissesSharedResource: Bool {
        code == "shared_grant_revoked" || code == "shared_grant_expired"
    }

    /// Diagnostics copy is requestId + code only: never host, user, path or
    /// secret.
    public func diagnosticText() -> String {
        var text = "code=" + code
        if let httpStatus { text += " status=\(httpStatus)" }
        if let requestId { text += " requestId=" + requestId }
        return text
    }

    public var description: String { diagnosticText() }

    public static func local(code: String, message: String, retryable: Bool = false) -> MobileError {
        MobileError(code: code, message: message, retryable: retryable, requestId: nil)
    }

    public static let offline = MobileError.local(code: "network_offline", message: "No network connection", retryable: true)
}
