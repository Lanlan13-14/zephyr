import Foundation

/// One JSON value as it may appear in ZFT2 frame metadata.
///
/// A purpose-built value type rather than `Any` or `Codable` dictionaries, for a
/// reason that is structural rather than stylistic: the encoded byte length of
/// this metadata lands in the frame header, so the encoding must be exactly
/// reproducible. `JSONSerialization` and `JSONEncoder` both make choices this
/// protocol cannot tolerate --
///
///   * key order. A Swift `Dictionary` has no order at all, and
///     `JSONSerialization` with `.sortedKeys` produces a *different* order than
///     the insertion order the JS and Kotlin sides emit. Either way the bytes
///     differ from the peer's, and `metaLen` differs with them.
///   * escaping. `JSONSerialization` escapes forward slashes as `\/` in some
///     configurations; ZFT2 metadata carries POSIX paths, so that alone would
///     change every open request's length.
///   * number formatting. A `Double` round-trip turns `3` into `3.0`, which is a
///     different byte count for the same value.
///
/// A desynchronised `metaLen` is not a cosmetic difference: the peer reads that
/// many bytes as metadata and the remainder as payload, so the frame is
/// misparsed and the session breaks. `contracts/generated/zft2-frames.json` pins
/// the exact hex of five frames precisely so all three implementations can be
/// held to one answer.
public enum Zft2Value: Sendable, Equatable {
    case string(String)
    case int(Int64)
    case bool(Bool)
    case null
}

/// Frame metadata: ordered key/value pairs.
///
/// Ordered because insertion order is part of the wire bytes (see `Zft2Value`).
/// Duplicate keys are rejected rather than last-wins: a duplicate would encode
/// twice and no peer's JSON parser would agree on which survived.
public struct Zft2Meta: Sendable, Equatable, ExpressibleByArrayLiteral {
    public private(set) var pairs: [(key: String, value: Zft2Value)]

    public init() { self.pairs = [] }

    public init(_ pairs: [(String, Zft2Value)]) {
        self.pairs = []
        for (key, value) in pairs { self.set(key, value) }
    }

    public init(arrayLiteral elements: (String, Zft2Value)...) {
        self.init(elements)
    }

    public var isEmpty: Bool { pairs.isEmpty }

    public subscript(key: String) -> Zft2Value? {
        pairs.first { $0.key == key }?.value
    }

    public mutating func set(_ key: String, _ value: Zft2Value) {
        if let index = pairs.firstIndex(where: { $0.key == key }) {
            pairs[index] = (key: key, value: value)
        } else {
            pairs.append((key: key, value: value))
        }
    }

    public static func == (lhs: Zft2Meta, rhs: Zft2Meta) -> Bool {
        guard lhs.pairs.count == rhs.pairs.count else { return false }
        for (left, right) in zip(lhs.pairs, rhs.pairs) {
            if left.key != right.key || left.value != right.value { return false }
        }
        return true
    }

    /// Compact JSON, insertion order preserved, non-ASCII written as raw UTF-8.
    ///
    /// Only the two escapes JSON requires plus the control-character range are
    /// emitted. Notably absent: escaping `/` and escaping non-ASCII as `\uXXXX`.
    /// The unicode-metadata fixture exists to pin that: with its CJK path escaped,
    /// its metadata would be 46 bytes instead of 28.
    public func encodedJson() -> Data {
        var text = "{"
        for (index, pair) in pairs.enumerated() {
            if index > 0 { text += "," }
            text += Self.quote(pair.key)
            text += ":"
            switch pair.value {
            case .string(let value): text += Self.quote(value)
            case .int(let value): text += String(value)
            case .bool(let value): text += value ? "true" : "false"
            case .null: text += "null"
            }
        }
        text += "}"
        return Data(text.utf8)
    }

    private static func quote(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    /// Parse compact JSON object metadata, preserving key order.
    ///
    /// Hand-written for the same reason `encodedJson()` is: `JSONSerialization`
    /// returns a `Dictionary`, which discards the order that must survive a
    /// decode/encode round trip. Only what ZFT2 metadata actually contains is
    /// supported -- a flat object of strings, integers, booleans and null.
    /// Anything else throws `bad_metadata` rather than being coerced, because a
    /// silently coerced value would re-encode to different bytes.
    public static func decode(_ data: Data) throws -> Zft2Meta {
        var parser = JsonScanner(bytes: [UInt8](data))
        let meta = try parser.parseObject()
        try parser.expectEnd()
        return meta
    }
}

/// Minimal recursive-descent scanner for the flat objects ZFT2 metadata uses.
private struct JsonScanner {
    let bytes: [UInt8]
    var index = 0

    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func parseObject() throws -> Zft2Meta {
        skipWhitespace()
        try expect(UInt8(ascii: "{"))
        var meta = Zft2Meta()
        skipWhitespace()
        if peek() == UInt8(ascii: "}") {
            index += 1
            return meta
        }
        while true {
            skipWhitespace()
            let key = try parseString()
            skipWhitespace()
            try expect(UInt8(ascii: ":"))
            skipWhitespace()
            let value = try parseValue()
            if meta[key] != nil { throw Zft2Error(code: "bad_metadata", message: "duplicate metadata key") }
            meta.set(key, value)
            skipWhitespace()
            let next = try require()
            if next == UInt8(ascii: "}") { return meta }
            if next != UInt8(ascii: ",") {
                throw Zft2Error(code: "bad_metadata", message: "ZFT2 metadata is not valid JSON")
            }
        }
    }

    mutating func parseValue() throws -> Zft2Value {
        let start = try peekRequired()
        switch start {
        case UInt8(ascii: "\""):
            return .string(try parseString())
        case UInt8(ascii: "t"):
            try expectLiteral("true")
            return .bool(true)
        case UInt8(ascii: "f"):
            try expectLiteral("false")
            return .bool(false)
        case UInt8(ascii: "n"):
            try expectLiteral("null")
            return .null
        default:
            return .int(try parseInt())
        }
    }

    mutating func parseString() throws -> String {
        try expect(UInt8(ascii: "\""))
        var scalars = [UInt8]()
        while true {
            let byte = try require()
            if byte == UInt8(ascii: "\"") { break }
            if byte != UInt8(ascii: "\\") {
                scalars.append(byte)
                continue
            }
            let escape = try require()
            switch escape {
            case UInt8(ascii: "\""): scalars.append(UInt8(ascii: "\""))
            case UInt8(ascii: "\\"): scalars.append(UInt8(ascii: "\\"))
            case UInt8(ascii: "/"): scalars.append(UInt8(ascii: "/"))
            case UInt8(ascii: "n"): scalars.append(0x0a)
            case UInt8(ascii: "r"): scalars.append(0x0d)
            case UInt8(ascii: "t"): scalars.append(0x09)
            case UInt8(ascii: "b"): scalars.append(0x08)
            case UInt8(ascii: "f"): scalars.append(0x0c)
            case UInt8(ascii: "u"):
                var code: UInt32 = 0
                for _ in 0..<4 {
                    let digit = try require()
                    guard let value = Self.hexValue(digit) else {
                        throw Zft2Error(code: "bad_metadata", message: "bad \\u escape in metadata")
                    }
                    code = code << 4 | UInt32(value)
                }
                guard let scalar = Unicode.Scalar(code) else {
                    throw Zft2Error(code: "bad_metadata", message: "bad \\u escape in metadata")
                }
                scalars.append(contentsOf: Array(String(scalar).utf8))
            default:
                throw Zft2Error(code: "bad_metadata", message: "unknown escape in metadata")
            }
        }
        guard let text = String(bytes: scalars, encoding: .utf8) else {
            throw Zft2Error(code: "bad_metadata", message: "metadata string is not valid UTF-8")
        }
        return text
    }

    /// Integers only.
    ///
    /// ZFT2 metadata carries handles, offsets and lengths. A float would
    /// re-encode with a decimal point and change `metaLen`, so a value with `.`,
    /// `e` or `E` is refused rather than accepted and silently reshaped.
    mutating func parseInt() throws -> Int64 {
        var digits = ""
        if peek() == UInt8(ascii: "-") {
            digits += "-"
            index += 1
        }
        while let byte = peek(), byte >= UInt8(ascii: "0"), byte <= UInt8(ascii: "9") {
            digits.append(Character(Unicode.Scalar(byte)))
            index += 1
        }
        if let byte = peek(), byte == UInt8(ascii: ".") || byte == UInt8(ascii: "e") || byte == UInt8(ascii: "E") {
            throw Zft2Error(code: "bad_metadata", message: "ZFT2 metadata numbers must be integers")
        }
        guard let value = Int64(digits) else {
            throw Zft2Error(code: "bad_metadata", message: "ZFT2 metadata is not valid JSON")
        }
        return value
    }

    mutating func expectEnd() throws {
        skipWhitespace()
        guard index == bytes.count else {
            throw Zft2Error(code: "bad_metadata", message: "trailing bytes after metadata object")
        }
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
        default: return nil
        }
    }

    private mutating func skipWhitespace() {
        while let byte = peek(), byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d {
            index += 1
        }
    }

    private func peek() -> UInt8? { index < bytes.count ? bytes[index] : nil }

    private func peekRequired() throws -> UInt8 {
        guard let byte = peek() else {
            throw Zft2Error(code: "bad_metadata", message: "ZFT2 metadata is not valid JSON")
        }
        return byte
    }

    private mutating func require() throws -> UInt8 {
        guard index < bytes.count else {
            throw Zft2Error(code: "bad_metadata", message: "ZFT2 metadata is not valid JSON")
        }
        defer { index += 1 }
        return bytes[index]
    }

    private mutating func expect(_ byte: UInt8) throws {
        guard try require() == byte else {
            throw Zft2Error(code: "bad_metadata", message: "ZFT2 metadata is not valid JSON")
        }
    }

    private mutating func expectLiteral(_ literal: String) throws {
        for byte in literal.utf8 { try expect(byte) }
    }
}
