package one.zephyr.mobile.security

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HKDF-SHA256 (RFC 5869).
 *
 * Split out from the envelope code because DATA_AND_MIGRATION.md 5.2 fixes salt and info to exact
 * byte strings, and those are worth testing independently of any KEM provider.
 */
object Hkdf {

    private const val HMAC = "HmacSHA256"
    private const val HASH_BYTES = 32

    fun extract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance(HMAC)
        // An all-zero salt is the RFC default; the frozen contract always supplies one, so an
        // empty salt here means a caller bug rather than a legitimate default.
        require(salt.isNotEmpty()) { "HKDF salt must not be empty for the mobile envelope suite" }
        mac.init(SecretKeySpec(salt, HMAC))
        return mac.doFinal(ikm)
    }

    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length > 0 && length <= 255 * HASH_BYTES) { "invalid HKDF output length " + length }
        val mac = Mac.getInstance(HMAC)
        mac.init(SecretKeySpec(prk, HMAC))
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            mac.reset()
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val take = minOf(previous.size, length - offset)
            previous.copyInto(out, offset, 0, take)
            offset += take
            counter += 1
        }
        return out
    }

    fun derive(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = extract(salt, ikm)
        return try {
            expand(prk, info, length)
        } finally {
            prk.fill(0)
        }
    }
}
