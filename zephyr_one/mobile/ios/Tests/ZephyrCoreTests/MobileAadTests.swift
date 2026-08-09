import XCTest
import ZephyrContracts
@testable import ZephyrCore

/// The Swift AAD builder against the same vectors Kotlin and JS are held to.
///
/// `contracts/generated/aad-vectors.json` is generated from
/// `mobile/tools/lib/aad.mjs`, so agreeing with it is agreeing with the server.
/// The mutated cases matter as much as the canonical ones: they are what proves
/// each field actually reaches the bytes, and therefore that a stolen ciphertext
/// cannot be replayed against a different device, entity, field or revision.
final class MobileAadTests: XCTestCase {

    private func secretInput(_ raw: [String: Any]) throws -> MobileAad.SecretInput {
        MobileAad.SecretInput(
            serverId: raw["serverId"] as? String ?? "",
            userId: raw["userId"] as? String ?? "",
            deviceId: raw["deviceId"] as? String ?? "",
            entityType: raw["entityType"] as? String ?? "",
            entityId: raw["entityId"] as? String ?? "",
            fieldName: raw["fieldName"] as? String ?? "",
            entityRevision: Int64((raw["entityRevision"] as? NSNumber)?.int64Value ?? -1),
            keyVersion: (raw["keyVersion"] as? NSNumber)?.intValue ?? -1
        )
    }

    private func sharedInput(_ raw: [String: Any]) throws -> MobileAad.SharedInput {
        MobileAad.SharedInput(
            serverId: raw["serverId"] as? String ?? "",
            userId: raw["userId"] as? String ?? "",
            deviceId: raw["deviceId"] as? String ?? "",
            sessionId: raw["sessionId"] as? String ?? "",
            resourceId: raw["resourceId"] as? String ?? "",
            resourceRevision: (raw["resourceRevision"] as? NSNumber)?.int64Value ?? -1,
            purpose: raw["purpose"] as? String ?? "",
            expiresAt: (raw["expiresAt"] as? NSNumber)?.int64Value ?? -1,
            clientNonce: raw["clientNonce"] as? String ?? ""
        )
    }

    func testEveryVectorMatchesByteForByte() throws {
        let vectors = try Fixtures.json("aad-vectors.json")
        let cases = try XCTUnwrap(vectors["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 17, "the full vector set must be exercised")

        var seenSecret = 0
        var seenShared = 0

        for entry in cases {
            let name = try XCTUnwrap(entry["name"] as? String)
            let kind = try XCTUnwrap(entry["kind"] as? String)
            let input = try XCTUnwrap(entry["input"] as? [String: Any])
            let expectedHex = try XCTUnwrap(entry["expectedHex"] as? String)
            let expectedLength = try XCTUnwrap((entry["expectedLength"] as? NSNumber)?.intValue)

            let produced: Data
            switch kind {
            case "secret":
                produced = try MobileAad.secretAad(try secretInput(input))
                seenSecret += 1
            case "shared":
                produced = try MobileAad.sharedAad(try sharedInput(input))
                seenShared += 1
            default:
                XCTFail("unknown vector kind \(kind)")
                continue
            }

            XCTAssertEqual(Fixtures.hexString(produced), expectedHex, "\(name): AAD bytes differ")
            XCTAssertEqual(produced.count, expectedLength, "\(name): AAD length differs")

            // The base64 form is what travels in the envelope, so it is pinned too.
            let expectedBase64 = try XCTUnwrap(entry["expectedBase64"] as? String)
            XCTAssertEqual(produced.base64EncodedString(), expectedBase64, "\(name): base64 differs")
        }

        // Guard against a fixture reshape quietly skipping one whole family.
        XCTAssertGreaterThan(seenSecret, 0, "no secret vectors ran")
        XCTAssertGreaterThan(seenShared, 0, "no shared vectors ran")
    }

    func testMutatingAnyFieldChangesTheAad() throws {
        /* The property the mutated vectors exist to establish, asserted directly
         * rather than inferred: every canonical AAD must differ from every
         * mutation of it. If a field were dropped from the join, its mutation
         * would produce identical bytes and a replay across that field would
         * succeed. */
        let vectors = try Fixtures.json("aad-vectors.json")
        let cases = try XCTUnwrap(vectors["cases"] as? [[String: Any]])

        var byKind: [String: [(String, Data)]] = [:]
        for entry in cases {
            let name = try XCTUnwrap(entry["name"] as? String)
            let kind = try XCTUnwrap(entry["kind"] as? String)
            let input = try XCTUnwrap(entry["input"] as? [String: Any])
            let produced = kind == "secret"
                ? try MobileAad.secretAad(try secretInput(input))
                : try MobileAad.sharedAad(try sharedInput(input))
            byKind[kind, default: []].append((name, produced))
        }

        for (kind, entries) in byKind {
            for outer in entries.indices {
                for inner in entries.indices where inner > outer {
                    XCTAssertFalse(
                        MobileAad.constantTimeEquals(entries[outer].1, entries[inner].1),
                        "\(kind): \(entries[outer].0) and \(entries[inner].0) produce the same AAD"
                    )
                }
            }
        }
    }

    func testRejectedInputsAreRefused() throws {
        /* The rejects encode the grammar, not merely bad taste. A leading-zero
         * revision has a second valid-looking spelling, so accepting "08" would
         * let two different byte strings authenticate the same row -- and the
         * server, which emits "8", would reject the envelope with a decryption
         * failure that names nothing. */
        let vectors = try Fixtures.json("aad-vectors.json")
        let rejects = try XCTUnwrap(vectors["rejects"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(rejects.count, 3)

        for entry in rejects {
            let name = try XCTUnwrap(entry["name"] as? String)
            let input = try XCTUnwrap(entry["input"] as? [String: Any])

            switch name {
            case "leading-zero-revision":
                /* Swift's type system already forbids this one: entityRevision is
                 * Int64, so "08" cannot be constructed. Asserted as a type-level
                 * fact rather than skipped, so the vector is not silently
                 * unexercised -- the JS side needs a regex for the same rule
                 * because its input is a string. */
                XCTAssertTrue(input["entityRevision"] is String,
                              "the vector should carry the string spelling this port cannot express")
            case "empty-field-name":
                XCTAssertThrowsError(try MobileAad.secretAad(try secretInput(input))) { error in
                    XCTAssertEqual(error as? MobileAadError, .emptyField("fieldName"))
                }
            case "negative-key-version":
                XCTAssertThrowsError(try MobileAad.secretAad(try secretInput(input))) { error in
                    XCTAssertEqual(error as? MobileAadError, .negativeInteger("keyVersion"))
                }
            default:
                XCTFail("unhandled reject vector \(name); add it rather than ignoring it")
            }
        }
    }

    func testSeparatorInAFieldIsRefused() throws {
        /* Not in the fixture set, and it is the reason the NUL check exists: a
         * field containing the separator could forge a different field split that
         * joins to the same bytes, which is an authentication bypass rather than a
         * formatting problem. */
        let input = MobileAad.SecretInput(
            serverId: "srv-1",
            userId: "usr-1\u{0000}extra",
            deviceId: "dev-1",
            entityType: "connection",
            entityId: "conn-1",
            fieldName: "password",
            entityRevision: 8,
            keyVersion: 1
        )
        XCTAssertThrowsError(try MobileAad.secretAad(input)) { error in
            XCTAssertEqual(error as? MobileAadError, .separatorInField("userId"))
        }
    }

    func testUnsupportedSharedPurposeIsRefused() throws {
        let input = MobileAad.SharedInput(
            serverId: "srv-1",
            userId: "usr-2",
            deviceId: "dev-1",
            sessionId: "sess-1",
            resourceId: "conn-7",
            resourceRevision: 9,
            purpose: "sftp",
            expiresAt: 1_786_093_230_000,
            clientNonce: "nonce-1234567890abcdef"
        )
        XCTAssertThrowsError(try MobileAad.sharedAad(input)) { error in
            XCTAssertEqual(error as? MobileAadError, .unsupportedPurpose("sftp"))
        }
    }

    func testHkdfSaltIsTheDigestOfTheFixedLabel() throws {
        /* A per-message salt here would be a correctness break rather than an
         * improvement: the server derives with the same fixed label, so a random
         * salt would derive a different key and every envelope would fail to
         * open. */
        let salt = MobileAad.hkdfSalt()
        XCTAssertEqual(salt.count, 32, "SHA-256 digest length")
        XCTAssertEqual(
            Fixtures.hexString(salt),
            "127f1b235a1e168bfa54237fe3bea132e01ba1106ce5856f827c961c877880f3",
            "HKDF salt must be SHA-256 of the frozen label"
        )
    }

    func testConstantTimeEqualsHandlesSlices() throws {
        /* Data slices keep the parent's indices, so an implementation that
         * indexed both operands with the same integer would compare different
         * logical positions. Two equal AADs, one of them a slice, must still
         * compare equal. */
        let whole = Data([1, 2, 3, 4, 5, 6])
        let slice = whole[whole.startIndex + 2..<whole.startIndex + 5]
        let standalone = Data([3, 4, 5])
        XCTAssertTrue(MobileAad.constantTimeEquals(slice, standalone))
        XCTAssertFalse(MobileAad.constantTimeEquals(slice, Data([3, 4, 6])))
        XCTAssertFalse(MobileAad.constantTimeEquals(slice, Data([3, 4])))
    }
}
