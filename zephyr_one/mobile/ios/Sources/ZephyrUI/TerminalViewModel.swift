import Combine
import Foundation

/// What the terminal screen asks the host navigation to do.
public enum TerminalEvent: Equatable, Sendable {
    /// The tab was minimised: the screen pops and the row keeps living in
    /// the session list.
    case minimised

    /// A dock item that pushes another screen (files/snippets/notes) or
    /// switches to the session list.
    case openDock(TerminalDockItem)

    /// The session ended and the row closed; nothing left to show.
    case closed
}

/// S21 SSH/Telnet 终端.
///
/// Holds the screen state machine for one session. The terminal canvas is an
/// honest placeholder: everything user-visible around it -- the dock, the
/// shortcut/IME contract surface, the host-key gate, the reconnect flow and
/// the Telnet differences -- is implemented and tested here, while every byte
/// path goes through ``TerminalHostPort`` so the blocked native engine slots
/// in without touching this class (NATIVE_ENGINE_DECISIONS.md).
public final class TerminalViewModel: ObservableObject {

    @Published public private(set) var page: PageState<TerminalContent> = .initialLoading
    @Published public private(set) var surface = TerminalSurfaceState()
    @Published public private(set) var event: TerminalEvent?
    @Published public private(set) var message: String?

    public let sessionId: String
    private let connectionId: String
    private let registry: SessionRegistry
    /// Narrowed to the one lookup this class performs, so S21 is unit
    /// testable without a database.
    private let findConnection: (String) -> Connection?
    private let host: TerminalHostPort
    private let emulator: TerminalEmulatorPort
    private let secretProvider: (Connection) async -> TerminalCredentials
    private let clock: () -> Int64

    private var connection: Connection?
    private var error: MobileError?
    private var hostKeyPrompt: HostKeyPrompt?
    private var autoLoginStatus: String?
    private var loaded = false
    private var encodingOverride: TerminalEncoding?

    public init(
        sessionId: String,
        connectionId: String,
        registry: SessionRegistry,
        findConnection: @escaping (String) -> Connection?,
        host: TerminalHostPort,
        emulator: TerminalEmulatorPort,
        secretProvider: @escaping (Connection) async -> TerminalCredentials = { _ in TerminalCredentials() },
        clock: @escaping () -> Int64 = { 0 }
    ) {
        self.sessionId = sessionId
        self.connectionId = connectionId
        self.registry = registry
        self.findConnection = findConnection
        self.host = host
        self.emulator = emulator
        self.secretProvider = secretProvider
        self.clock = clock
        registry.addObserver { [weak self] in self?.recompute() }
    }

    public func load() {
        connection = findConnection(connectionId)
        loaded = true
        recompute()
    }

    private func recompute() {
        page = TerminalStates.derive(
            connection: connection,
            surface: surface,
            row: registry.row(sessionId),
            loaded: loaded,
            error: error,
            hostKeyPrompt: hostKeyPrompt,
            autoLoginStatus: autoLoginStatus
        )
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    /// Opens the transport.
    ///
    /// Explicit rather than automatic in ``load``: a restored workspace tab
    /// must not dial, and the same view model serves both a fresh connect
    /// and a restored row. The caller decides.
    public func connect() {
        guard let connection else { return }
        if !emulator.isAvailable {
            error = UnavailableTerminalEmulator.blocked
            recompute()
            return
        }
        if !host.isAvailable {
            error = UnavailableTerminalHost.error(for: connection.`protocol`)
            recompute()
            return
        }
        error = nil
        hostKeyPrompt = nil
        registerRow(connection, .connecting)
        recompute()

        Task { await performOpen(connection) }
    }

    /// The async dial, split out so tests can await it deterministically on
    /// the host runner instead of racing a fire-and-forget `Task`.
    func performOpen(_ connection: Connection) async {
        let surfaceSnapshot = surface
        let credentials = await secretProvider(connection)
        let request = TerminalOpenRequest(
            sessionId: sessionId,
            protocol: connection.`protocol`,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: credentials.password,
            privateKey: credentials.privateKey,
            passphrase: credentials.passphrase,
            columns: surfaceSnapshot.columns,
            rows: surfaceSnapshot.rows,
            encoding: encodingOverride ?? connection.encoding,
            autoLogin: connection.`protocol` == .telnet && !connection.username.isEmpty
        )
        let outcome = await host.open(request)
        handle(outcome)
    }

    /// A dropped session dials again under the same row identity. The gate
    /// is re-checked against the registry row so a tab revoked while the
    /// screen was open cannot reconnect.
    public func reconnect() {
        guard let connection else { return }
        let row = registry.row(sessionId)
        let gateRow = row ?? SessionRow(
            sessionId: sessionId,
            connectionId: connectionId,
            protocol: connection.`protocol`,
            name: connection.name,
            host: connection.host,
            port: connection.port,
            transport: .disconnected,
            capabilities: connection.capabilities,
            residency: connection.residency
        )
        let reconnectGate = SessionActions.gate(gateRow, action: .reconnect)
        guard reconnectGate.isAllowed else {
            if case let .disabled(_, reason) = reconnectGate {
                message = reason
            } else {
                message = SessionActions.reasonUseRevoked
            }
            return
        }
        connect()
    }

    private func handle(_ outcome: TerminalOpenOutcome) {
        switch outcome {
        case .opened:
            registry.setTransport(sessionId, .connected, clock())
            hostKeyPrompt = nil
            if connection?.`protocol` == .telnet, !(connection?.username.isEmpty ?? true) {
                autoLoginStatus = TerminalStates.autoLoginRunning
            }
        case let .hostKeyRequired(prompt):
            // The row stays in 连接中: the session is genuinely waiting on
            // the user's trust decision, not on the network.
            hostKeyPrompt = prompt
        case let .failed(openError):
            error = openError
            registry.setTransport(sessionId, .disconnected, clock())
        }
        recompute()
    }

    // ---- host key gate ---------------------------------------------------------------------------

    public func trustHostKey() {
        guard hostKeyPrompt != nil else { return }
        Task { await performAnswerHostKey(trust: true) }
    }

    public func rejectHostKey() {
        guard hostKeyPrompt != nil else { return }
        Task { await performAnswerHostKey(trust: false) }
        message = TerminalViewModel.msgHostKeyRejected
    }

    func performAnswerHostKey(trust: Bool) async {
        hostKeyPrompt = nil
        let outcome = await host.answerHostKey(sessionId: sessionId, trust: trust)
        if trust {
            handle(outcome)
        } else {
            registry.setTransport(sessionId, .disconnected, clock())
            message = TerminalViewModel.msgHostKeyRejected
            recompute()
        }
    }

    // ---- session control ---------------------------------------------------------------------------

    /// Ends the session: the row moves to history first, the transport is
    /// torn down afterwards.
    public func disconnect() {
        let transport = host.transport(for: sessionId)
        registry.close(sessionId, clock())
        recompute()
        Task { await transport?.close() }
        event = .closed
    }

    /// Minimise is a pure UI move: the session keeps running and the row
    /// joins 已最小化.
    public func minimise() {
        registry.setMinimised(sessionId, true)
        event = .minimised
    }

    // ---- input surface ---------------------------------------------------------------------------

    /// Committed text becomes bytes. Called by the IME bridge on commit
    /// only: composition updates never reach the wire
    /// (TERMINAL_EXPERIENCE.md: CJK composition 期间不滚，commit 后最多一次校正).
    public func commitText(_ text: String) {
        guard let transport = host.transport(for: sessionId) else { return }
        let bytes = [UInt8](text.utf8)
        Task { try? await transport.write(bytes) }
    }

    /// Viewport changes resize the PTY (SCREEN_CATALOG.md 8).
    public func resize(columns: Int, rows: Int) {
        guard columns > 0, rows > 0 else { return }
        surface.columns = columns
        surface.rows = rows
        recompute()
        guard let transport = host.transport(for: sessionId) else { return }
        Task { try? await transport.resize(columns: columns, rows: rows) }
    }

    /// Only Telnet negotiates a code page; the picker is absent for SSH, so
    /// a call for SSH is a programming error the guard absorbs.
    public func setEncoding(_ encoding: TerminalEncoding) {
        guard connection?.`protocol` == .telnet else { return }
        encodingOverride = encoding
        recompute()
    }

    // ---- scrollback ------------------------------------------------------------------------------

    /// The user started reading scrollback: remote output stops moving the
    /// viewport and counts toward the badge instead.
    public func beginReading() {
        surface.beginReading()
        recompute()
    }

    public func jumpToBottom() {
        surface.jumpToBottom()
        registry.markRead(sessionId)
        recompute()
    }

    /// Fed by the engine's output pump once one exists.
    public func noteOutput(rows: Int) {
        surface.noteOutput(rows: rows)
        if registry.row(sessionId)?.minimised == true {
            registry.markUnread(sessionId)
        }
        recompute()
    }

    // ---- dock ------------------------------------------------------------------------------------

    public func onDock(_ item: TerminalDockItem) {
        switch item {
        case .disconnect:
            disconnect()
        case .sessions:
            minimise()
        case .keyboard, .files, .snippets, .notes:
            event = .openDock(item)
        }
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

    public static let msgHostKeyRejected = "已拒绝主机密钥，会话未建立"
}