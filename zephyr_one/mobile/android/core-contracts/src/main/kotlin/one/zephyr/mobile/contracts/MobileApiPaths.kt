// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

package one.zephyr.mobile.contracts

/** Paths taken verbatim from contracts/openapi-mobile-v1.json. */
object MobileApiPaths {
    const val TITLE: String = "Zephyr One Mobile API"
    const val VERSION: String = "1.0.0"
    const val PROTOCOL_VERSION: Int = 1

    const val POST_AUTH_LOGIN: String = "/api/auth/login"
    const val POST_AUTH_TOTP_VERIFY: String = "/api/auth/totp/verify"
    const val GET_MOBILE_V1_CAPABILITIES: String = "/api/mobile/v1/capabilities"
    const val POST_MOBILE_V1_DEVICES_BIND: String = "/api/mobile/v1/devices/bind"
    const val POST_MOBILE_V1_DEVICES_REFRESH: String = "/api/mobile/v1/devices/refresh"
    const val GET_MOBILE_V1_DEVICES: String = "/api/mobile/v1/devices"
    const val PATCH_MOBILE_V1_DEVICES_BY: String = "/api/mobile/v1/devices/{deviceId}"
    const val DELETE_MOBILE_V1_DEVICES_BY: String = "/api/mobile/v1/devices/{deviceId}"
    const val GET_MOBILE_V1_SYNC_BOOTSTRAP: String = "/api/mobile/v1/sync/bootstrap"
    const val GET_MOBILE_V1_SYNC_CHANGES: String = "/api/mobile/v1/sync/changes"
    const val POST_MOBILE_V1_SYNC_PUSH: String = "/api/mobile/v1/sync/push"
    const val POST_MOBILE_V1_SYNC_ACK: String = "/api/mobile/v1/sync/ack"
    const val POST_MOBILE_V1_SYNC_NOW: String = "/api/mobile/v1/sync/now"
    const val GET_MOBILE_V1_SYNC_STATUS: String = "/api/mobile/v1/sync/status"
    const val POST_MOBILE_V1_SENSITIVE_VERIFY: String = "/api/mobile/v1/sensitive/verify"
    const val POST_MOBILE_V1_FILE_BRIDGE_LEASE: String = "/api/mobile/v1/file-bridge/lease"
    const val GET_MOBILE_V1_SHARED: String = "/api/mobile/v1/shared"
    const val GET_MOBILE_V1_SHARED_BY_BY: String = "/api/mobile/v1/shared/{resourceType}/{resourceId}"
    const val POST_MOBILE_V1_SHARED_BY_BY_INVOKE: String = "/api/mobile/v1/shared/{resourceType}/{resourceId}/invoke"
    const val POST_MOBILE_V1_SHARED_SESSIONS_BY_REFRESH: String = "/api/mobile/v1/shared/sessions/{sessionId}/refresh"
    const val DELETE_MOBILE_V1_SHARED_SESSIONS_BY: String = "/api/mobile/v1/shared/sessions/{sessionId}"
    const val POST_MOBILE_V1_SHARED_CONNECTIONS_BY_SESSIONS: String = "/api/mobile/v1/shared/connections/{connectionId}/sessions"

    fun deviceById(deviceId: String): String = "/api/mobile/v1/devices/" + deviceId

    fun sharedResource(resourceType: String, resourceId: String): String =
        "/api/mobile/v1/shared/" + resourceType + "/" + resourceId

    fun sharedConnectionSessions(connectionId: String): String =
        "/api/mobile/v1/shared/connections/" + connectionId + "/sessions"

    fun sharedSession(sessionId: String): String =
        "/api/mobile/v1/shared/sessions/" + sessionId
}
