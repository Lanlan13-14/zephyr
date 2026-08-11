import XCTest
@testable import ZephyrUI

/// S22/S23 remote view model: chrome per protocol, the connect/certificate
/// flow and the engine-unavailable honesty.
final class RemoteViewModelTests: XCTestCase {

    private final class FakeEngine: RemoteEnginePort {
        var available: Bool = true
        var outcome: RemoteConnectOutcome = .connected(RemoteSessionStatus(phase: .connected, phaseSince: 1))
        var answeredTrust: Bool?

        var isAvailable: Bool { available }

        func connect(_ request: RemoteConnectRequest) async -> RemoteConnectOutcome {
            outcome
        }

        func answerCertificate(sessionId: String, trust: Bool) async -> RemoteConnectOutcome {
            answeredTrust = trust
            return outcome
        }
    }

    private func makeVM(
        registry: SessionRegistry = SessionRegistry(),
        engine: RemoteEnginePort,
        connection: Connection
    ) -> RemoteViewModel {
        RemoteViewModel(
            sessionId: "r-1",
            connectionId: connection.id,
            registry: registry,
            findConnection: { _ in connection },
            engine: engine
        )
    }

    func testChromePerProtocol() {
        XCTAssertTrue(RemoteStates.chrome(for: .rdp).contains(.sound))
        XCTAssertTrue(RemoteStates.chrome(for: .rdp).contains(.certificate))
        XCTAssertTrue(RemoteStates.chrome(for: .rdp).contains(.fileDrive))
        XCTAssertFalse(RemoteStates.chrome(for: .vnc).contains(.sound))
        XCTAssertFalse(RemoteStates.chrome(for: .vnc).contains(.fileDrive))
        XCTAssertTrue(RemoteStates.chrome(for: .vnc).contains(.quality))
    }

    func testUnavailableEngineIsFatal() {
        let vm = makeVM(engine: FakeEngine(available: false), connection: UiTestData.connection(`protocol`: .rdp))
        vm.load()
        vm.connect()
        guard case let .fatalIncompatible(error) = vm.page else {
            return XCTFail("expected fatalIncompatible, got \(vm.page)")
        }
        XCTAssertEqual(error.code, "rdp_engine_unavailable")
    }

    func testConnectOpensAndMarksConnected() async {
        let registry = SessionRegistry()
        let engine = FakeEngine()
        let rdp = UiTestData.connection(`protocol`: .rdp)
        let vm = makeVM(registry: registry, engine: engine, connection: rdp)
        vm.load()
        vm.connect()
        XCTAssertEqual(registry.row("r-1")?.transport, .connecting)
        await vm.performConnect(rdp)
        XCTAssertEqual(registry.row("r-1")?.transport, .connected)
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content, got \(vm.page)")
        }
        XCTAssertTrue(value.status.hasSurface)
    }

    func testCertificateGate() async {
        let registry = SessionRegistry()
        let engine = FakeEngine()
        engine.outcome = .certificateRequired(
            RemoteCertificate(subject: "host", issuer: "ca", validFromMs: 0, validToMs: 0, sha256: "ABC", changed: true)
        )
        let vm = makeVM(registry: registry, engine: engine, connection: UiTestData.connection(`protocol`: .rdp))
        vm.load()
        vm.connect()
        await vm.performConnect(UiTestData.connection(`protocol`: .rdp))
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content, got \(vm.page)")
        }
        XCTAssertNotNil(value.certificate)
        XCTAssertEqual(value.certificate?.changed, true)

        engine.outcome = .connected(RemoteSessionStatus(phase: .connected, phaseSince: 1))
        await vm.performAnswerCertificate(trust: true)
        XCTAssertEqual(engine.answeredTrust, true)
        XCTAssertEqual(registry.row("r-1")?.transport, .connected)
    }

    func testRejectCertificateDisconnects() async {
        let registry = SessionRegistry()
        let engine = FakeEngine()
        engine.outcome = .certificateRequired(
            RemoteCertificate(subject: "host", issuer: "ca", validFromMs: 0, validToMs: 0, sha256: "ABC", changed: true)
        )
        let vm = makeVM(registry: registry, engine: engine, connection: UiTestData.connection(`protocol`: .rdp))
        vm.load()
        vm.connect()
        await vm.performConnect(UiTestData.connection(`protocol`: .rdp))
        await vm.performAnswerCertificate(trust: false)
        XCTAssertEqual(engine.answeredTrust, false)
        XCTAssertEqual(registry.row("r-1")?.transport, .disconnected)
        XCTAssertEqual(vm.message, RemoteViewModel.msgCertificateRejected)
    }

    func testChannelDeclineKeepsSession() {
        let engine = FakeEngine()
        let vm = makeVM(engine: engine, connection: UiTestData.connection(`protocol`: .rdp))
        vm.load()
        vm.requestChannel(.mic)
        vm.respondChannel(.mic, granted: false)
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content, got \(vm.page)")
        }
        XCTAssertEqual(value.permissions.first { $0.kind == .mic }?.granted, false)
        // Declining never disconnects: transport is untouched.
        XCTAssertNil(engine.answeredTrust)
    }

    func testDisconnectClosesRow() {
        let registry = SessionRegistry()
        registry.upsert(SessionTestSupport.row(sessionId: "r-1", connectionId: "c-1", transport: .connected))
        let vm = makeVM(registry: registry, engine: FakeEngine(), connection: UiTestData.connection(`protocol`: .rdp))
        vm.load()
        vm.disconnect()
        XCTAssertEqual(registry.row("r-1")?.transport, .closed)
        XCTAssertEqual(vm.event, .closed)
    }
}