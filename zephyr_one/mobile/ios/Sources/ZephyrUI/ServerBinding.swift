import Foundation
import ZephyrContracts

/// A Zephyr main-end deployment One can bind to. Portable metadata only.
public struct ServerProfile: Equatable, Sendable {
    public var id: String
    public var baseUrl: String
    public var displayName: String
    public var tlsPolicy: TlsPolicy
    public var createdAt: Int64
    public var lastUsedAt: Int64?

    public init(
        id: String,
        baseUrl: String,
        displayName: String,
        tlsPolicy: TlsPolicy,
        createdAt: Int64,
        lastUsedAt: Int64? = nil
    ) {
        self.id = id
        self.baseUrl = baseUrl
        self.displayName = displayName
        self.tlsPolicy = tlsPolicy
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
    }
}

/// TLS trust for this profile. There is deliberately no "ignore all
/// certificate errors" option; self-signed deployments must pin explicitly.
public enum TlsPolicy: Equatable, Sendable {
    /// System trust store, strict validation. The only default.
    case systemTrust

    /// Explicit SHA-256 SPKI pin for a private CA or self-signed deployment.
    case pinnedSpki([String])

    public var isStrict: Bool { true }

    /// A pinned policy with no pins would be a silent system-trust fallback,
    /// so the empty case is refused here rather than at save time.
    public static func pinned(_ sha256Pins: [String]) -> TlsPolicy? {
        sha256Pins.isEmpty ? nil : .pinnedSpki(sha256Pins)
    }
}

/// The account + token + device binding produced by the S02 flow. Device
/// identity material lives in the SecretStore, never in this row.
public struct AccountBinding: Equatable, Sendable {
    public var serverProfileId: String
    public var userId: String
    public var username: String
    public var deviceId: String
    public var deviceName: String
    public var tokenId: String
    public var tokenName: String
    public var state: BindingState
    public var registryHash: String
    public var boundAt: Int64
    public var lastSyncAt: Int64?
    /// Bumped by a main-end backup restore; invalidates every cursor and
    /// credential.
    public var instanceEpoch: Int64

    public init(
        serverProfileId: String,
        userId: String,
        username: String,
        deviceId: String,
        deviceName: String,
        tokenId: String,
        tokenName: String,
        state: BindingState,
        registryHash: String,
        boundAt: Int64,
        lastSyncAt: Int64? = nil,
        instanceEpoch: Int64
    ) {
        self.serverProfileId = serverProfileId
        self.userId = userId
        self.username = username
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.tokenId = tokenId
        self.tokenName = tokenName
        self.state = state
        self.registryHash = registryHash
        self.boundAt = boundAt
        self.lastSyncAt = lastSyncAt
        self.instanceEpoch = instanceEpoch
    }

    public var isLive: Bool { state.isBound && state != .revoked }
}

/// Result of the bind handshake, before anything is persisted.
public enum BindingOutcome: Equatable, Sendable {
    case success(AccountBinding)
    case totpRequired
    case tokenChoiceRequired([ClientToken])
    case noTokenOnServer
    case failed(MobileError)
}

/// The S02 flow pages, in the frozen order (SCREEN_CATALOG.md 4):
/// 服务器地址 → capabilities → 账号密码 → TOTP/CAPTCHA → Token 选择 →
/// 设备名/间隔 → bootstrap.
public enum BindingStep: String, Sendable, CaseIterable {
    case serverAddress
    case credentials
    case secondFactor
    case tokenChoice
    case device
    case bootstrap
}

/// One S02 form failure, tied to the field that caused it.
public struct BindingFormIssue: Equatable, Sendable {
    public let field: String
    public let message: String

    public init(field: String, message: String) {
        self.field = field
        self.message = message
    }
}

/// The S02 form, as a pure value.
///
/// The rules the catalog freezes live here rather than in the view: HTTPS/WSS
/// only, deviceName 1-120 (the OpenAPI contract's maxLength), and the sync
/// interval clamped to the contract range. username/password exist only for
/// the lifetime of this form and are never persisted.
public struct ServerBindingDraft: Equatable, Sendable {
    public var baseUrl: String
    public var username: String
    public var password: String
    public var totpCode: String
    public var selectedTokenId: String?
    public var deviceName: String
    public var intervalSec: Int

    public init(
        baseUrl: String = "",
        username: String = "",
        password: String = "",
        totpCode: String = "",
        selectedTokenId: String? = nil,
        deviceName: String = "",
        intervalSec: Int = SyncContract.defaultIntervalSec
    ) {
        self.baseUrl = baseUrl
        self.username = username
        self.password = password
        self.totpCode = totpCode
        self.selectedTokenId = selectedTokenId
        self.deviceName = deviceName
        self.intervalSec = intervalSec
    }

    /// The trimmed URL, or nil when it cannot name a Zephyr main end.
    ///
    /// SCREEN_CATALOG.md 4 allows HTTPS/WSS; a WSS address names the same
    /// deployment over its secure WebSocket transport and is normalised to the
    /// HTTPS base URL the API paths hang off. Plain HTTP is refused, as is
    /// anything without a host.
    public func normalizedBaseUrl() -> String? {
        let trimmed = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let url = URL(string: trimmed),
            let scheme = url.scheme?.lowercased(),
            scheme == "https" || scheme == "wss",
            let host = url.host,
            !host.isEmpty
        else { return nil }
        if scheme == "https" { return trimmed }
        return "https" + String(trimmed.dropFirst(scheme.count))
    }

    public var urlIssue: BindingFormIssue? {
        normalizedBaseUrl() == nil
            ? BindingFormIssue(field: "baseUrl", message: ServerBindingDraft.msgInvalidUrl)
            : nil
    }

    /// Device name is 1-120 characters after trimming (SCREEN_CATALOG.md 4 and
    /// the OpenAPI contract's maxLength: 120).
    public var deviceNameIssue: BindingFormIssue? {
        let trimmed = deviceName.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed.count > ServerBindingDraft.maxDeviceNameLength {
            return BindingFormIssue(field: "deviceName", message: ServerBindingDraft.msgDeviceName)
        }
        return nil
    }

    /// A stale UI value can never persist an out-of-range period.
    public var clampedIntervalSec: Int {
        SyncContract.clampIntervalSec(intervalSec)
    }

    public func credentialIssues() -> [BindingFormIssue] {
        var issues: [BindingFormIssue] = []
        if username.trimmingCharacters(in: .whitespaces).isEmpty {
            issues.append(BindingFormIssue(field: "username", message: ServerBindingDraft.msgUsernameRequired))
        }
        if password.isEmpty {
            issues.append(BindingFormIssue(field: "password", message: ServerBindingDraft.msgPasswordRequired))
        }
        return issues
    }

    /// TOTP is required only when the account demands it; the code itself is
    /// opaque to One (no invented digit count).
    public func secondFactorIssue() -> BindingFormIssue? {
        totpCode.trimmingCharacters(in: .whitespaces).isEmpty
            ? BindingFormIssue(field: "totpCode", message: ServerBindingDraft.msgTotpRequired)
            : nil
    }

    /// A token must be selected, and it must belong to the account that just
    /// authenticated: a token minted for another user is the wrong-owner state
    /// the catalog calls out.
    public func tokenIssue(available: [ClientToken], accountUserId: String) -> BindingFormIssue? {
        guard let selectedTokenId,
              let token = available.first(where: { $0.id == selectedTokenId })
        else {
            return BindingFormIssue(field: "tokenId", message: ServerBindingDraft.msgTokenRequired)
        }
        if token.ownerUserId != accountUserId {
            return BindingFormIssue(field: "tokenId", message: ServerBindingDraft.msgWrongOwnerToken)
        }
        return nil
    }

    public static let maxDeviceNameLength = 120

    public static let msgInvalidUrl = "请输入有效的 HTTPS 主端地址"
    public static let msgUsernameRequired = "请填写账号"
    public static let msgPasswordRequired = "请填写密码"
    public static let msgTotpRequired = "请输入动态验证码"
    public static let msgTokenRequired = "请选择一个 Client Token"
    public static let msgWrongOwnerToken = "该 Token 属于其他账号，不能使用"
    public static let msgDeviceName = "设备名需为 1–120 个字符"
    public static let msgZeroToken = "该账号还没有 Client Token，请先在主端创建"
}
