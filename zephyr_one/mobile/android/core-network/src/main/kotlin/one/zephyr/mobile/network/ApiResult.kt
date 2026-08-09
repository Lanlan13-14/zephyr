package one.zephyr.mobile.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.network.dto.ErrorEnvelopeDto

/** JSON configuration shared by every mobile API call. */
object MobileJson {
    /**
     * ignoreUnknownKeys is a compatibility requirement, not a shortcut: a newer main end may add
     * response fields, and One must keep working rather than failing to parse.
     */
    val instance: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = false
    }
}

/**
 * Result of one API call.
 *
 * Errors are always the structured envelope from contracts/schemas/error.schema.json, never a raw
 * HTTP status: every screen branches on [MobileError.code] and the registry decides retryability.
 */
sealed interface ApiResult<out T> {
    data class Success<T>(val value: T, val requestId: String?) : ApiResult<T>
    data class Failure(val error: MobileError) : ApiResult<Nothing>

    val successOrNull: T? get() = (this as? Success<T>)?.value
    val errorOrNull: MobileError? get() = (this as? Failure)?.error
}

inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Success -> ApiResult.Success(transform(value), requestId)
    is ApiResult.Failure -> this
}

fun <T> ApiResult<T>.getOrThrow(): T = when (this) {
    is ApiResult.Success -> value
    is ApiResult.Failure -> throw one.zephyr.mobile.model.MobileApiException(error)
}

internal object ErrorDecoder {

    /**
     * Decode the structured envelope. A body that is not a valid envelope becomes a synthetic
     * error carrying the status, because silently succeeding on an unparseable error response is
     * how a client ends up treating a 500 as an empty list.
     */
    fun decode(status: Int, body: String?, requestId: String?, retryAfterSeconds: Long?): MobileError {
        val parsed = body?.takeIf { it.isNotBlank() }?.let {
            runCatching { MobileJson.instance.decodeFromString(ErrorEnvelopeDto.serializer(), it) }.getOrNull()
        }
        if (parsed != null) {
            return MobileError(
                code = parsed.error.code,
                message = parsed.error.message,
                retryable = parsed.error.retryable,
                requestId = parsed.error.requestId ?: requestId,
                details = flatten(parsed.error.details),
                httpStatus = status,
                retryAfterSeconds = retryAfterSeconds,
            )
        }
        return MobileError(
            code = syntheticCode(status),
            message = "unstructured HTTP " + status + " response",
            retryable = status == 429 || status >= 500,
            requestId = requestId,
            httpStatus = status,
            retryAfterSeconds = retryAfterSeconds,
        )
    }

    private fun syntheticCode(status: Int): String = when (status) {
        401 -> "access_expired"
        403 -> "forbidden_unstructured"
        404 -> "not_found_unstructured"
        409 -> "conflict_unstructured"
        429 -> "rate_limited"
        in 500..599 -> "server_error"
        else -> "http_" + status
    }

    private fun flatten(details: JsonObject?): Map<String, String> =
        details?.mapValues { (_, value) -> (value as? JsonPrimitive)?.content ?: value.toString() } ?: emptyMap()
}
