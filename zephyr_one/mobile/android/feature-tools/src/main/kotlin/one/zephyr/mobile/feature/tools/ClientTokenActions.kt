package one.zephyr.mobile.feature.tools

import one.zephyr.mobile.data.repository.ClientTokenRepository
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.network.ClientTokenManagementPort
import one.zephyr.mobile.network.ManagedClientToken

/** Secret-cache boundary kept separate so action ordering is testable without Room or KeyStore. */
interface ClientTokenSecretCache {
    fun replace(tokenId: String, secret: String)

    fun forget(tokenId: String)

    suspend fun forgetAll()
}

class RepositoryClientTokenSecretCache(
    private val repository: ClientTokenRepository,
    private val ownerUserId: String,
) : ClientTokenSecretCache {
    override fun replace(tokenId: String, secret: String) {
        repository.storeSecret(tokenId, secret)
    }

    override fun forget(tokenId: String) {
        repository.forgetSecret(tokenId)
    }

    override suspend fun forgetAll() {
        repository.forgetAllSecrets(ownerUserId)
    }
}

/**
 * Executes Client Token mutations against the canonical main-end routes.
 *
 * The server emits the change-feed record. This coordinator only maintains the local encrypted
 * secret cache and requests an immediate pull so mirror metadata catches up without waiting for the
 * interval timer.
 */
class ClientTokenActions(
    private val management: ClientTokenManagementPort,
    private val secretCache: ClientTokenSecretCache,
    private val localMode: Boolean,
    private val onServerMutation: suspend () -> Unit = {},
) {
    suspend fun create(name: String): ApiResult<ManagedClientToken> =
        ifUnavailableOr { cacheMinted(management.create(name), clearExisting = false) }

    suspend fun reveal(tokenId: String, verificationSecret: String): ApiResult<ManagedClientToken> =
        ifUnavailableOr {
            cacheMinted(
                management.reveal(tokenId, verificationSecret),
                clearExisting = false,
                requestSync = false,
            )
        }

    suspend fun rotate(tokenId: String, verificationSecret: String): ApiResult<ManagedClientToken> =
        ifUnavailableOr { cacheMinted(management.rotate(tokenId, verificationSecret), clearExisting = false) }

    suspend fun delete(tokenId: String, verificationSecret: String): ApiResult<Unit> = ifUnavailableOr {
        when (val result = management.delete(tokenId, verificationSecret)) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> {
                runCatching { secretCache.forget(tokenId) }.getOrElse { return@ifUnavailableOr cacheFailure() }
                notifyServerMutation()
                result
            }
        }
    }

    suspend fun resetAll(name: String, verificationSecret: String): ApiResult<ManagedClientToken> =
        ifUnavailableOr { cacheMinted(management.resetAll(name, verificationSecret), clearExisting = true) }

    private suspend fun cacheMinted(
        result: ApiResult<ManagedClientToken>,
        clearExisting: Boolean,
        requestSync: Boolean = true,
    ): ApiResult<ManagedClientToken> = when (result) {
        is ApiResult.Failure -> result
        is ApiResult.Success -> {
            val cached = runCatching {
                if (clearExisting) secretCache.forgetAll()
                secretCache.replace(result.value.id, result.value.secret)
            }
            if (cached.isFailure) {
                cacheFailure()
            } else {
                if (requestSync) notifyServerMutation()
                result
            }
        }
    }

    private suspend fun notifyServerMutation() {
        runCatching { onServerMutation() }
    }

    private suspend inline fun <T> ifUnavailableOr(
        block: suspend () -> ApiResult<T>,
    ): ApiResult<T> = if (localMode) {
        ApiResult.Failure(
            MobileError.local(
                code = "main_end_unavailable",
                message = "本地模式没有主端，无法管理 Client Token",
                retryable = false,
            ),
        )
    } else {
        block()
    }

    private fun cacheFailure(): ApiResult.Failure = ApiResult.Failure(
        MobileError.local(
            code = "client_token_cache_failed",
            message = "主端已完成操作，但本机无法保存 Token；请同步后重新查看",
            retryable = false,
        ),
    )
}
