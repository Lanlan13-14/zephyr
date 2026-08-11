import Foundation
import XCTest
@testable import ZephyrCore

final class WakeStreamClientTests: XCTestCase {
    func testParserAcceptsOnlyExactBoundedWakeFrames() throws {
        var parser = WakeSSEParser()

        XCTAssertNil(parser.accept("retry: 7000"))
        XCTAssertNil(parser.accept(": heartbeat"))
        XCTAssertNil(parser.accept("id: epoch-1:8"))
        XCTAssertNil(parser.accept("event: wake"))
        XCTAssertNil(parser.accept("data: {\"cursor\":8,\"epoch\":\"epoch-1\",\"reason\":\"change\"}"))
        let event = try XCTUnwrap(parser.accept(""))

        XCTAssertEqual(7_000, parser.retryMilliseconds)
        XCTAssertEqual(8, event.cursor)
        XCTAssertEqual("epoch-1:8", event.eventID)
        XCTAssertEqual(.change, event.reason)

        XCTAssertNil(parser.accept("id: epoch-1:9"))
        XCTAssertNil(parser.accept("event: wake"))
        XCTAssertNil(parser.accept("data: {\"cursor\":9,\"epoch\":\"epoch-1\",\"reason\":\"change\",\"owner\":\"x\"}"))
        XCTAssertNil(parser.accept(""), "extra payload fields must be rejected")
    }

    func testParserRejectsMismatchedIDsInvalidReasonsAndOversizedData() {
        var parser = WakeSSEParser()
        for line in [
            "id: epoch:2",
            "event: wake",
            "data: {\"cursor\":1,\"epoch\":\"epoch\",\"reason\":\"change\"}",
        ] {
            XCTAssertNil(parser.accept(line))
        }
        XCTAssertNil(parser.accept(""))

        for line in [
            "id: epoch:2",
            "event: wake",
            "data: {\"cursor\":2,\"epoch\":\"epoch\",\"reason\":\"unknown\"}",
        ] {
            XCTAssertNil(parser.accept(line))
        }
        XCTAssertNil(parser.accept(""))

        var bounded = WakeSSEParser(maximumDataBytes: 8)
        XCTAssertNil(bounded.accept("id: epoch:2"))
        XCTAssertNil(bounded.accept("event: wake"))
        XCTAssertNil(bounded.accept("data: 123456789"))
        XCTAssertNil(bounded.accept(""))
    }

    func testLineDecoderBoundsBytesAndHandlesCRLF() throws {
        var decoder = WakeSSELineDecoder(maximumBytes: 4)
        for byte in Array("abc\r".utf8) {
            XCTAssertNil(try decoder.append(byte))
        }
        XCTAssertEqual("abc", try decoder.append(0x0a))

        for byte in Array("1234".utf8) {
            XCTAssertNil(try decoder.append(byte))
        }
        XCTAssertThrowsError(try decoder.append(0x35)) { error in
            XCTAssertEqual(error as? WakeSSEParseError, .lineTooLong)
        }
    }

    func testReconnectPolicyPrefersRetryAfterThenServerRetryAndBoundsJitter() {
        XCTAssertEqual(
            11_000,
            WakeReconnectPolicy.delayMilliseconds(
                outcome: WakeStreamOutcome(
                    retryAfterMilliseconds: 11_000,
                    serverRetryMilliseconds: 7_000
                ),
                consecutiveFailures: 6,
                jitter: 0.5
            )
        )
        XCTAssertEqual(
            7_000,
            WakeReconnectPolicy.delayMilliseconds(
                outcome: WakeStreamOutcome(serverRetryMilliseconds: 7_000),
                consecutiveFailures: 6,
                jitter: 1.5
            )
        )
        XCTAssertEqual(
            1_500,
            WakeReconnectPolicy.delayMilliseconds(
                outcome: WakeStreamOutcome(),
                consecutiveFailures: 0,
                jitter: 99
            )
        )
        XCTAssertEqual(
            WakeReconnectPolicy.maximumDelayMilliseconds,
            WakeReconnectPolicy.delayMilliseconds(
                outcome: WakeStreamOutcome(retryAfterMilliseconds: Int64.max),
                consecutiveFailures: 0,
                jitter: 1
            )
        )
    }
}
