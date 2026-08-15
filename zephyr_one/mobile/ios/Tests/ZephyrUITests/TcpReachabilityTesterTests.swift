import XCTest
@testable import ZephyrUI

final class TcpReachabilityTesterTests: XCTestCase {

    func testReachableReportsHandshakeDuration() async throws {
        let clock = LockedClock(1_000)
        let tester = TcpReachabilityTester(
            nowMs: { clock.now },
            connect: { host, port, timeout in
                XCTAssertEqual(host, "10.0.8.30")
                XCTAssertEqual(port, 3389)
                XCTAssertEqual(timeout, 5_000)
                clock.now = 1_041
            }
        )
        let result = try await tester.test(
            UiTestData.connection(host: "10.0.8.30", protocol: .rdp, port: 3389)
        )
        XCTAssertEqual(result, .reachable(roundTripMs: 41))
    }

    func testEmptyHostDoesNotConnect() async throws {
        let opened = LockedFlag()
        let tester = TcpReachabilityTester(connect: { _, _, _ in opened.value = true })
        let result = try await tester.test(
            UiTestData.connection(host: "  ", protocol: .rdp, port: 3389)
        )
        if case let .failed(error) = result {
            XCTAssertEqual(error.code, "test_no_host")
        } else {
            XCTFail("expected failed, got \(result)")
        }
        XCTAssertFalse(opened.value)
    }
}

private final class LockedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64
    init(_ value: Int64) { self.value = value }
    var now: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
