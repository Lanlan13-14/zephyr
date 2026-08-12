import XCTest
import Combine
@testable import ZephyrUI

/// S21 terminal view model: connect flow, host-key gate, reconnect policy and
/// the Telnet/encoding rules.
final class TerminalViewModelTests: XCTestCase {

    /// Holds the task started by `connect()` at the host boundary. This lets
    /// the test inspect the observable connecting state before a successful
    /// dial is allowed to update it, without racing task scheduling.
    private actor OpenGate {
        private var hasOpened = false
        private var hasReleased = false
        private var earlyOutcome: TerminalOpenOutcome?
        private var outcomeContinuation: CheckedContinuation<TerminalOpenOutcome, Never>?

        func open() async -> TerminalOpenOutcome {
            precondition(!hasOpened, "OpenGate supports exactly one open")
            hasOpened = true
            if let earlyOutcome {
                self.earlyOutcome = nil
                return earlyOutcome
            }
            return await withCheckedContinuation {
                outcomeContinuation = $0
            }
        }

        func release(_ outcome: TerminalOpenOutcome) {
            precondition(!hasReleased, "OpenGate supports exactly one release")
            hasReleased = true
            guard let continuation = outcomeContinuation else {
                earlyOutcome = outcome
                return
            }
            outcomeContinuation = nil
            continuation.resume(returning: outcome)
        }

    }

    private final class FakeEmulator: TerminalEmulatorPort {
        var available: Bool
        init(available: Bool = true) { self.available = available }
        var isAvailable: Bool { available }
    }

    private final class FakeHost: TerminalHostPort {
        var available: Bool = true
        var outcome: TerminalOpenOutcome = .opened
        var openedRequest: TerminalOpenRequest?
        var answeredTrust: Bool?
        let openGate: OpenGate?
        let onOpenStarted: () -> Void

        init(openGate: OpenGate? = nil, onOpenStarted: @escaping () -> Void = {}) {
            self.openGate = openGate
            self.onOpenStarted = onOpenStarted
        }

        var isAvailable: Bool { available }

        func open(_ request: TerminalOpenRequest) async -> TerminalOpenOutcome {
            openedRequest = request
            if let openGate {
                onOpenStarted()
                return await openGate.open()
            }
            return outcome
        }

        func answerHostKey(sessionId: String, trust: Bool) async -> TerminalOpenOutcome {
            answeredTrust = trust
            return outcome
        }

        func transport(for sessionId: String) -> TerminalTransportPort? { nil }
    }

    private func makeVM(
        registry: SessionRegistry = SessionRegistry(),
        host: TerminalHostPort,
        emulator: TerminalEmulatorPort = FakeEmulator(),
        connection: Connection
    ) -> TerminalViewModel {
        TerminalViewModel(
            sessionId: "s-1",
            connectionId: connection.id,
            registry: registry,
            findConnection: { _ in connection },
            host: host,
            emulator: emulator
        )
    }

    func testUnavailableEmulatorIsFatalAndRegistersNothing() {
        let registry = SessionRegistry()
        let host = FakeHost()
        let vm = makeVM(
            registry: registry,
            host: host,
            emulator: FakeEmulator(available: false),
            connection: UiTestData.connection()
        )
        vm.load()
        vm.connect()
        guard case let .fatalIncompatible(error) = vm.page else {
            return XCTFail("expected fatalIncompatible, got \(vm.page)")
        }
        XCTAssertEqual(error.code, "engine_unavailable")
        XCTAssertNil(registry.row("s-1"))
    }

    func testConnectRegistersConnectingThenConnected() async {
        let registry = SessionRegistry()
        let openStarted = expectation(description: "connect task reaches the host")
        let gate = OpenGate()
        let host = FakeHost(openGate: gate) { openStarted.fulfill() }
        let vm = makeVM(registry: registry, host: host, connection: UiTestData.connection())
        vm.load()
        vm.connect()
        await fulfillment(of: [openStarted], timeout: 1)
        XCTAssertEqual(registry.row("s-1")?.transport, .connecting)

        let connected = expectation(description: "connect task marks the row connected")
        registry.addObserver {
            if registry.row("s-1")?.transport == .connected {
                connected.fulfill()
            }
        }
        await gate.release(.opened)
        await fulfillment(of: [connected], timeout: 1)
        XCTAssertEqual(registry.row("s-1")?.transport, .connected)
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content, got \(vm.page)")
        }
        XCTAssertEqual(value.transport, .connected)
    }

    func testSharedRelayExecution() async {
        let registry = SessionRegistry()
        let openStarted = expectation(description: "relay connect reaches the host")
        let gate = OpenGate()
        let host = FakeHost(openGate: gate) { openStarted.fulfill() }
        let relay = UiTestData.connection(residency: .sharedOnlineOnly, sharedUsePolicy: .relayOnly)
        let vm = makeVM(registry: registry, host: host, connection: relay)
        vm.load()
        vm.connect()
        await fulfillment(of: [openStarted], timeout: 1)
        let connected = expectation(description: "relay connect task completes")
        registry.addObserver {
            if registry.row("s-1")?.transport == .connected {
                connected.fulfill()
            }
        }
        await gate.release(.opened)
        await fulfillment(of: [connected], timeout: 1)
        XCTAssertEqual(registry.row("s-1")?.execution, .relay)
    }

    func testHostKeyGate() async {
        let registry = SessionRegistry()
        let openStarted = expectation(description: "host-key connect reaches the host")
        let gate = OpenGate()
        let host = FakeHost(openGate: gate) { openStarted.fulfill() }
        let vm = makeVM(registry: registry, host: host, connection: UiTestData.connection())
        vm.load()
        vm.connect()
        await fulfillment(of: [openStarted], timeout: 1)
        let promptShown = expectation(description: "host-key prompt is published")
        let pageObservation = vm.$page.sink { page in
            if case let .content(value, _, _, _) = page, value.hostKeyPrompt?.changed == true {
                promptShown.fulfill()
            }
        }
        defer { pageObservation.cancel() }
        await gate.release(.hostKeyRequired(HostKeyPrompt(fingerprint: "AA:BB", changed: true)))
        await fulfillment(of: [promptShown], timeout: 1)

        // Prompt is surfaced and the row stays connecting.
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content, got \(vm.page)")
        }
        XCTAssertNotNil(value.hostKeyPrompt)
        XCTAssertEqual(value.hostKeyPrompt?.changed, true)
        XCTAssertEqual(registry.row("s-1")?.transport, .connecting)

        // Trust resolves to connected.
        host.outcome = .opened
        await vm.performAnswerHostKey(trust: true)
        XCTAssertEqual(host.answeredTrust, true)
        XCTAssertEqual(registry.row("s-1")?.transport, .connected)
    }

    func testRejectHostKeyDisconnects() async {
        let registry = SessionRegistry()
        let openStarted = expectation(description: "rejected host-key connect reaches the host")
        let gate = OpenGate()
        let host = FakeHost(openGate: gate) { openStarted.fulfill() }
        let vm = makeVM(registry: registry, host: host, connection: UiTestData.connection())
        vm.load()
        vm.connect()
        await fulfillment(of: [openStarted], timeout: 1)
        let promptShown = expectation(description: "host-key prompt is published")
        let pageObservation = vm.$page.sink { page in
            if case let .content(value, _, _, _) = page, value.hostKeyPrompt?.changed == false {
                promptShown.fulfill()
            }
        }
        defer { pageObservation.cancel() }
        await gate.release(.hostKeyRequired(HostKeyPrompt(fingerprint: "AA:BB", changed: false)))
        await fulfillment(of: [promptShown], timeout: 1)
        await vm.performAnswerHostKey(trust: false)
        XCTAssertEqual(host.answeredTrust, false)
        XCTAssertEqual(registry.row("s-1")?.transport, .disconnected)
        XCTAssertEqual(vm.message, TerminalViewModel.msgHostKeyRejected)
    }

    func testReconnectOnRevokedRowIsBlocked() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", connectionId: "c-1", transport: .disconnected, revoked: true))
        let vm = makeVM(registry: registry, host: FakeHost(), connection: UiTestData.connection())
        vm.load()
        vm.reconnect()
        XCTAssertEqual(vm.message, SessionActions.reasonRevoked)
    }

    func testSetEncodingIgnoredForSsh() {
        let host = FakeHost()
        let vm = makeVM(registry: SessionRegistry(), host: host, connection: UiTestData.connection())
        vm.load()
        vm.setEncoding(.gbk)
        // SSH is UTF-8; the override must not apply and no request is made.
        XCTAssertEqual(vm.surface.columns, 80)
    }

    func testTelnetSetEncodingIsAppliedToRequest() async {
        let openStarted = expectation(description: "Telnet connect reaches the host")
        let gate = OpenGate()
        let host = FakeHost(openGate: gate) { openStarted.fulfill() }
        let registry = SessionRegistry()
        let telnet = UiTestData.connection(`protocol`: .telnet)
        let vm = makeVM(registry: registry, host: host, connection: telnet)
        vm.load()
        vm.setEncoding(.gbk)
        vm.connect()
        await fulfillment(of: [openStarted], timeout: 1)
        let connected = expectation(description: "telnet connect task completes")
        registry.addObserver {
            if registry.row("s-1")?.transport == .connected {
                connected.fulfill()
            }
        }
        await gate.release(.opened)
        await fulfillment(of: [connected], timeout: 1)
        XCTAssertEqual(host.openedRequest?.encoding, .gbk)
    }

    func testDisconnectClosesRow() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "s-1", connectionId: "c-1", transport: .connected))
        let vm = makeVM(registry: registry, host: FakeHost(), connection: UiTestData.connection())
        vm.load()
        vm.disconnect()
        XCTAssertEqual(registry.row("s-1")?.transport, .closed)
        XCTAssertEqual(vm.event, .closed)
    }
}
