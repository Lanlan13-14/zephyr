package one.zephyr.mobile.app.binding

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import one.zephyr.mobile.model.AccountBinding

/** Stable for process recovery and unique to a fresh server-issued device binding. */
internal object BindingGeneration {
    fun of(binding: AccountBinding): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(
            ByteArrayOutputStream().use { bytes ->
                DataOutputStream(bytes).use { output ->
                    output.write(DOMAIN)
                    listOf(
                        binding.serverProfileId,
                        binding.userId,
                        binding.deviceId,
                        binding.instanceEpoch.toString(),
                        binding.boundAt.toString(),
                    ).forEach { value ->
                        val encoded = value.toByteArray(Charsets.UTF_8)
                        output.writeInt(encoded.size)
                        output.write(encoded)
                    }
                }
                bytes.toByteArray()
            },
        )
        return buildString(digest.size * 2) {
            digest.forEach { byte ->
                val value = byte.toInt() and 0xff
                append(HEX[value ushr 4])
                append(HEX[value and 0x0f])
            }
        }
    }

    private val DOMAIN = "zephyr.one.binding-generation.v1\u0000".toByteArray(Charsets.UTF_8)
    private const val HEX = "0123456789abcdef"
}
