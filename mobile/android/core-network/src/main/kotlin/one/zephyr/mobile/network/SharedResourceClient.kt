package one.zephyr.mobile.network

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.MobileApiPaths
import one.zephyr.mobile.model.CapabilitySet
import one.zephyr.mobile.model.SharedUseEnvelope
import one.zephyr.mobile.model.SharedUsePolicy
import one.zephyr.mobile.network.dto.SharedInvokeRequestDto
import one.zephyr.mobile.network.dto.SharedInvokeResponseDto
import one.zephyr.mobile.network.dto.SharedListDto
import one.zephyr.mobile.network.dto.SharedResourceSummaryDto
import one.zephyr.mobile.network.dto.SharedSessionRequestDto
import one.zephyr.mobile.network.dto.SharedSessionResponseDto

/** A resource shared with the bound account. Online-only, never persisted. */
data class SharedResource(
    val resourceType: String,
    val resourceId: String,
    val displayName: String,
    val ownerLabel: String,
    val capabilities: CapabilitySet,
    val expiresAt: Long?,
    val usePolicy: SharedUsePolicy,
    val revision: Long,
    val protocol: String?,
)

/** How a shared session was opened. The UI must state which one happened. */
sealed interface SharedSession {
    val sessionId: String
    val expiresAt: Long

    /** Credentials stayed on the main end; One only relays bytes. */
    data class Relay(
        override val sessionId: String,
        override val expiresAt: Long,
        val relayUrl: String,
    ) : SharedSession

    /**
     * The owner permitted a direct session, so connection material was decrypted into One's memory.
     * The envelope is handed straight to the session arena and is never written anywhere.
     */
    data class Direct(
        override val sessionId: String,
        override val expiresAt: Long,
        val envelope: SharedUseEnvelope,
    ) : SharedSession
}

/**
 * Shared-to-me access.
 *
 * Kept in its own client rather than folded into [MobileApi] because the residency rules are
 * different in kind, not degree: SHARED_RESOURCE_RESIDENCY.md 3 forbids any of these responses from
 * reaching Room, the SecretStore, the FTS index, a backup, a log or a notification. Every method
 * here therefore returns a value the caller is expected to hold in memory for the life of a screen
 * and drop, and there is deliberately no cache and no repository behind it.
 */
class SharedResourceClient(private val client: MobileApiClient) {

    /** Fetched fresh every time the list is shown. There is no offline-with-cache state for these. */
    suspend fun list(): ApiResult<List<SharedResource>> =
        client.get(MobileApiPaths.GET_MOBILE_V1_SHARED, SharedListDto.serializer())
            .map { dto -> dto.resources.map(::toDomain) }

    suspend fun detail(resourceType: String, resourceId: String): ApiResult<SharedResource> =
        client.get(
            path = MobileApiPaths.sharedResource(resourceType, resourceId),
            responseSerializer = SharedResourceSummaryDto.serializer(),
        ).map(::toDomain)

    /**
     * Runs an operation on the owner's behalf without the credential ever leaving the server.
     *
     * This is the path used for everything except a native terminal or remote-desktop session, so a
     * shared connection can be listed, observed and operated without a direct-use envelope.
     */
    suspend fun invoke(
        resourceType: String,
        resourceId: String,
        operation: String,
        arguments: JsonObject = JsonObject(emptyMap()),
    ): ApiResult<SharedInvokeResponseDto> =
        client.post(
            path = MobileApiPaths.sharedResource(resourceType, resourceId) + "/invoke",
            body = SharedInvokeRequestDto(operation = operation, arguments = arguments),
            bodySerializer = SharedInvokeRequestDto.serializer(),
            responseSerializer = SharedInvokeResponseDto.serializer(),
        )

    /**
     * Opens a session on a shared connection.
     *
     * [requestDirect] is a request, not a decision: the owner's policy is authoritative and the
     * server may answer with a relay session anyway. One must never treat a relay answer as a
     * failure or retry it as direct.
     */
    suspend fun openSession(
        connectionId: String,
        purpose: String,
        clientNonce: String,
        requestDirect: Boolean,
    ): ApiResult<SharedSession> =
        client.post(
            path = "/api/mobile/v1/shared/connections/" + connectionId + "/sessions",
            body = SharedSessionRequestDto(
                purpose = purpose,
                clientNonce = clientNonce,
                requestDirect = requestDirect,
            ),
            bodySerializer = SharedSessionRequestDto.serializer(),
            responseSerializer = SharedSessionResponseDto.serializer(),
        ).map { dto -> toSession(dto) }

    suspend fun refreshSession(sessionId: String): ApiResult<SharedSession> =
        client.post(
            path = MobileApiPaths.sharedSession(sessionId) + "/refresh",
            body = OkResponseDto(ok = true),
            bodySerializer = OkResponseDto.serializer(),
            responseSerializer = SharedSessionResponseDto.serializer(),
        ).map { dto -> toSession(dto) }

    /** Closing is best-effort on the wire but mandatory locally: the arena is wiped either way. */
    suspend fun closeSession(sessionId: String): ApiResult<Boolean> =
        client.delete(
            path = MobileApiPaths.sharedSession(sessionId),
            responseSerializer = OkResponseDto.serializer(),
        ).map { it.ok }

    private fun toSession(dto: SharedSessionResponseDto): SharedSession =
        if (dto.mode == "direct" && dto.envelope != null) {
            SharedSession.Direct(
                sessionId = dto.sessionId,
                expiresAt = dto.expiresAt,
                envelope = MobileJson.instance.decodeFromJsonElement(
                    SharedUseEnvelope.serializer(),
                    dto.envelope,
                ),
            )
        } else {
            SharedSession.Relay(
                sessionId = dto.sessionId,
                expiresAt = dto.expiresAt,
                relayUrl = dto.relayUrl ?: "",
            )
        }

    private fun toDomain(dto: SharedResourceSummaryDto): SharedResource = SharedResource(
        resourceType = dto.resourceType,
        resourceId = dto.resourceId,
        displayName = dto.displayName,
        ownerLabel = dto.ownerLabel,
        capabilities = CapabilitySet.fromWire(dto.capabilities),
        expiresAt = dto.expiresAt,
        // Absent means relay. Defaulting the other way would let a server omission silently
        // upgrade a resource to direct use.
        usePolicy = if (dto.directUseAllowed) SharedUsePolicy.DIRECT_ALLOWED else SharedUsePolicy.RELAY_ONLY,
        revision = dto.revision,
        protocol = dto.protocol,
    )
}
