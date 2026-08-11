import Foundation
import XCTest
@testable import ZephyrCore

final class KeychainResourceLeaseTests: XCTestCase {
    func testEnvelopeBindsResourceCompleteGenerationAndExactComparisonToken() throws {
        let scope = resourceScope(resource: "device-signing-es256")
        let envelope = try KeychainResourceLeaseEnvelope(
            state: .active,
            scope: scope,
            resourceVersion: Data(repeating: 0x11, count: 32),
            payload: Data("non-secret-locator".utf8)
        )
        let item = try KeychainResourceLeaseCodec.makeItem(for: envelope)

        XCTAssertEqual(
            try KeychainResourceLeaseCodec.decode(item, expectedScope: scope).envelope,
            envelope
        )
        XCTAssertThrowsError(
            try KeychainResourceLeaseCodec.decode(
                item,
                expectedScope: resourceScope(resource: "device-encryption-mlkem768")
            )
        ) { error in
            XCTAssertEqual(error as? KeychainResourceLeaseError, .corruptRecord)
        }
        XCTAssertThrowsError(
            try KeychainResourceLeaseCodec.decode(
                item,
                expectedScope: resourceScope(
                    resource: "device-signing-es256",
                    generation: "replacement-generation"
                )
            )
        ) { error in
            XCTAssertEqual(error as? KeychainResourceLeaseError, .corruptRecord)
        }

        let tampered = KeychainResourceLeaseItem(
            data: item.data,
            comparisonToken: Data(repeating: 0xff, count: item.comparisonToken.count)
        )
        XCTAssertThrowsError(
            try KeychainResourceLeaseCodec.decode(tampered, expectedScope: scope)
        ) { error in
            XCTAssertEqual(error as? KeychainResourceLeaseError, .corruptRecord)
        }
    }

    func testTerminationRetainsExactRandomVersionAndErasesPayload() throws {
        let version = Data(repeating: 0x22, count: 32)
        let active = try KeychainResourceLeaseEnvelope(
            state: .active,
            scope: resourceScope(resource: "device-encryption-mlkem768"),
            resourceVersion: version,
            payload: Data("private-key-locator".utf8)
        )

        let tombstone = try active.terminated()
        let item = try KeychainResourceLeaseCodec.makeItem(for: tombstone)

        XCTAssertEqual(tombstone.state, .terminated)
        XCTAssertEqual(tombstone.resourceVersion, version)
        XCTAssertNil(tombstone.payload)
        XCTAssertNil(item.data.range(of: Data("private-key-locator".utf8)))
    }

    private func resourceScope(
        resource: String,
        generation: String = "generation-1"
    ) -> KeychainResourceLeaseScope {
        KeychainResourceLeaseScope(
            resource: resource,
            identity: SyncBindingIdentity(
                serverID: "server-1",
                accountID: "account-1",
                deviceID: "device-1",
                generation: generation
            )
        )
    }
}
