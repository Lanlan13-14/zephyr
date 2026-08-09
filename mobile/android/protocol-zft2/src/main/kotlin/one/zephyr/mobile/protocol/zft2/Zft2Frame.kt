package one.zephyr.mobile.protocol.zft2

import kotlinx.serialization.json.JsonObject
import one.zephyr.mobile.contracts.Zft2Contract
import one.zephyr.mobile.contracts.Zft2Op

/**
 * A rejection with a stable code.
 *
 * The codes are part of the wire contract, not debug text: the JS
 * (`file-transfer-protocol.js`) and Dart (`zephyr_agent`) implementations use the same set, and
 * `contracts/generated/zft2-frames.json` asserts them, so a renamed code is a cross-platform break.
 */
class Zft2Exception(val code: String, message: String) : Exception(message)

/**
 * One decoded ZFT2 frame.
 *
 * [requestId] is a Long because the wire field is an unsigned 32-bit integer: 0xFFFFFFFF is a legal
 * id that would be -1 as a signed Int, and the fixture set deliberately includes it.
 */
data class Zft2Frame(
    val op: Int,
    val requestId: Long,
    val flags: Int,
    val meta: JsonObject,
    val payload: ByteArray,
) {
    val isResponse: Boolean get() = (flags and Zft2Contract.FLAG_RESPONSE) != 0
    val isError: Boolean get() = (flags and Zft2Contract.FLAG_ERROR) != 0
    val operation: Zft2Op? get() = Zft2Op.fromCode(op)

    /** True for an op that mutates the remote filesystem. */
    val isWrite: Boolean get() = operation?.isWrite == true

    override fun equals(other: Any?): Boolean =
        other is Zft2Frame &&
            op == other.op &&
            requestId == other.requestId &&
            flags == other.flags &&
            meta == other.meta &&
            payload.contentEquals(other.payload)

    override fun hashCode(): Int {
        var result = op
        result = 31 * result + requestId.hashCode()
        result = 31 * result + flags
        result = 31 * result + meta.hashCode()
        result = 31 * result + payload.contentHashCode()
        return result
    }
}
