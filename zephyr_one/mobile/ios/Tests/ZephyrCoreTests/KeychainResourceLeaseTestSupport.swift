import Foundation
@testable import ZephyrCore

final class MemoryResourceLeaseKeychain: KeychainResourceLeaseAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: KeychainResourceLeaseItem] = [:]
    private var nextReadError: Error?
    private var nextReplaceError: Error?
    private var nextReplaceHook: (() throws -> Void)?
    private var replaceMisses = 0
    private var inserts = 0
    private var replacements = 0

    var insertCount: Int {
        synchronized { inserts }
    }

    var replaceCount: Int {
        synchronized { replacements }
    }

    func failNextRead(with error: Error) {
        synchronized { nextReadError = error }
    }

    func failNextReplace(with error: Error) {
        synchronized { nextReplaceError = error }
    }

    func failNextReplaceAsComparisonMiss() {
        synchronized { replaceMisses += 1 }
    }

    func runBeforeNextReplace(_ hook: @escaping () throws -> Void) {
        synchronized { nextReplaceHook = hook }
    }

    func rawDataContains(_ value: String) -> Bool {
        let needle = Data(value.utf8)
        return synchronized {
            values.values.contains { $0.data.range(of: needle) != nil }
        }
    }

    func onlyEnvelope() throws -> KeychainResourceLeaseEnvelope {
        let item = try synchronized { () throws -> KeychainResourceLeaseItem in
            guard values.count == 1, let item = values.values.first else {
                throw KeychainResourceLeaseError.corruptRecord
            }
            return item
        }
        return try JSONDecoder().decode(KeychainResourceLeaseEnvelope.self, from: item.data)
    }

    func forceReplaceOnlyEnvelope(_ envelope: KeychainResourceLeaseEnvelope) throws {
        let item = try KeychainResourceLeaseCodec.makeItem(for: envelope)
        try synchronized {
            guard values.count == 1, let itemKey = values.keys.first else {
                throw KeychainResourceLeaseError.corruptRecord
            }
            values[itemKey] = item
        }
    }

    func read(service: String, account: String) throws -> KeychainResourceLeaseItem? {
        try synchronized {
            if let error = nextReadError {
                nextReadError = nil
                throw error
            }
            return values[key(service, account)]
        }
    }

    func insertIfAbsent(
        _ item: KeychainResourceLeaseItem,
        service: String,
        account: String
    ) throws -> Bool {
        synchronized {
            let itemKey = key(service, account)
            guard values[itemKey] == nil else { return false }
            values[itemKey] = item
            inserts += 1
            return true
        }
    }

    func replace(
        _ item: KeychainResourceLeaseItem,
        matchingComparisonToken expectedComparisonToken: Data,
        service: String,
        account: String
    ) throws -> Bool {
        let hook = synchronized { () -> (() throws -> Void)? in
            let value = nextReplaceHook
            nextReplaceHook = nil
            return value
        }
        try hook?()

        return try synchronized {
            if let error = nextReplaceError {
                nextReplaceError = nil
                throw error
            }
            if replaceMisses > 0 {
                replaceMisses -= 1
                return false
            }
            let itemKey = key(service, account)
            guard values[itemKey]?.comparisonToken == expectedComparisonToken else { return false }
            values[itemKey] = item
            replacements += 1
            return true
        }
    }

    private func key(_ service: String, _ account: String) -> String {
        service + "\0" + account
    }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }
}
