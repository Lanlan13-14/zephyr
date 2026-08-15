import Foundation
#if canImport(Network)
import Network
#endif

/// Local TCP reachability. Independent of any protocol engine and of the
/// main end. Measures the time to complete a TCP handshake.
public struct TcpReachabilityTester: ConnectionTester {
    public var timeoutMs: Int
    public var nowMs: () -> Int64
    public var connect: (String, Int, Int) async throws -> Void

    public init(
        timeoutMs: Int = 5_000,
        nowMs: @escaping () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        },
        connect: @escaping (String, Int, Int) async throws -> Void = { host, port, timeoutMs in
            try await TcpReachabilityTester.open(host: host, port: port, timeoutMs: timeoutMs)
        }
    ) {
        self.timeoutMs = timeoutMs
        self.nowMs = nowMs
        self.connect = connect
    }

    public func test(_ connection: Connection) async throws -> ConnectionTestResult {
        let host = connection.host.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.isEmpty {
            return .failed(MobileError.local(code: "test_no_host", message: "没有填写主机"))
        }
        if connection.port < 1 || connection.port > 65_535 {
            return .failed(MobileError.local(code: "test_bad_port", message: "端口无效"))
        }
        let started = nowMs()
        do {
            try await connect(host, connection.port, timeoutMs)
            return .reachable(roundTripMs: max(0, nowMs() - started))
        } catch {
            return .failed(
                MobileError.local(
                    code: "test_unreachable",
                    message: error.localizedDescription,
                    retryable: true
                )
            )
        }
    }

    public static func open(host: String, port: Int, timeoutMs: Int) async throws {
        #if canImport(Network)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let connection = NWConnection(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(rawValue: UInt16(port)) ?? .any,
                using: .tcp
            )
            let lock = NSLock()
            var finished = false
            func finish(_ result: Result<Void, Error>) {
                lock.lock()
                defer { lock.unlock() }
                guard !finished else { return }
                finished = true
                connection.cancel()
                continuation.resume(with: result)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.success(()))
                case let .failed(error):
                    finish(.failure(error))
                case .cancelled:
                    finish(.failure(CancellationError()))
                default:
                    break
                }
            }
            connection.start(queue: DispatchQueue.global(qos: .userInitiated))
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + .milliseconds(timeoutMs)
            ) {
                finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(ETIMEDOUT))))
            }
        }
        #else
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTSUP))
        #endif
    }
}
