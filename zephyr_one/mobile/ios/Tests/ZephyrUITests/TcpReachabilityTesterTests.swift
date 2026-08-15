import XCTest
@testable import ZephyrUI

final class TcpReachabilityTesterTests: XCTestCase {

    func testReachableReportsHandshakeDuration() async throws {
        var now: Int64 = 1_000
        let tester = TcpReachabilityTester(
            nowMs: { now },
            connect: { host, port, timeout in
                XCTAssertEqual(host, "10.0.8.30")
                XCTAssertEqual(port, 3389)
                XCTAssertEqual(timeout, 5_000)
                now = 1_041
            }
        )
        let result = try await tester.test(
            UiTestData.connection(`protocol`: .rdp, host: "10.0.8.30", port: 3389)
        )
        XCTAssertEqual(result, .reachable(roundTripMs: 41))
    }

    func testEmptyHostDoesNotConnect() async throws {
        var opened = false
        let tester = TcpReachabilityTester(connect: { _, _, _ in opened = true })
        let result = try await tester.test(
            UiTestData.connection(`protocol`: .rdp, host: "  ", port: 3389)
        )
        if case let .failed(error) = result {
            XCTAssertEqual(error.code, "test_no_host")
        } else {
            XCTFail("expected failed, got \(result)")
        }
        XCTAssertFalse(opened)
    }
}
