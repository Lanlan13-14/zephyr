import Foundation
import XCTest
@testable import ZephyrCore

/// In-memory ``KeyValueStore``.
///
/// Models the two properties of the real thing the callers depend on: reads see
/// writes immediately, and a batch is applied as one unit. Values are held as `Any`
/// because the store is heterogeneous by design -- a share row is two strings plus a
/// boolean, a bookmark row is data plus a boolean -- and a typed dictionary per kind
/// would let a test pass while the production code read the wrong one.
final class FakeKeyValueStore: KeyValueStore {

    private var values: [String: Any]

    /// Number of batches applied. Proves a multi-key row is written once rather than
    /// key by key, where a termination mid-row would leave a partial row behind.
    private(set) var batches = 0

    init(values: [String: Any] = [:]) {
        self.values = values
    }

    func string(_ key: String) -> String? { values[key] as? String }

    func data(_ key: String) -> Data? { values[key] as? Data }

    func boolean(_ key: String, default defaultValue: Bool) -> Bool {
        values[key] as? Bool ?? defaultValue
    }

    func stringArray(_ key: String) -> [String] { values[key] as? [String] ?? [] }

    func keys() -> [String] { Array(values.keys) }

    func edit(_ block: (KeyValueWriter) -> Void) {
        batches += 1
        /* Staged and merged, so a batch that returns early leaves nothing behind.
         * UserDefaults behaves the same way from the caller's point of view. */
        let writer = Writer()
        block(writer)
        for key in writer.removed { values.removeValue(forKey: key) }
        for (key, value) in writer.staged { values[key] = value }
    }

    /// Simulates a relaunch: the same bytes, a new object graph on top of them.
    func surviveRestart() -> FakeKeyValueStore { FakeKeyValueStore(values: values) }

    /// Simulates external truncation, e.g. a partially cleared defaults domain.
    func drop(_ key: String) { values.removeValue(forKey: key) }

    private final class Writer: KeyValueWriter {
        var staged: [String: Any] = [:]
        var removed: Set<String> = []

        func setString(_ key: String, _ value: String) {
            staged[key] = value
            removed.remove(key)
        }

        func setData(_ key: String, _ value: Data) {
            staged[key] = value
            removed.remove(key)
        }

        func setBoolean(_ key: String, _ value: Bool) {
            staged[key] = value
            removed.remove(key)
        }

        func setStringArray(_ key: String, _ value: [String]) {
            staged[key] = value
            removed.remove(key)
        }

        func remove(_ key: String) {
            staged.removeValue(forKey: key)
            removed.insert(key)
        }
    }
}
