import XCTest
@testable import ZephyrUI

/// S22/S23 remote view model: chrome per protocol, the connect/certificate
/// flow and the engine-unavailable honesty.
@MainActor
final class RemoteViewModelTests: XCTestCase {

    private final class FakeEngine: RemoteEnginePort {
        var available: Bool
        init(available: Bool = true) { self.available = available }
        var outcome: RemoteConnectOutcome = .connected(RemoteSessionStatus(phase: .connected, phaseSince: 1))
        var answeredTrust: Bool?
        var connectCalls = 0

        var isAvailable: Bool { available }

        func connect(_ request: RemoteConnectRequest) async -> RemoteConnectOutcome {
            connectCalls += 1
            return outcome
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
        let rdp = RemoteStates.chrome(for: .rdp)
        XCTAssertEqual(rdp.first, .pointerMode)
        XCTAssertTrue(rdp.contains(.quality))
        XCTAssertTrue(rdp.contains(.fileDrive))
        XCTAssertTrue(rdp.contains(.cad))
        XCTAssertTrue(rdp.contains(.shortcuts))
        XCTAssertFalse(rdp.contains(.vncQuality))
        let vnc = RemoteStates.chrome(for: .vnc)
        XCTAssertTrue(vnc.contains(.vncQuality))
        XCTAssertFalse(vnc.contains(.fileDrive))
        XCTAssertFalse(vnc.contains(.cad))
        XCTAssertFalse(vnc.contains(.resolution))
    }

    func testUnavailableEngineStaysOnTheSessionPage() {
        let vm = makeVM(engine: FakeEngine(available: false), connection: UiTestData.connection(`protocol`: .rdp))
        vm.load()
        vm.connect()
        guard case let .content(value, _, _, _) = vm.page else {
            return XCTFail("expected content overlay, got \(vm.page)")
        }
        XCTAssertTrue(value.engineUnavailable)
    }

    func testConnectOpensAndMarksConnected() async {
        let registry = SessionRegistry()
        let engine = FakeEngine()
        let rdp = UiTestData.connection(`protocol`: .rdp)
        let vm = makeVM(registry: registry, engine: engine, connection: rdp)
        vm.load()
        vm.connect()
        XCTAssertEqual(registry.row("r-1")?.transport, .connecting)
        await vm.waitForPendingConnect()
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
        await vm.waitForPendingConnect()
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
        await vm.waitForPendingConnect()
        await vm.performAnswerCertificate(trust: false)
        XCTAssertEqual(engine.answeredTrust, false)
        XCTAssertEqual(registry.row("r-1")?.transport, .disconnected)
        XCTAssertEqual(vm.message, RemoteViewModel.msgCertificateRejected)
    }

    func testRepeatedConnectWhilePendingStartsOneEngineRequest() async {
        let registry = SessionRegistry()
        let engine = FakeEngine()
        let rdp = UiTestData.connection(`protocol`: .rdp)
        let vm = makeVM(registry: registry, engine: engine, connection: rdp)
        vm.load()

        vm.connect()
        vm.connect()
        await vm.waitForPendingConnect()

        XCTAssertEqual(engine.connectCalls, 1)
        XCTAssertEqual(registry.row("r-1")?.transport, .connected)
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
        XCTAssertEqual(vm.message, "会话已关闭")
    }
}
