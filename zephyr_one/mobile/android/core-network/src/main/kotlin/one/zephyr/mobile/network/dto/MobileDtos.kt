package one.zephyr.mobile.network.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.model.SecretEnvelope

/**
 * Wire DTOs for /api/mobile/v1.
 *
 * Field names and nullability track contracts/openapi-mobile-v1.json exactly. Anything the schema
 * marks optional is nullable here so a older/newer server cannot cause a parse crash, and unknown
 * keys are ignored by the Json configuration in [one.zephyr.mobile.network.MobileJson].
 */
@Serializable
data class ErrorEnvelopeDto(
    val ok: Boolean = false,
    val error: ErrorBodyDto,
)

@Serializable
data class ErrorBodyDto(
    val code: String,
    val message: String = "",
    val retryable: Boolean = false,
    val requestId: String? = null,
    val details: JsonObject? = null,
)

@Serializable
data class LoginRequestDto(
    val username: String,
    val password: String,
    /** Native clients must ask for the SID explicitly; the browser flow uses a cookie. */
    val returnSid: Boolean = true,
)

@Serializable
data class LoginResponseDto(
    val ok: Boolean = false,
    val sid: String? = null,
    val totpRequired: Boolean = false,
    val userId: String? = null,
    val username: String? = null,
)

@Serializable
data class TotpRequestDto(val code: String, val returnSid: Boolean = true)

@Serializable
data class DeviceEncryptionKeyDto(
    val alg: String,
    val publicKey: String,
)

@Serializable
data class DeviceSigningKeyDto(
    val alg: String,
    val jwk: JsonObject,
)

@Serializable
data class DeviceKeysDto(
    val encryption: DeviceEncryptionKeyDto,
    val signing: DeviceSigningKeyDto,
)

@Serializable
data class BindRequestDto(
    val deviceId: String,
    val deviceName: String,
    val platform: String,
    val appVersion: String,
    val tokenId: String,
    val keys: DeviceKeysDto,
    val syncIntervalSec: Int,
)

@Serializable
data class DeviceDto(
    val deviceId: String,
    val ownerUserId: String,
    val deviceName: String,
    val platform: String,
    val appVersion: String,
    val tokenId: String,
    val enabled: Boolean,
    val automaticEnabled: Boolean,
    val syncIntervalSec: Int,
    val lastSyncAt: Long? = null,
    val lastSeenAt: Long? = null,
    val createdAt: Long,
    val revokedAt: Long? = null,
)

@Serializable
data class BindResponseDto(
    val ok: Boolean = false,
    val device: DeviceDto,
    val accessCredential: String,
    val accessExpiresAt: Long? = null,
    val refreshCredential: String,
    val registryHash: String,
    val bootstrapRequired: Boolean? = null,
)

@Serializable
data class SyncOperationDto(
    val opId: String,
    val entityType: String,
    val entityId: String,
    val action: String,
    val baseRevision: Long,
    val clientModifiedAt: Long? = null,
    val fieldMask: List<String> = emptyList(),
    val payload: JsonObject = JsonObject(emptyMap()),
    val secretEnvelopes: Map<String, SecretEnvelope>? = null,
)

@Serializable
data class SyncChangeDto(
    val changeSeq: Long,
    val entityType: String,
    val entityId: String,
    val action: String,
    val revision: Long,
    val actorDeviceId: String? = null,
    val changedAt: Long,
    val fieldMask: List<String> = emptyList(),
    val payload: JsonObject = JsonObject(emptyMap()),
    val secretEnvelopes: Map<String, SecretEnvelope>? = null,
    val tombstone: JsonObject? = null,
)

@Serializable
data class PushRequestDto(
    val protocolVersion: Int,
    val deviceId: String,
    val batchId: String,
    val baseCursor: Long,
    val registryHash: String,
    val operations: List<SyncOperationDto>,
)

@Serializable
data class PushResultDto(
    val opId: String,
    val status: String,
    val entityId: String? = null,
    val revision: Long? = null,
    val changeSeq: Long? = null,
    val error: ErrorEnvelopeDto? = null,
    val conflict: JsonObject? = null,
)

@Serializable
data class PushResponseDto(
    val ok: Boolean = false,
    val batchId: String,
    val serverCursor: Long,
    val results: List<PushResultDto> = emptyList(),
    val changesAvailable: Boolean = false,
)

@Serializable
data class ChangePageDto(
    val ok: Boolean = false,
    val fromCursor: Long,
    val nextCursor: Long,
    val hasMore: Boolean,
    val changes: List<SyncChangeDto> = emptyList(),
)

@Serializable
data class BootstrapPageDto(
    val ok: Boolean = false,
    val bootstrapId: String,
    val snapshotCursor: Long,
    val nextPageToken: String? = null,
    val complete: Boolean,
    val entities: List<SyncChangeDto> = emptyList(),
)

@Serializable
data class CapabilitiesDto(
    val ok: Boolean = false,
    val protocolVersions: List<Int> = emptyList(),
    val registryHash: String,
    val minimumAppVersions: JsonObject? = null,
    val limits: JsonObject = JsonObject(emptyMap()),
    val auth: JsonObject = JsonObject(emptyMap()),
    val features: JsonObject? = null,
)

@Serializable
data class SensitiveVerifyRequestDto(
    val action: String,
    val secret: String,
    val targetIds: List<String> = emptyList(),
)

@Serializable
data class SensitiveGrantDto(
    val ok: Boolean = false,
    val grant: String,
    val expiresAt: Long,
    val action: String,
    val targetHash: String,
)

@Serializable
data class SyncStatusDto(
    val ok: Boolean = false,
    val state: String,
    val lastAttemptAt: Long? = null,
    val lastSuccessAt: Long? = null,
    val cursor: Long,
    val pendingCount: Int,
    val conflictCount: Int,
    val lastError: ErrorEnvelopeDto? = null,
)

@Serializable
data class AckRequestDto(
    val deviceId: String,
    val cursor: Long,
    val appliedOpIds: List<String> = emptyList(),
)

@Serializable
data class SharedResourceSummaryDto(
    val resourceType: String,
    val resourceId: String,
    val displayName: String,
    /**
     * `ownerDisplayName` in the frozen schema, not `ownerLabel`.
     *
     * This DTO previously named it `ownerLabel`, which is not a key the server
     * ever sends: SharedResourceSummary is `additionalProperties: false` with
     * exactly seven properties. kotlinx would have defaulted it silently, so
     * every shared row would have rendered with a blank owner and the residency
     * UI could not have told the user whose resource it was.
     */
    val ownerDisplayName: String,
    val capabilities: List<String> = emptyList(),
    val revision: Long,
    val expiresAt: Long? = null,
    /*
     * Below here: detail-only enrichment. GET /shared/{type}/{id} has a free-form
     * 200 schema and the server adds non-secret connect metadata to it, while the
     * list projection is restricted to the seven schema properties. Nullable so
     * the same DTO can parse both without inventing values for the list case.
     */
    val protocol: String? = null,
    val host: String? = null,
    val port: Int? = null,
    val username: String? = null,
    /** Null in a list response; the caller must fall back to the capability set. */
    val directUseAllowed: Boolean? = null,
    val hasContent: Boolean? = null,
)

@Serializable
data class SharedListDto(
    /**
     * `items`, not `resources`, and there is no `ok` field.
     *
     * The frozen 200 schema for GET /api/mobile/v1/shared requires `items` and
     * allows `nextPageToken`. Reading `resources` produced an always-empty list,
     * so the shared directory would have looked permanently empty to the user
     * even while the server was returning rows.
     */
    val items: List<SharedResourceSummaryDto> = emptyList(),
    val nextPageToken: String? = null,
)

@Serializable
data class SharedSessionRequestDto(
    /**
     * `direct-ephemeral` or `relay-strict`. The schema is an enum with
     * `additionalProperties: false`, so the old `purpose`/`requestDirect` pair
     * was rejected outright rather than merely misread.
     */
    val mode: String,
    /** >= 22 chars per the schema; the server refuses a shorter nonce with 400. */
    val clientSessionNonce: String,
    val requestedChannels: List<String> = emptyList(),
    val deviceKeyVersion: Int,
)

@Serializable
data class SharedSessionResponseDto(
    val sessionId: String,
    /** `direct-ephemeral` or `relay-strict`, never the bare word `direct`. */
    val mode: String,
    val expiresAt: Long,
    val capabilities: List<String> = emptyList(),
    /** Present only for `direct-ephemeral`. */
    val useEnvelope: JsonObject? = null,
    /** Present only for `relay-strict`. */
    val relay: SharedRelayDto? = null,
)

/**
 * Where to attach a relay-strict session, and the token that authorises it.
 *
 * The credential is scoped to this one session and is not a bearer token for
 * anything else (SHARED_RESOURCE_RESIDENCY.md 3.3). It carries no connect
 * material: the main end holds the credential and proxies the protocol.
 */
@Serializable
data class SharedRelayDto(
    val websocketUrl: String? = null,
    val protocol: String? = null,
    val credential: String? = null,
)

/**
 * Body for POST /shared/sessions/{id}/refresh.
 *
 * The frozen schema requires `clientSessionNonce` (minLength 22) and sets
 * `additionalProperties: false`. The client previously posted `{ ok: true }`
 * here, which the server rejects with 400 `invalid_request` - so a dropped
 * relay socket could never be re-established inside a live grant, and a
 * direct session could never be re-sealed under a fresh nonce.
 */
@Serializable
data class SharedSessionRefreshDto(
    val clientSessionNonce: String,
)

@Serializable
data class SharedInvokeRequestDto(
    val operation: String,
    val arguments: JsonObject = JsonObject(emptyMap()),
    /** Required by the server for note `update`; omitted for reads. */
    val expectedRevision: Long? = null,
    val runId: String? = null,
)

@Serializable
data class SharedInvokeResponseDto(
    val ok: Boolean = false,
    /** Required by the schema: the revision to send back on the next edit. */
    val revision: Long = 0,
    val result: JsonElement? = null,
    val auditId: String? = null,
)

@Serializable
data class FileBridgeLeaseRequestDto(
    /**
     * The frozen body requires `shareProfileIds`; `connectionId`/`rootLabel`/
     * `ttlSeconds` were never part of it. A lease is taken over device-local
     * share profiles, and the TTL is the server's to decide.
     */
    val shareProfileIds: List<String>,
    val readOnly: Boolean = true,
)

@Serializable
data class FileBridgeLeaseResponseDto(
    val ok: Boolean = false,
    val leaseId: String,
    val endpoint: String,
    val expiresAt: Long,
    val readOnly: Boolean,
    val maxInflight: Int = 8,
    val chunkBytes: Int = 262144,
)

@Serializable
data class DeviceListDto(
    val ok: Boolean = false,
    val devices: List<DeviceDto> = emptyList(),
)

@Serializable
data class DevicePatchDto(
    val deviceName: String? = null,
    val enabled: Boolean? = null,
    val automaticEnabled: Boolean? = null,
    val syncIntervalSec: Int? = null,
)
