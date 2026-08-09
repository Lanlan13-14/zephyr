package one.zephyr.mobile.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The device-local wrapping key.
 *
 * LOCAL_SECURITY.md requires every at-rest secret to be sealed by non-exportable hardware key
 * material. This key is intentionally *not* user-authentication bound: background sync must be
 * able to re-envelope queued writes after the first device unlock, and the app lock requirement is
 * enforced separately by [AppLock] over the in-memory plaintext cache. setUnlockedDeviceRequired
 * still keeps the ciphertext unreadable while the device is locked on API 28+.
 */
object KeystoreMasterKey {

    const val ALIAS_SECRET_STORE: String = "zephyr.one.secretstore.v1"
    const val ALIAS_DEVICE_KEY_WRAP: String = "zephyr.one.devicekey.wrap.v1"

    private const val PROVIDER = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    /** Sealed blob layout: [1-byte version][12-byte IV][ciphertext||tag]. */
    private const val BLOB_VERSION: Byte = 1

    fun getOrCreate(alias: String): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    setUnlockedDeviceRequired(true)
                    // StrongBox where the device has it; fall back below if unavailable.
                    setIsStrongBoxBacked(true)
                }
            }
            .build()

        return try {
            generator.init(spec)
            generator.generateKey()
        } catch (strongBoxUnavailable: java.security.ProviderException) {
            val fallback = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setUnlockedDeviceRequired(true)
                }
                .build()
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).run {
                init(fallback)
                generateKey()
            }
        }
    }

    fun delete(alias: String) {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    /**
     * @param aad binds the blob to its logical slot so a blob copied to a different ref fails to
     *   open instead of silently decrypting.
     */
    fun seal(key: SecretKey, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(aad)
        val iv = cipher.iv
        require(iv.size == IV_BYTES) { "AndroidKeyStore returned an unexpected GCM IV length" }
        val body = cipher.doFinal(plaintext)
        val out = ByteArray(1 + IV_BYTES + body.size)
        out[0] = BLOB_VERSION
        iv.copyInto(out, 1)
        body.copyInto(out, 1 + IV_BYTES)
        return out
    }

    fun open(key: SecretKey, blob: ByteArray, aad: ByteArray): ByteArray {
        require(blob.size > 1 + IV_BYTES) { "sealed blob is truncated" }
        require(blob[0] == BLOB_VERSION) { "unsupported sealed blob version " + blob[0] }
        val iv = blob.copyOfRange(1, 1 + IV_BYTES)
        val body = blob.copyOfRange(1 + IV_BYTES, blob.size)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(aad)
        return cipher.doFinal(body)
    }
}
