import Foundation
import CryptoKit

public protocol DeviceProofSigning: Sendable {
    func sign(_ challenge: DeviceProofChallenge) throws -> String
}

public enum DeviceProofSigningError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidField(String)
    case malformedDERSignature
    case signingFailed

    public var description: String {
        switch self {
        case .invalidField(let field):
            return "device proof signing field \(field) is invalid"
        case .malformedDERSignature:
            return "device proof signing returned an invalid signature"
        case .signingFailed:
            return "device proof signing failed"
        }
    }
}

/// ES256 v2 signer backed by the existing non-exportable device identity.
public final class KeychainDeviceProofSigner: DeviceProofSigning, @unchecked Sendable {
    private let identityStore: DeviceIdentityStore

    public init(identityStore: DeviceIdentityStore) {
        self.identityStore = identityStore
    }

    public func sign(_ challenge: DeviceProofChallenge) throws -> String {
        let payload = try Self.signaturePayload(
            deviceID: identityStore.deviceID,
            challenge: challenge
        )
        do {
            // SecKey's X9.62 signing API returns ASN.1 DER. The wire contract is
            // fixed-width P1363, so conversion happens exactly at this boundary.
            let der = try identityStore.signDeviceProofPayloadReturningDER(payload)
            return try Self.p1363Signature(fromDER: der).base64EncodedString()
        } catch let error as DeviceProofSigningError {
            throw error
        } catch {
            throw DeviceProofSigningError.signingFailed
        }
    }

    static func signaturePayload(deviceID: String, challenge: DeviceProofChallenge) throws -> Data {
        guard challenge.proofVersion == DeviceProofCoordinator.proofVersion else {
            throw DeviceProofSigningError.invalidField("proofVersion")
        }
        guard challenge.algorithm == DeviceProofCoordinator.algorithm else {
            throw DeviceProofSigningError.invalidField("algorithm")
        }
        guard challenge.signatureFormat == DeviceProofCoordinator.signatureFormat else {
            throw DeviceProofSigningError.invalidField("signatureFormat")
        }
        let fields = [
            DeviceProofCoordinator.proofVersion,
            deviceID,
            challenge.method.uppercased(),
            challenge.canonicalPath,
            challenge.bodySha256,
            challenge.usage,
            String(challenge.timestamp),
            challenge.nonce,
        ]
        let names = [
            "proofVersion", "deviceID", "method", "canonicalPath",
            "bodySha256", "usage", "timestamp", "nonce",
        ]
        for (index, value) in fields.enumerated() {
            guard !value.isEmpty, !value.unicodeScalars.contains(where: { $0.value == 0 }) else {
                throw DeviceProofSigningError.invalidField(names[index])
            }
        }
        guard challenge.timestamp > 0 else {
            throw DeviceProofSigningError.invalidField("timestamp")
        }
        return Data(fields.joined(separator: "\0").utf8)
    }

    /// Converts the X9.62 ASN.1 signature returned by SecKey to fixed r || s.
    static func p1363Signature(fromDER der: Data) throws -> Data {
        do {
            let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
            let raw = signature.rawRepresentation
            guard raw.count == 64 else {
                throw DeviceProofSigningError.malformedDERSignature
            }
            return raw
        } catch let error as DeviceProofSigningError {
            throw error
        } catch {
            throw DeviceProofSigningError.malformedDERSignature
        }
    }
}
