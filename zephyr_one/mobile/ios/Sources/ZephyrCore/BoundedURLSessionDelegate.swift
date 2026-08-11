import Foundation

/// Collects URLSession's decoded response chunks while keeping the buffered
/// body at or below the configured limit. One instance may serve concurrent
/// data tasks; task state is protected because delegate callbacks and caller
/// cancellation can arrive on different queues.
final class BoundedURLSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct ResponseTooLargeError: Error {
        let response: HTTPURLResponse?
    }

    private final class Transfer {
        let byteLimit: Int
        let continuation: CheckedContinuation<(Data, URLResponse), Error>
        var response: URLResponse?
        var data = Data()

        init(
            byteLimit: Int,
            continuation: CheckedContinuation<(Data, URLResponse), Error>
        ) {
            self.byteLimit = byteLimit
            self.continuation = continuation
        }
    }

    private let lock = NSLock()
    private var transfers: [Int: Transfer] = [:]

    func load(
        _ request: URLRequest,
        using session: URLSession,
        byteLimit: Int
    ) async throws -> (Data, URLResponse) {
        let task = session.dataTask(with: request)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let transfer = Transfer(byteLimit: byteLimit, continuation: continuation)
                lock.lock()
                transfers[task.taskIdentifier] = transfer
                lock.unlock()

                // Cancellation can win before the continuation is registered.
                // Rechecking here closes that race without starting any I/O.
                if Task.isCancelled {
                    cancel(task)
                } else {
                    task.resume()
                }
            }
        } onCancel: {
            self.cancel(task)
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        var rejected: Transfer?

        lock.lock()
        if let transfer = transfers[dataTask.taskIdentifier] {
            transfer.response = response
            if let http = response as? HTTPURLResponse,
               Self.declaredLengthExceedsLimit(http, byteLimit: transfer.byteLimit) {
                rejected = transfers.removeValue(forKey: dataTask.taskIdentifier)
            }
        }
        lock.unlock()

        guard let rejected else {
            completionHandler(.allow)
            return
        }

        completionHandler(.cancel)
        dataTask.cancel()
        rejected.continuation.resume(
            throwing: ResponseTooLargeError(response: response as? HTTPURLResponse)
        )
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var rejected: Transfer?
        var response: HTTPURLResponse?

        lock.lock()
        if let transfer = transfers[dataTask.taskIdentifier] {
            let remaining = transfer.byteLimit - transfer.data.count
            if data.count > remaining {
                response = transfer.response as? HTTPURLResponse
                rejected = transfers.removeValue(forKey: dataTask.taskIdentifier)
            } else {
                transfer.data.append(data)
            }
        }
        lock.unlock()

        guard let rejected else { return }
        dataTask.cancel()
        rejected.continuation.resume(throwing: ResponseTooLargeError(response: response))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        let transfer = transfers.removeValue(forKey: task.taskIdentifier)
        lock.unlock()

        guard let transfer else { return }
        if let error {
            transfer.continuation.resume(throwing: error)
        } else if let response = transfer.response {
            transfer.continuation.resume(returning: (transfer.data, response))
        } else {
            transfer.continuation.resume(throwing: URLError(.badServerResponse))
        }
    }

    /// API redirects are never legitimate. Refusing them prevents a
    /// credentialed request from being replayed at a server-selected target.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    private func cancel(_ task: URLSessionTask) {
        lock.lock()
        let transfer = transfers.removeValue(forKey: task.taskIdentifier)
        lock.unlock()

        task.cancel()
        transfer?.continuation.resume(throwing: CancellationError())
    }

    private static func declaredLengthExceedsLimit(
        _ response: HTTPURLResponse,
        byteLimit: Int
    ) -> Bool {
        guard let rawValue = response.value(forHTTPHeaderField: "Content-Length") else {
            return false
        }
        let value = rawValue.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }) else {
            return false
        }
        guard let declaredLength = UInt64(value) else {
            // A syntactically valid decimal larger than UInt64 is necessarily
            // larger than every supported in-memory response limit.
            return true
        }
        return declaredLength > UInt64(byteLimit)
    }
}
