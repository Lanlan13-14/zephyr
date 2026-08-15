import Foundation
#if canImport(Network)
import Network
#endif

/// Local TCP reachability. Independent of any protocol engine and of the
/// main end. Measures the time to complete a TCP handshake.
public struct TcpReachabilityTester: ConnectionTester, @unchecked Sendable {
    public var timeoutMs: Int
    public var nowMs: @Sendable () -> Int64
    public var connect: @Sendable (String, Int, Int) async throws -> Void

    public init(
        timeoutMs: Int = 5_000,
        nowMs: @escaping @Sendable () -> Int64 = {
            Int64(Date().timeIntervalSince1970 * 1_000)
        },
        connect: @escaping @Sendable (String, Int, Int) async throws -> Void = { host, port, timeoutMs in
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
            let finisher = TcpConnectionFinisher(connection: connection, continuation: continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finisher.finish(.success(()))
                case let .failed(error):
                    finisher.finish(.failure(error))
                case .cancelled:
                    finisher.finish(.failure(CancellationError()))
                default:
                    break
                }
            }
            connection.start(queue: DispatchQueue.global(qos: .userInitiated))
            DispatchQueue.global(qos: .userInitiated).asyncAfter(
                deadline: .now() + .milliseconds(timeoutMs)
            ) {
                finisher.finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(ETIMEDOUT))))
            }
        }
        #else
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTSUP))
        #endif
    }
}

#if canImport(Network)
private final class TcpConnectionFinisher: @unchecked Sendable {
    private let lock = NSLock()
    private let connection: NWConnection
    private let continuation: CheckedContinuation<Void, Error>
    private var finished = false

    init(connection: NWConnection, continuation: CheckedContinuation<Void, Error>) {
        self.connection = connection
        self.continuation = continuation
    }

    func finish(_ result: Result<Void, Error>) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        lock.unlock()
        connection.cancel()
        continuation.resume(with: result)
    }
}
#endif
