import Foundation
import XCTest
@testable import ZephyrCore

final class DeviceProofTests: XCTestCase {
    private let now: Int64 = 1_725_000_000_000

    func testBindingCanonicalizesRouteAndHashesExactBodyBytes() throws {
        let url = try XCTUnwrap(URL(string:
            "https://example.test/api/mobile/v1/sync/bootstrap?z=~&pageToken=page%20token%2F%2B%3D%3D&a=2"
        ))
        let binding = try DeviceProofRequestBinding(method: "get", url: url, body: Data())

        XCTAssertEqual(binding.method, "GET")
        XCTAssertEqual(
            binding.canonicalPath,
            "/api/mobile/v1/sync/bootstrap?a=2&pageToken=page+token%2F%2B%3D%3D&z=%7E"
        )
        XCTAssertEqual(binding.bodySha256, "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=")
        XCTAssertEqual(binding.usage, "sync.bootstrap")

        let first = try DeviceProofRequestBinding(
            method: "POST",
            url: try XCTUnwrap(URL(string: "https://example.test/api/mobile/v1/sync/push")),
            body: Data([0x7b, 0x7d])
        )
        let changed = try DeviceProofRequestBinding(
            method: "POST",
            url: try XCTUnwrap(URL(string: "https://example.test/api/mobile/v1/sync/push")),
            body: Data([0x7b, 0x20, 0x7d])
        )
        XCTAssertNotEqual(first.bodySha256, changed.bodySha256)
    }

    func testUsageCoversFinalSyncBlobAndSharedRoutes() throws {
        let cases: [(String, String, String)] = [
            ("GET", "/api/mobile/v1/sync/wake", "sync.wake"),
            ("POST", "/api/mobile/v1/blobs/uploads", "blob.upload.create"),
            ("GET", "/api/mobile/v1/blobs/uploads/upload-1", "blob.upload.status"),
            ("PUT", "/api/mobile/v1/blobs/uploads/upload-1/chunks/3", "blob.chunk.upload"),
            ("GET", "/api/mobile/v1/blobs/hash/chunks/3", "blob.chunk.download"),
            ("GET", "/api/mobile/v1/blobs/hash", "blob.download"),
            ("GET", "/api/mobile/v1/shared/connection/id-1", "shared.read"),
            ("POST", "/api/mobile/v1/shared/connection/id-1/invoke", "shared.invoke"),
            ("POST", "/api/mobile/v1/shared/connections/id-1/sessions", "shared.session.open"),
            ("POST", "/api/mobile/v1/shared/sessions/id-1/refresh", "shared.session.refresh"),
            ("DELETE", "/api/mobile/v1/shared/sessions/id-1", "shared.session.close"),
        ]
        for (method, path, expected) in cases {
            let binding = try DeviceProofRequestBinding(
                method: method,
                url: try XCTUnwrap(URL(string: "https://example.test" + path)),
                body: Data()
            )
            XCTAssertEqual(binding.usage, expected, path)
        }
    }

    func testCoordinatorRejectsMutatedBindingBeforeSigning() async throws {
        let signer = RecordingDeviceProofSigner()
        let coordinator = DeviceProofCoordinator(signer: signer, nowMilliseconds: { self.now })
        let binding = try statusBinding()
        let original = challenge(for: binding, nonce: String(repeating: "A", count: 43))
        let mutated = DeviceProofChallenge(
            nonce: original.nonce,
            timestamp: original.timestamp,
            expiresAt: original.expiresAt,
            method: original.method,
            canonicalPath: "/api/mobile/v1/sync/changes?cursor=0",
            bodySha256: original.bodySha256,
            usage: original.usage,
            algorithm: original.algorithm,
            signatureFormat: original.signatureFormat,
            proofVersion: original.proofVersion
        )

        do {
            _ = try await coordinator.authorize(binding: binding) { _ in
                DeviceProofChallengeResponse(ok: true, challenge: mutated)
            }
            XCTFail("Expected binding rejection")
        } catch let error as DeviceProofCoordinatorError {
            XCTAssertEqual(error, .invalidChallenge("canonicalPath"))
            XCTAssertFalse(error.description.contains(mutated.nonce))
        }
        XCTAssertEqual(signer.signCount, 0)
    }

    func testExpiredAndReplayedChallengesAreNeverSignedTwice() async throws {
        let signer = RecordingDeviceProofSigner()
        let coordinator = DeviceProofCoordinator(signer: signer, nowMilliseconds: { self.now })
        let binding = try statusBinding()
        let nonce = String(repeating: "B", count: 43)
        let expired = challenge(for: binding, nonce: nonce, expiresAt: now)

        do {
            _ = try await coordinator.authorize(binding: binding) { _ in
                DeviceProofChallengeResponse(ok: true, challenge: expired)
            }
            XCTFail("Expected expiry rejection")
        } catch let error as DeviceProofCoordinatorError {
            XCTAssertEqual(error, .challengeExpired)
        }
        XCTAssertEqual(signer.signCount, 0)

        let live = challenge(for: binding, nonce: nonce)
        let authorization = try await coordinator.authorize(binding: binding) { _ in
            DeviceProofChallengeResponse(ok: true, challenge: live)
        }
        XCTAssertFalse(authorization.description.contains(nonce))
        XCTAssertFalse(authorization.description.contains(authorization.proof))
        do {
            _ = try await coordinator.authorize(binding: binding) { _ in
                DeviceProofChallengeResponse(ok: true, challenge: live)
            }
            XCTFail("Expected replay rejection")
        } catch let error as DeviceProofCoordinatorError {
            XCTAssertEqual(error, .challengeReplayed)
            XCTAssertFalse(error.description.contains(nonce))
        }
        XCTAssertEqual(signer.signCount, 1)
    }

    func testKeychainSignerUsesExactV2PayloadAndP1363WireFormat() throws {
        let der = Self.derSignature()
        let key = ProofTestSigningKey(signature: der)
        let keys = ProofTestIdentityKeys(key: key)
        let scope = try DeviceIdentityScope(
            serverID: "server-1",
            accountID: "account-1",
            deviceID: "device-1",
            generation: "generation-1"
        )
        let signer = KeychainDeviceProofSigner(identityStore: DeviceIdentityStore(scope: scope, keys: keys))
        let binding = try statusBinding()
        let proofChallenge = challenge(for: binding, nonce: String(repeating: "C", count: 43))

        let proof = try signer.sign(proofChallenge)
        let raw = try XCTUnwrap(Data(base64Encoded: proof))
        XCTAssertEqual(raw.count, 64)
        XCTAssertEqual(Array(raw.prefix(32)), [0x80] + [UInt8](repeating: 0x11, count: 31))
        XCTAssertEqual(Array(raw.suffix(32)), [UInt8](repeating: 0, count: 31) + [0x01])

        let expected = [
            "zephyr-one-device-proof-v2",
            "device-1",
            "GET",
            "/api/mobile/v1/sync/status",
            "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            "sync.status",
            "1725000000",
            String(repeating: "C", count: 43),
        ].joined(separator: "\0")
        XCTAssertEqual(String(data: try XCTUnwrap(key.signedMessage), encoding: .utf8), expected)
    }

    func testMalformedDERIsRejectedWithoutIncludingSignatureBytes() throws {
        let malformed = Data([0x30, 0x06, 0x02, 0x02, 0x00, 0x01, 0x02, 0x00])
        do {
            _ = try KeychainDeviceProofSigner.p1363Signature(fromDER: malformed)
            XCTFail("Expected DER rejection")
        } catch let error as DeviceProofSigningError {
            XCTAssertEqual(error, .malformedDERSignature)
            XCTAssertEqual(error.description, "device proof signing returned an invalid signature")
            XCTAssertFalse(error.description.contains(malformed.base64EncodedString()))
        }
    }

    func testCancellationStopsBeforeSigning() async throws {
        let signer = RecordingDeviceProofSigner()
        let coordinator = DeviceProofCoordinator(signer: signer, nowMilliseconds: { self.now })
        let binding = try statusBinding()
        let started = expectation(description: "challenge request started")

        let task = Task {
            try await coordinator.authorize(binding: binding) { _ in
                started.fulfill()
                try await Task.sleep(nanoseconds: 5_000_000_000)
                return DeviceProofChallengeResponse(
                    ok: true,
                    challenge: self.challenge(for: binding, nonce: String(repeating: "D", count: 43))
                )
            }
        }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Cancellation is control flow and must not become a proof/network error.
        }
        XCTAssertEqual(signer.signCount, 0)
    }

    private func statusBinding() throws -> DeviceProofRequestBinding {
        try DeviceProofRequestBinding(
            method: "GET",
            url: XCTUnwrap(URL(string: "https://example.test/api/mobile/v1/sync/status")),
            body: Data()
        )
    }

    private func challenge(
        for binding: DeviceProofRequestBinding,
        nonce: String,
        expiresAt: Int64? = nil
    ) -> DeviceProofChallenge {
        DeviceProofChallenge(
            nonce: nonce,
            timestamp: now / 1_000,
            expiresAt: expiresAt ?? now + 30_000,
            method: binding.method,
            canonicalPath: binding.canonicalPath,
            bodySha256: binding.bodySha256,
            usage: binding.usage,
            algorithm: "ES256",
            signatureFormat: "P1363",
            proofVersion: "zephyr-one-device-proof-v2"
        )
    }

    private static func derSignature() -> Data {
        let r = [UInt8](repeating: 0x11, count: 31)
        return Data([0x30, 0x26, 0x02, 0x21, 0x00, 0x80] + r + [0x02, 0x01, 0x01])
    }
}

private final class RecordingDeviceProofSigner: DeviceProofSigning, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var signCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func sign(_ challenge: DeviceProofChallenge) throws -> String {
        lock.lock()
        count += 1
        lock.unlock()
        return Data(repeating: 0x5a, count: 64).base64EncodedString()
    }
}

private final class ProofTestSigningKey: DeviceSigningKey {
    let signature: Data
    var signedMessage: Data?

    init(signature: Data) {
        self.signature = signature
    }

    func publicKeyX963Representation() throws -> Data {
        Data([0x04] + [UInt8](repeating: 0x01, count: 64))
    }

    func signature(for message: Data) throws -> Data {
        signedMessage = message
        return signature
    }
}

private final class ProofTestIdentityKeys: DeviceIdentityKeyManaging {
    let key: ProofTestSigningKey

    init(key: ProofTestSigningKey) {
        self.key = key
    }

    func existing(tag: Data) throws -> ManagedDeviceSigningKey? {
        ManagedDeviceSigningKey(key: key, protection: .softwareKeychain)
    }

    func create(tag: Data, protection: DeviceSigningKeyProtection) throws -> ManagedDeviceSigningKey {
        ManagedDeviceSigningKey(key: key, protection: protection)
    }

    func delete(tag: Data) throws {}
}
