// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

import Foundation

/// Paths taken verbatim from contracts/openapi-mobile-v1.json.
public enum MobileApiPaths {
    public static let title = "Zephyr One Mobile API"
    public static let version = "1.0.0"
    public static let protocolVersion = 1

    public static let postAuthLogin = "/api/auth/login"
    public static let postAuthTotpVerify = "/api/auth/totp/verify"
    public static let getMobileV1Capabilities = "/api/mobile/v1/capabilities"
    public static let postMobileV1DevicesBind = "/api/mobile/v1/devices/bind"
    public static let postMobileV1DevicesRefresh = "/api/mobile/v1/devices/refresh"
    public static let getMobileV1Devices = "/api/mobile/v1/devices"
    public static let patchMobileV1DevicesBy = "/api/mobile/v1/devices/{deviceId}"
    public static let deleteMobileV1DevicesBy = "/api/mobile/v1/devices/{deviceId}"
    public static let getMobileV1SyncBootstrap = "/api/mobile/v1/sync/bootstrap"
    public static let getMobileV1SyncChanges = "/api/mobile/v1/sync/changes"
    public static let postMobileV1SyncPush = "/api/mobile/v1/sync/push"
    public static let postMobileV1SyncAck = "/api/mobile/v1/sync/ack"
    public static let postMobileV1SyncNow = "/api/mobile/v1/sync/now"
    public static let getMobileV1SyncStatus = "/api/mobile/v1/sync/status"
    public static let postMobileV1SensitiveVerify = "/api/mobile/v1/sensitive/verify"
    public static let postMobileV1FileBridgeLease = "/api/mobile/v1/file-bridge/lease"
    public static let getMobileV1Shared = "/api/mobile/v1/shared"
    public static let getMobileV1SharedByBy = "/api/mobile/v1/shared/{resourceType}/{resourceId}"
    public static let postMobileV1SharedByByInvoke = "/api/mobile/v1/shared/{resourceType}/{resourceId}/invoke"
    public static let postMobileV1SharedSessionsByRefresh = "/api/mobile/v1/shared/sessions/{sessionId}/refresh"
    public static let deleteMobileV1SharedSessionsBy = "/api/mobile/v1/shared/sessions/{sessionId}"
    public static let postMobileV1SharedConnectionsBySessions = "/api/mobile/v1/shared/connections/{connectionId}/sessions"

    public static func deviceById(_ deviceId: String) -> String {
        "/api/mobile/v1/devices/" + deviceId
    }

    public static func sharedResource(_ resourceType: String, _ resourceId: String) -> String {
        "/api/mobile/v1/shared/" + resourceType + "/" + resourceId
    }

    public static func sharedSession(_ sessionId: String) -> String {
        "/api/mobile/v1/shared/sessions/" + sessionId
    }
}
