package one.zephyr.mobile.network

import java.net.URLEncoder
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.Request
import okio.Buffer
import one.zephyr.mobile.model.Base64Codec

/** Exact server-issued values covered by a mobile Device Proof v2 signature. */
data class DeviceProofChallenge(
    val nonce: String,
    val timestamp: Long,
    val expiresAt: Long,
    val method: String,
    val canonicalPath: String,
    val bodySha256: String,
    val usage: String,
) {
    override fun toString(): String =
        "DeviceProofChallenge(nonce=[redacted], timestamp=$timestamp, expiresAt=$expiresAt, " +
            "method=$method, canonicalPath=[redacted], bodySha256=$bodySha256, usage=$usage)"
}

/** Implemented by core-security's non-exportable ES256 device identity. */
fun interface DeviceProofSigner {
    fun sign(challenge: DeviceProofChallenge): String
}

@Serializable
internal data class DeviceProofChallengeRequestDto(
    val method: String,
    val path: String,
    val bodySha256: String,
    val usage: String,
) {
    override fun toString(): String =
        "DeviceProofChallengeRequestDto(method=$method, path=[redacted], " +
            "bodySha256=$bodySha256, usage=$usage)"
}

@Serializable
internal data class DeviceProofChallengeDto(
    val nonce: String,
    val timestamp: Long,
    val expiresAt: Long,
    val method: String,
    val canonicalPath: String,
    val bodySha256: String,
    val usage: String,
    val algorithm: String,
    val signatureFormat: String,
    val proofVersion: String,
) {
    override fun toString(): String =
        "DeviceProofChallengeDto(nonce=[redacted], timestamp=$timestamp, expiresAt=$expiresAt, " +
            "method=$method, canonicalPath=[redacted], bodySha256=$bodySha256, usage=$usage, " +
            "algorithm=$algorithm, signatureFormat=$signatureFormat, proofVersion=$proofVersion)"
}

@Serializable
internal data class DeviceProofChallengeResponseDto(
    val ok: Boolean,
    val challenge: DeviceProofChallengeDto,
)

internal data class DeviceProofBinding(
    val method: String,
    val challengePath: String,
    val canonicalPath: String,
    val bodySha256: String,
    val usage: String,
)

internal fun Request.deviceProofBinding(): DeviceProofBinding? {
    val method = method.uppercase()
    val usage = DeviceProofPolicy.usage(method, url.encodedPath) ?: return null
    require(body?.isOneShot() != true) { "one-shot request bodies cannot be device-proofed" }
    val bodyBytes = body?.let { requestBody ->
        Buffer().use { buffer ->
            requestBody.writeTo(buffer)
            buffer.readByteArray()
        }
    } ?: ByteArray(0)
    val digest = MessageDigest.getInstance("SHA-256").digest(bodyBytes)
    bodyBytes.fill(0)
    return DeviceProofBinding(
        method = method,
        challengePath = url.encodedPath + (url.encodedQuery?.let { "?" + it } ?: ""),
        canonicalPath = canonicalPath(url),
        bodySha256 = Base64Codec.encode(digest),
        usage = usage,
    )
}

internal fun DeviceProofChallengeDto.toChallenge(binding: DeviceProofBinding): DeviceProofChallenge? {
    if (
        method != binding.method ||
        canonicalPath != binding.canonicalPath ||
        bodySha256 != binding.bodySha256 ||
        usage != binding.usage ||
        algorithm != PROOF_ALGORITHM ||
        signatureFormat != PROOF_SIGNATURE_FORMAT ||
        proofVersion != PROOF_VERSION ||
        !PROOF_NONCE.matches(nonce) ||
        timestamp <= 0L ||
        expiresAt <= timestamp * 1000L ||
        expiresAt > timestamp * 1000L + PROOF_MAX_TTL_MILLIS
    ) {
        return null
    }
    return DeviceProofChallenge(
        nonce = nonce,
        timestamp = timestamp,
        expiresAt = expiresAt,
        method = method,
        canonicalPath = canonicalPath,
        bodySha256 = bodySha256,
        usage = usage,
    )
}

internal fun isStrictP1363Proof(value: String): Boolean {
    if (!P1363_BASE64.matches(value)) return false
    return runCatching {
        val decoded = Base64Codec.decode(value)
        decoded.size == P1363_SIGNATURE_BYTES && Base64Codec.encode(decoded) == value
    }.getOrDefault(false)
}

/** Mirrors mobile-v1-proof.js. The server remains authoritative over the returned usage. */
internal object DeviceProofPolicy {
    fun usage(method: String, encodedPath: String): String? {
        val exact = when (method + " " + encodedPath) {
            "GET /api/mobile/v1/sync/bootstrap" -> "sync.bootstrap"
            "GET /api/mobile/v1/sync/changes" -> "sync.changes"
            "GET /api/mobile/v1/sync/wake" -> "sync.wake"
            "POST /api/mobile/v1/sync/push" -> "sync.push"
            "POST /api/mobile/v1/sync/ack" -> "sync.ack"
            "POST /api/mobile/v1/sync/now" -> "sync.now"
            "GET /api/mobile/v1/sync/status" -> "sync.status"
            "POST /api/mobile/v1/blobs/uploads" -> "blob.upload.create"
            "GET /api/mobile/v1/shared" -> "shared.list"
            "POST /api/mobile/v1/file-bridge/lease" -> "file-bridge.lease"
            else -> null
        }
        if (exact != null) return exact
        return when {
            method == "GET" && BLOB_UPLOAD_STATUS.matches(encodedPath) -> "blob.upload.status"
            method == "PUT" && BLOB_CHUNK_UPLOAD.matches(encodedPath) -> "blob.chunk.upload"
            method == "GET" && BLOB_CHUNK_DOWNLOAD.matches(encodedPath) -> "blob.chunk.download"
            method == "GET" && BLOB_DOWNLOAD.matches(encodedPath) -> "blob.download"
            method == "GET" && SHARED_READ.matches(encodedPath) -> "shared.read"
            method == "POST" && SHARED_INVOKE.matches(encodedPath) -> "shared.invoke"
            method == "POST" && SHARED_SESSION_OPEN.matches(encodedPath) -> "shared.session.open"
            method == "POST" && SHARED_SESSION_REFRESH.matches(encodedPath) -> "shared.session.refresh"
            method == "DELETE" && SHARED_SESSION_CLOSE.matches(encodedPath) -> "shared.session.close"
            else -> null
        }
    }

    private val BLOB_UPLOAD_STATUS = Regex("^/api/mobile/v1/blobs/uploads/[^/]+$")
    private val BLOB_CHUNK_UPLOAD = Regex("^/api/mobile/v1/blobs/uploads/[^/]+/chunks/[^/]+$")
    private val BLOB_CHUNK_DOWNLOAD = Regex("^/api/mobile/v1/blobs/[^/]+/chunks/[^/]+$")
    private val BLOB_DOWNLOAD = Regex("^/api/mobile/v1/blobs/[^/]+$")
    private val SHARED_READ = Regex("^/api/mobile/v1/shared/[^/]+/[^/]+$")
    private val SHARED_INVOKE = Regex("^/api/mobile/v1/shared/[^/]+/[^/]+/invoke$")
    private val SHARED_SESSION_OPEN = Regex("^/api/mobile/v1/shared/connections/[^/]+/sessions$")
    private val SHARED_SESSION_REFRESH = Regex("^/api/mobile/v1/shared/sessions/[^/]+/refresh$")
    private val SHARED_SESSION_CLOSE = Regex("^/api/mobile/v1/shared/sessions/[^/]+$")
}

/** Node URLSearchParams canonical form: decoded pairs, unique keys, sorted, form-encoded. */
private fun canonicalPath(url: HttpUrl): String {
    val pairs = (0 until url.querySize).map { index ->
        url.queryParameterName(index) to (url.queryParameterValue(index) ?: "")
    }
    require(pairs.map { it.first }.distinct().size == pairs.size) {
        "duplicate query keys cannot be device-proofed"
    }
    val query = pairs
        .sortedWith(compareBy<Pair<String, String>>({ it.first }, { it.second }))
        .joinToString("&") { (key, value) -> formEncode(key) + "=" + formEncode(value) }
    return url.encodedPath + if (query.isEmpty()) "" else "?" + query
}

private fun formEncode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name())

internal const val HEADER_DEVICE_PROOF = "X-Zephyr-Device-Proof"
internal const val HEADER_SERVER_NONCE = "X-Zephyr-Server-Nonce"
internal const val HEADER_PROOF_TIMESTAMP = "X-Zephyr-Proof-Timestamp"
internal const val PROOF_VERSION = "zephyr-one-device-proof-v2"
private const val PROOF_ALGORITHM = "ES256"
private const val PROOF_SIGNATURE_FORMAT = "P1363"
private const val P1363_SIGNATURE_BYTES = 64
private const val PROOF_MAX_TTL_MILLIS = 30_999L
private val PROOF_NONCE = Regex("^[A-Za-z0-9_-]{43}$")
private val P1363_BASE64 = Regex("^[A-Za-z0-9+/]{86}==$")
