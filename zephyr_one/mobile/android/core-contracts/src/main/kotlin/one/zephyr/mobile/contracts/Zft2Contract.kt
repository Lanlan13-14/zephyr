// GENERATED FILE - DO NOT EDIT.
// Source: mobile/contracts. Regenerate with `node mobile/tools/generate.mjs`.

package one.zephyr.mobile.contracts

/** ZFT2 wire constants frozen by ZEPHYR_PARITY.md 10.2. */
object Zft2Contract {
    val MAGIC: ByteArray = byteArrayOf(0x5A, 0x46, 0x54, 0x32)
    const val VERSION: Int = 2
    const val HEADER_BYTES: Int = 20
    const val FLAG_ERROR: Int = 0x0001
    const val FLAG_RESPONSE: Int = 0x0002
    const val MAX_META_BYTES: Int = 262144
    const val MAX_PAYLOAD_BYTES: Int = 1048576
    const val MAX_INFLIGHT_MIN: Int = 1
    const val MAX_INFLIGHT_MAX: Int = 16
    const val MAX_INFLIGHT_DEFAULT: Int = 8
}

enum class Zft2Op(val code: Int) {
    OPEN(0x01),
    READ(0x02),
    WRITE(0x03),
    CLOSE(0x04),
    STAT(0x05),
    LIST(0x06),
    MKDIR(0x07),
    DELETE(0x08),
    RENAME(0x09),
    TRUNCATE(0x0a),
    CANCEL(0x0b),
    PING(0x0c),
    ;
    /** Write semantics a readOnly provider must reject at the provider layer. */
    val isWrite: Boolean get() = this in listOf(WRITE, MKDIR, DELETE, RENAME, TRUNCATE)

    companion object {
        fun fromCode(code: Int): Zft2Op? = entries.firstOrNull { it.code == code }
    }
}
