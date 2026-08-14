package one.zephyr.mobile.network

import kotlinx.serialization.Serializable
import one.zephyr.mobile.model.ClientToken

/**
 * Existing main-end Client Token management surface.
 *
 * These routes predate Mobile v1 and are intentionally kept outside generated [MobileApiPaths].
 * They are nevertheless the canonical mutation routes used by the main-end UI: rotation and reset
 * mint a new secret atomically and emit the mobile change feed entry consumed by the next sync.
 */
object ClientTokenManagementPaths {
    const val TOKENS: String = "/api/rdp/file-agent-tokens"
    const val RESET_ALL: String = "$TOKENS/reset-all"

    fun create(): String = TOKENS

    fun reveal(tokenId: String): String = tokenPath(tokenId) + "/open"

    fun rotate(tokenId: String): String = tokenPath(tokenId) + "/regenerate"

    fun delete(tokenId: String): String = tokenPath(tokenId) + "/delete"

    private fun tokenPath(tokenId: String): String {
        require(TOKEN_ID.matches(tokenId) && tokenId != "." && tokenId != "..") {
            "invalid Client Token id"
        }
        return "$TOKENS/$tokenId"
    }

    private val TOKEN_ID = Regex("^[A-Za-z0-9_.:-]{1,128}$")
}

/** A newly minted or explicitly revealed token. Its [secret] must never be logged or persisted raw. */
data class ManagedClientToken(
    val id: String,
    val name: String,
    val secret: String,
    val revision: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val lastUsedAt: Long?,
) {
    init {
        require(id.isNotBlank()) { "Client Token response is missing id" }
        require(name.isNotBlank()) { "Client Token response is missing name" }
        require(secret.length in ClientToken.MIN_SECRET_CHARS..ClientToken.MAX_SECRET_CHARS) {
            "Client Token response secret length is invalid"
        }
        require(revision > 0L) { "Client Token response revision is invalid" }
    }

    override fun toString(): String =
        "ManagedClientToken(id=$id, name=$name, secret=[redacted], revision=$revision)"
}

/** Port consumed by the feature action layer and faked by JVM tests. */
interface ClientTokenManagementPort {
    suspend fun create(name: String): ApiResult<ManagedClientToken>

    suspend fun reveal(tokenId: String, verificationSecret: String): ApiResult<ManagedClientToken>

    suspend fun rotate(tokenId: String, verificationSecret: String): ApiResult<ManagedClientToken>

    suspend fun delete(tokenId: String, verificationSecret: String): ApiResult<Unit>

    suspend fun resetAll(name: String, verificationSecret: String): ApiResult<ManagedClientToken>
}

class ClientTokenManagementApi(
    private val client: MobileApiClient,
) : ClientTokenManagementPort {

    override suspend fun create(name: String): ApiResult<ManagedClientToken> {
        val validatedName = validateName(name)
        return client.post(
            path = ClientTokenManagementPaths.create(),
            body = CreateTokenRequestDto(name = validatedName),
            bodySerializer = CreateTokenRequestDto.serializer(),
            responseSerializer = TokenResponseDto.serializer(),
        ).map { it.token.toDomain() }
    }

    override suspend fun reveal(
        tokenId: String,
        verificationSecret: String,
    ): ApiResult<ManagedClientToken> = sensitiveTokenCall(
        path = ClientTokenManagementPaths.reveal(tokenId),
        verificationSecret = verificationSecret,
    )

    override suspend fun rotate(
        tokenId: String,
        verificationSecret: String,
    ): ApiResult<ManagedClientToken> = sensitiveTokenCall(
        path = ClientTokenManagementPaths.rotate(tokenId),
        verificationSecret = verificationSecret,
    )

    override suspend fun delete(tokenId: String, verificationSecret: String): ApiResult<Unit> =
        client.post(
            path = ClientTokenManagementPaths.delete(tokenId),
            body = SensitiveTokenRequestDto(secret = validateVerificationSecret(verificationSecret)),
            bodySerializer = SensitiveTokenRequestDto.serializer(),
            responseSerializer = TokenDeleteResponseDto.serializer(),
        ).map { Unit }

    override suspend fun resetAll(
        name: String,
        verificationSecret: String,
    ): ApiResult<ManagedClientToken> = client.post(
        path = ClientTokenManagementPaths.RESET_ALL,
        body = ResetTokensRequestDto(
            secret = validateVerificationSecret(verificationSecret),
            name = validateName(name),
        ),
        bodySerializer = ResetTokensRequestDto.serializer(),
        responseSerializer = TokenResponseDto.serializer(),
    ).map { it.token.toDomain() }

    private suspend fun sensitiveTokenCall(
        path: String,
        verificationSecret: String,
    ): ApiResult<ManagedClientToken> = client.post(
        path = path,
        body = SensitiveTokenRequestDto(secret = validateVerificationSecret(verificationSecret)),
        bodySerializer = SensitiveTokenRequestDto.serializer(),
        responseSerializer = TokenResponseDto.serializer(),
    ).map { it.token.toDomain() }

    private fun validateName(name: String): String = name.trim().also {
        require(it.isNotEmpty() && it.length <= ClientToken.MAX_NAME_CHARS) {
            "Client Token name must be 1..${ClientToken.MAX_NAME_CHARS} characters"
        }
    }

    private fun validateVerificationSecret(secret: String): String = secret.also {
        require(it.isNotBlank()) { "sensitive verification secret must not be blank" }
        require('\r' !in it && '\n' !in it) { "sensitive verification secret contains a line break" }
    }
}

@Serializable
private data class CreateTokenRequestDto(
    val name: String,
    val length: Int = DEFAULT_TOKEN_LENGTH,
)

@Serializable
private data class SensitiveTokenRequestDto(
    val secret: String,
    val length: Int = DEFAULT_TOKEN_LENGTH,
) {
    override fun toString(): String = "SensitiveTokenRequestDto(secret=[redacted], length=$length)"
}

@Serializable
private data class ResetTokensRequestDto(
    val secret: String,
    val name: String,
    val length: Int = DEFAULT_TOKEN_LENGTH,
) {
    override fun toString(): String =
        "ResetTokensRequestDto(secret=[redacted], name=$name, length=$length)"
}

@Serializable
private data class TokenResponseDto(
    val ok: Boolean,
    val token: ManagedClientTokenDto,
) {
    init {
        require(ok) { "Client Token mutation did not succeed" }
    }
}

@Serializable
private data class TokenDeleteResponseDto(val ok: Boolean) {
    init {
        require(ok) { "Client Token delete did not succeed" }
    }
}

@Serializable
private data class ManagedClientTokenDto(
    val id: String,
    val name: String,
    val token: String,
    val revision: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val lastUsedAt: Long? = null,
) {
    fun toDomain(): ManagedClientToken = ManagedClientToken(
        id = id,
        name = name,
        secret = token,
        revision = revision,
        createdAt = createdAt,
        updatedAt = updatedAt,
        lastUsedAt = lastUsedAt,
    )

    override fun toString(): String =
        "ManagedClientTokenDto(id=$id, name=$name, token=[redacted], revision=$revision)"
}

private const val DEFAULT_TOKEN_LENGTH = 50
