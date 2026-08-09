package one.zephyr.mobile.protocol.ssh

import java.security.MessageDigest

/** One presented host key. [blob] is the raw public key exactly as the server sent it. */
data class HostKey(
    val algorithm: String,
    val blob: ByteArray,
) {
    /**
     * OpenSSH-style `SHA256:<base64 without padding>`.
     *
     * The format matches what `ssh-keygen -l` prints so a user can compare it against a value they
     * already have, which is the only thing that makes the prompt actionable.
     */
    val sha256Fingerprint: String by lazy {
        "SHA256:" + base64NoPad(MessageDigest.getInstance("SHA-256").digest(blob))
    }

    override fun equals(other: Any?): Boolean =
        other is HostKey && algorithm == other.algorithm && blob.contentEquals(other.blob)

    override fun hashCode(): Int = 31 * algorithm.hashCode() + blob.contentHashCode()

    /** Never dumps the key material. */
    override fun toString(): String = algorithm + " " + sha256Fingerprint

    private companion object {
        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        /**
         * Hand-rolled rather than `java.util.Base64`, which is API 26+ while the module targets
         * lower, and `android.util.Base64`, which would make this class untestable off-device.
         */
        fun base64NoPad(bytes: ByteArray): String {
            val out = StringBuilder((bytes.size + 2) / 3 * 4)
            var index = 0
            while (index + 2 < bytes.size) {
                val chunk = ((bytes[index].toInt() and 0xFF) shl 16) or
                    ((bytes[index + 1].toInt() and 0xFF) shl 8) or
                    (bytes[index + 2].toInt() and 0xFF)
                out.append(ALPHABET[(chunk shr 18) and 0x3F])
                out.append(ALPHABET[(chunk shr 12) and 0x3F])
                out.append(ALPHABET[(chunk shr 6) and 0x3F])
                out.append(ALPHABET[chunk and 0x3F])
                index += 3
            }
            when (bytes.size - index) {
                1 -> {
                    val chunk = (bytes[index].toInt() and 0xFF) shl 16
                    out.append(ALPHABET[(chunk shr 18) and 0x3F])
                    out.append(ALPHABET[(chunk shr 12) and 0x3F])
                }
                2 -> {
                    val chunk = ((bytes[index].toInt() and 0xFF) shl 16) or
                        ((bytes[index + 1].toInt() and 0xFF) shl 8)
                    out.append(ALPHABET[(chunk shr 18) and 0x3F])
                    out.append(ALPHABET[(chunk shr 12) and 0x3F])
                    out.append(ALPHABET[(chunk shr 6) and 0x3F])
                }
            }
            return out.toString()
        }
    }
}

/**
 * Where a trusted key is recorded.
 *
 * DEVELOPMENT.md 14.1 scopes trust to `serverProfile/host/port`, not to a connection id: the same
 * host reached through two connection rows is the same host, and duplicating trust per row would ask
 * the user the same question repeatedly and train them to accept it.
 */
data class HostKeyScope(
    val serverProfileId: String,
    val host: String,
    val port: Int,
) {
    val storageKey: String get() = serverProfileId + "|" + host.lowercase() + "|" + port
}

interface HostKeyStore {
    suspend fun find(scope: HostKeyScope): HostKey?
    suspend fun trust(scope: HostKeyScope, key: HostKey)
    suspend fun forget(scope: HostKeyScope)
}

enum class HostKeyPolicy {
    /** Ask on first sight, block on change. The only policy a release build may ship. */
    PROMPT_UNKNOWN_BLOCK_CHANGED,

    /**
     * Accept anything. Never selectable from the UI; exists so an integration test can dial a
     * throwaway container without a fixture keystore.
     */
    INSECURE_ACCEPT_ANY,
}

sealed interface HostKeyVerdict {
    /** Already trusted for this scope. */
    data object Trusted : HostKeyVerdict

    /** First sight. The UI must show algorithm and fingerprint and wait for the user. */
    data class UnknownNeedsConfirmation(val presented: HostKey) : HostKeyVerdict

    /**
     * The key changed. Blocked by default and not dismissible with a toast
     * (DEVELOPMENT.md 14.1: "host key 改变默认阻断，不用普通 toast 一键忽略").
     */
    data class ChangedBlocked(val presented: HostKey, val known: HostKey) : HostKeyVerdict
}

/**
 * Decides what to do with a presented host key.
 *
 * Split from the engine on purpose: this is the check that protects against the man in the middle,
 * and it must be identical whichever engine ADR-002 picks, reviewable without reading an engine, and
 * testable without a network.
 */
class HostKeyVerifier(private val store: HostKeyStore) {

    suspend fun verify(scope: HostKeyScope, presented: HostKey, policy: HostKeyPolicy): HostKeyVerdict {
        if (policy == HostKeyPolicy.INSECURE_ACCEPT_ANY) return HostKeyVerdict.Trusted
        val known = store.find(scope) ?: return HostKeyVerdict.UnknownNeedsConfirmation(presented)
        if (known == presented) return HostKeyVerdict.Trusted
        return HostKeyVerdict.ChangedBlocked(presented = presented, known = known)
    }

    /**
     * Records a key the user accepted.
     *
     * Deliberately separate from [verify]: trust is only ever written after an explicit user action,
     * so no code path can accept a key as a side effect of checking it.
     */
    suspend fun acceptAndRemember(scope: HostKeyScope, key: HostKey) = store.trust(scope, key)

    /** Used when a user chooses to re-trust a changed key, which must drop the old one first. */
    suspend fun replaceTrust(scope: HostKeyScope, key: HostKey) {
        store.forget(scope)
        store.trust(scope, key)
    }
}
