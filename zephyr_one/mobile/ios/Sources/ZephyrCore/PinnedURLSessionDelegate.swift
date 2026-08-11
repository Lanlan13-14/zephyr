import Foundation
import CryptoKit
import Security

/// URLSession policy for the Zephyr mobile API.
///
/// System certificate and hostname validation always runs. Optional SPKI pins
/// further restrict an otherwise trusted chain; they never turn a self-signed
/// or expired certificate into a trusted one. Redirects are refused before
/// Foundation can replay an authenticated request, which also rules out HTTPS
/// to HTTP downgrade redirects.
public final class PinnedURLSessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    public enum ConfigurationError: Error, Equatable, CustomStringConvertible {
        case invalidExpectedURL
        case invalidPin

        public var description: String {
            switch self {
            case .invalidExpectedURL:
                return "TLS policy requires an HTTPS URL with a host"
            case .invalidPin:
                return "SPKI pins must be SHA-256 digests in Base64"
            }
        }
    }

    private struct ExpectedOrigin: Equatable {
        let host: String
        let port: Int
    }

    private let origin: ExpectedOrigin
    private let pinDigests: Set<Data>
    private let bounded = BoundedURLSessionDelegate()

    public init(expectedURL: URL, sha256SPKIPins: [String] = []) throws {
        guard expectedURL.scheme?.lowercased() == "https",
              let host = expectedURL.host?.lowercased(),
              !host.isEmpty else {
            throw ConfigurationError.invalidExpectedURL
        }

        var digests = Set<Data>()
        for pin in sha256SPKIPins {
            guard let digest = Self.decodePin(pin) else { throw ConfigurationError.invalidPin }
            digests.insert(digest)
        }
        self.origin = ExpectedOrigin(host: host, port: expectedURL.port ?? 443)
        self.pinDigests = digests
        super.init()
    }

    /// Canonical display/storage spelling accepted by OkHttp and this client.
    public static func canonicalPin(_ pin: String) throws -> String {
        guard let digest = decodePin(pin) else { throw ConfigurationError.invalidPin }
        return "sha256/" + digest.base64EncodedString()
    }

    func load(
        _ request: URLRequest,
        using session: URLSession,
        byteLimit: Int
    ) async throws -> (Data, URLResponse) {
        guard request.url?.scheme?.lowercased() == "https",
              request.url?.host?.lowercased() == origin.host,
              Self.normalizedPort(request.url?.port ?? 443) == origin.port else {
            throw URLError(.unsupportedURL)
        }
        try await bounded.load(request, using: session, byteLimit: byteLimit)
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler: completionHandler)
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler: completionHandler)
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        bounded.urlSession(
            session,
            dataTask: dataTask,
            didReceive: response,
            completionHandler: completionHandler
        )
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        bounded.urlSession(session, dataTask: dataTask, didReceive: data)
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        bounded.urlSession(session, task: task, didCompleteWithError: error)
    }

    /// Mobile API redirects are never legitimate. Refusing every redirect is
    /// stricter and easier to audit than attempting to strip credentials from
    /// selected destinations, and necessarily rejects protocol downgrades.
    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    private func handle(
        _ challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard challenge.previousFailureCount == 0,
              challenge.protectionSpace.host.lowercased() == origin.host,
              Self.normalizedPort(challenge.protectionSpace.port) == origin.port,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // Set the expected host explicitly so pinning can never replace normal
        // hostname validation with a key-only check.
        let policy = SecPolicyCreateSSL(true, origin.host as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        var trustError: CFError?
        guard SecTrustEvaluateWithError(trust, &trustError), pinsMatch(trust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    private func pinsMatch(_ trust: SecTrust) -> Bool {
        guard !pinDigests.isEmpty else { return true }
        for index in 0..<SecTrustGetCertificateCount(trust) {
            guard let certificate = SecTrustGetCertificateAtIndex(trust, index) else { continue }
            let der = SecCertificateCopyData(certificate) as Data
            guard let digest = Self.spkiDigest(certificateDER: der) else { continue }
            if pinDigests.contains(digest) { return true }
        }
        return false
    }

    static func pinsMatch(_ pins: [String], certificateDERs: [Data]) -> Bool {
        var expected = Set<Data>()
        for pin in pins {
            guard let digest = decodePin(pin) else { return false }
            expected.insert(digest)
        }
        guard !expected.isEmpty else { return false }
        return certificateDERs.contains { der in
            guard let digest = spkiDigest(certificateDER: der) else { return false }
            return expected.contains(digest)
        }
    }

    static func spkiPin(certificateDER: Data) -> String? {
        guard let digest = spkiDigest(certificateDER: certificateDER) else { return nil }
        return "sha256/" + digest.base64EncodedString()
    }

    private static func spkiDigest(certificateDER: Data) -> Data? {
        guard let spki = DER.subjectPublicKeyInfo(inCertificate: certificateDER) else { return nil }
        return Data(SHA256.hash(data: spki))
    }

    private static func decodePin(_ value: String) -> Data? {
        let encoded: Substring
        if value.hasPrefix("sha256/") {
            encoded = value.dropFirst("sha256/".count)
        } else {
            encoded = value[...]
        }
        guard let data = Data(base64Encoded: String(encoded)), data.count == 32 else { return nil }
        return data
    }

    private static func normalizedPort(_ port: Int) -> Int {
        port == 0 ? 443 : port
    }
}

/// Minimal DER traversal for X.509's SubjectPublicKeyInfo field.
///
/// The pin is over the exact SPKI TLV from the certificate, not over
/// `SecKeyCopyExternalRepresentation` (which omits the algorithm identifier and
/// therefore produces the wrong bytes for both RSA and EC certificates).
private enum DER {
    private struct Value {
        let tag: UInt8
        let fullRange: Range<Int>
        let contentRange: Range<Int>
    }

    static func subjectPublicKeyInfo(inCertificate data: Data) -> Data? {
        var certificateOffset = 0
        guard let certificate = readValue(data, offset: &certificateOffset),
              certificate.tag == 0x30,
              certificateOffset == data.count else { return nil }

        var tbsOffset = certificate.contentRange.lowerBound
        guard let tbs = readValue(data, offset: &tbsOffset, limit: certificate.contentRange.upperBound),
              tbs.tag == 0x30 else { return nil }

        var fieldOffset = tbs.contentRange.lowerBound
        if fieldOffset < tbs.contentRange.upperBound, data[fieldOffset] == 0xa0 {
            guard readValue(data, offset: &fieldOffset, limit: tbs.contentRange.upperBound) != nil else {
                return nil
            }
        }

        // serialNumber, signature, issuer, validity and subject precede SPKI.
        for _ in 0..<5 {
            guard readValue(data, offset: &fieldOffset, limit: tbs.contentRange.upperBound) != nil else {
                return nil
            }
        }
        guard let spki = readValue(data, offset: &fieldOffset, limit: tbs.contentRange.upperBound),
              spki.tag == 0x30 else { return nil }
        return data.subdata(in: spki.fullRange)
    }

    private static func readValue(
        _ data: Data,
        offset: inout Int,
        limit: Int? = nil
    ) -> Value? {
        let upperBound = limit ?? data.count
        guard offset >= 0, offset < upperBound, upperBound <= data.count else { return nil }
        let start = offset
        let tag = data[offset]
        offset += 1
        guard offset < upperBound else { return nil }

        let firstLength = data[offset]
        offset += 1
        let contentLength: Int
        if firstLength & 0x80 == 0 {
            contentLength = Int(firstLength)
        } else {
            let byteCount = Int(firstLength & 0x7f)
            // DER forbids indefinite length and non-minimal long forms. Four
            // bytes already exceed every certificate URLSession can hold.
            guard (1...4).contains(byteCount),
                  offset <= upperBound - byteCount,
                  data[offset] != 0 else { return nil }
            var length = 0
            for _ in 0..<byteCount {
                guard length <= (Int.max >> 8) else { return nil }
                length = (length << 8) | Int(data[offset])
                offset += 1
            }
            guard length >= 128 else { return nil }
            contentLength = length
        }

        guard contentLength <= upperBound - offset else { return nil }
        let contentStart = offset
        offset += contentLength
        return Value(
            tag: tag,
            fullRange: start..<offset,
            contentRange: contentStart..<offset
        )
    }
}
