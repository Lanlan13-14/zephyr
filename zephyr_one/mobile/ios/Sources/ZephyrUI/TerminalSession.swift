import Foundation
import ZephyrContracts

/// The context dock from SCREEN_CATALOG.md 8.
///
/// ``files`` is absent for Telnet rather than disabled: the frozen rule is
/// that Telnet has no SFTP and the dock entry simply does not exist there,
/// so modelling availability per protocol keeps the screen from having to
/// know the rule.
public enum TerminalDockItem: String, Sendable, CaseIterable {
    case keyboard
    case files
    case snippets
    case notes
    case sessions
    case disconnect

    public var title: String {
        switch self {
        case .keyboard: return "键盘"
        case .files: return "文件"
        case .snippets: return "片段"
        case .notes: return "笔记"
        case .sessions: return "会话"
        case .disconnect: return "断开"
        }
    }

    public var systemImage: String {
        switch self {
        case .keyboard: return "keyboard"
        case .files: return "folder"
        case .snippets: return "chevron.left.slash.chevron.right"
        case .notes: return "note.text"
        case .sessions: return "square.stack"
        case .disconnect: return "xmark.circle"
        }
    }

    public static func forProtocol(_ value: ConnectionProtocol) -> [TerminalDockItem] {
        allCases.filter { $0 != .files || value.supportsFiles }
    }
}

/// A host-key decision the user must make before the session can continue
/// (the trust gate from the native-engine decisions).
public struct HostKeyPrompt: Equatable, Sendable {
    public let fingerprint: String
    /// True when the presented key differs from the stored one. A changed key
    /// blocks by default; only an explicit trust continues.
    public let changed: Bool

    public init(fingerprint: String, changed: Bool) {
        self.fingerprint = fingerprint
        self.changed = changed
    }
}

/// What the terminal surface itself reports.
///
/// The cell grid is engine territory and deliberately absent: the native
/// terminal engine is a separate blocked track, so this state machine covers
/// exactly what S21 owns today -- geometry handed to the PTY, the follow/
/// reading-mode contract and the missed-output badge (TERMINAL_EXPERIENCE.md
/// 9). A placeholder canvas renders from this; nothing here fakes a terminal.
public struct TerminalSurfaceState: Equatable, Sendable {
    public var columns: Int
    public var rows: Int
    /// True while the viewport tracks the live bottom.
    public var followingBottom: Bool
    /// Output rows that arrived while the user was reading scrollback. Remote
    /// output must never steal the scroll position from a reading user, so
    /// the badge counts instead.
    public var missedOutputRows: Int

    public init(
        columns: Int = 80,
        rows: Int = 24,
        followingBottom: Bool = true,
        missedOutputRows: Int = 0
    ) {
        self.columns = columns
        self.rows = rows
        self.followingBottom = followingBottom
        self.missedOutputRows = missedOutputRows
    }

    /// The user scrolled up to read: follow stops, output counts.
    public mutating func beginReading() {
        followingBottom = false
    }

    /// Jump to the live bottom: follow resumes and the badge clears.
    public mutating func jumpToBottom() {
        followingBottom = true
        missedOutputRows = 0
    }

    /// New output arrived. While following, the viewport stays glued to the
    /// bottom and nothing is counted; while reading, the rows accumulate.
    public mutating func noteOutput(rows: Int) {
        guard rows > 0 else { return }
        if !followingBottom {
            missedOutputRows += rows
        }
    }
}

/// Everything S21 renders around the terminal surface.
public struct TerminalContent: Equatable, Sendable {
    public let connection: Connection
    public let surface: TerminalSurfaceState
    public let transport: SessionTransport
    public let dock: [TerminalDockItem]
    /// Non-nil for Telnet only: the frozen cleartext warning
    /// (TERMINAL_EXPERIENCE.md 10).
    public let cleartextWarning: String?
    public let encoding: TerminalEncoding
    /// Only Telnet negotiates a code page; SSH is UTF-8 and offering a picker
    /// would suggest the user can change something that has no effect.
    public let encodingSelectable: Bool
    public let autoLoginStatus: String?
    public let hostKeyPrompt: HostKeyPrompt?
    /// Shared sessions keep saying how they are executed
    /// (SCREEN_CATALOG.md 2.1).
    public let executionDisclosure: String?

    public init(
        connection: Connection,
        surface: TerminalSurfaceState,
        transport: SessionTransport,
        dock: [TerminalDockItem],
        cleartextWarning: String?,
        encoding: TerminalEncoding,
        encodingSelectable: Bool,
        autoLoginStatus: String?,
        hostKeyPrompt: HostKeyPrompt?,
        executionDisclosure: String?
    ) {
        self.connection = connection
        self.surface = surface
        self.transport = transport
        self.dock = dock
        self.cleartextWarning = cleartextWarning
        self.encoding = encoding
        self.encodingSelectable = encodingSelectable
        self.autoLoginStatus = autoLoginStatus
        self.hostKeyPrompt = hostKeyPrompt
        self.executionDisclosure = executionDisclosure
    }

    public var followingBottom: Bool { surface.followingBottom }

    /// The reconnect affordance exists exactly when the transport dropped
    /// and the grant still allows dialling.
    public var canReconnect: Bool {
        transport == .disconnected && connection.capabilities.canUse
    }
}

/// The S21 page state, as a pure function.
public enum TerminalStates {

    /// - Parameter row: the session registry row, when one exists. A missing
    ///   row reads as disconnected rather than connecting: registering the
    ///   row is synchronous with dialling, so the only way to observe a
    ///   missing row is a tab that has never dialled -- and telling that
    ///   user 连接中 would hide the one button that can help them.
    public static func derive(
        connection: Connection?,
        surface: TerminalSurfaceState,
        row: SessionRow?,
        loaded: Bool,
        error: MobileError?,
        hostKeyPrompt: HostKeyPrompt?,
        autoLoginStatus: String?
    ) -> PageState<TerminalContent> {
        if !loaded { return .initialLoading }

        // A connection that vanished from the mirror, or a grant revoked
        // while the tab was open, is terminal: the tab keeps its explanation
        // and offers no retry.
        guard let connection else { return .notFoundOrRevoked }
        if row?.revoked == true { return .notFoundOrRevoked }
        if !connection.capabilities.canUse {
            return .permissionDenied(missing: .use, reason: SessionActions.reasonUseRevoked)
        }
        if let error {
            // engine_unavailable cannot be retried away, so it renders as
            // fatal rather than offering a retry button that would fail
            // identically.
            if error.retryable || error.isRegistryRetryable {
                return .retryableError(error)
            }
            return .fatalIncompatible(error)
        }

        return .content(
            TerminalContent(
                connection: connection,
                surface: surface,
                transport: row?.transport ?? .disconnected,
                dock: TerminalDockItem.forProtocol(connection.`protocol`),
                cleartextWarning: connection.`protocol`.isCleartext ? cleartextWarning : nil,
                encoding: connection.encoding,
                encodingSelectable: connection.`protocol` == .telnet,
                autoLoginStatus: autoLoginStatus,
                hostKeyPrompt: hostKeyPrompt,
                executionDisclosure: disclosureFor(connection)
            )
        )
    }

    static func disclosureFor(_ connection: Connection) -> String? {
        guard connection.residency == .sharedOnlineOnly else { return nil }
        return connection.sharedUsePolicy.materialTouchesDevice
            ? SessionActions.disclosureDirect
            : SessionActions.disclosureRelay
    }

    public static let cleartextWarning = "Telnet 为明文协议：凭据与会话内容在网络上不加密"
    public static let autoLoginRunning = "自动登录已发送凭据"
}

/// Credentials resolved for one connect attempt. Plaintext exists only for
/// the call; nothing here is stored.
public struct TerminalCredentials: Equatable, Sendable {
    public var password: String?
    public var privateKey: String?
    public var passphrase: String?

    public init(password: String? = nil, privateKey: String? = nil, passphrase: String? = nil) {
        self.password = password
        self.privateKey = privateKey
        self.passphrase = passphrase
    }
}

/// One dial attempt, as the engine would receive it.
public struct TerminalOpenRequest: Equatable, Sendable {
    public let sessionId: String
    public let `protocol`: ConnectionProtocol
    public let host: String
    public let port: Int
    public let username: String
    public let password: String?
    public let privateKey: String?
    public let passphrase: String?
    public let columns: Int
    public let rows: Int
    public let encoding: TerminalEncoding
    public let autoLogin: Bool

    public init(
        sessionId: String,
        `protocol`: ConnectionProtocol,
        host: String,
        port: Int,
        username: String,
        password: String?,
        privateKey: String?,
        passphrase: String?,
        columns: Int,
        rows: Int,
        encoding: TerminalEncoding,
        autoLogin: Bool
    ) {
        self.sessionId = sessionId
        self.`protocol` = `protocol`
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.privateKey = privateKey
        self.passphrase = passphrase
        self.columns = columns
        self.rows = rows
        self.encoding = encoding
        self.autoLogin = autoLogin
    }
}

/// The engine's answer to one dial.
public enum TerminalOpenOutcome: Equatable, Sendable {
    case opened

    /// A host key the user has not ruled on yet. The transport is held open
    /// by the engine until ``TerminalHostPort/answerHostKey`` resolves it.
    case hostKeyRequired(HostKeyPrompt)

    case failed(MobileError)
}

/// A live transport, once one exists.
public protocol TerminalTransportPort: AnyObject {
    func write(_ bytes: [UInt8]) async throws
    func resize(columns: Int, rows: Int) async throws
    func close() async
}

/// The native terminal host: the engine track that is currently blocked.
///
/// Everything S21 does with bytes goes through this seam, so the screen state
/// machine, the reconnection UI and the interaction contract are fully
/// implemented and tested while the engine itself is pending
/// (NATIVE_ENGINE_DECISIONS.md). ``UnavailableTerminalHost`` is the honest
/// default: it reports the engine's absence as a structured error instead of
/// pretending to connect.
public protocol TerminalHostPort: AnyObject {
    var isAvailable: Bool { get }
    func open(_ request: TerminalOpenRequest) async -> TerminalOpenOutcome
    /// Resolves a pending host-key prompt.
    func answerHostKey(sessionId: String, trust: Bool) async -> TerminalOpenOutcome
    func transport(for sessionId: String) -> TerminalTransportPort?
}

/// The terminal emulator half of the engine. Separate from the host because
/// a build can ship a parser without a transport or vice versa, and the
/// screen must say which piece is missing.
public protocol TerminalEmulatorPort: AnyObject {
    var isAvailable: Bool { get }
}

/// Default emulator while the native engine track is blocked.
public final class UnavailableTerminalEmulator: TerminalEmulatorPort {
    public init() {}
    public var isAvailable: Bool { false }

    public static let blocked = MobileError.local(
        code: "engine_unavailable",
        message: "终端引擎在此版本中尚未接入",
        retryable: false
    )
}

/// Default host while the native engine track is blocked.
public final class UnavailableTerminalHost: TerminalHostPort {
    public let `protocol`: ConnectionProtocol

    public init(`protocol`: ConnectionProtocol = .ssh) {
        self.`protocol` = `protocol`
    }

    public var isAvailable: Bool { false }

    public func open(_ request: TerminalOpenRequest) async -> TerminalOpenOutcome {
        .failed(UnavailableTerminalHost.error(for: request.`protocol`))
    }

    public func answerHostKey(sessionId: String, trust: Bool) async -> TerminalOpenOutcome {
        .failed(UnavailableTerminalHost.error(for: `protocol`))
    }

    public func transport(for sessionId: String) -> TerminalTransportPort? { nil }

    public static func error(for value: ConnectionProtocol) -> MobileError {
        switch value {
        case .telnet: return telnetNoSocket
        default: return sshBlocked
        }
    }

    public static let sshBlocked = MobileError.local(
        code: "engine_unavailable",
        message: "SSH 引擎在此版本中尚未接入，无法建立会话",
        retryable: false
    )
    public static let telnetNoSocket = MobileError.local(
        code: "engine_unavailable",
        message: "Telnet 引擎在此版本中尚未接入，无法建立会话",
        retryable: false
    )
}