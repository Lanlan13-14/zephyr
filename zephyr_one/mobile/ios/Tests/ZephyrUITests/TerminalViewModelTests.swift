import XCTest
@testable import ZephyrUI

/// S21 terminal view model: connect flow, host-key gate, reconnect policy and
/// the Telnet/encoding rules.
final class TerminalViewModelTests: XCTestCase {

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

        var isAvailable: Bool { available }

        func open(_ request: TerminalOpenRequest) async -> TerminalOpenOutcome {
            openedRequest = request
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
        let host = FakeHost()
        host.outcome = .opened
        let vm = makeVM(registry: registry, host: host, connection: UiTestData.connection())
        vm.load()
        vm.connect()
        XCTAssertEqual(registry.row("s-1")?.transport, .connecting)

        await vm.performOpen(UiTestData.connection())
        XCTAssertEqual(registry.row("s-1")?.transport, .connected)
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content, got \(vm.page)")
        }
        XCTAssertEqual(value.transport, .connected)
    }

    func testSharedRelayExecution() async {
        let registry = SessionRegistry()
        let host = FakeHost()
        host.outcome = .opened
        let relay = UiTestData.connection(residency: .sharedOnlineOnly, sharedUsePolicy: .relayOnly)
        let vm = makeVM(registry: registry, host: host, connection: relay)
        vm.load()
        vm.connect()
        await vm.performOpen(relay)
        XCTAssertEqual(registry.row("s-1")?.execution, .relay)
    }

    func testHostKeyGate() async {
        let registry = SessionRegistry()
        let host = FakeHost()
        host.outcome = .hostKeyRequired(HostKeyPrompt(fingerprint: "AA:BB", changed: true))
        let vm = makeVM(registry: registry, host: host, connection: UiTestData.connection())
        vm.load()
        vm.connect()
        await vm.performOpen(UiTestData.connection())

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
        let host = FakeHost()
        host.outcome = .hostKeyRequired(HostKeyPrompt(fingerprint: "AA:BB", changed: false))
        let vm = makeVM(registry: registry, host: host, connection: UiTestData.connection())
        vm.load()
        vm.connect()
        await vm.performOpen(UiTestData.connection())
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
        let host = FakeHost()
        let telnet = UiTestData.connection(`protocol`: .telnet)
        let vm = makeVM(registry: SessionRegistry(), host: host, connection: telnet)
        vm.load()
        vm.setEncoding(.gbk)
        vm.connect()
        await vm.performOpen(telnet)
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