import Foundation
import XCTest
@testable import ZephyrCore

final class KeychainSyncDatabaseKeyStoreTests: XCTestCase {
    func testEveryScopeComponentProducesAnIndependentUnlockedOnlyKey() throws {
        let items = DatabaseKeychainItems()
        let random = DeterministicDatabaseKeys()
        let store = try KeychainSyncDatabaseKeyStore(
            servicePrefix: "test.sync-db",
            items: items,
            randomBytes: random.next
        )
        let baseline = try scope()
        let scopes = [
            baseline,
            try scope(serverID: "server-2"),
            try scope(accountID: "account-2"),
            try scope(deviceID: "device-2"),
            try scope(generation: "generation-2"),
        ]

        let keys = try scopes.map { try store.loadOrCreateKey(for: $0) }
        XCTAssertEqual(Set(keys).count, scopes.count)
        XCTAssertTrue(keys.allSatisfy { $0.count == 32 })
        XCTAssertEqual(items.adds.count, scopes.count)
        XCTAssertTrue(items.adds.allSatisfy { $0.accessibility == .whenUnlockedThisDeviceOnly })
        XCTAssertEqual(try store.loadOrCreateKey(for: baseline), keys[0])
        XCTAssertEqual(items.adds.count, scopes.count)
    }

    func testDuplicateInsertUsesDurableRaceWinner() throws {
        let items = DatabaseKeychainItems()
        let winner = Data(repeating: 0xA5, count: 32)
        items.duplicateWinner = winner
        let store = try KeychainSyncDatabaseKeyStore(
            servicePrefix: "test.sync-db",
            items: items,
            randomBytes: { _ in Data(repeating: 0x5A, count: 32) }
        )

        XCTAssertEqual(try store.loadOrCreateKey(for: scope()), winner)
    }

    func testCorruptStoredKeyFailsClosedAndDeletionIsGenerationScoped() throws {
        let items = DatabaseKeychainItems()
        let store = try KeychainSyncDatabaseKeyStore(
            servicePrefix: "test.sync-db",
            items: items,
            randomBytes: { count in Data(repeating: 1, count: count) }
        )
        let first = try scope()
        let second = try scope(generation: "generation-2")
        _ = try store.loadOrCreateKey(for: first)
        _ = try store.loadOrCreateKey(for: second)

        try store.deleteKey(for: first)
        XCTAssertNil(try store.loadKey(for: first))
        XCTAssertNotNil(try store.loadKey(for: second))

        items.replaceOnlyValue(with: Data(repeating: 0, count: 31))
        XCTAssertThrowsError(try store.loadKey(for: second)) { error in
            XCTAssertEqual(error as? SyncDatabaseKeyStoreError, .invalidStoredKey)
        }
    }

    private func scope(
        serverID: String = "server-1",
        accountID: String = "account-1",
        deviceID: String = "device-1",
        generation: String = "generation-1"
    ) throws -> SyncDatabaseKeyScope {
        try SyncDatabaseKeyScope(
            serverID: serverID,
            accountID: accountID,
            deviceID: deviceID,
            generation: generation
        )
    }
}

private final class DeterministicDatabaseKeys: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt8 = 1

    func next(count: Int) -> Data {
        lock.lock()
        defer { lock.unlock() }
        let result = Data(repeating: value, count: count)
        value &+= 1
        return result
    }
}

private final class DatabaseKeychainItems: KeychainItemAccessing {
    struct Add {
        let service: String
        let account: String
        let accessibility: KeychainItemAccessibility
    }

    var adds: [Add] = []
    var duplicateWinner: Data?
    private var values: [String: Data] = [:]

    func readGenericPassword(service: String, account: String) throws -> Data? {
        values[key(service, account)]
    }

    func writeGenericPassword(
        _ data: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws {
        values[key(service, account)] = data
    }

    func addGenericPasswordIfAbsent(
        _ data: Data,
        service: String,
        account: String,
        accessibility: KeychainItemAccessibility
    ) throws -> Bool {
        let itemKey = key(service, account)
        if let duplicateWinner {
            values[itemKey] = duplicateWinner
            self.duplicateWinner = nil
            return false
        }
        guard values[itemKey] == nil else { return false }
        adds.append(Add(service: service, account: account, accessibility: accessibility))
        values[itemKey] = data
        return true
    }

    func deleteGenericPassword(service: String, account: String) throws {
        values.removeValue(forKey: key(service, account))
    }

    func deleteGenericPasswords(service: String) throws {
        values = values.filter { !$0.key.hasPrefix(service + "\u{0}") }
    }

    func replaceOnlyValue(with data: Data) {
        guard let key = values.keys.first else { return }
        values[key] = data
    }

    private func key(_ service: String, _ account: String) -> String {
        service + "\u{0}" + account
    }
}
