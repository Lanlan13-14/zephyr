import Foundation
@testable import ZephyrUI

/// Loads the frozen cross-language vectors from `mobile/contracts/generated/`.
///
/// Same #filePath walk as the ZephyrCoreTests loader, for the same reason:
/// SwiftPM resources would mean copying the JSON into Tests/, a second source
/// of truth for bytes four languages must agree on.
enum UiFixtures {

    /// `.../mobile/contracts/generated`
    static var generatedDir: URL {
        // #filePath is .../mobile/ios/Tests/ZephyrUITests/UiFixtures.swift
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // -> Tests/ZephyrUITests
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
            throw UiFixtureError(reason: "\(name) is not a JSON object")
        }
        return object
    }
}

struct UiFixtureError: Error, CustomStringConvertible {
    let reason: String
    var description: String { "fixture: \(reason)" }
}

/// Builders for the screen-logic tests.
///
/// Defaults are an owned SSH row with full capabilities, so each test states
/// only the field it is actually about. Mirrors the Kotlin
/// ConnectionTestSupport.
enum UiTestData {

    static let owner = "user-1"

    static func connection(
        id: String = "c-1",
        name: String = "prod-web",
        host: String = "10.0.0.1",
        `protocol`: ConnectionProtocol = .ssh,
        port: Int? = nil,
        username: String = "root",
        remark: String = "",
        tags: [String] = [],
        lastConnectedAt: Int64? = nil,
        deletedAt: Int64? = nil,
        residency: Residency = .owned,
        capabilities: CapabilitySet = .owner,
        sharedUsePolicy: SharedUsePolicy = .relayOnly,
        password: SecretPresence = .absent,
        privateKey: SecretPresence = .absent,
        revision: Int64 = 3
    ) -> Connection {
        Connection(
            id: id,
            ownerUserId: owner,
            protocol: `protocol`,
            name: name,
            host: host,
            port: port ?? `protocol`.defaultPort,
            username: username,
            remark: remark,
            tags: tags,
            lastConnectedAt: lastConnectedAt,
            deletedAt: deletedAt,
            residency: residency,
            capabilities: capabilities,
            sharedUsePolicy: sharedUsePolicy,
            password: password,
            privateKey: privateKey,
            revision: revision
        )
    }

    /// Shared-to-me row: implicit grants only, so no EDIT/DELETE/SHARE.
    static func shared(
        id: String = "s-1",
        name: String = "shared-db",
        usePolicy: SharedUsePolicy = .relayOnly
    ) -> Connection {
        connection(
            id: id,
            name: name,
            residency: .sharedOnlineOnly,
            capabilities: .implicitShare,
            sharedUsePolicy: usePolicy
        )
    }

    /// Everything the route validator will accept, for tests that are not
    /// about route repair.
    static func inventory(
        proxies: Set<String> = ["p-1", "p-2"],
        keys: Set<String> = ["k-1", "k-2"],
        jumps: Set<String> = ["j-1", "j-2", "j-3", "j-4", "j-5", "j-6", "j-7", "j-8", "j-9"]
    ) -> RouteInventory {
        RouteInventory(
            usableProxyIds: proxies,
            usableSshKeyIds: keys,
            usableJumpHostIds: jumps
        )
    }
}
