import Foundation
import XCTest
@testable import ZephyrCore

final class AppleLinkChannelTests: XCTestCase {
    func testNativeArchiveActuallyRunsAndHasCurrentBuildIdentity() async throws {
        let info = try AppleLinkNativeRuntime.buildInfo()
        XCTAssertEqual(info["goVersion"], .string("go1.26.10"))
        XCTAssertEqual(info["vcs.modified"], .string("false"))
        if let revision = ProcessInfo.processInfo.environment["GITHUB_SHA"] {
            XCTAssertEqual(info["vcs.revision"], .string(revision))
        }
        let native = try AppleLinkNativeRuntime()
        do {
            _ = try await native.call(path: "/mlkem/generate", body: [:])
            XCTFail("initiator ABI exposed a server/key generation route")
        } catch let error as LinkChannelError {
            XCTAssertEqual(error.code, "operation_not_allowed")
        }
        await native.close()
        do {
            _ = try await native.call(path: "/link/push", body: [:])
            XCTFail("closed native runtime accepted a call")
        } catch { }
    }

    func testFirstOperationSignsAndFinishesBeforeSendingSyncFrame() async throws {
        let native = AppleChannelProbe()
        let channel = try AppleLinkChannel(serverURL: "https://example.invalid/base/", deviceID: "device-1", pins: ["pin"], native: native) { transcript in
            XCTAssertEqual(transcript, Data(repeating: 7, count: 32))
            return "proof"
        }
        XCTAssertFalse(channel.isEstablished)
        let reply = try await channel.syncOp(op: "changes", body: ["op": .string("changes")])
        XCTAssertEqual(reply["ok"], .boolean(true))
        XCTAssertTrue(channel.isEstablished)
        let paths = await native.paths
        XCTAssertEqual(paths, ["/link/dial", "/link/dial/finish", "/link/push"])
        let hello = await native.hello
        XCTAssertEqual(hello?["serverUrl"], .string("https://example.invalid/base/api/link/v2"))
        XCTAssertEqual(hello?["insecure"], .boolean(false))
        await channel.close()
    }

    func testActorReentrancyCannotRaceTwoHandshakesOrFrameSequences() async throws {
        let native = AppleChannelProbe()
        let channel = try AppleLinkChannel(serverURL: "https://example.invalid/", deviceID: "device-1", pins: [], native: native) { _ in "proof" }
        async let first = channel.syncOp(op: "changes", body: ["op": .string("changes")])
        async let second = channel.syncOp(op: "ack", body: ["op": .string("ack")])
        _ = try await (first, second)
        let paths = await native.paths
        let maximum = await native.maximumInFlight
        XCTAssertEqual(paths.filter { $0 == "/link/dial" }.count, 1)
        XCTAssertEqual(paths.filter { $0 == "/link/push" }.count, 2)
        XCTAssertEqual(maximum, 1)
        await channel.close()
    }

    func testNoProofServerAndMismatchedOperationFailClosed() async throws {
        let native = AppleChannelProbe(requireProof: false)
        let channel = try AppleLinkChannel(serverURL: "https://example.invalid/", deviceID: "device-1", pins: [], native: native) { _ in XCTFail("unproven server requested signature"); return "proof" }
        do { _ = try await channel.syncOp(op: "changes", body: ["op": .string("changes")]); XCTFail("accepted unproven hello") }
        catch let error as LinkChannelError { XCTAssertEqual(error.code, "proof_required") }
        let paths = await native.paths
        XCTAssertFalse(paths.contains("/link/push"))
        await channel.close()
        do { _ = try await channel.syncOp(op: "changes", body: ["op": .string("changes")]); XCTFail("closed channel sent") } catch { }
    }

    func testAmbiguousPushDoesNotReplayAndNextRoundRedials() async throws {
        let native = AppleChannelProbe(failFirstPush: true)
        let channel = try AppleLinkChannel(serverURL: "https://example.invalid/", deviceID: "device-1", pins: [], native: native) { _ in "proof" }
        do { _ = try await channel.syncOp(op: "push", body: ["op": .string("push")]); XCTFail("missing failure") } catch { }
        XCTAssertFalse(channel.isEstablished)
        var paths = await native.paths
        XCTAssertEqual(paths.filter { $0 == "/link/push" }.count, 1)
        _ = try await channel.syncOp(op: "push", body: ["op": .string("push")])
        paths = await native.paths
        XCTAssertEqual(paths.filter { $0 == "/link/dial" }.count, 2)
        XCTAssertEqual(paths.filter { $0 == "/link/push" }.count, 2)
        await channel.close()
    }
}

private actor AppleChannelProbe: AppleLinkCalling {
    var paths = [String]()
    var hello: [String: MobileJSONValue]?
    var maximumInFlight = 0
    private var inFlight = 0
    private let requireProof: Bool
    private var failFirstPush: Bool
    init(requireProof: Bool = true, failFirstPush: Bool = false) {
        self.requireProof = requireProof; self.failFirstPush = failFirstPush
    }
    func call(path: String, body: [String: MobileJSONValue]) async throws -> [String: MobileJSONValue] {
        paths.append(path)
        inFlight += 1
        maximumInFlight = max(maximumInFlight, inFlight)
        defer { inFlight -= 1 }
        await Task.yield()
        if path == "/link/dial" {
            hello = body
            return ["ok": .boolean(true), "pending": .boolean(requireProof), "sessionId": .string("session"),
                    "transcript": .string(Data(repeating: 7, count: 32).base64EncodedString())]
        }
        if path == "/link/dial/finish" {
            XCTAssertEqual(body["proof"], .string("proof"))
            return ["ok": .boolean(true), "sessionId": .string("session")]
        }
        if failFirstPush { failFirstPush = false; throw LinkChannelError(message: "ambiguous failure") }
        return ["ok": .boolean(true), "ackKind": .integer(2), "ack": .object(["ok": .boolean(true)])]
    }
    func close() async { paths.append("close") }
}
