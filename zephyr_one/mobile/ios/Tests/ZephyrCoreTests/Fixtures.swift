import Foundation

/// A malformed fixture, as distinct from a mismatch against a good one.
///
/// Its own type rather than reusing `Zft2Error`: a ZFT2 error is a wire-protocol
/// rejection with a code the peer branches on, and borrowing it for "this JSON
/// file is broken" would make a fixture problem look like a protocol failure in
/// the test output. The distinction matters when a test fails and someone has to
/// tell whether the port or the vector is wrong.
struct FixtureError: Error, CustomStringConvertible {
    let reason: String
    var description: String { "fixture: \(reason)" }
}

/// Loads the frozen cross-language vectors from `mobile/contracts/generated/`.
///
/// Located from `#filePath` rather than from a SwiftPM resource bundle. SwiftPM
/// can only bundle files that live inside the package, so a resource declaration
/// would mean copying the JSON into Tests/ -- a second source of truth for bytes
/// that four languages must agree on, which would go stale silently. The
/// generated-manifest drift gate exists precisely to prevent that class of
/// duplication, so the tests read the one real file instead.
enum Fixtures {

    /// `.../mobile/contracts/generated`
    static var generatedDir: URL {
        // #filePath is .../mobile/ios/Tests/ZephyrCoreTests/Fixtures.swift
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // -> Tests/ZephyrCoreTests
            .deletingLastPathComponent()   // -> Tests
            .deletingLastPathComponent()   // -> ios
            .deletingLastPathComponent()   // -> mobile
            .appendingPathComponent("contracts")
            .appendingPathComponent("generated")
    }

    static func json(_ name: String) throws -> [String: Any] {
        let url = generatedDir.appendingPathComponent(name)
        let data = try Data(contentsOf: url)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw FixtureError(reason: "\(name) is not a JSON object")
        }
        return object
    }

    /// Hex string to bytes. Rejects an odd length rather than truncating, so a
    /// malformed fixture fails as a fixture problem instead of as a mismatch.
    static func hex(_ text: String) throws -> Data {
        guard text.count % 2 == 0 else {
            throw FixtureError(reason: "odd-length hex: \(text.count)")
        }
        var out = Data(capacity: text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else {
                throw FixtureError(reason: "bad hex digit in \(text)")
            }
            out.append(byte)
            index = next
        }
        return out
    }

    static func hexString(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
