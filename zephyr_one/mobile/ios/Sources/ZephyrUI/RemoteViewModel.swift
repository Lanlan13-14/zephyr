import Combine
import Foundation

/// Everything S22/S23 renders around the remote surface.
public struct RemoteContent: Equatable, Sendable {
    public let connection: Connection
    public let status: RemoteSessionStatus
    public let chrome: [RemoteChromeItem]
    public let certificate: RemoteCertificate?
    public let toolbarVisible: Bool
    public let permissions: [RemoteChannelPermission]
    /// True while the engine is absent, so the shell can say so honestly.
    public let engineUnavailable: Bool
    public let disclosure: String?

    public init(
        connection: Connection,
        status: RemoteSessionStatus,
        chrome: [RemoteChromeItem],
        certificate: RemoteCertificate?,
        toolbarVisible: Bool,
        permissions: [RemoteChannelPermission],
        engineUnavailable: Bool,
        disclosure: String?
    ) {
        self.connection = connection
        self.status = status
        self.chrome = chrome
        self.certificate = certificate
        self.toolbarVisible = toolbarVisible
        self.permissions = permissions
        self.engineUnavailable = engineUnavailable
        self.disclosure = disclosure
    }
}

/// The S22/S23 page state, as a pure function.
public enum RemoteStates {

    public static func derive(
        connection: Connection?,
        status: RemoteSessionStatus,
        chrome: [RemoteChromeItem],
        certificate: RemoteCertificate?,
        toolbarVisible: Bool,
        permissions: [RemoteChannelPermission],
        row: SessionRow?,
        loaded: Bool,
        error: MobileError?
    ) -> PageState<RemoteContent> {
        if !loaded { return .initialLoading }
        guard let connection else { return .notFoundOrRevoked }
        if row?.revoked == true { return .notFoundOrRevoked }
        if !connection.capabilities.canUse {
            return .permissionDenied(missing: .use, reason: SessionActions.reasonUseRevoked)
        }
        if let error {
            if error.retryable || error.isRegistryRetryable {
                return .retryableError(error)
            }
            return .fatalIncompatible(error)
        }
        return .content(
            RemoteContent(
                connection: connection,
                status: status,
                chrome: chrome,
                certificate: certificate,
                toolbarVisible: toolbarVisible,
                permissions: permissions,
                engineUnavailable: false,
                disclosure: disclosureFor(connection)
            )
        )
    }

    /// The toolbar set per protocol (SCREEN_CATALOG.md 9/10). RDP carries
    /// sound/resolution/file-drive/certificate; VNC carries quality/color and
    /// neither sound nor a drive.
    public static func chrome(for `protocol`: ConnectionProtocol) -> [RemoteChromeItem] {
        switch `protocol` {
        case .rdp:
            return [.keyboard, .pointerMode, .zoom, .clipboard, .sound, .resolution, .quality, .fileDrive, .certificate, .reconnect, .disconnect]
        default:
            return [.keyboard, .pointerMode, .zoom, .clipboard, .quality, .reconnect, .disconnect]
        }
    }

    static func disclosureFor(_ connection: Connection) -> String? {
        guard connection.residency == .sharedOnlineOnly else { return nil }
        return connection.sharedUsePolicy.materialTouchesDevice
            ? SessionActions.disclosureDirect
            : SessionActions.disclosureRelay
    }
}

/// What the remote screen asks the host navigation to do.
public enum RemoteEvent: Equatable, Sendable {
    case minimised
    case closed
    /// A chrome item that pushes a sub-screen (certificate, file drive).
    case openChrome(RemoteChromeItem)
}

/// S22 RDP / S23 VNC 会话.
///
/// Owns the chrome and the trust/phase state machine. The pixels belong to
/// the blocked remote engine, so the surface is an honest placeholder; every
/// dial and every certificate decision goes through ``RemoteEnginePort``.
public final class RemoteViewModel: ObservableObject {

    @Published public private(set) var page: PageState<RemoteContent> = .initialLoading
    @Published public private(set) var status = RemoteSessionStatus()
    @Published public private(set) var event: RemoteEvent?
    @Published public private(set) var message: String?
    @Published public private(set) var toolbarVisible = true

    public let sessionId: String
    private let connectionId: String
    private let registry: SessionRegistry
    private let findConnection: (String) -> Connection?
    private let engine: RemoteEnginePort
    private let clock: () -> Int64

    private var connection: Connection?
    private var loaded = false
    private var error: MobileError?
    private var certificate: RemoteCertificate?
    private var permissions: [RemoteChannelPermission] = RemoteChannelKind.allCases.map { RemoteChannelPermission(kind: $0) }

    public init(
        sessionId: String,
        connectionId: String,
        registry: SessionRegistry,
        findConnection: @escaping (String) -> Connection?,
        engine: RemoteEnginePort,
        clock: @escaping () -> Int64 = { 0 }
    ) {
        self.sessionId = sessionId
        self.connectionId = connectionId
        self.registry = registry
        self.findConnection = findConnection
        self.engine = engine
        self.clock = clock
        registry.addObserver { [weak self] in self?.recompute() }
    }

    public func load() {
        connection = findConnection(connectionId)
        loaded = true
        recompute()
    }

    private func recompute() {
        guard let connection else {
            page = RemoteStates.derive(
                connection: nil, status: status, chrome: [], certificate: certificate,
                toolbarVisible: toolbarVisible, permissions: permissions, row: nil,
                loaded: loaded, error: error
            )
            return
        }
        page = RemoteStates.derive(
            connection: connection,
            status: status,
            chrome: RemoteStates.chrome(for: connection.`protocol`),
            certificate: certificate,
            toolbarVisible: toolbarVisible,
            permissions: permissions,
            row: registry.row(sessionId),
            loaded: loaded,
            error: error
        )
    }

    // ---- connect --------------------------------------------------------------------------------

    public func connect() {
        guard let connection else { return }
        if !engine.isAvailable {
            error = UnavailableRemoteEngine.error(for: connection.`protocol`)
            recompute()
            return
        }
        error = nil
        certificate = nil
        status = status.advance(.resolving, clock())
        registerRow(connection, .connecting)
        recompute()
        Task { await performConnect(connection) }
    }

    func performConnect(_ connection: Connection) async {
        let request = RemoteConnectRequest(
            sessionId: sessionId,
            protocol: connection.`protocol`,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: nil
        )
        let outcome = await engine.connect(request)
        handle(outcome)
    }

    private func handle(_ outcome: RemoteConnectOutcome) {
        switch outcome {
        case let .connected(next):
            status = next
            registry.setTransport(sessionId, .connected, clock())
        case let .certificateRequired(cert):
            status = status.advance(.securing, clock())
            certificate = cert
        case let .failed(fail):
            error = fail
            status = status.advance(.disconnected, clock())
            registry.setTransport(sessionId, .disconnected, clock())
        }
        recompute()
    }

    public func trustCertificate() {
        guard certificate != nil else { return }
        Task { await performAnswerCertificate(trust: true) }
    }

    public func rejectCertificate() {
        guard certificate != nil else { return }
        Task { await performAnswerCertificate(trust: false) }
        message = RemoteViewModel.msgCertificateRejected
    }

    func performAnswerCertificate(trust: Bool) async {
        certificate = nil
        let outcome = await engine.answerCertificate(sessionId: sessionId, trust: trust)
        if trust {
            handle(outcome)
        } else {
            status = status.advance(.disconnected, clock())
            registry.setTransport(sessionId, .disconnected, clock())
            recompute()
        }
    }

    // ---- reconnect ------------------------------------------------------------------------------

    /// Manual reconnect. An automatic reconnect is only attempted when the
    /// failure is a genuine drop, never for a revoked credential or ACL
    /// (SCREEN_CATALOG.md 9/10).
    public func reconnect() {
        guard let connection else { return }
        if !engine.isAvailable {
            error = UnavailableRemoteEngine.error(for: connection.`protocol`)
            recompute()
            return
        }
        error = nil
        status = status.advance(.reconnecting, clock())
        status.attempt += 1
        recompute()
        Task { await performConnect(connection) }
    }

    /// Whether an automatic reconnect is warranted after the latest drop.
    public var canAutoReconnect: Bool {
        RemotePhasePolicy.canAutoReconnect(error) &&
            status.attempt < RemotePhasePolicy.maxAutoAttempts &&
            !status.hasSurface
    }

    // ---- chrome -----------------------------------------------------------------------------------

    public func toggleToolbar() {
        toolbarVisible.toggle()
        recompute()
    }

    public func onChrome(_ item: RemoteChromeItem) {
        switch item {
        case .reconnect:
            reconnect()
        case .disconnect:
            disconnect()
        case .certificate:
            event = .openChrome(.certificate)
        default:
            event = .openChrome(item)
        }
    }

    /// A channel the session genuinely requested. Declining one channel never
    /// exits the session (SCREEN_CATALOG.md 9).
    public func requestChannel(_ kind: RemoteChannelKind) {
        guard let index = permissions.firstIndex(where: { $0.kind == kind }) else { return }
        permissions[index] = RemoteChannelPermission(kind: kind, requested: true)
        recompute()
    }

    public func respondChannel(_ kind: RemoteChannelKind, granted: Bool) {
        guard let index = permissions.firstIndex(where: { $0.kind == kind }) else { return }
        permissions[index] = RemoteChannelPermission(kind: kind, requested: true, granted: granted)
        recompute()
    }

    // ---- session control ---------------------------------------------------------------------------

    public func disconnect() {
        registry.close(sessionId, clock())
        status = status.advance(.disconnected, clock())
        recompute()
        event = .closed
    }

    public func minimise() {
        registry.setMinimised(sessionId, true)
        event = .minimised
    }

    public func consumeEvent() {
        event = nil
    }

    public func consumeMessage() {
        message = nil
    }

    private func registerRow(_ connection: Connection, _ transport: SessionTransport) {
        let execution: SessionExecution = connection.residency == .sharedOnlineOnly &&
            !connection.sharedUsePolicy.materialTouchesDevice ? .relay : .local
        registry.upsert(
            SessionRow(
                sessionId: sessionId,
                connectionId: connectionId,
                protocol: connection.`protocol`,
                name: connection.name,
                host: connection.host,
                port: connection.port,
                transport: transport,
                execution: execution,
                capabilities: connection.capabilities,
                residency: connection.residency,
                startedAt: registry.row(sessionId)?.startedAt ?? clock()
            )
        )
    }

    public static let msgCertificateRejected = "已拒绝证书，会话未建立"
}