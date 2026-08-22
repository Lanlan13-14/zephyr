package one.zephyr.mobile.network.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import one.zephyr.mobile.model.Base64Codec
import one.zephyr.mobile.model.SecretEnvelope

/**
 * Wire DTOs for /api/mobile/v1.
 *
 * Field names and nullability track the live routes and contracts/openapi-mobile-v1.json. Unknown
 * additive keys remain forward-compatible, but authentication and credential-bearing success
 * payloads deliberately reject missing fields rather than inventing security-critical defaults.
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
    val captchaToken: String? = null,
    val remember: Boolean = false,
    /** Native clients must ask for the SID explicitly; the browser flow uses a cookie. */
    val returnSid: Boolean,
) {
    override fun toString(): String =
        "LoginRequestDto(username=[redacted], password=[redacted], captchaToken=[redacted], " +
            "remember=$remember, returnSid=$returnSid)"
}

@Serializable
data class LoginResponseDto(
    val ok: Boolean,
    val requireTotp: Boolean? = null,
    val tempToken: String? = null,
    val sid: String? = null,
    val user: AuthUserDto? = null,
    val mustChangePassword: Boolean? = null,
) {
    init {
        require(ok) { "login response ok must be true" }
        if (requireTotp == true) {
            require(!tempToken.isNullOrBlank()) { "TOTP response is missing its continuation token" }
            require(sid == null && user == null && mustChangePassword == null) {
                "TOTP response mixes challenge and authenticated session fields"
            }
        } else {
            require(tempToken == null) { "authenticated response carries an unexpected continuation token" }
            require(!sid.isNullOrBlank()) { "authenticated response is missing its SID" }
            requireNotNull(user) { "authenticated response is missing its user" }
            requireNotNull(mustChangePassword) {
                "authenticated response is missing mustChangePassword"
            }
        }
    }

    override fun toString(): String =
        "LoginResponseDto(ok=$ok, requireTotp=$requireTotp, tempToken=[redacted], " +
            "sid=[redacted], user=$user, mustChangePassword=$mustChangePassword)"
}

@Serializable
data class AuthUserDto(
    val userId: String,
    val username: String,
)

@Serializable
data class TotpRequestDto(
    val tempToken: String,
    val code: String,
    val returnSid: Boolean,
) {
    override fun toString(): String =
        "TotpRequestDto(tempToken=[redacted], code=[redacted], returnSid=$returnSid)"
}

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
data class LinkEnrollmentCreateRequestDto(
    val deviceId: String,
    val deviceName: String,
    val platform: String,
    val appVersion: String,
    val keys: DeviceKeysDto,
)

@Serializable
data class LinkEnrollmentCreateResponseDto(
    val ok: Boolean,
    val bindId: String,
    val userCode: String,
    val enrollmentSecret: String,
    val verificationUri: String,
    val sas: String,
    val fingerprint: String,
    val expiresAt: Long,
    val serverId: String,
    val pollMinIntervalMs: Long = 800,
    val qrDataUrl: String? = null,
    val deviceId: String,
    val deviceName: String,
    val platform: String,
) {
    init {
        require(ok) { "enrollment create response ok must be true" }
        require(bindId.isNotBlank()) { "enrollment create is missing bindId" }
        require(enrollmentSecret.isNotBlank()) { "enrollment create is missing its secret" }
        require(verificationUri.startsWith("https://")) { "enrollment verification URI must be https" }
    }

    override fun toString(): String =
        "LinkEnrollmentCreateResponseDto(ok=$ok, bindId=$bindId, userCode=$userCode, " +
            "enrollmentSecret=[redacted], verificationUri=$verificationUri, sas=$sas, " +
            "fingerprint=$fingerprint, expiresAt=$expiresAt, serverId=$serverId)"
}

@Serializable
data class LinkEnrollmentStatusDto(
    val ok: Boolean = false,
    val bindId: String,
    val status: String,
    val userCode: String? = null,
    val sas: String? = null,
    val fingerprint: String? = null,
    val deviceName: String? = null,
    val platform: String? = null,
    val expiresAt: Long? = null,
    val serverId: String? = null,
)

@Serializable
data class LinkEnrollmentConsumeRequestDto(
    val userCode: String,
    val enrollmentSecret: String,
    val proof: String,
    val keys: DeviceKeysDto,
    val syncIntervalSec: Int,
) {
    override fun toString(): String =
        "LinkEnrollmentConsumeRequestDto(userCode=$userCode, enrollmentSecret=[redacted], " +
            "proof=[redacted], syncIntervalSec=$syncIntervalSec)"
}

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
    val ok: Boolean,
    val device: DeviceDto,
    val accessCredential: String,
    val accessExpiresAt: Long,
    val refreshCredential: String,
    val registryHash: String,
    val bootstrapRequired: Boolean,
    val username: String? = null,
    val userId: String? = null,
) {
    init {
        require(ok) { "bind response ok must be true" }
        require(accessCredential.isNotBlank()) { "bind response is missing its access credential" }
        require(accessExpiresAt > 0L) { "bind response has an invalid access expiry" }
        require(refreshCredential.isNotBlank()) { "bind response is missing its refresh credential" }
        require(registryHash.isNotBlank()) { "bind response is missing its registry hash" }
        require(bootstrapRequired) { "fresh binding must require bootstrap" }
    }

    override fun toString(): String =
        "BindResponseDto(ok=$ok, device=$device, accessCredential=[redacted], " +
            "accessExpiresAt=$accessExpiresAt, refreshCredential=[redacted], " +
            "registryHash=$registryHash, bootstrapRequired=$bootstrapRequired)"
}

@Serializable
data class RefreshRequestDto(
    val deviceId: String,
    val refreshCredential: String,
) {
    override fun toString(): String =
        "RefreshRequestDto(deviceId=$deviceId, refreshCredential=[redacted])"
}

@Serializable
data class RefreshResponseDto(
    val ok: Boolean,
    val device: DeviceDto,
    val accessCredential: String,
    val accessExpiresAt: Long,
    val refreshCredential: String,
    val registryHash: String,
) {
    init {
        require(ok) { "refresh response ok must be true" }
        require(accessCredential.isNotBlank()) { "refresh response is missing its access credential" }
        require(accessExpiresAt > 0L) { "refresh response has an invalid access expiry" }
        require(refreshCredential.isNotBlank()) { "refresh response is missing its refresh credential" }
        require(registryHash.isNotBlank()) { "refresh response is missing its registry hash" }
    }

    override fun toString(): String =
        "RefreshResponseDto(ok=$ok, device=$device, accessCredential=[redacted], " +
            "accessExpiresAt=$accessExpiresAt, refreshCredential=[redacted], registryHash=$registryHash)"
}

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
    val clearSecretFields: List<String>? = null,
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
data class MinimumAppVersionsDto(
    val android: String,
    val ios: String,
)

@Serializable
data class CapabilityLimitsDto(
    val maxOpsPerBatch: Long,
    val maxPageSize: Long,
    val defaultPageSize: Long,
    val minIntervalSec: Long,
    val maxIntervalSec: Long,
    val blobChunkBytes: Long,
    val maxBlobBytes: Long,
    val tombstoneRetentionDays: Long,
    val appliedOpRetentionDays: Long,
)

@Serializable
data class AuthCapabilitiesDto(
    val sidHeader: String,
    val accessScheme: String,
    val proofHeader: String,
    val nonceHeader: String,
    val timestampHeader: String,
    val challengePath: String,
    val proofVersion: String,
    val proofSkewSec: Int,
    val challengeTtlSec: Int,
    val challengeMaxActivePerDevice: Int,
    val challengeMaxIssuesPerMinute: Int,
    val signatureFormat: String,
    val encryptionAlg: String,
    val signingAlg: String,
) {
    init {
        require(sidHeader == "X-Zephyr-Sid" && accessScheme == "Bearer") {
            "capability auth scheme is unsupported"
        }
        require(
            proofHeader == "X-Zephyr-Device-Proof" &&
                nonceHeader == "X-Zephyr-Server-Nonce" &&
                timestampHeader == "X-Zephyr-Proof-Timestamp",
        ) { "capability proof headers are unsupported" }
        require(challengePath == "/api/mobile/v1/devices/proof-challenge") {
            "capability challenge path is unsupported"
        }
        require(proofVersion == "zephyr-one-device-proof-v2" && proofSkewSec > 0 && challengeTtlSec > 0) {
            "capability proof timing is invalid"
        }
        require(challengeMaxActivePerDevice > 0 && challengeMaxIssuesPerMinute > 0) {
            "capability challenge limits are invalid"
        }
        require(signatureFormat == "P1363" && encryptionAlg == "ML-KEM-768" && signingAlg == "ES256") {
            "capability proof algorithms are unsupported"
        }
    }
}

@Serializable
data class ServerEncryptionDto(
    val alg: String,
    val keyVersion: Int,
    val publicKey: String,
) {
    init {
        val decodedKeySize = runCatching { Base64Codec.decode(publicKey).size }.getOrDefault(-1)
        require(alg == "ML-KEM-768" && keyVersion > 0 && decodedKeySize == 1184) {
            "server encryption capability is invalid"
        }
    }
}

/**
 * A non-null wrapper keeps an omitted key distinct from the server's explicit `null` value even
 * though the shared JSON configuration uses explicitNulls=false for additive compatibility.
 */
@Serializable(with = ServerEncryptionCapabilityDto.Serializer::class)
sealed interface ServerEncryptionCapabilityDto {
    data object Unavailable : ServerEncryptionCapabilityDto

    data class Available(val value: ServerEncryptionDto) : ServerEncryptionCapabilityDto

    object Serializer : KSerializer<ServerEncryptionCapabilityDto> {
        override val descriptor: SerialDescriptor =
            buildClassSerialDescriptor("ServerEncryptionCapability")

        override fun deserialize(decoder: Decoder): ServerEncryptionCapabilityDto {
            val jsonDecoder = decoder as? JsonDecoder
                ?: throw SerializationException("server encryption capability requires JSON")
            return when (val element = jsonDecoder.decodeJsonElement()) {
                JsonNull -> Unavailable
                is JsonObject -> Available(
                    jsonDecoder.json.decodeFromJsonElement(ServerEncryptionDto.serializer(), element),
                )
                else -> throw SerializationException("server encryption capability must be an object or null")
            }
        }

        override fun serialize(encoder: Encoder, value: ServerEncryptionCapabilityDto) {
            val jsonEncoder = encoder as? JsonEncoder
                ?: throw SerializationException("server encryption capability requires JSON")
            val element = when (value) {
                Unavailable -> JsonNull
                is Available -> jsonEncoder.json.encodeToJsonElement(ServerEncryptionDto.serializer(), value.value)
            }
            jsonEncoder.encodeJsonElement(element)
        }
    }
}

@Serializable
data class FeatureCapabilitiesDto(
    val bidirectionalSync: Boolean,
    val sharedResources: Boolean,
    val fileBridge: Boolean,
    val blobTransfer: Boolean,
    val nearRealtimeWake: Boolean,
    val linkEnrollment: Boolean = false,
)

@Serializable
data class WakeCapabilitiesDto(
    val enabled: Boolean,
    val transport: String,
    val path: String,
    val event: String,
    val payloadFields: List<String>,
    val heartbeatSec: Int,
    val retryMs: Long,
    val supportsLastEventId: Boolean,
    val requiresDeviceAccess: Boolean,
    val requiresDeviceProof: Boolean,
    val maxConnections: Int,
    val maxConnectionsPerOwner: Int,
    val maxBufferedBytes: Long,
) {
    init {
        require(enabled) { "wake transport is disabled" }
        require(transport == "sse" && path == "/api/mobile/v1/sync/wake" && event == "wake") {
            "wake transport metadata is unsupported"
        }
        require(payloadFields == listOf("cursor", "epoch", "reason")) {
            "wake transport payload is unsupported"
        }
        require(heartbeatSec > 0 && retryMs > 0L) { "wake transport timing is invalid" }
        require(supportsLastEventId) { "wake transport must support Last-Event-ID" }
        require(requiresDeviceAccess && requiresDeviceProof) { "wake transport authentication is incomplete" }
        require(maxConnections > 0 && maxConnectionsPerOwner > 0 && maxBufferedBytes > 0L) {
            "wake transport limits are invalid"
        }
    }
}

@Serializable
data class CapabilitiesDto(
    val ok: Boolean,
    val protocolVersions: List<Int>,
    val registryHash: String,
    val minimumAppVersions: MinimumAppVersionsDto? = null,
    val limits: CapabilityLimitsDto,
    val serverId: String,
    val auth: AuthCapabilitiesDto,
    /** Required on the wire, but explicitly null when the server cannot publish its key. */
    val serverEncryption: ServerEncryptionCapabilityDto,
    val features: FeatureCapabilitiesDto,
    val wake: WakeCapabilitiesDto,
) {
    init {
        require(ok) { "capabilities response ok must be true" }
        require(protocolVersions.isNotEmpty()) { "capabilities response has no protocol versions" }
        require(registryHash.isNotBlank()) { "capabilities response is missing its registry hash" }
        require(serverId.isNotBlank()) { "capabilities response is missing its server id" }
    }
}

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

/**
 * The ACK endpoint is a durability boundary, so its open-object schema is interpreted narrowly.
 * A generic `ok` DTO would either default a missing field or let callers ignore `false`; this
 * serializer accepts exactly the success receipt current servers issue and nothing else.
 */
@Serializable(with = AckResponseDto.Serializer::class)
data object AckResponseDto {
    object Serializer : KSerializer<AckResponseDto> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AckResponse") {
            element<Boolean>("ok")
        }

        override fun deserialize(decoder: Decoder): AckResponseDto {
            val jsonDecoder = decoder as? JsonDecoder
                ?: throw SerializationException("ack response requires JSON")
            val response = jsonDecoder.decodeJsonElement() as? JsonObject
                ?: throw SerializationException("ack response must be an object")
            if (response.size != 1 || response["ok"] != JsonPrimitive(true)) {
                throw SerializationException("ack response must contain only literal ok true")
            }
            return AckResponseDto
        }

        override fun serialize(encoder: Encoder, value: AckResponseDto) {
            val jsonEncoder = encoder as? JsonEncoder
                ?: throw SerializationException("ack response requires JSON")
            jsonEncoder.encodeJsonElement(JsonObject(mapOf("ok" to JsonPrimitive(true))))
        }
    }
}

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
