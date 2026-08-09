import XCTest
import ZephyrContracts
@testable import ZephyrCore

/// The Swift ZFT2 codec against the same frames Kotlin, JS and Dart are held to.
///
/// `contracts/generated/zft2-frames.json` pins exact hex for five frames and a
/// stable rejection code for five malformed ones. Encoding to those bytes is not
/// a nicety: `metaLen` and `payloadLen` live in the header, so an implementation
/// that serialises metadata differently makes the peer split the frame at the
/// wrong offset and the session desynchronises rather than erroring cleanly.
final class Zft2CodecTests: XCTestCase {

    func testEveryFrameDecodesFromAndReEncodesToTheFrozenBytes() throws {
        /* Driven from the frozen bytes in both directions.
         *
         * Decoding the fixture hex and re-encoding it is a stronger formulation
         * than building metadata from the fixture's parsed JSON object would be,
         * and it avoids a trap: metadata key order is part of the encoded bytes,
         * but `JSONSerialization` returns an unordered dictionary, so any test
         * that rebuilt the metadata from a parsed object would either impose its
         * own order or scrape the fixture's text. Round-tripping the real bytes
         * sidesteps that entirely -- and a decoder that lost key order would fail
         * the re-encode, which is exactly the defect worth catching.
         */
        let fixture = try Fixtures.json("zft2-frames.json")
        let frames = try XCTUnwrap(fixture["frames"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(frames.count, 5, "the full frame set must be exercised")

        for entry in frames {
            let name = try XCTUnwrap(entry["name"] as? String)
            let type = try XCTUnwrap((entry["type"] as? NSNumber)?.intValue)
            let requestId = try XCTUnwrap((entry["requestId"] as? NSNumber)?.int64Value)
            let flags = try XCTUnwrap((entry["flags"] as? NSNumber)?.intValue)
            let expectedHex = try XCTUnwrap(entry["expectedHex"] as? String)
            let expectedLength = try XCTUnwrap((entry["expectedLength"] as? NSNumber)?.intValue)
            let raw = try Fixtures.hex(expectedHex)

            XCTAssertEqual(raw.count, expectedLength, "\(name): fixture length disagrees with its own hex")

            let decoded = try Zft2Codec.decode(raw)
            XCTAssertEqual(decoded.op, type, "\(name): op")
            XCTAssertEqual(decoded.requestId, requestId, "\(name): requestId")
            XCTAssertEqual(decoded.flags, flags, "\(name): flags")

            let expectedPayload = (entry["payloadUtf8"] as? String).map { Data($0.utf8) } ?? Data()
            XCTAssertEqual(decoded.payload, expectedPayload, "\(name): payload")

            // Metadata keys and values must match the fixture's declared object,
            // compared as a set of pairs so this check does not depend on order.
            let rawMeta = try XCTUnwrap(entry["meta"] as? [String: Any])
            XCTAssertEqual(decoded.meta.pairs.count, rawMeta.count, "\(name): metadata key count")
            for (key, value) in rawMeta {
                switch value {
                case let text as String:
                    XCTAssertEqual(decoded.meta[key], .string(text), "\(name): meta[\(key)]")
                case let number as NSNumber:
                    XCTAssertEqual(decoded.meta[key], .int(number.int64Value), "\(name): meta[\(key)]")
                default:
                    XCTFail("\(name): unsupported metadata value for \(key)")
                }
            }

            // The re-encode is where key order is actually proven.
            let reencoded = try Zft2Codec.encode(
                op: decoded.op,
                requestId: decoded.requestId,
                flags: decoded.flags,
                meta: decoded.meta.isEmpty ? nil : decoded.meta,
                payload: decoded.payload.isEmpty ? nil : decoded.payload
            )
            XCTAssertEqual(
                Fixtures.hexString(reencoded),
                expectedHex,
                "\(name): re-encoding the decoded frame must reproduce the frozen bytes"
            )
        }
    }

    func testMaximumRequestIdSurvivesTheRoundTrip() throws {
        /* 0xFFFFFFFF is a legal unsigned id that is -1 as a signed 32-bit value.
         * The `unicode-metadata` fixture uses it deliberately; this asserts the
         * property directly so the reason is not buried in a data file. */
        let encoded = try Zft2Codec.encode(op: 12, requestId: 0xFFFF_FFFF)
        let decoded = try Zft2Codec.decode(encoded)
        XCTAssertEqual(decoded.requestId, 4_294_967_295)

        XCTAssertThrowsError(try Zft2Codec.encode(op: 12, requestId: 0x1_0000_0000)) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "invalid_request_id")
        }
        XCTAssertThrowsError(try Zft2Codec.encode(op: 12, requestId: -1)) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "invalid_request_id")
        }
    }

    func testNonAsciiMetadataIsRawUtf8NotEscaped() throws {
        /* The `unicode-metadata` fixture exists for this. Escaped as \uXXXX the
         * same path would be far longer, so metaLen would disagree with every
         * other implementation and the peer would read into the payload. */
        var built = Zft2Meta()
        built.set("path", .string("/\u{4e2d}\u{6587}/\u{30c6}\u{30b9}\u{30c8}"))
        let encoded = try Zft2Codec.encode(op: 6, requestId: 0xFFFF_FFFF, meta: built)
        XCTAssertEqual(
            Fixtures.hexString(encoded),
            "5a46543202060000ffffffff0000001c000000007b2270617468223a222fe4b8ade696872fe38386e382b9e38388227d"
        )
        XCTAssertEqual(Zft2Codec.readU32(encoded, 12), 28, "raw UTF-8 metadata is 28 bytes")
        XCTAssertFalse(
            String(decoding: encoded, as: UTF8.self).contains("\\u"),
            "non-ASCII must not be escaped"
        )
    }

    func testForwardSlashesAreNotEscaped() throws {
        /* JSONSerialization escapes `/` as `\/` in some configurations. ZFT2
         * metadata is mostly POSIX paths, so that alone would change the length
         * of nearly every frame. */
        var built = Zft2Meta()
        built.set("path", .string("/data/report.txt"))
        let json = String(decoding: built.encodedJson(), as: UTF8.self)
        XCTAssertEqual(json, "{\"path\":\"/data/report.txt\"}")
        XCTAssertFalse(json.contains("\\/"))
    }

    func testEmptyMetadataStillEncodesAsAnObject() throws {
        /* metaLen 2, not 0. The ping fixture pins it: a zero-length metadata
         * field would decode to something different from what the JS peer sent,
         * which always writes an object. */
        let encoded = try Zft2Codec.encode(op: 12, requestId: 1)
        XCTAssertEqual(Fixtures.hexString(encoded), "5a465432020c00000000000100000002000000007b7d")
        XCTAssertEqual(Zft2Codec.readU32(encoded, 12), 2)
    }

    func testEveryRejectionReportsItsFrozenCode() throws {
        let fixture = try Fixtures.json("zft2-frames.json")
        let rejects = try XCTUnwrap(fixture["rejects"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(rejects.count, 5)

        for entry in rejects {
            let name = try XCTUnwrap(entry["name"] as? String)
            let hex = try XCTUnwrap(entry["hex"] as? String)
            let expectedCode = try XCTUnwrap(entry["expectedCode"] as? String)
            let raw = try Fixtures.hex(hex)

            XCTAssertThrowsError(try Zft2Codec.decode(raw), name) { error in
                XCTAssertEqual((error as? Zft2Error)?.code, expectedCode, "\(name): wrong rejection code")
            }
        }
    }

    func testCheckOrderPrefersTheSpecificReason() throws {
        /* The `metadata-length-bomb` frame is simultaneously a limit violation
         * and a length mismatch. Reporting length_mismatch would lose the reason
         * the frame was refused and would let a hostile length bomb look like a
         * truncated read. Kotlin orders these checks the same way; this pins the
         * order rather than trusting both ports drifted together. */
        let bomb = try Fixtures.hex("5a4654320206000000000001ffffffff00000000")
        XCTAssertThrowsError(try Zft2Codec.decode(bomb)) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "metadata_too_large")
        }

        // A truncated header outranks bad magic: four bytes cannot be checked.
        let truncatedWithBadMagic = try Fixtures.hex("58465432")
        XCTAssertThrowsError(try Zft2Codec.decode(truncatedWithBadMagic)) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "truncated_header")
        }
    }

    func testInflightClampMatchesTheFixture() throws {
        let fixture = try Fixtures.json("zft2-frames.json")
        let cases = try XCTUnwrap(fixture["inflight"] as? [[String: Any]])
        for entry in cases {
            let input = try XCTUnwrap((entry["input"] as? NSNumber)?.intValue)
            let expected = try XCTUnwrap((entry["expected"] as? NSNumber)?.intValue)
            XCTAssertEqual(Zft2Codec.clampInflight(input), expected, "clamp(\(input))")
        }
        // A missing value takes the default rather than the minimum.
        XCTAssertEqual(Zft2Codec.clampInflight(nil), Zft2Contract.maxInflightDefault)
    }

    func testChunkNegotiationMatchesTheFixture() throws {
        let fixture = try Fixtures.json("zft2-frames.json")
        let cases = try XCTUnwrap(fixture["chunkNegotiation"] as? [[String: Any]])
        for entry in cases {
            let local = try XCTUnwrap((entry["local"] as? NSNumber)?.intValue)
            let remote = try XCTUnwrap((entry["remote"] as? NSNumber)?.intValue)
            let expected = try XCTUnwrap((entry["expected"] as? NSNumber)?.intValue)
            XCTAssertEqual(Zft2Codec.negotiateChunk(local, remote), expected, "negotiate(\(local), \(remote))")
        }
        /* Never above the protocol ceiling even when both peers claim more: the
         * ceiling is what the frame length field and the peer's buffers assume. */
        XCTAssertEqual(Zft2Codec.negotiateChunk(Int.max, Int.max), Zft2Contract.maxPayloadBytes)
        XCTAssertEqual(Zft2Codec.negotiateChunk(nil, nil), Zft2Contract.maxPayloadBytes)
    }

    func testWriteOpsMatchTheFixture() throws {
        /* A provider marked read-only rejects these at the provider layer, so a
         * missing entry here would silently permit a mutation on a read-only
         * share. */
        let fixture = try Fixtures.json("zft2-frames.json")
        let writeOps = try XCTUnwrap(fixture["writeOps"] as? [NSNumber]).map { $0.intValue }

        for op in writeOps {
            let operation = try XCTUnwrap(Zft2Op(rawValue: UInt8(op)), "op \(op) must be known")
            XCTAssertTrue(operation.isWrite, "op \(op) must count as a write")
        }
        for operation in Zft2Op.allCases where !writeOps.contains(Int(operation.rawValue)) {
            XCTAssertFalse(operation.isWrite, "\(operation) must not count as a write")
        }
    }

    func testResponseAndErrorHelpersReuseTheRequestIdentity() throws {
        /* The peer correlates on op plus id, so a response that renumbered either
         * would be an orphan the requester waits on until timeout. */
        var requestMeta = Zft2Meta()
        requestMeta.set("path", .string("/data/report.txt"))
        let request = try Zft2Codec.decode(
            try Zft2Codec.encode(op: 3, requestId: 77, meta: requestMeta)
        )

        let response = try Zft2Codec.decode(try Zft2Codec.encodeResponse(request))
        XCTAssertEqual(response.op, 3)
        XCTAssertEqual(response.requestId, 77)
        XCTAssertTrue(response.isResponse)
        XCTAssertFalse(response.isError)

        let failure = try Zft2Codec.decode(
            try Zft2Codec.encodeError(request, code: "read_only_share", message: "provider is read only")
        )
        XCTAssertEqual(failure.op, 3)
        XCTAssertEqual(failure.requestId, 77)
        XCTAssertTrue(failure.isResponse)
        XCTAssertTrue(failure.isError)
        XCTAssertEqual(failure.meta["code"], .string("read_only_share"))

        /* An error frame must not leak the path it failed on. The request carried
         * one; the error must carry only code and message. */
        XCTAssertNil(failure.meta["path"])
        XCTAssertEqual(failure.meta.pairs.count, 2)
    }

    func testMetadataRoundTripPreservesKeyOrder() throws {
        /* The property that makes Zft2Meta ordered rather than a Dictionary. A
         * decode that returned an unordered map would re-encode to different
         * bytes, so a proxy or a retry would emit a frame the peer sees as
         * different from the original. Deliberately not alphabetical, so a sorted
         * implementation fails rather than coincidentally passing. */
        var built = Zft2Meta()
        built.set("zebra", .int(1))
        built.set("alpha", .string("two"))
        built.set("middle", .bool(true))

        let encoded = built.encodedJson()
        XCTAssertEqual(
            String(decoding: encoded, as: UTF8.self),
            "{\"zebra\":1,\"alpha\":\"two\",\"middle\":true}",
            "insertion order must survive encoding, not be sorted"
        )

        let decoded = try Zft2Meta.decode(encoded)
        XCTAssertEqual(decoded.pairs.map { $0.key }, ["zebra", "alpha", "middle"])
        XCTAssertEqual(decoded.encodedJson(), encoded)
    }

    func testFloatMetadataIsRefusedRatherThanReshaped() throws {
        /* A float would re-encode with a decimal point and change metaLen. Being
         * refused is the honest outcome; silently truncating to an Int would make
         * the frame encode to bytes the sender never produced. */
        XCTAssertThrowsError(try Zft2Meta.decode(Data("{\"offset\":1.5}".utf8))) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "bad_metadata")
        }
    }

    func testDuplicateMetadataKeysAreRefused() throws {
        /* Last-wins would encode one pair while the peer's parser might keep the
         * other, so the two sides would disagree about the frame they exchanged. */
        XCTAssertThrowsError(try Zft2Meta.decode(Data("{\"a\":1,\"a\":2}".utf8))) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "bad_metadata")
        }
    }

    func testTrailingBytesAfterMetadataAreRefused() throws {
        // Two objects concatenated would otherwise decode as the first one.
        XCTAssertThrowsError(try Zft2Meta.decode(Data("{\"a\":1}{\"b\":2}".utf8))) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "bad_metadata")
        }
    }

    func testMalformedMetadataInsideAValidFrameReportsBadMetadata() throws {
        /* The header is well-formed and the lengths agree, so this is not a
         * length problem; it must report the metadata code the peer branches on. */
        let meta = Data("{not json}".utf8)
        var raw = Data()
        raw.append(contentsOf: Zft2Contract.magic)
        raw.append(Zft2Contract.version)
        raw.append(UInt8(6))
        raw.append(contentsOf: [0x00, 0x00])                        // flags
        raw.append(contentsOf: [0x00, 0x00, 0x00, 0x01])            // requestId
        raw.append(contentsOf: [0x00, 0x00, 0x00, UInt8(meta.count)])
        raw.append(contentsOf: [0x00, 0x00, 0x00, 0x00])            // payloadLen
        raw.append(meta)

        XCTAssertThrowsError(try Zft2Codec.decode(raw)) { error in
            XCTAssertEqual((error as? Zft2Error)?.code, "bad_metadata")
        }
    }

    func testDecodeToleratesASlicedBuffer() throws {
        /* Frames arrive out of a stream buffer, so `decode` is routinely handed a
         * slice whose startIndex is not zero. Indexing from 0 rather than from
         * startIndex would read the wrong bytes -- and would do so only in
         * production, where the buffer is a slice, never in a test that built its
         * own Data. */
        let frame = try Zft2Codec.encode(op: 12, requestId: 5)
        var stream = Data([0xAA, 0xBB, 0xCC])
        stream.append(frame)
        let slice = stream[stream.startIndex + 3..<stream.endIndex]

        let decoded = try Zft2Codec.decode(slice)
        XCTAssertEqual(decoded.op, 12)
        XCTAssertEqual(decoded.requestId, 5)
    }
}
