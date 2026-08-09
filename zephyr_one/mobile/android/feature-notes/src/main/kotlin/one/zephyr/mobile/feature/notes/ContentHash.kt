package one.zephyr.mobile.feature.notes

import java.security.MessageDigest

/**
 * SHA-256 of an editor buffer.
 *
 * The S31 editor baseline is mtime *and* hash (SCREEN_CATALOG.md 12). mtime alone is not enough:
 * many servers report whole-second granularity, and a filesystem restore or a touch can move mtime
 * without changing a byte. Comparing content hashes is what lets the editor tell "someone else
 * rewrote this file" from "the timestamp moved", so only the former interrupts the user.
 */
object ContentHash {

    const val ALGORITHM = "SHA-256"

    fun of(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance(ALGORITHM).digest(bytes)
        val out = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val value = byte.toInt() and 0xff
            out.append(HEX[value ushr 4])
            out.append(HEX[value and 0x0f])
        }
        return out.toString()
    }

    fun of(text: String, encoding: FileEncoding): String = of(encoding.encode(text))

    /**
     * Constant-time-ish comparison is deliberately not used: these are integrity hashes shown to
     * the user, not secrets, and a case-insensitive compare avoids a false conflict when a server
     * adapter reports upper-case hex.
     */
    fun matches(left: String?, right: String?): Boolean =
        left != null && right != null && left.equals(right, ignoreCase = true)

    private val HEX = "0123456789abcdef".toCharArray()
}
