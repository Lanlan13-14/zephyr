import Foundation
import Network

public struct ConnectivityStatus: Equatable, Sendable {
    public let isReachable: Bool
    public let isExpensive: Bool
    public let isConstrained: Bool

    public init(isReachable: Bool, isExpensive: Bool = false, isConstrained: Bool = false) {
        self.isReachable = isReachable
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
    }

    public static let unknown = ConnectivityStatus(isReachable: false)
}

public protocol ConnectivityMonitoring: Sendable {
    func start(_ handler: @escaping @Sendable (ConnectivityStatus) -> Void)
    func cancel()
}

/// One-shot path monitor intended to live with one binding-scoped scheduler.
public final class ConnectivityMonitor: ConnectivityMonitoring, @unchecked Sendable {
    private let monitor: NWPathMonitor
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var started = false
    private var cancelled = false

    public init(queue: DispatchQueue = DispatchQueue(label: "one.zephyr.mobile.connectivity")) {
        self.monitor = NWPathMonitor()
        self.queue = queue
    }

    public func start(_ handler: @escaping @Sendable (ConnectivityStatus) -> Void) {
        lock.lock()
        guard !started, !cancelled else {
            lock.unlock()
            return
        }
        started = true
        monitor.pathUpdateHandler = { path in
            handler(
                ConnectivityStatus(
                    isReachable: path.status == .satisfied,
                    isExpensive: path.isExpensive,
                    isConstrained: path.isConstrained
                )
            )
        }
        monitor.start(queue: queue)
        lock.unlock()
    }

    public func cancel() {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return
        }
        cancelled = true
        lock.unlock()

        monitor.pathUpdateHandler = nil
        monitor.cancel()
    }
}
