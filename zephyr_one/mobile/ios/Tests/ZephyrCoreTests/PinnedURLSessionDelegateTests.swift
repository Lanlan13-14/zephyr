import Foundation
import XCTest
@testable import ZephyrCore

final class PinnedURLSessionDelegateTests: XCTestCase {
    func testPinCanonicalizationAndConfigurationRejectMalformedValues() throws {
        let digest = Data((0..<32).map(UInt8.init)).base64EncodedString()
        XCTAssertEqual(
            try PinnedURLSessionDelegate.canonicalPin(digest),
            "sha256/" + digest
        )
        XCTAssertNoThrow(
            try PinnedURLSessionDelegate(
                expectedURL: try XCTUnwrap(URL(string: "https://example.test")),
                sha256SPKIPins: ["sha256/" + digest]
            )
        )
        XCTAssertThrowsError(
            try PinnedURLSessionDelegate(
                expectedURL: try XCTUnwrap(URL(string: "https://example.test")),
                sha256SPKIPins: ["sha256/not-base64"]
            )
        ) { error in
            XCTAssertEqual(error as? PinnedURLSessionDelegate.ConfigurationError, .invalidPin)
        }
        XCTAssertThrowsError(
            try PinnedURLSessionDelegate(
                expectedURL: try XCTUnwrap(URL(string: "http://example.test"))
            )
        ) { error in
            XCTAssertEqual(error as? PinnedURLSessionDelegate.ConfigurationError, .invalidExpectedURL)
        }
    }

    func testSPKIPinHashesExactSubjectPublicKeyInfoTLV() throws {
        let spki = derSequence(
            derSequence(Data()) + derValue(tag: 0x03, content: Data([0x00, 0x01, 0x02, 0x03]))
        )
        let certificate = fakeCertificate(spki: spki)
        let expected = "sha256/qvC4vCdY/alefI/OWssfTI1GrrR3yUDwm0+oilBHyt4="

        XCTAssertEqual(PinnedURLSessionDelegate.spkiPin(certificateDER: certificate), expected)
        XCTAssertTrue(PinnedURLSessionDelegate.pinsMatch([expected], certificateDERs: [certificate]))
        XCTAssertFalse(
            PinnedURLSessionDelegate.pinsMatch(
                ["sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
                certificateDERs: [certificate]
            )
        )
        XCTAssertNil(PinnedURLSessionDelegate.spkiPin(certificateDER: Data([0x30, 0x80])))
    }

    func testRedirectsAreAlwaysRejected() throws {
        let delegate = try PinnedURLSessionDelegate(
            expectedURL: try XCTUnwrap(URL(string: "https://example.test"))
        )
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let request = URLRequest(url: try XCTUnwrap(URL(string: "http://attacker.test")))
        let task = session.dataTask(with: request)
        let response = try XCTUnwrap(
            HTTPURLResponse(
                url: try XCTUnwrap(URL(string: "https://example.test")),
                statusCode: 302,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": "http://attacker.test"]
            )
        )
        var redirectedRequest: URLRequest? = request

        delegate.urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: request
        ) { redirectedRequest = $0 }

        XCTAssertNil(redirectedRequest)
    }

    func testLoadRejectsDirectOriginAndProtocolDowngrades() async throws {
        let delegate = try PinnedURLSessionDelegate(
            expectedURL: try XCTUnwrap(URL(string: "https://example.test"))
        )
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }

        for value in ["http://example.test/path", "https://other.test/path"] {
            let request = URLRequest(url: try XCTUnwrap(URL(string: value)))
            do {
                _ = try await delegate.load(request, using: session, byteLimit: 1)
                XCTFail("Expected an origin policy error")
            } catch let error as URLError {
                XCTAssertEqual(error.code, .unsupportedURL)
            }
        }
    }

    private func fakeCertificate(spki: Data) -> Data {
        let version = derValue(tag: 0xa0, content: derValue(tag: 0x02, content: Data([0x02])))
        let serial = derValue(tag: 0x02, content: Data([0x01]))
        let emptySequence = derSequence(Data())
        let tbs = derSequence(
            version
                + serial
                + emptySequence // signature
                + emptySequence // issuer
                + emptySequence // validity
                + emptySequence // subject
                + spki
        )
        return derSequence(
            tbs
                + emptySequence
                + derValue(tag: 0x03, content: Data([0x00]))
        )
    }

    private func derSequence(_ content: Data) -> Data {
        derValue(tag: 0x30, content: content)
    }

    private func derValue(tag: UInt8, content: Data) -> Data {
        precondition(content.count < 128)
        return Data([tag, UInt8(content.count)]) + content
    }
}
