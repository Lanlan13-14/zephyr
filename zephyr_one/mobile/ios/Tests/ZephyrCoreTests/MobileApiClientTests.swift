import Foundation
import CryptoKit
import XCTest
@testable import ZephyrCore
import ZephyrContracts

final class MobileApiClientTests: XCTestCase {
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        URLProtocolStub.handler = nil
        URLProtocolStub.chunkSize = nil
        URLProtocolStub.chunkDelay = 0
        URLProtocolStub.stopHandler = nil
        URLProtocolStub.cacheStoragePolicy = .notAllowed
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        URLProtocolStub.handler = nil
        URLProtocolStub.chunkSize = nil
        URLProtocolStub.chunkDelay = 0
        URLProtocolStub.stopHandler = nil
        URLProtocolStub.cacheStoragePolicy = .notAllowed
        super.tearDown()
    }

    func testRejectsUnsafeBaseURLsWithoutEchoingThem() throws {
        XCTAssertEqual(MobileApiClient.defaultResponseByteLimit, 33_554_432)
        for (baseURL, expected) in [
            ("http://example.test", MobileApiConfigurationError.httpsRequired),
            ("https://user:secret@example.test", .credentialsInBaseURL),
            ("https://example.test?token=secret", .queryOrFragmentInBaseURL),
            ("https://example.test/#secret", .queryOrFragmentInBaseURL),
        ] {
            XCTAssertThrowsError(try makeClient(baseURL: baseURL)) { error in
                XCTAssertEqual(error as? MobileApiConfigurationError, expected)
                XCTAssertFalse(String(describing: error).contains("secret"))
            }
        }
        XCTAssertThrowsError(try makeClient(responseByteLimit: -1)) { error in
            XCTAssertEqual(error as? MobileApiConfigurationError, .invalidResponseByteLimit)
        }
        XCTAssertThrowsError(try makeClient(responseByteLimit: 33_554_433)) { error in
            XCTAssertEqual(error as? MobileApiConfigurationError, .invalidResponseByteLimit)
        }
        XCTAssertThrowsError(try makeClient(sha256SPKIPins: ["not-a-sha256-pin"])) { error in
            XCTAssertEqual(error as? MobileApiConfigurationError, .invalidTLSPin)
        }
    }

    func testSensitiveSessionConfigurationCannotPersistCookiesCredentialsOrResponses() throws {
        let template = URLSessionConfiguration.default
        template.protocolClasses = [URLProtocolStub.self]
        template.httpShouldSetCookies = true
        template.httpCookieStorage = .shared
        template.urlCredentialStorage = .shared
        template.urlCache = .shared
        template.requestCachePolicy = .returnCacheDataElseLoad
        let injected = URLSession(configuration: template)
        defer { injected.invalidateAndCancel() }

        let client = try MobileApiClient(
            baseURL: "https://example.test",
            appVersion: "2.3.4",
            session: injected
        )
        let configuration = client.streamingSession.configuration

        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertNil(configuration.urlCache)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(configuration.protocolClasses?.count, 1)
        XCTAssertTrue(
            configuration.protocolClasses?.contains { $0 === URLProtocolStub.self } == true
        )
    }

    func testSensitiveSessionDoesNotAcceptSendOrCacheHTTPState() async throws {
        let storage = HTTPCookieStorage.sharedCookieStorage(
            forGroupContainerIdentifier: "zephyr.tests.session-state." + UUID().uuidString
        )
        storage.cookieAcceptPolicy = .always
        storage.setCookie(try Self.cookie(name: "theme", value: "dark", domain: "example.test"))

        let cache = URLCache(memoryCapacity: 1_048_576, diskCapacity: 0, diskPath: nil)
        let template = URLSessionConfiguration.default
        template.protocolClasses = [URLProtocolStub.self]
        template.httpShouldSetCookies = true
        template.httpCookieAcceptPolicy = .always
        template.httpCookieStorage = storage
        template.urlCache = cache
        template.requestCachePolicy = .returnCacheDataElseLoad
        template.httpAdditionalHeaders = [
            "Cookie": "zephyr_sid=template-secret",
            "Authorization": "Bearer template-secret",
        ]
        let injected = URLSession(configuration: template)
        defer { injected.invalidateAndCancel() }

        URLProtocolStub.cacheStoragePolicy = .allowed
        var requestCount = 0
        URLProtocolStub.handler = { request in
            requestCount += 1
            Self.assertSensitiveRequest(request)
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return Self.response(
                request,
                headers: [
                    "Cache-Control": "public, max-age=3600",
                    "Set-Cookie": "zephyr_sid=response-secret; Path=/; Secure; HttpOnly",
                ],
                json: Self.capabilitiesJSON()
            )
        }

        let client = try MobileApiClient(
            baseURL: "https://example.test",
            appVersion: "2.3.4",
            session: injected,
            legacyCookieStorage: storage
        )
        let first = try await client.capabilities()
        let second = try await client.capabilities()
        XCTAssertEqual(first.serverId, "server-1")
        XCTAssertEqual(second.serverId, "server-1")

        XCTAssertEqual(requestCount, 2, "A fresh network load is required for every sensitive request")
        let cookies = storage.cookies(for: URL(string: "https://example.test/")!) ?? []
        XCTAssertFalse(cookies.contains { $0.name == "zephyr_sid" })
        XCTAssertTrue(cookies.contains { $0.name == "theme" && $0.value == "dark" })
        XCTAssertEqual(cache.currentMemoryUsage, 0)
        XCTAssertEqual(cache.currentDiskUsage, 0)
    }

    func testLegacySIDCleanupIsLimitedToApplicableOriginCookies() throws {
        let storage = HTTPCookieStorage.sharedCookieStorage(
            forGroupContainerIdentifier: "zephyr.tests.cookies." + UUID().uuidString
        )
        storage.cookieAcceptPolicy = .always
        storage.setCookie(try Self.cookie(name: "zephyr_sid", value: "legacy", domain: "example.test"))
        storage.setCookie(try Self.cookie(
            name: "zephyr_sid",
            value: "legacy-api-path",
            domain: "example.test",
            path: "/api"
        ))
        storage.setCookie(try Self.cookie(name: "theme", value: "dark", domain: "example.test"))
        storage.setCookie(try Self.cookie(name: "zephyr_sid", value: "other", domain: "other.test"))

        _ = try makeClient(legacyCookieStorage: storage)

        let originCookies = storage.cookies(for: URL(string: "https://example.test/")!) ?? []
        XCTAssertFalse(originCookies.contains { $0.name == "zephyr_sid" })
        XCTAssertTrue(originCookies.contains { $0.name == "theme" && $0.value == "dark" })
        let apiCookies = storage.cookies(for: URL(string: "https://example.test/api")!) ?? []
        XCTAssertFalse(apiCookies.contains { $0.name == "zephyr_sid" })
        let otherCookies = storage.cookies(for: URL(string: "https://other.test/")!) ?? []
        XCTAssertTrue(otherCookies.contains { $0.name == "zephyr_sid" && $0.value == "other" })
    }

    func testLogoutUsesOneExplicitEncodedSIDCookieAndClearsLegacyCookie() async throws {
        let storage = HTTPCookieStorage.sharedCookieStorage(
            forGroupContainerIdentifier: "zephyr.tests.logout." + UUID().uuidString
        )
        storage.cookieAcceptPolicy = .always
        let client = try makeClient(legacyCookieStorage: storage)
        storage.setCookie(try Self.cookie(name: "zephyr_sid", value: "legacy", domain: "example.test"))
        storage.setCookie(try Self.cookie(name: "theme", value: "dark", domain: "example.test"))

        URLProtocolStub.handler = { request in
            Self.assertSensitiveRequest(request)
            XCTAssertEqual(request.url?.path, "/api/auth/logout")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "zephyr_sid=sid%2F%2B%3D%3D")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sid"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return Self.response(request, json: "{\"ok\":true}")
        }

        try await client.logout(sid: "sid/+==")

        let cookies = storage.cookies(for: URL(string: "https://example.test/")!) ?? []
        XCTAssertFalse(cookies.contains { $0.name == "zephyr_sid" })
        XCTAssertTrue(cookies.contains { $0.name == "theme" && $0.value == "dark" })
    }

    func testLogoutClearsLegacySIDWhenRemoteRevocationFails() async throws {
        let storage = HTTPCookieStorage.sharedCookieStorage(
            forGroupContainerIdentifier: "zephyr.tests.logout-failure." + UUID().uuidString
        )
        storage.cookieAcceptPolicy = .always
        let client = try makeClient(legacyCookieStorage: storage)
        storage.setCookie(try Self.cookie(name: "zephyr_sid", value: "legacy", domain: "example.test"))

        URLProtocolStub.handler = { request in
            Self.assertSensitiveRequest(request)
            throw URLError(.timedOut)
        }

        do {
            try await client.logout(sid: "sid-secret")
            XCTFail("Expected remote logout to fail")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "network_timeout")
        } catch {
            XCTFail("Expected MobileApiError, got \(type(of: error))")
        }

        let cookies = storage.cookies(for: URL(string: "https://example.test/")!) ?? []
        XCTAssertFalse(cookies.contains { $0.name == "zephyr_sid" })
    }

    func testRequestsAndExternalProofAuthorizationDisableCookiesAndCaching() async throws {
        let now: Int64 = 1_725_000_000_000
        let signer = MobileClientProofSigner()
        let coordinator = DeviceProofCoordinator(signer: signer, nowMilliseconds: { now })
        var challengeCount = 0
        URLProtocolStub.handler = { request in
            Self.assertSensitiveRequest(request)
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertEqual(request.url?.path, MobileApiPaths.postMobileV1DevicesProofChallenge)
            challengeCount += 1
            let body = try Self.jsonBody(request)
            let nonce = String(repeating: "N", count: 42) + String(challengeCount)
            return Self.response(request, json: Self.proofChallengeJSON(body: body, nonce: nonce))
        }

        let client = try makeClient(proofCoordinator: coordinator)
        let targets = [
            "https://example.test/api/mobile/v1/shared",
            "https://example.test/api/mobile/v1/blobs/" + String(repeating: "a", count: 64),
        ]
        for target in targets {
            var request = URLRequest(
                url: try XCTUnwrap(URL(string: target)),
                cachePolicy: .returnCacheDataDontLoad
            )
            request.httpMethod = "GET"
            request.httpShouldHandleCookies = true
            request.setValue("zephyr_sid=legacy", forHTTPHeaderField: "Cookie")

            let authorized = try await client.authorizeDeviceProofRequest(request)

            Self.assertSensitiveRequest(authorized)
            XCTAssertNil(authorized.value(forHTTPHeaderField: "Cookie"))
            XCTAssertEqual(authorized.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertEqual(authorized.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"), signer.proof)
        }
        XCTAssertEqual(challengeCount, targets.count)
    }

    func testLoginTotpAndAuthenticatedOutcomesUseStrictWireShapes() async throws {
        var requestCount = 0
        URLProtocolStub.handler = { request in
            requestCount += 1
            Self.assertSensitiveRequest(request)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sid"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"))
            let body = try Self.jsonBody(request)
            switch requestCount {
            case 1:
                XCTAssertEqual(request.url?.path, MobileApiPaths.postAuthLogin)
                XCTAssertEqual(Set(body.keys), ["username", "password", "returnSid"])
                XCTAssertEqual(body["username"] as? String, "alice")
                XCTAssertEqual(body["password"] as? String, "login-password")
                XCTAssertEqual(body["returnSid"] as? Bool, true)
                return Self.response(request, json: "{\"ok\":true,\"requireTotp\":true,\"tempToken\":\"temp-secret\"}")
            case 2:
                XCTAssertEqual(request.url?.path, MobileApiPaths.postAuthTotpVerify)
                XCTAssertEqual(Set(body.keys), ["tempToken", "code", "returnSid"])
                XCTAssertEqual(body["tempToken"] as? String, "temp-secret")
                XCTAssertEqual(body["code"] as? String, "123456")
                XCTAssertEqual(body["returnSid"] as? Bool, true)
                return Self.response(
                    request,
                    json: "{\"ok\":true,\"sid\":\"sid-secret\",\"user\":{\"userId\":\"user-1\",\"username\":\"alice\"},\"mustChangePassword\":true}"
                )
            default:
                XCTAssertEqual(request.url?.path, MobileApiPaths.postAuthLogin)
                XCTAssertEqual(body["captchaToken"] as? String, "captcha-secret")
                XCTAssertEqual(body["remember"] as? Bool, true)
                return Self.response(
                    request,
                    json: "{\"ok\":true,\"requireTotp\":false,\"sid\":\"sid-two\",\"user\":{\"userId\":\"user-2\",\"username\":\"bob\"},\"mustChangePassword\":false}"
                )
            }
        }

        let client = try makeClient(
            proofCoordinator: DeviceProofCoordinator(
                signer: ThrowingMobileClientProofSigner(error: MobileApiError.offline)
            )
        )
        let login = try await client.login(username: "alice", password: "login-password")
        guard case .totpRequired(let tempToken) = login else {
            XCTFail("Expected TOTP challenge")
            return
        }
        XCTAssertEqual(tempToken, "temp-secret")

        let verified = try await client.verifyTotp(tempToken: tempToken, code: "123456")
        guard case .mustChangePassword(let changedSession) = verified else {
            XCTFail("Expected must-change-password session")
            return
        }
        XCTAssertEqual(changedSession.sid, "sid-secret")
        XCTAssertEqual(changedSession.user.userId, "user-1")

        let authenticated = try await client.login(
            username: "bob",
            password: "second-password",
            captchaToken: "captcha-secret",
            remember: true
        )
        guard case .authenticated(let session) = authenticated else {
            XCTFail("Expected authenticated session")
            return
        }
        XCTAssertEqual(session.sid, "sid-two")
        XCTAssertEqual(requestCount, 3)
    }

    func testMixedAndStaleFlattenedLoginResponsesAreMalformed() async throws {
        let fixtures = [
            "{\"ok\":true,\"requireTotp\":true,\"tempToken\":\"temp-secret\",\"sid\":\"sid-secret\"}",
            "{\"ok\":true,\"sid\":\"sid-secret\",\"totpRequired\":false,\"userId\":\"user-1\",\"username\":\"alice\"}",
        ]
        var index = 0
        URLProtocolStub.handler = { request in
            defer { index += 1 }
            return Self.response(request, json: fixtures[index])
        }

        for _ in fixtures {
            do {
                _ = try await makeClient().login(username: "alice", password: "login-password")
                XCTFail("Expected malformed login response")
            } catch let error as MobileApiError {
                XCTAssertEqual(error.code, "malformed_response")
                XCTAssertFalse(error.description.contains("sid-secret"))
                XCTAssertFalse(error.message.contains("login-password"))
            }
        }
    }

    func testCapabilitiesIsUnauthenticatedAndDecodesTypedSecurityMetadata() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://example.test/root/api/mobile/v1/capabilities")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-One-Client"), "1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-One-Platform"), "ios")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-One-Version"), "2.3.4")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Protocol-Version"), "1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Request-Id"), "request-1")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sid"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"))
            return Self.response(request, json: Self.capabilitiesJSON())
        }

        let capabilities = try await makeClient(baseURL: "https://example.test/root/").capabilities()

        XCTAssertTrue(capabilities.supports(protocolVersion: 1))
        XCTAssertEqual(capabilities.registryHash, "registry-hash")
        XCTAssertEqual(capabilities.serverId, "server-1")
        XCTAssertEqual(capabilities.minimumAppVersions?.ios, "2.0.0")
        XCTAssertEqual(capabilities.limits.maxOpsPerBatch, 200)
        XCTAssertEqual(capabilities.auth.proofVersion, "zephyr-one-device-proof-v2")
        XCTAssertEqual(capabilities.auth.proofHeader, "X-Zephyr-Device-Proof")
        XCTAssertEqual(capabilities.serverEncryption?.keyVersion, 3)
        XCTAssertTrue(capabilities.features.nearRealtimeWake)
        XCTAssertEqual(capabilities.wake.transport, "sse")
        XCTAssertEqual(capabilities.wake.payloadFields, ["cursor", "epoch", "reason"])
        XCTAssertTrue(capabilities.wake.requiresDeviceProof)
    }

    func testCapabilitiesRequiresServerEncryptionKeyEvenWhenUnavailable() async throws {
        URLProtocolStub.handler = { request in
            Self.response(request, json: Self.capabilitiesJSON(includeServerEncryption: false))
        }
        do {
            _ = try await makeClient().capabilities()
            XCTFail("Expected missing serverEncryption to fail")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "malformed_response")
        }
    }

    func testSensitiveBindRefreshPatchAndRevokeUseOnlyTheirManagementCredentials() async throws {
        let deviceId = "device-1234567890"
        let sid = "sid-secret"
        let grant = "grant-secret"
        let bindReceipt = String(repeating: "r", count: 43)
        var requestCount = 0
        URLProtocolStub.handler = { request in
            requestCount += 1
            Self.assertSensitiveRequest(request)
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"))
            let path = try XCTUnwrap(request.url?.path)
            switch requestCount {
            case 1:
                XCTAssertEqual(path, MobileApiPaths.postMobileV1SensitiveVerify)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Sid"), sid)
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sensitive-Grant"))
                let body = try Self.jsonBody(request)
                XCTAssertEqual(Set(body.keys), ["action", "secret", "targetIds"])
                XCTAssertEqual(body["action"] as? String, "device.bind")
                XCTAssertEqual(body["secret"] as? String, "verify-secret")
                XCTAssertEqual(body["targetIds"] as? [String], ["token-1", deviceId])
                return Self.response(
                    request,
                    json: "{\"ok\":true,\"grant\":\"grant-secret\",\"expiresAt\":1725000030000,\"action\":\"device.bind\",\"targetHash\":\"target-hash\",\"bindingProtocolVersion\":2,\"bindAttempt\":{\"receipt\":\"\(bindReceipt)\",\"expectedBindingRevision\":0,\"expectedRefreshGeneration\":0,\"expiresAt\":1725000030000}}"
                )
            case 2:
                XCTAssertEqual(path, MobileApiPaths.postMobileV1DevicesBind)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Sid"), sid)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Sensitive-Grant"), grant)
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["deviceId"] as? String, deviceId)
                XCTAssertEqual(body["platform"] as? String, "ios")
                XCTAssertEqual(body["appVersion"] as? String, "2.3.4")
                XCTAssertEqual(body["tokenId"] as? String, "token-1")
                XCTAssertEqual(body["syncIntervalSec"] as? Int, 60)
                XCTAssertEqual(body["bindingProtocolVersion"] as? Int, 2)
                XCTAssertEqual(body["bindReceipt"] as? String, bindReceipt)
                return Self.response(request, json: Self.bindResponseJSON(deviceId: deviceId))
            case 3:
                XCTAssertEqual(path, MobileApiPaths.postMobileV1DevicesRefresh)
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sid"))
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sensitive-Grant"))
                let body = try Self.jsonBody(request)
                XCTAssertEqual(Set(body.keys), ["deviceId", "refreshCredential"])
                XCTAssertEqual(body["refreshCredential"] as? String, "refresh-secret")
                return Self.response(request, json: Self.refreshResponseJSON(deviceId: deviceId))
            case 4:
                XCTAssertEqual(path, MobileApiPaths.deviceById(deviceId))
                XCTAssertEqual(request.httpMethod, "PATCH")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Sid"), sid)
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Sensitive-Grant"))
                let body = try Self.jsonBody(request)
                XCTAssertEqual(Set(body.keys), ["deviceName", "automaticEnabled"])
                XCTAssertEqual(body["deviceName"] as? String, "Work Phone")
                XCTAssertEqual(body["automaticEnabled"] as? Bool, false)
                return Self.response(request, json: Self.deviceJSON(deviceId: deviceId))
            default:
                XCTAssertEqual(path, MobileApiPaths.deviceById(deviceId))
                XCTAssertEqual(request.httpMethod, "DELETE")
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Sid"), sid)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Sensitive-Grant"), grant)
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return Self.response(request, json: "{\"ok\":true}")
            }
        }

        let client = try makeClient(
            proofCoordinator: DeviceProofCoordinator(
                signer: ThrowingMobileClientProofSigner(error: MobileApiError.offline)
            )
        )
        let verified = try await client.verifySensitive(
            secret: "verify-secret",
            tokenId: "token-1",
            deviceId: deviceId,
            sid: sid
        )
        XCTAssertEqual(verified.grant, grant)

        let keys = MobileDeviceKeys(
            encryption: MobileDeviceEncryptionKey(publicKey: "public-encryption-key"),
            signing: MobileDeviceSigningKey(jwk: ["kty": .string("EC"), "kid": .string("device-key")])
        )
        let bound = try await client.bind(
            MobileDeviceBindRequest(
                deviceId: deviceId,
                deviceName: "Phone",
                appVersion: "2.3.4",
                tokenId: "token-1",
                keys: keys,
                syncIntervalSec: 60,
                bindReceipt: bindReceipt
            ),
            sid: sid,
            sensitiveGrant: grant
        )
        XCTAssertTrue(bound.bootstrapRequired)
        XCTAssertEqual(bound.accessCredential, "access-new")

        let refreshed = try await client.refresh(
            deviceId: deviceId,
            refreshCredential: "refresh-secret"
        )
        XCTAssertEqual(refreshed.accessCredential, "access-refreshed")
        XCTAssertEqual(refreshed.refreshCredential, "refresh-refreshed")

        let patched = try await client.patchDevice(
            deviceId: deviceId,
            patch: MobileDevicePatchRequest(deviceName: "Work Phone", automaticEnabled: false),
            sid: sid
        )
        XCTAssertEqual(patched.deviceName, "Phone")
        let revoked = try await client.revokeDevice(deviceId: deviceId, sid: sid, sensitiveGrant: grant)
        XCTAssertTrue(revoked.ok)
        XCTAssertEqual(requestCount, 5)

        for unsafeId in ["..", ".", "device/other", "device\\other", "device.name"] {
            do {
                _ = try await client.patchDevice(
                    deviceId: unsafeId,
                    patch: MobileDevicePatchRequest(enabled: false),
                    sid: sid
                )
                XCTFail("Expected unsafe device ID to be rejected")
            } catch let error as MobileApiError {
                XCTAssertEqual(error.code, "invalid_request")
            }
        }
        XCTAssertEqual(requestCount, 5)
    }

    func testSyncEndpointsUseFrozenPathsQueriesBodiesAndTypedResponses() async throws {
        var paths = [String]()
        var challengeCount = 0
        var expectedBodyDigest: String?
        let now: Int64 = 1_725_000_000_000
        let signer = MobileClientProofSigner()
        let coordinator = DeviceProofCoordinator(
            signer: signer,
            nowMilliseconds: { now }
        )
        URLProtocolStub.handler = { request in
            Self.assertSensitiveRequest(request)
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            if components.path == MobileApiPaths.postMobileV1DevicesProofChallenge {
                challengeCount += 1
                let body = try Self.jsonBody(request)
                expectedBodyDigest = body["bodySha256"] as? String
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"))
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
                let nonce = String(repeating: "N", count: 42) + String(challengeCount)
                return Self.response(
                    request,
                    json: Self.proofChallengeJSON(body: body, nonce: nonce)
                )
            }
            paths.append(components.path)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Zephyr-Server-Nonce"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Proof-Timestamp"), "1725000000")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"), signer.proof)
            let transmittedBody = request.httpBody ?? Data()
            XCTAssertEqual(
                try XCTUnwrap(expectedBodyDigest),
                Data(SHA256.hash(data: transmittedBody)).base64EncodedString()
            )
            expectedBodyDigest = nil

            switch components.path {
            case "/api/mobile/v1/sync/bootstrap":
                XCTAssertEqual(Self.query(components, "pageToken"), "page token/+==")
                XCTAssertEqual(Self.query(components, "limit"), "50")
                XCTAssertNil(Self.query(components, "pageSize"))
                return Self.response(
                    request,
                    json: """
                    {"ok":true,"bootstrapId":"boot-1","snapshotCursor":4,
                     "nextPageToken":null,"complete":true,"entities":[]}
                    """
                )
            case "/api/mobile/v1/sync/changes":
                XCTAssertEqual(Self.query(components, "cursor"), "4")
                XCTAssertEqual(Self.query(components, "limit"), "25")
                XCTAssertNil(Self.query(components, "sinceCursor"))
                return Self.response(
                    request,
                    json: """
                    {"ok":true,"fromCursor":4,"nextCursor":5,"hasMore":false,
                     "changes":[{"changeSeq":5,"entityType":"connection","entityId":"c-1",
                     "action":"delete","revision":2,"changedAt":100,"tombstone":{"id":"c-1"}}]}
                    """
                )
            case "/api/mobile/v1/sync/push":
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["protocolVersion"] as? Int, 1)
                XCTAssertEqual(body["deviceId"] as? String, "device-1")
                XCTAssertEqual((body["operations"] as? [[String: Any]])?.first?["opId"] as? String, "op-1")
                return Self.response(
                    request,
                    json: """
                    {"ok":true,"batchId":"batch-1","serverCursor":6,
                     "results":[{"opId":"op-1","status":"accepted","entityId":"c-1",
                     "revision":1,"changeSeq":6}],"changesAvailable":true}
                    """
                )
            case "/api/mobile/v1/sync/ack":
                let body = try Self.jsonBody(request)
                XCTAssertEqual(Set(body.keys), ["cursor"])
                XCTAssertEqual(body["cursor"] as? Int, 6)
                return Self.response(request, json: "{\"ok\":true}")
            case "/api/mobile/v1/sync/status":
                XCTAssertEqual(request.httpMethod, "GET")
                return Self.response(request, json: Self.statusJSON(cursor: 6))
            case "/api/mobile/v1/sync/now":
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(try Self.jsonBody(request).count, 0)
                return Self.response(request, json: Self.statusJSON(cursor: 7))
            default:
                XCTFail("Unexpected path \(components.path)")
                return Self.response(request, status: 404, json: "{}")
            }
        }

        let client = try makeClient(proofCoordinator: coordinator)
        let bootstrap = try await client.bootstrap(pageToken: "page token/+==", limit: 50)
        XCTAssertTrue(bootstrap.complete)
        XCTAssertEqual(bootstrap.snapshotCursor, 4)

        let changes = try await client.changes(cursor: 4, limit: 25)
        XCTAssertEqual(changes.nextCursor, 5)
        XCTAssertEqual(changes.changes.first?.action, .delete)
        XCTAssertEqual(changes.changes.first?.payload, [:])

        let operation = MobileSyncOperation(
            opId: "op-1",
            entityType: "connection",
            entityId: "c-1",
            action: .upsert,
            baseRevision: 0,
            fieldMask: ["name"],
            payload: ["name": .string("Test")]
        )
        let pushed = try await client.push(
            MobilePushRequest(
                deviceId: "device-1",
                batchId: "batch-1",
                baseCursor: 5,
                registryHash: "registry-hash",
                operations: [operation]
            )
        )
        XCTAssertEqual(pushed.results.first?.status, .accepted)
        XCTAssertTrue(pushed.changesAvailable)

        let ack = try await client.ack(MobileAckRequest(cursor: 6))
        let status = try await client.status()
        let nowResponse = try await client.now()
        XCTAssertEqual(ack.ok, true)
        XCTAssertEqual(status.cursor, 6)
        XCTAssertEqual(nowResponse.cursor, 7)
        XCTAssertEqual(challengeCount, 6)
        XCTAssertEqual(
            paths,
            [
                "/api/mobile/v1/sync/bootstrap",
                "/api/mobile/v1/sync/changes",
                "/api/mobile/v1/sync/push",
                "/api/mobile/v1/sync/ack",
                "/api/mobile/v1/sync/status",
                "/api/mobile/v1/sync/now",
            ]
        )
    }

    func testStructuredErrorUsesEnvelopeRetryAfterAndRedactsCredential() async throws {
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                status: 429,
                headers: ["Retry-After": "17", "X-Zephyr-Request-Id": "response-id"],
                json: """
                {"ok":false,"error":{"code":"rate_limited",
                 "message":"do not repeat access-token","retryable":true,
                 "requestId":"server-id","details":{"credential":"access-token",
                 "access-token":"server echoed a secret key"}}}
                """
            )
        }

        do {
            _ = try await makeClient().login(username: "alice", password: "access-token")
            XCTFail("Expected MobileApiError")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "rate_limited")
            XCTAssertEqual(error.httpStatus, 429)
            XCTAssertEqual(error.retryAfterSeconds, 17)
            XCTAssertEqual(error.requestId, "server-id")
            XCTAssertEqual(error.message, "do not repeat [REDACTED]")
            XCTAssertEqual(error.details["credential"], "[REDACTED]")
            XCTAssertEqual(error.details["[REDACTED]"], "server echoed a secret key")
            XCTAssertFalse(error.description.contains("access-token"))
            XCTAssertFalse(error.description.contains(error.message))
        }
    }

    func testTimeoutIsSanitizedAndCancellationIsPreserved() async throws {
        URLProtocolStub.handler = { _ in throw URLError(.timedOut) }
        do {
            _ = try await makeClient().login(username: "alice", password: "password")
            XCTFail("Expected timeout")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "network_timeout")
            XCTAssertTrue(error.retryable)
            XCTAssertEqual(error.requestId, "request-1")
        }

        URLProtocolStub.handler = { _ in throw URLError(.cancelled) }
        do {
            _ = try await makeClient().login(username: "alice", password: "password")
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Expected: cancellation is control flow, not a retryable API error.
        }
    }

    func testMalformedSuccessDoesNotExposeBodyOrCredential() async throws {
        URLProtocolStub.handler = { request in
            Self.response(request, json: "access-token is not JSON")
        }

        do {
            _ = try await makeClient().login(username: "alice", password: "access-token")
            XCTFail("Expected malformed response")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "malformed_response")
            XCTAssertFalse(error.message.contains("access-token"))
            XCTAssertFalse(error.description.contains("access-token"))
        }
    }

    func testRedirectIsRejected() async throws {
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                status: 302,
                headers: ["Location": "https://other.example.test/collect"],
                json: "{}"
            )
        }

        do {
            _ = try await makeClient().login(username: "alice", password: "access-token")
            XCTFail("Expected redirect rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "unexpected_redirect")
            XCTAssertEqual(error.httpStatus, 302)
            XCTAssertFalse(error.description.contains("other.example.test"))
            XCTAssertFalse(error.description.contains("access-token"))
        }
    }

    func testOversizedContentLengthIsRejectedBeforeTheBody() async throws {
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                headers: ["Content-Length": "257"],
                json: Self.statusJSON(cursor: 1)
            )
        }

        do {
            _ = try await makeClient(responseByteLimit: 256).login(username: "alice", password: "password")
            XCTFail("Expected response size rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "response_too_large")
            XCTAssertEqual(error.message, "response exceeds the 256 byte limit")
            XCTAssertFalse(error.retryable)
            XCTAssertEqual(error.httpStatus, 200)
            XCTAssertEqual(error.requestId, "request-1")
        }
    }

    func testDefault32MiBDeclaredLimitRejectsOneAdditionalByte() async throws {
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                headers: ["Content-Length": String(MobileApiClient.defaultResponseByteLimit + 1)],
                data: Data()
            )
        }

        do {
            _ = try await makeClient().login(username: "alice", password: "password")
            XCTFail("Expected production response limit rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "response_too_large")
            XCTAssertEqual(error.message, "response exceeds the 33554432 byte limit")
            XCTAssertEqual(error.httpStatus, 200)
        }
    }

    func testChunkedResponseWithoutContentLengthIsCancelledAtTheActualLimit() async throws {
        let cancelled = expectation(description: "oversized task cancelled")
        URLProtocolStub.chunkSize = 7
        URLProtocolStub.chunkDelay = 0.01
        URLProtocolStub.stopHandler = { cancelled.fulfill() }
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                json: Self.statusJSON(cursor: 2) + String(repeating: " ", count: 128)
            )
        }

        do {
            _ = try await makeClient(responseByteLimit: 96).login(username: "alice", password: "password")
            XCTFail("Expected response size rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "response_too_large")
            XCTAssertEqual(error.httpStatus, 200)
        }
        await fulfillment(of: [cancelled], timeout: 1)
    }

    func testDefault32MiBStreamedLimitRejectsOneAdditionalByte() async throws {
        URLProtocolStub.chunkSize = 1_048_576
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                data: Data(repeating: 0x20, count: MobileApiClient.defaultResponseByteLimit + 1)
            )
        }

        do {
            _ = try await makeClient().login(username: "alice", password: "password")
            XCTFail("Expected production streamed response limit rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "response_too_large")
            XCTAssertEqual(error.message, "response exceeds the 33554432 byte limit")
            XCTAssertEqual(error.httpStatus, 200)
        }
    }

    func testCallerCancellationCancelsTheUnderlyingTask() async throws {
        let started = expectation(description: "request started")
        let cancelled = expectation(description: "request cancelled")
        URLProtocolStub.chunkSize = 1
        URLProtocolStub.chunkDelay = 0.1
        URLProtocolStub.stopHandler = { cancelled.fulfill() }
        URLProtocolStub.handler = { request in
            started.fulfill()
            return Self.response(request, json: Self.statusJSON(cursor: 3))
        }

        let client = try makeClient()
        let task = Task { try await client.login(username: "alice", password: "password") }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Cancellation remains control flow and reaches the URLSessionTask.
        }
        await fulfillment(of: [cancelled], timeout: 1)
    }

    func testGzipLimitCountsURLSessionsDecompressedBytes() async throws {
        let compressed = try XCTUnwrap(Data(base64Encoded: "H4sIAAAAAAAEAKtWys9WsiopKk3VUSouSSxJVbJS8nTxcVXSUcpJLC5xLClJzS0AUkpWeaU5ORDB4NLk5NTiYpCgoYGBjlJyaVFxfpGSlZmOUkFqXkpmXrpzfmkeUBYkl5+XlpOZXIIQAZngWlQE0gAyslYBLwAA7/I8SKAAAAA="))
        XCTAssertEqual(compressed.count, 128)
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                headers: [
                    "Content-Encoding": "gzip",
                    "Content-Length": String(compressed.count),
                ],
                data: compressed
            )
        }

        do {
            _ = try await makeClient(responseByteLimit: compressed.count).login(username: "alice", password: "password")
            XCTFail("Expected decompressed response size rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "response_too_large")
        }
    }

    func testResponseExactlyAtTheLimitIsAccepted() async throws {
        let json = "{\"ok\":true,\"sid\":\"sid\",\"user\":{\"userId\":\"user-1\",\"username\":\"alice\"},\"mustChangePassword\":false}"
        let limit = Data(json.utf8).count + 32
        let body = json + String(repeating: " ", count: 32)
        XCTAssertEqual(Data(body.utf8).count, limit)
        URLProtocolStub.chunkSize = 5
        URLProtocolStub.handler = { request in
            Self.response(request, json: body)
        }

        let result = try await makeClient(responseByteLimit: limit).login(username: "alice", password: "password")
        guard case .authenticated(let session) = result else {
            XCTFail("Expected authenticated response")
            return
        }
        XCTAssertEqual(session.user.userId, "user-1")
    }

    func testOversizedErrorBodyUsesSanitizedStableError() async throws {
        let credential = "access-token"
        URLProtocolStub.chunkSize = 11
        URLProtocolStub.handler = { request in
            Self.response(
                request,
                status: 500,
                headers: ["X-Zephyr-Request-Id": "response-" + credential],
                json: "{\"secret\":\"" + credential + "\"}" + String(repeating: "x", count: 128)
            )
        }

        do {
            _ = try await makeClient(responseByteLimit: 64).login(username: "alice", password: credential)
            XCTFail("Expected response size rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "response_too_large")
            XCTAssertEqual(error.httpStatus, 500)
            XCTAssertEqual(error.requestId, "response-[REDACTED]")
            XCTAssertFalse(error.message.contains(credential))
            XCTAssertFalse(error.description.contains(credential))
            XCTAssertTrue(error.details.isEmpty)
        }
    }

    func testDeviceProofRetryAlwaysAcquiresNewChallengeAndRedactsProofSecrets() async throws {
        let now: Int64 = 1_725_000_000_000
        let signer = MobileClientProofSigner()
        let coordinator = DeviceProofCoordinator(signer: signer, nowMilliseconds: { now })
        var challengeCount = 0
        var targetCount = 0
        var issuedNonces = [String]()
        var issuedProofs = [String]()

        URLProtocolStub.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            if path == MobileApiPaths.postMobileV1DevicesProofChallenge {
                challengeCount += 1
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["method"] as? String, "GET")
                XCTAssertEqual(body["path"] as? String, "/api/mobile/v1/sync/status")
                XCTAssertEqual(body["bodySha256"] as? String, "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=")
                XCTAssertEqual(body["usage"] as? String, "sync.status")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-token")
                XCTAssertNil(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"))

                let nonce = String(repeating: challengeCount == 1 ? "A" : "B", count: 43)
                issuedNonces.append(nonce)
                return Self.response(
                    request,
                    json: """
                    {"ok":true,"challenge":{
                      "nonce":"\(nonce)","timestamp":1725000000,"expiresAt":1725000030000,
                      "method":"GET","canonicalPath":"/api/mobile/v1/sync/status",
                      "bodySha256":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
                      "usage":"sync.status","algorithm":"ES256","signatureFormat":"P1363",
                      "proofVersion":"zephyr-one-device-proof-v2"}}
                    """
                )
            }

            XCTAssertEqual(path, MobileApiPaths.getMobileV1SyncStatus)
            targetCount += 1
            let nonce = try XCTUnwrap(request.value(forHTTPHeaderField: "X-Zephyr-Server-Nonce"))
            let proof = try XCTUnwrap(request.value(forHTTPHeaderField: "X-Zephyr-Device-Proof"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Proof-Timestamp"), "1725000000")
            XCTAssertEqual(nonce, issuedNonces.last)
            issuedProofs.append(proof)
            let reflectedNonces = issuedNonces.joined(separator: " ")
            let reflectedProofs = issuedProofs.joined(separator: " ")
            return Self.response(
                request,
                status: 401,
                headers: [
                    "X-Zephyr-Request-Id": "response-" + reflectedNonces + "-" + reflectedProofs
                ],
                json: """
                {"ok":false,"error":{"code":"device_proof_invalid",
                 "message":"\(reflectedNonces) \(reflectedProofs)","retryable":false,
                 "details":{"leak":"\(reflectedProofs) \(reflectedNonces)"}}}
                """
            )
        }

        do {
            _ = try await makeClient(proofCoordinator: coordinator).status()
            XCTFail("Expected proof rejection")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "device_proof_invalid")
            XCTAssertEqual(
                error.requestId,
                "response-[REDACTED] [REDACTED]-[REDACTED] [REDACTED]"
            )
            XCTAssertEqual(
                error.message,
                "[REDACTED] [REDACTED] [REDACTED] [REDACTED]"
            )
            XCTAssertEqual(
                error.details["leak"],
                "[REDACTED] [REDACTED] [REDACTED] [REDACTED]"
            )
            for secret in issuedNonces + issuedProofs {
                XCTAssertFalse(error.requestId?.contains(secret) == true)
                XCTAssertFalse(error.description.contains(secret))
                XCTAssertFalse(error.message.contains(secret))
                XCTAssertFalse(error.details.values.contains { $0.contains(secret) })
            }
        }
        XCTAssertEqual(challengeCount, 2)
        XCTAssertEqual(targetCount, 2)
        XCTAssertEqual(Set(issuedNonces).count, 2)
        XCTAssertEqual(Set(issuedProofs).count, 2)
        XCTAssertEqual(issuedProofs, signer.proofs)
        XCTAssertEqual(signer.signCount, 2)
    }

    func testExpiredProofChallengeIsReplacedBeforeTheTargetIsSent() async throws {
        let now: Int64 = 1_725_000_000_000
        let signer = MobileClientProofSigner()
        let coordinator = DeviceProofCoordinator(signer: signer, nowMilliseconds: { now })
        var challengeCount = 0
        var targetCount = 0

        URLProtocolStub.handler = { request in
            if request.url?.path == MobileApiPaths.postMobileV1DevicesProofChallenge {
                challengeCount += 1
                let nonce = String(repeating: challengeCount == 1 ? "E" : "F", count: 43)
                let expiry = challengeCount == 1 ? now : now + 30_000
                return Self.response(
                    request,
                    json: """
                    {"ok":true,"challenge":{"nonce":"\(nonce)","timestamp":1725000000,
                    "expiresAt":\(expiry),"method":"GET",
                    "canonicalPath":"/api/mobile/v1/sync/status",
                    "bodySha256":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
                    "usage":"sync.status","algorithm":"ES256","signatureFormat":"P1363",
                    "proofVersion":"zephyr-one-device-proof-v2"}}
                    """
                )
            }

            targetCount += 1
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Zephyr-Server-Nonce"), String(repeating: "F", count: 43))
            return Self.response(request, json: Self.statusJSON(cursor: 9))
        }

        let status = try await makeClient(proofCoordinator: coordinator).status()

        XCTAssertEqual(status.cursor, 9)
        XCTAssertEqual(challengeCount, 2)
        XCTAssertEqual(targetCount, 1)
        XCTAssertEqual(signer.signCount, 1)
    }

    func testDeviceProofFailsClosedAndRejectsMismatchedChallengeBeforeTargetRequest() async throws {
        var networkCount = 0
        URLProtocolStub.handler = { request in
            networkCount += 1
            return Self.response(request, json: Self.statusJSON(cursor: 1))
        }
        do {
            _ = try await makeClient().status()
            XCTFail("Expected missing proof coordinator to fail closed")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "device_proof_unavailable")
        }
        XCTAssertEqual(networkCount, 0)

        let now: Int64 = 1_725_000_000_000
        let coordinator = DeviceProofCoordinator(
            signer: MobileClientProofSigner(),
            nowMilliseconds: { now }
        )
        var challengeCount = 0
        var targetCount = 0
        URLProtocolStub.handler = { request in
            if request.url?.path == MobileApiPaths.postMobileV1DevicesProofChallenge {
                challengeCount += 1
                return Self.response(
                    request,
                    json: """
                    {"ok":true,"challenge":{"nonce":"\(String(repeating: "M", count: 43))",
                    "timestamp":1725000000,"expiresAt":1725000030000,"method":"GET",
                    "canonicalPath":"/api/mobile/v1/sync/changes",
                    "bodySha256":"47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
                    "usage":"sync.status","algorithm":"ES256","signatureFormat":"P1363",
                    "proofVersion":"zephyr-one-device-proof-v2"}}
                    """
                )
            }
            targetCount += 1
            return Self.response(request, json: Self.statusJSON(cursor: 2))
        }

        do {
            _ = try await makeClient(proofCoordinator: coordinator).status()
            XCTFail("Expected challenge mismatch")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "malformed_response")
            XCTAssertFalse(error.message.contains("canonicalPath"))
        }
        XCTAssertEqual(challengeCount, 1)
        XCTAssertEqual(targetCount, 0)
    }

    func testSignerFailureIsOpaqueAndSignerCancellationIsPreserved() async throws {
        let now: Int64 = 1_725_000_000_000
        var challengeCount = 0
        var targetCount = 0
        URLProtocolStub.handler = { request in
            if request.url?.path == MobileApiPaths.postMobileV1DevicesProofChallenge {
                challengeCount += 1
                let body = try Self.jsonBody(request)
                let nonce = String(repeating: challengeCount == 1 ? "S" : "T", count: 43)
                return Self.response(
                    request,
                    json: Self.proofChallengeJSON(body: body, nonce: nonce)
                )
            }
            targetCount += 1
            return Self.response(request, json: Self.statusJSON(cursor: 3))
        }

        let failingCoordinator = DeviceProofCoordinator(
            signer: ThrowingMobileClientProofSigner(
                error: MobileApiError.local(code: "signer-secret", message: "signer-secret")
            ),
            nowMilliseconds: { now }
        )
        do {
            _ = try await makeClient(proofCoordinator: failingCoordinator).status()
            XCTFail("Expected signing failure")
        } catch let error as MobileApiError {
            XCTAssertEqual(error.code, "device_key_unavailable")
            XCTAssertFalse(error.description.contains("signer-secret"))
            XCTAssertFalse(error.message.contains("signer-secret"))
        }

        let cancellingCoordinator = DeviceProofCoordinator(
            signer: ThrowingMobileClientProofSigner(error: CancellationError()),
            nowMilliseconds: { now }
        )
        do {
            _ = try await makeClient(proofCoordinator: cancellingCoordinator).status()
            XCTFail("Expected signer cancellation")
        } catch is CancellationError {
            // Cancellation remains caller control flow.
        }
        XCTAssertEqual(challengeCount, 2)
        XCTAssertEqual(targetCount, 0)
    }

    func testCredentialBearingDescriptionsRedactEverySecret() throws {
        let loginRequest = MobileLoginRequest(
            username: "username-secret",
            password: "password-secret",
            captchaToken: "captcha-secret"
        )
        let totpRequest = MobileTotpRequest(tempToken: "temp-secret", code: "654321")
        let session = MobileAuthenticatedSession(
            sid: "sid-secret",
            user: MobileAuthUser(userId: "user-1", username: "alice")
        )
        let sensitiveRequest = MobileSensitiveVerifyRequest(
            secret: "verify-secret",
            tokenId: "token-secret",
            deviceId: "device-1234567890"
        )
        let refreshRequest = MobileDeviceRefreshRequest(
            deviceId: "device-1234567890",
            refreshCredential: "refresh-secret"
        )
        let bindRequest = MobileDeviceBindRequest(
            deviceId: "device-1234567890",
            deviceName: "Phone",
            appVersion: "2.3.4",
            tokenId: "token-secret",
            keys: MobileDeviceKeys(
                encryption: MobileDeviceEncryptionKey(publicKey: "encryption-key-secret"),
                signing: MobileDeviceSigningKey(jwk: ["d": .string("signing-key-secret")])
            ),
            syncIntervalSec: 60,
            bindReceipt: String(repeating: "r", count: 43)
        )
        let grant = try JSONDecoder().decode(
            MobileSensitiveGrantResponse.self,
            from: Data("{\"ok\":true,\"grant\":\"grant-secret\",\"expiresAt\":1,\"action\":\"device.bind\",\"targetHash\":\"hash-secret\"}".utf8)
        )
        let bound = try JSONDecoder().decode(
            MobileDeviceBindResponse.self,
            from: Data(Self.bindResponseJSON(deviceId: "device-1234567890").utf8)
        )
        let refreshed = try JSONDecoder().decode(
            MobileDeviceRefreshResponse.self,
            from: Data(Self.refreshResponseJSON(deviceId: "device-1234567890").utf8)
        )
        let values: [Any] = [
            loginRequest,
            totpRequest,
            session,
            MobileLoginResponse.totpRequired(tempToken: "temp-secret"),
            MobileLoginResponse.authenticated(session: session),
            sensitiveRequest,
            bindRequest,
            refreshRequest,
            DeviceProofAuthorization(
                nonce: "nonce-secret",
                timestamp: 1_725_000_000,
                proof: "proof-secret"
            ),
            grant,
            bound,
            refreshed,
        ]
        let secrets = [
            "username-secret", "password-secret", "captcha-secret", "temp-secret", "654321",
            "sid-secret", "verify-secret", "token-secret", "refresh-secret", "grant-secret",
            "access-new", "refresh-new", "access-refreshed", "refresh-refreshed",
            "encryption-key-secret", "signing-key-secret", "nonce-secret", "proof-secret",
        ]
        for value in values {
            let description = String(describing: value)
            for secret in secrets {
                XCTAssertFalse(description.contains(secret), "Description leaked \(secret): \(description)")
            }
        }
    }

    private func makeClient(
        baseURL: String = "https://example.test",
        responseByteLimit: Int = MobileApiClient.defaultResponseByteLimit,
        sha256SPKIPins: [String] = [],
        proofCoordinator: DeviceProofCoordinator? = nil,
        legacyCookieStorage: HTTPCookieStorage = .shared
    ) throws -> MobileApiClient {
        try MobileApiClient(
            baseURL: baseURL,
            appVersion: "2.3.4",
            session: session,
            requestTimeout: 5,
            responseByteLimit: responseByteLimit,
            sha256SPKIPins: sha256SPKIPins,
            proofCoordinator: proofCoordinator,
            legacyCookieStorage: legacyCookieStorage,
            credentialProvider: { "access-token" },
            requestIdProvider: { "request-1" }
        )
    }

    private static func assertSensitiveRequest(
        _ request: URLRequest,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData, file: file, line: line)
        XCTAssertFalse(request.httpShouldHandleCookies, file: file, line: line)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store", file: file, line: line)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache", file: file, line: line)
    }

    private static func cookie(
        name: String,
        value: String,
        domain: String,
        path: String = "/"
    ) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
            .secure: "TRUE",
        ]))
    }

    private static func query(_ components: URLComponents, _ name: String) -> String? {
        components.queryItems?.first { $0.name == name }?.value
    }

    private static func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data = try requestBody(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func requestBody(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody {
            return data
        }

        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let bytesRead = stream.read(&buffer, maxLength: buffer.count)
            if bytesRead < 0 {
                throw stream.streamError ?? URLError(.cannotDecodeRawData)
            }
            guard bytesRead > 0 else { break }
            data.append(contentsOf: buffer.prefix(bytesRead))
        }
        return data
    }

    private static func statusJSON(cursor: Int) -> String {
        """
        {"ok":true,"state":"IDLE","lastAttemptAt":null,"lastSuccessAt":100,
         "cursor":\(cursor),"pendingCount":0,"conflictCount":0,"lastError":null}
        """
    }

    private static func capabilitiesJSON(includeServerEncryption: Bool = true) -> String {
        let publicKey = Data(repeating: 0x42, count: 1184).base64EncodedString()
        let encryption = includeServerEncryption
            ? "\"serverEncryption\":{\"alg\":\"ML-KEM-768\",\"keyVersion\":3,\"publicKey\":\"\(publicKey)\"},"
            : ""
        return """
        {"ok":true,"protocolVersions":[1],"registryHash":"registry-hash",
        "minimumAppVersions":{"android":"2.0.0","ios":"2.0.0"},
        "limits":{"maxOpsPerBatch":200,"maxPageSize":500,"defaultPageSize":100,
        "minIntervalSec":30,"maxIntervalSec":86400,"blobChunkBytes":262144,
        "maxBlobBytes":1073741824,"tombstoneRetentionDays":30,"appliedOpRetentionDays":30},
        "serverId":"server-1","auth":{"sidHeader":"X-Zephyr-Sid","accessScheme":"Bearer",
        "proofHeader":"X-Zephyr-Device-Proof","nonceHeader":"X-Zephyr-Server-Nonce",
        "timestampHeader":"X-Zephyr-Proof-Timestamp",
        "challengePath":"/api/mobile/v1/devices/proof-challenge",
        "proofVersion":"zephyr-one-device-proof-v2","proofSkewSec":30,"challengeTtlSec":30,
        "challengeMaxActivePerDevice":4,"challengeMaxIssuesPerMinute":60,
        "signatureFormat":"P1363","encryptionAlg":"ML-KEM-768","signingAlg":"ES256"},
        \(encryption)
        "features":{"bidirectionalSync":true,"sharedResources":true,"fileBridge":true,
        "blobTransfer":true,"nearRealtimeWake":true},
        "wake":{"enabled":true,"transport":"sse","path":"/api/mobile/v1/sync/wake",
        "event":"wake","payloadFields":["cursor","epoch","reason"],"heartbeatSec":15,
        "retryMs":1000,"supportsLastEventId":true,"requiresDeviceAccess":true,
        "requiresDeviceProof":true,"maxConnections":100,"maxConnectionsPerOwner":5,
        "maxBufferedBytes":65536}}
        """
    }

    private static func deviceJSON(deviceId: String) -> String {
        """
        {"deviceId":"\(deviceId)","ownerUserId":"user-1","deviceName":"Phone",
        "platform":"ios","appVersion":"2.3.4","tokenId":"token-1","enabled":true,
        "automaticEnabled":true,"syncIntervalSec":60,"createdAt":1725000000000}
        """
    }

    private static func bindResponseJSON(deviceId: String) -> String {
        """
        {"ok":true,"device":\(deviceJSON(deviceId: deviceId)),"accessCredential":"access-new",
        "accessExpiresAt":1725003600000,"refreshCredential":"refresh-new",
        "registryHash":"registry-hash","bindingProtocolVersion":2,"bindingRevision":1,
        "bindingToken":"\(String(repeating: "t", count: 43))","bootstrapRequired":true}
        """
    }

    private static func refreshResponseJSON(deviceId: String) -> String {
        """
        {"ok":true,"device":\(deviceJSON(deviceId: deviceId)),"accessCredential":"access-refreshed",
        "accessExpiresAt":1725007200000,"refreshCredential":"refresh-refreshed",
        "registryHash":"registry-hash"}
        """
    }

    private static func proofChallengeJSON(body: [String: Any], nonce: String) -> String {
        let method = body["method"] as? String ?? ""
        let path = body["path"] as? String ?? ""
        let digest = body["bodySha256"] as? String ?? ""
        let usage = body["usage"] as? String ?? ""
        return """
        {"ok":true,"challenge":{"nonce":"\(nonce)","timestamp":1725000000,
        "expiresAt":1725000030000,"method":"\(method)","canonicalPath":"\(path)",
        "bodySha256":"\(digest)","usage":"\(usage)","algorithm":"ES256",
        "signatureFormat":"P1363","proofVersion":"zephyr-one-device-proof-v2"}}
        """
    }

    private static func response(
        _ request: URLRequest,
        status: Int = 200,
        headers: [String: String] = [:],
        json: String
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        return (response, Data(json.utf8))
    }

    private static func response(
        _ request: URLRequest,
        status: Int = 200,
        headers: [String: String] = [:],
        data: Data
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        return (response, data)
    }
}

private final class MobileClientProofSigner: DeviceProofSigning, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var signedProofs = [String]()

    var proof: String {
        lock.lock()
        defer { lock.unlock() }
        return signedProofs.last ?? Data(repeating: 0x33, count: 64).base64EncodedString()
    }

    var proofs: [String] {
        lock.lock()
        defer { lock.unlock() }
        return signedProofs
    }

    var signCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func sign(_ challenge: DeviceProofChallenge) throws -> String {
        lock.lock()
        let proof = Data(repeating: UInt8(0x33 + count), count: 64).base64EncodedString()
        count += 1
        signedProofs.append(proof)
        lock.unlock()
        return proof
    }
}

private final class ThrowingMobileClientProofSigner: DeviceProofSigning, @unchecked Sendable {
    private let error: Error

    init(error: Error) {
        self.error = error
    }

    func sign(_ challenge: DeviceProofChallenge) throws -> String {
        throw error
    }
}

private final class URLProtocolStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    static var chunkSize: Int?
    static var chunkDelay: TimeInterval = 0
    static var stopHandler: (() -> Void)?
    static var cacheStoragePolicy: URLCache.StoragePolicy = .notAllowed

    private let stateLock = NSLock()
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: Self.cacheStoragePolicy)
            if let chunkSize = Self.chunkSize, chunkSize > 0 {
                send(data, offset: 0, chunkSize: chunkSize)
            } else {
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
        Self.stopHandler?()
    }

    private func send(_ data: Data, offset: Int, chunkSize: Int) {
        stateLock.lock()
        let shouldStop = stopped
        stateLock.unlock()
        guard !shouldStop else { return }
        guard offset < data.count else {
            client?.urlProtocolDidFinishLoading(self)
            return
        }

        let end = min(offset + chunkSize, data.count)
        client?.urlProtocol(self, didLoad: data.subdata(in: offset..<end))
        let sendNext: () -> Void = { [weak self] in
            self?.send(data, offset: end, chunkSize: chunkSize)
        }
        if Self.chunkDelay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.chunkDelay, execute: sendNext)
        } else {
            sendNext()
        }
    }
}
