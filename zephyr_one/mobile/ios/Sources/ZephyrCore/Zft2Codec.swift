import Foundation
import ZephyrContracts

/// A rejection with a stable code.
///
/// The codes are part of the wire contract, not debug text: the JS
/// (`file-transfer-protocol.js`), Kotlin (`Zft2Codec.kt`) and Dart
/// implementations use the same set, and `contracts/generated/zft2-frames.json`
/// asserts them, so a renamed code is a cross-platform break.
public struct Zft2Error: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code): \(message)" }
}

/// One decoded ZFT2 frame.
///
/// `requestId` is an `Int64` because the wire field is an unsigned 32-bit
/// integer: 0xFFFFFFFF is a legal id that would be -1 as a signed 32-bit value,
/// and the fixture set deliberately includes it.
public struct Zft2Frame: Sendable, Equatable {
    public let op: Int
    public let requestId: Int64
    public let flags: Int
    public let meta: Zft2Meta
    public let payload: Data

    public init(op: Int, requestId: Int64, flags: Int, meta: Zft2Meta, payload: Data) {
        self.op = op
        self.requestId = requestId
        self.flags = flags
        self.meta = meta
        self.payload = payload
    }

    public var isResponse: Bool { (flags & Int(Zft2Contract.flagResponse)) != 0 }
    public var isError: Bool { (flags & Int(Zft2Contract.flagError)) != 0 }
    public var operation: Zft2Op? { Zft2Op(rawValue: UInt8(truncatingIfNeeded: op)) }

    /// True for an op that mutates the remote filesystem.
    public var isWrite: Bool { operation?.isWrite == true }
}

/// Byte-exact ZFT2 codec.
///
/// A port of `Zft2Codec.kt`, itself ported from `file-transfer-protocol.js`.
/// "Byte-exact" is a hard requirement rather than an aspiration: the same frame
/// is produced by four languages and consumed by all of them, so
/// `contracts/generated/zft2-frames.json` pins the exact hex of five
/// representative frames plus five rejection cases, and this implementation is
/// held to the same file Kotlin is.
///
/// Header layout (all multi-byte fields big-endian), ZEPHYR_PARITY.md 10.2:
///
/// ```text
/// [0..3]   magic "ZFT2"
/// [4]      version (2)
/// [5]      op
/// [6..7]   u16 flags
/// [8..11]  u32 requestId
/// [12..15] u32 metaLen
/// [16..19] u32 payloadLen
/// ```
public enum Zft2Codec {

    private static let emptyMeta = Data("{}".utf8)

    public static func encode(
        op: Int,
        requestId: Int64,
        flags: Int = 0,
        meta: Zft2Meta? = nil,
        payload: Data? = nil,
        maxMetaBytes: Int = Zft2Contract.maxMetaBytes,
        maxPayloadBytes: Int = Zft2Contract.maxPayloadBytes
    ) throws -> Data {
        guard op >= 0, op <= 0xFF else {
            throw Zft2Error(code: "invalid_type", message: "Invalid ZFT2 frame type")
        }
        guard requestId >= 0, requestId <= 0xFFFF_FFFF else {
            throw Zft2Error(code: "invalid_request_id", message: "Invalid ZFT2 request id")
        }

        /* An absent or empty metadata object still encodes as `{}`, never as
         * zero bytes. The JS side always writes an object, so a frame with
         * metaLen 0 would decode to different metadata than the peer sent -- the
         * ping fixture pins this with a 2-byte metaLen for empty metadata. */
        let metaBytes = (meta?.isEmpty ?? true) ? emptyMeta : meta!.encodedJson()
        let payloadBytes = payload ?? Data()

        guard metaBytes.count <= maxMetaBytes else {
            throw Zft2Error(code: "metadata_too_large", message: "ZFT2 metadata exceeds limit")
        }
        guard payloadBytes.count <= maxPayloadBytes else {
            throw Zft2Error(code: "payload_too_large", message: "ZFT2 payload exceeds limit")
        }

        var out = Data(capacity: Zft2Contract.headerBytes + metaBytes.count + payloadBytes.count)
        out.append(contentsOf: Zft2Contract.magic)
        out.append(Zft2Contract.version)
        out.append(UInt8(op & 0xFF))
        appendU16(&out, flags & 0xFFFF)
        appendU32(&out, requestId)
        appendU32(&out, Int64(metaBytes.count))
        appendU32(&out, Int64(payloadBytes.count))
        out.append(metaBytes)
        out.append(payloadBytes)
        return out
    }

    /// Decode one frame.
    ///
    /// Check order is load-bearing and matches the Kotlin implementation exactly:
    /// a truncated header is reported before magic, and the length limits before
    /// the total-length comparison. A reordered check would classify a hostile
    /// length bomb as a mere length mismatch and lose the reason the frame was
    /// refused -- the `metadata-length-bomb` fixture declares 0xFFFFFFFF bytes of
    /// metadata in a 20-byte frame, which is both a limit violation and a length
    /// mismatch, and it must report the former.
    public static func decode(
        _ raw: Data,
        maxMetaBytes: Int = Zft2Contract.maxMetaBytes,
        maxPayloadBytes: Int = Zft2Contract.maxPayloadBytes
    ) throws -> Zft2Frame {
        guard raw.count >= Zft2Contract.headerBytes else {
            throw Zft2Error(code: "truncated_header", message: "Truncated ZFT2 header")
        }
        let base = raw.startIndex
        for index in 0..<4 where raw[base + index] != Zft2Contract.magic[index] {
            throw Zft2Error(code: "bad_magic", message: "Invalid ZFT2 magic")
        }
        let version = raw[base + 4]
        guard version == Zft2Contract.version else {
            throw Zft2Error(code: "unsupported_version", message: "Unsupported ZFT2 version \(version)")
        }

        let metaLength = readU32(raw, 12)
        let payloadLength = readU32(raw, 16)
        guard metaLength <= Int64(maxMetaBytes) else {
            throw Zft2Error(code: "metadata_too_large", message: "ZFT2 metadata exceeds limit")
        }
        guard payloadLength <= Int64(maxPayloadBytes) else {
            throw Zft2Error(code: "payload_too_large", message: "ZFT2 payload exceeds limit")
        }

        let expected = Int64(Zft2Contract.headerBytes) + metaLength + payloadLength
        guard Int64(raw.count) == expected else {
            throw Zft2Error(code: "length_mismatch", message: "ZFT2 frame length mismatch")
        }

        let metaStart = base + Zft2Contract.headerBytes
        let metaEnd = metaStart + Int(metaLength)
        let meta: Zft2Meta
        if metaLength == 0 {
            meta = Zft2Meta()
        } else {
            do {
                meta = try Zft2Meta.decode(raw[metaStart..<metaEnd])
            } catch let error as Zft2Error {
                /* Re-thrown as bad_metadata regardless of the scanner's own
                 * reason: the wire contract names one code for "metadata is not
                 * usable", and the peer branches on that code. */
                throw Zft2Error(code: "bad_metadata", message: error.message)
            }
        }

        return Zft2Frame(
            op: Int(raw[base + 5]),
            requestId: readU32(raw, 8),
            flags: readU16(raw, 6),
            meta: meta,
            payload: Data(raw[metaEnd..<raw.endIndex])
        )
    }

    /// Response to a request, reusing its op and id so the peer can correlate.
    public static func encodeResponse(
        _ request: Zft2Frame,
        meta: Zft2Meta? = nil,
        payload: Data? = nil
    ) throws -> Data {
        try encode(
            op: request.op,
            requestId: request.requestId,
            flags: Int(Zft2Contract.flagResponse),
            meta: meta,
            payload: payload
        )
    }

    /// Error response. Carries only a code and message: never a path or a secret.
    public static func encodeError(_ request: Zft2Frame, code: String, message: String) throws -> Data {
        try encode(
            op: request.op,
            requestId: request.requestId,
            flags: Int(Zft2Contract.flagResponse) | Int(Zft2Contract.flagError),
            meta: Zft2Meta([("code", .string(code)), ("message", .string(message))])
        )
    }

    /// Clamp to the frozen 1..16 window; a nil value falls back to the default of 8.
    public static func clampInflight(_ value: Int?) -> Int {
        guard let value else { return Zft2Contract.maxInflightDefault }
        return min(Zft2Contract.maxInflightMax, max(Zft2Contract.maxInflightMin, value))
    }

    /// Negotiated chunk size is the smaller capability, never above the ceiling.
    public static func negotiateChunk(_ localMax: Int?, _ remoteMax: Int?) -> Int {
        let local = localMax ?? Zft2Contract.maxPayloadBytes
        let remote = remoteMax ?? Zft2Contract.maxPayloadBytes
        return max(1, min(Zft2Contract.maxPayloadBytes, local, remote))
    }

    // MARK: - unsigned big-endian helpers

    private static func appendU16(_ out: inout Data, _ value: Int) {
        out.append(UInt8((value >> 8) & 0xFF))
        out.append(UInt8(value & 0xFF))
    }

    private static func appendU32(_ out: inout Data, _ value: Int64) {
        out.append(UInt8((value >> 24) & 0xFF))
        out.append(UInt8((value >> 16) & 0xFF))
        out.append(UInt8((value >> 8) & 0xFF))
        out.append(UInt8(value & 0xFF))
    }

    public static func readU16(_ raw: Data, _ offset: Int) -> Int {
        let base = raw.startIndex + offset
        return Int(raw[base]) << 8 | Int(raw[base + 1])
    }

    /// Returns `Int64` so 0xFFFFFFFF stays positive.
    public static func readU32(_ raw: Data, _ offset: Int) -> Int64 {
        let base = raw.startIndex + offset
        return Int64(raw[base]) << 24
            | Int64(raw[base + 1]) << 16
            | Int64(raw[base + 2]) << 8
            | Int64(raw[base + 3])
    }
}
