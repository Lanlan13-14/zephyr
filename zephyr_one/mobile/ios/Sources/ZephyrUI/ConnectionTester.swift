import Foundation

/// Outcome of the S11 "测试" action.
///
/// Reachability and authentication are separate outcomes because they need
/// different remedies: a refused TCP connect is a host/port/route problem, a
/// rejected credential is an auth problem, and telling the user "失败" for
/// both is the anti-pattern MOBILE_EXPERIENCE.md 6 calls out.
public enum ConnectionTestResult: Equatable, Sendable {
    case reachable(roundTripMs: Int64)
    case authenticated(roundTripMs: Int64)
    case failed(MobileError)
}

/// Port for the connection test.
///
/// A port rather than a direct engine call because the editor lives above the
/// protocol layer: the native engines are gated on the spikes in
/// NATIVE_ENGINE_DECISIONS.md, while the screen logic must be testable on the
/// host today. Wiring concrete testers at the composition root keeps this
/// module free of protocol dependencies and lets each engine arrive
/// independently.
public protocol ConnectionTester: Sendable {
    func test(_ connection: Connection) async throws -> ConnectionTestResult
}

/// Fallback for protocols whose engine is not available in this build.
///
/// Returns a structured error instead of pretending the test passed. A fake
/// success here would be worse than no button: the user would save a
/// connection believing it was verified.
public struct UnavailableConnectionTester: ConnectionTester {
    public init() {}

    public func test(_ connection: Connection) async throws -> ConnectionTestResult {
        .failed(
            MobileError.local(
                code: "engine_unavailable",
                message: connection.`protocol`.wireName + " 引擎在此版本中尚不可用，无法测试"
            )
        )
    }
}
