import Foundation
import ZephyrContracts

/// The connect pipeline from REMOTE_DESKTOP_EXPERIENCE.md 13.
///
/// Modelled as distinct phases rather than a boolean "connecting" because the
/// spec requires a specific error and an elapsed time per phase. A single
/// flag cannot tell the user whether a 20-second wait was DNS, TCP, TLS or a
/// server that accepted the connection and never sent a frame -- and those
/// four have four different fixes.
public enum RemotePhase: String, Sendable, CaseIterable {
    case resolving
    case connecting
    case securing
    case authenticating
    case negotiating
    case firstFrame
    case connected
    /// Connected, but below the negotiated quality target: still usable, so
    /// it is not an error.
    case degraded
    case reconnecting
    case disconnected

    public var label: String {
        switch self {
        case .resolving: return "解析主机"
        case .connecting: return "建立连接"
        case .securing: return "TLS / 证书"
        case .authenticating: return "认证"
        case .negotiating: return "协商能力"
        case .firstFrame: return "等待首帧"
        case .connected: return "已连接"
        case .degraded: return "质量降级"
        case .reconnecting: return "重连中"
        case .disconnected: return "已断开"
        }
    }

    /// True once pixels can be on screen.
    public var hasSurface: Bool { self == .connected || self == .degraded }

    public var isProgressing: Bool {
        self == .resolving || self == .connecting || self == .securing ||
            self == .authenticating || self == .negotiating || self == .firstFrame ||
            self == .reconnecting
    }

    public var isTerminal: Bool { self == .disconnected }
}

/// Live status for one remote session.
public struct RemoteSessionStatus: Equatable, Sendable {
    public var phase: RemotePhase
    /// When the current phase started, so the UI can show elapsed time per
    /// phase rather than one total that hides where the time went.
    public var phaseSince: Int64
    /// 1 for the first connect; incremented by a reconnect so the UI can say
    /// which attempt is running instead of looping silently.
    public var attempt: Int
    public var error: MobileError?
    public var remoteWidthPx: Int
    public var remoteHeightPx: Int
    public var negotiatedLabel: String?
    public var latencyMs: Int64?
    public var fps: Int?
    public var droppedFrames: Int

    public init(
        phase: RemotePhase = .disconnected,
        phaseSince: Int64 = 0,
        attempt: Int = 0,
        error: MobileError? = nil,
        remoteWidthPx: Int = 0,
        remoteHeightPx: Int = 0,
        negotiatedLabel: String? = nil,
        latencyMs: Int64? = nil,
        fps: Int? = nil,
        droppedFrames: Int = 0
    ) {
        self.phase = phase
        self.phaseSince = phaseSince
        self.attempt = attempt
        self.error = error
        self.remoteWidthPx = remoteWidthPx
        self.remoteHeightPx = remoteHeightPx
        self.negotiatedLabel = negotiatedLabel
        self.latencyMs = latencyMs
        self.fps = fps
        self.droppedFrames = droppedFrames
    }

    public var hasSurface: Bool { phase.hasSurface }

    public func elapsedMs(_ nowMs: Int64) -> Int64 {
        phaseSince <= 0 ? 0 : max(0, nowMs - phaseSince)
    }

    public func advance(_ next: RemotePhase, _ nowMs: Int64) -> RemoteSessionStatus {
        if next == phase { return self }
        var copy = self
        copy.phase = next
        copy.phaseSince = nowMs
        copy.error = nil
        return copy
    }
}

/// Timeouts and the auto-reconnect decision.
///
/// The two timeouts are separate values because section 13 requires it: a TCP
/// connect that never completes is a routing problem, while a server that
/// completes the handshake and sends no frame is usually a display/session
/// problem on the far side.
public enum RemotePhasePolicy {

    public static let resolveTimeoutMs: Int64 = 10_000
    public static let connectTimeoutMs: Int64 = 20_000
    public static let secureTimeoutMs: Int64 = 15_000
    public static let authTimeoutMs: Int64 = 30_000
    public static let negotiateTimeoutMs: Int64 = 20_000
    /// Deliberately generous: an RDP session that has to start a Windows
    /// shell can be slow.
    public static let firstFrameTimeoutMs: Int64 = 30_000

    public static func timeoutMs(_ phase: RemotePhase) -> Int64? {
        switch phase {
        case .resolving: return resolveTimeoutMs
        case .connecting: return connectTimeoutMs
        case .securing: return secureTimeoutMs
        case .authenticating: return authTimeoutMs
        case .negotiating: return negotiateTimeoutMs
        case .firstFrame: return firstFrameTimeoutMs
        default: return nil
        }
    }

    public static func hasTimedOut(_ status: RemoteSessionStatus, _ nowMs: Int64) -> Bool {
        guard let limit = timeoutMs(status.phase) else { return false }
        return status.elapsedMs(nowMs) >= limit
    }

    public static func timeoutError(_ phase: RemotePhase) -> MobileError {
        MobileError.local(
            code: phase == .firstFrame ? firstFrameTimeoutCode : phaseTimeoutCode,
            message: phase.label + "超时",
            retryable: true
        )
    }

    /// Whether the session may dial again without asking.
    ///
    /// Section 13 allows an automatic reconnect after a network change but
    /// requires a revoked credential, ACL or token to stop and be handled.
    public static func canAutoReconnect(_ error: MobileError?) -> Bool {
        guard let error else { return true }
        if stopCodes.contains(error.code) { return false }
        return error.retryable
    }

    public static let stopCodes: Set<String> = [
        "resource_revoked",
        "capability_denied",
        "grant_expired",
        "sid_expired",
        "token_revoked",
        "auth_failed",
        "rfb_auth_failed",
        "rfb_too_many_attempts",
        "rfb_no_supported_security",
        "certificate_changed",
        "rdp_engine_unavailable",
        "vnc_engine_unavailable",
        "engine_unavailable",
    ]

    public static let phaseTimeoutCode = "remote_phase_timeout"
    public static let firstFrameTimeoutCode = "remote_first_frame_timeout"

    /// Backoff for an automatic reconnect, capped low because a remote
    /// desktop is an interactive session the user is watching.
    public static func reconnectDelayMs(attempt: Int) -> Int64 {
        switch attempt {
        case ...1: return 1_000
        case 2: return 2_000
        case 3: return 5_000
        case 4: return 10_000
        default: return 15_000
        }
    }

    public static let maxAutoAttempts = 5
}

/// A server certificate for the RDP/VNC trust decision (SCREEN_CATALOG.md
/// 9/10). A changed certificate blocks by default.
public struct RemoteCertificate: Equatable, Sendable {
    public let subject: String
    public let issuer: String
    public let validFromMs: Int64
    public let validToMs: Int64
    public let sha256: String
    /// True when it differs from the stored fingerprint. A changed key is
    /// blocked until the user explicitly trusts it.
    public let changed: Bool

    public init(
        subject: String,
        issuer: String,
        validFromMs: Int64,
        validToMs: Int64,
        sha256: String,
        changed: Bool
    ) {
        self.subject = subject
        self.issuer = issuer
        self.validFromMs = validFromMs
        self.validToMs = validToMs
        self.sha256 = sha256
        self.changed = changed
    }
}

/// Channels an RDP session may request (SCREEN_CATALOG.md 9): asked for only
/// when the session genuinely requests them, and refusing one channel must
/// never exit the session.
public enum RemoteChannelKind: String, Sendable, CaseIterable {
    case mic
    case camera
    case location
    case fileDrive

    public var title: String {
        switch self {
        case .mic: return "麦克风"
        case .camera: return "摄像头"
        case .location: return "位置"
        case .fileDrive: return "文件"
        }
    }
}

public struct RemoteChannelPermission: Equatable, Sendable {
    public let kind: RemoteChannelKind
    public let requested: Bool
    public let granted: Bool

    public init(kind: RemoteChannelKind, requested: Bool = false, granted: Bool = false) {
        self.kind = kind
        self.requested = requested
        self.granted = granted
    }
}

/// The floating toolbar set for RDP and VNC (SCREEN_CATALOG.md 9/10).
public enum RemoteChromeItem: String, Sendable, CaseIterable {
    case pointerMode
    case keyboard
    case quality
    case resolution
    case fps
    case fit
    case zoom
    case clipboard
    case fileDrive
    case shortcuts
    case joystick
    case cad
    case reconnect
    case disconnect
    case vncQuality

    public var title: String {
        switch self {
        case .pointerMode: return "触控板"
        case .keyboard: return "键盘"
        case .quality: return "平衡"
        case .resolution: return "自动"
        case .fps: return "30FPS"
        case .fit: return "适应"
        case .zoom: return "100%"
        case .clipboard: return "剪贴板"
        case .fileDrive: return "文件"
        case .shortcuts: return "快捷键"
        case .joystick: return "视区"
        case .cad: return "CAD"
        case .reconnect: return "重连"
        case .disconnect: return "断开"
        case .vncQuality: return "高质量"
        }
    }
}

/// The native remote engine: a blocked track, like the terminal engine. The
/// screen state machine and chrome are implemented and tested; connecting is
/// an honest absence until the engine lands.
public protocol RemoteEnginePort: AnyObject {
    var isAvailable: Bool { get }
    func connect(_ request: RemoteConnectRequest) async -> RemoteConnectOutcome
    func answerCertificate(sessionId: String, trust: Bool) async -> RemoteConnectOutcome
}

public struct RemoteConnectRequest: Equatable, Sendable {
    public let sessionId: String
    public let `protocol`: ConnectionProtocol
    public let host: String
    public let port: Int
    public let username: String
    public let password: String?

    public init(
        sessionId: String,
        `protocol`: ConnectionProtocol,
        host: String,
        port: Int,
        username: String,
        password: String?
    ) {
        self.sessionId = sessionId
        self.`protocol` = `protocol`
        self.host = host
        self.port = port
        self.username = username
        self.password = password
    }
}

public enum RdpShortcut: String, CaseIterable, Sendable {
    case win
    case cad
    case altTab
    case winR
    case altF4

    public var label: String {
        switch self {
        case .win: return "Win"
        case .cad: return "Ctrl+Alt+Del"
        case .altTab: return "Alt+Tab"
        case .winR: return "Win+R"
        case .altF4: return "Alt+F4"
        }
    }
}

public enum RemoteConnectOutcome: Equatable, Sendable {
    case connected(RemoteSessionStatus)
    case certificateRequired(RemoteCertificate)
    case failed(MobileError)
}

/// Default engine while the remote track is blocked.
public final class UnavailableRemoteEngine: RemoteEnginePort {
    public let `protocol`: ConnectionProtocol

    public init(`protocol`: ConnectionProtocol = .rdp) {
        self.`protocol` = `protocol`
    }

    public var isAvailable: Bool { false }

    public func connect(_ request: RemoteConnectRequest) async -> RemoteConnectOutcome {
        .failed(UnavailableRemoteEngine.error(for: request.`protocol`))
    }

    public func answerCertificate(sessionId: String, trust: Bool) async -> RemoteConnectOutcome {
        .failed(UnavailableRemoteEngine.error(for: `protocol`))
    }

    public static func error(for value: ConnectionProtocol) -> MobileError {
        switch value {
        case .rdp: return rdpBlocked
        default: return vncBlocked
        }
    }

    public static let rdpBlocked = MobileError.local(
        code: "rdp_engine_unavailable",
        message: "RDP 引擎在此版本中尚未接入，无法建立会话",
        retryable: false
    )
    public static let vncBlocked = MobileError.local(
        code: "vnc_engine_unavailable",
        message: "VNC 引擎在此版本中尚未接入，无法建立会话",
        retryable: false
    )
}