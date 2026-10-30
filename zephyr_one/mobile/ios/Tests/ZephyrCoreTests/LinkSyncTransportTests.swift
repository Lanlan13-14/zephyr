import Foundation
import XCTest
@testable import ZephyrCore
import ZephyrContracts

/// Pins the Link transport's wire behaviour: every sync verb must encode the SAME DTO shape the
/// HTTP path would send (with the documented `sinceCursor` / `pageSize` ZSL field names), route it
/// under the right `op` discriminator, and map a sealed `{ok:false}` onto `MobileApiError` while
/// preserving the business code.
final class LinkSyncTransportTests: XCTestCase {
    func testBootstrapRidesLinkAndNeverCallsHTTPFallback() async throws {
        let channel = FakeLinkChannel(established: false)
        channel.ackResponder = { _, _ in
            [
                "ok": .boolean(true),
                "bootstrapId": .string("bs-link"),
                "snapshotCursor": .integer(0),
                "complete": .boolean(true),
                "entities": .array([]),
            ]
        }
        let fallback = RecordingFallback()
        let transport = LinkSyncTransport(channel: channel, deviceId: "dev-1", httpFallback: fallback)

        let page = try await transport.bootstrap(pageToken: nil, limit: 25)

        XCTAssertEqual(page.bootstrapId, "bs-link")
        XCTAssertEqual(page.complete, true)
        let call = try XCTUnwrap(channel.calls().single)
        XCTAssertEqual(call.op, "bootstrap")
        XCTAssertEqual(try XCTUnwrap(jsonString(call.body["op"])), "bootstrap")
        XCTAssertEqual(try XCTUnwrap(int64(call.body["pageSize"])), 25)
        XCTAssertNil(call.body["pageToken"])
        XCTAssertNil(call.body["limit"])
        XCTAssertEqual(fallback.recordedCalls(), [])
    }

    func testChangesEncodesSinceCursorUnderTheChangesOp() async throws {
        let channel = FakeLinkChannel()
        channel.ackResponder = { _, _ in
            [
                "ok": .boolean(true),
                "fromCursor": .integer(5),
                "nextCursor": .integer(5),
                "hasMore": .boolean(false),
                "changes": .array([]),
            ]
        }
        let fallback = RecordingFallback()
        let transport = LinkSyncTransport(channel: channel, deviceId: "dev-1", httpFallback: fallback)

        let page = try await transport.changes(cursor: 5, limit: 50)

        XCTAssertEqual(page.nextCursor, 5)
        XCTAssertEqual(page.fromCursor, 5)
        XCTAssertEqual(page.hasMore, false)
        let call = try XCTUnwrap(channel.calls().single)
        XCTAssertEqual(call.op, "changes")
        XCTAssertEqual(jsonString(call.body["op"]), "changes")
        XCTAssertEqual(int64(call.body["sinceCursor"]), 5)
        XCTAssertEqual(int64(call.body["limit"]), 50)
        // ZSL body must use the Android/server name. iOS HTTPS GET uses `cursor`; the Go/Node
        // bridge reads `sinceCursor`. Sending `cursor` here would break executeChangesForDevice.
        XCTAssertNil(call.body["cursor"])
        XCTAssertEqual(fallback.recordedCalls(), [])
    }

    func testPushCarriesStandardPushRequestFieldsUnderThePushOp() async throws {
        let channel = FakeLinkChannel()
        channel.ackResponder = { _, _ in
            [
                "ok": .boolean(true),
                "batchId": .string("batch-1"),
                "serverCursor": .integer(11),
                "changesAvailable": .boolean(false),
                "results": .array([]),
            ]
        }
        let fallback = RecordingFallback()
        let transport = LinkSyncTransport(channel: channel, deviceId: "dev-1", httpFallback: fallback)
        let request = MobilePushRequest(
            protocolVersion: MobileApiPaths.protocolVersion,
            deviceId: "ignored-device",
            batchId: "batch-1",
            baseCursor: 7,
            registryHash: "hash-1",
            operations: []
        )

        let response = try await transport.push(request)

        XCTAssertEqual(response.batchId, "batch-1")
        XCTAssertEqual(response.serverCursor, 11)
        let call = try XCTUnwrap(channel.calls().single)
        XCTAssertEqual(call.op, "push")
        XCTAssertEqual(try XCTUnwrap(jsonString(call.body["op"])), "push")
        XCTAssertEqual(try XCTUnwrap(jsonString(call.body["batchId"])), "batch-1")
        XCTAssertEqual(try XCTUnwrap(jsonString(call.body["registryHash"])), "hash-1")
        XCTAssertEqual(try XCTUnwrap(jsonString(call.body["deviceId"])), "dev-1")
        XCTAssertEqual(
            try XCTUnwrap(int64(call.body["protocolVersion"])),
            Int64(MobileApiPaths.protocolVersion)
        )
        XCTAssertEqual(try XCTUnwrap(int64(call.body["baseCursor"])), 7)
        guard case .array(let operations)? = call.body["operations"] else {
            return XCTFail("push body must include operations")
        }
        XCTAssertTrue(operations.isEmpty)
        XCTAssertEqual(fallback.recordedCalls(), [])
    }

    func testSealedCursorErrorKeepsItsCodeForBootstrapRecovery() async throws {
        let channel = FakeLinkChannel()
        channel.ackResponder = { _, _ in
            [
                "ok": .boolean(false),
                "error": .object([
                    "code": .string("cursor_expired"),
                    "message": .string("bootstrap required"),
                    "retryable": .boolean(false),
                    "details": .object(["bootstrapRequired": .boolean(true)]),
                ]),
            ]
        }
        let transport = LinkSyncTransport(
            channel: channel,
            deviceId: "dev-1",
            httpFallback: RecordingFallback()
        )

        do {
            _ = try await transport.changes(cursor: 4, limit: 50)
            XCTFail("Expected cursor_expired to throw")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "cursor_expired")
            XCTAssertEqual(error.retryable, false)
            XCTAssertEqual(error.details["bootstrapRequired"], "true")
            XCTAssertTrue(error.requiresBootstrapRestart)
        }
    }

    func testCapabilitiesDelegatesToHTTPFallback() async throws {
        let channel = FakeLinkChannel()
        let fallback = RecordingFallback()
        let transport = LinkSyncTransport(channel: channel, deviceId: "dev-1", httpFallback: fallback)

        do {
            _ = try await transport.capabilities()
            XCTFail("RecordingFallback.capabilities always throws")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "fallback_capabilities")
        }
        XCTAssertEqual(channel.calls().count, 0)
        XCTAssertEqual(fallback.recordedCalls(), ["capabilities"])
    }

    func testUnestablishedChannelStillInvokesSyncOp() async throws {
        let channel = FakeLinkChannel(established: false)
        channel.ackResponder = { _, _ in
            [
                "ok": .boolean(true),
                "fromCursor": .integer(0),
                "nextCursor": .integer(0),
                "hasMore": .boolean(false),
                "changes": .array([]),
            ]
        }
        let transport = LinkSyncTransport(
            channel: channel,
            deviceId: "dev-1",
            httpFallback: RecordingFallback()
        )

        _ = try await transport.changes(cursor: 0, limit: 50)
        XCTAssertEqual(channel.calls().count, 1)
        XCTAssertEqual(channel.calls()[0].op, "changes")
    }

    func testChannelExceptionSurfacesAsRetryableLinkFailure() async throws {
        let channel = FakeLinkChannel()
        channel.throwOnCall = LinkChannelError(message: "seal failed")
        let transport = LinkSyncTransport(
            channel: channel,
            deviceId: "dev-1",
            httpFallback: RecordingFallback()
        )

        do {
            _ = try await transport.ack(MobileAckRequest(cursor: 3))
            XCTFail("Expected a mapped MobileApiError")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "link_unavailable")
            XCTAssertTrue(error.retryable)
        }
    }

    func testUnestablishedChannelThatFailsToDialIsRetryable() async throws {
        let channel = FakeLinkChannel(established: false)
        channel.throwOnCall = LinkChannelError(message: "Link session is not established")
        let transport = LinkSyncTransport(
            channel: channel,
            deviceId: "dev-1",
            httpFallback: RecordingFallback()
        )

        do {
            _ = try await transport.changes(cursor: 0, limit: 50)
            XCTFail("Expected a mapped MobileApiError")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "link_unavailable")
            XCTAssertTrue(error.retryable)
        }
    }

    func testMalformedBootstrapAckIsAFailure() async throws {
        let channel = FakeLinkChannel()
        channel.ackResponder = { _, _ in
            [
                "ok": .boolean(true),
                "bootstrapId": .null,
            ]
        }
        let transport = LinkSyncTransport(
            channel: channel,
            deviceId: "dev-1",
            httpFallback: RecordingFallback()
        )

        do {
            _ = try await transport.bootstrap(pageToken: nil, limit: 25)
            XCTFail("Expected an unparseable ack to throw")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "link_unavailable")
            XCTAssertFalse(error.retryable)
        }
    }

    func testAckCarriesItsOpDiscriminatorAndHTTPSFields() async throws {
        let channel = FakeLinkChannel()
        channel.ackResponder = { _, _ in ["ok": .boolean(true)] }
        let transport = LinkSyncTransport(
            channel: channel,
            deviceId: "dev-1",
            httpFallback: RecordingFallback()
        )

        let response = try await transport.ack(MobileAckRequest(cursor: 3))
        XCTAssertEqual(response.ok, true)
        let call = try XCTUnwrap(channel.calls().single)
        XCTAssertEqual(call.op, "ack")
        XCTAssertEqual(try XCTUnwrap(jsonString(call.body["op"])), "ack")
        XCTAssertEqual(try XCTUnwrap(int64(call.body["cursor"])), 3)
        // iOS HTTPS ack body is `{cursor}` only. Do not invent Android's appliedOpIds/deviceId.
        XCTAssertNil(call.body["appliedOpIds"])
        XCTAssertNil(call.body["deviceId"])
    }
}

/// Records the op + body it was handed and replies with a canned ack.
private final class FakeLinkChannel: LinkChannel, @unchecked Sendable {
    struct Call: Equatable {
        let op: String
        let body: [String: MobileJSONValue]
    }

    private let lock = NSLock()
    private let establishedFlag: Bool
    private var recorded: [Call] = []
    var ackResponder: @Sendable (String, [String: MobileJSONValue]) -> [String: MobileJSONValue] = { _, _ in [:] }
    var throwOnCall: LinkChannelError?

    init(established: Bool = true) {
        self.establishedFlag = established
    }

    var isEstablished: Bool { establishedFlag }

    func syncOp(op: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue] {
        if let throwOnCall { throw throwOnCall }
        lock.lock()
        recorded.append(Call(op: op, body: body))
        lock.unlock()
        return ackResponder(op, body)
    }

    func calls() -> [Call] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}

/// The HTTP fallback is never exercised by the owned-sync verbs; it exists so capabilities delegate.
private final class RecordingFallback: SyncTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []

    func recordedCalls() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return names
    }

    func capabilities() async throws -> MobileCapabilitiesResponse {
        record("capabilities")
        throw MobileApiError.local(code: "fallback_capabilities", message: "capabilities stay on HTTPS")
    }

    func bootstrap(pageToken: String?, limit: Int?) async throws -> MobileBootstrapResponse {
        record("bootstrap")
        throw bomb("bootstrap")
    }

    func changes(cursor: Int64, limit: Int?) async throws -> MobileChangesResponse {
        record("changes")
        throw bomb("changes")
    }

    func push(_ request: MobilePushRequest) async throws -> MobilePushResponse {
        record("push")
        throw bomb("push")
    }

    func ack(_ request: MobileAckRequest) async throws -> MobileAckResponse {
        record("ack")
        throw bomb("ack")
    }

    private func record(_ name: String) {
        lock.lock()
        names.append(name)
        lock.unlock()
    }

    private func bomb(_ name: String) -> MobileApiError {
        MobileApiError.local(
            code: "fallback_must_not_be_called",
            message: "HTTP fallback \(name) must not be called"
        )
    }
}

private extension Array {
    var single: Element? { count == 1 ? first : nil }
}

private func int64(_ value: MobileJSONValue?) -> Int64? {
    switch value {
    case .integer(let number)?: return number
    case .number(let number)?: return Int64(number)
    default: return nil
    }
}

private func jsonString(_ value: MobileJSONValue?) -> String? {
    if case .string(let text) = value { return text }
    return nil
}
