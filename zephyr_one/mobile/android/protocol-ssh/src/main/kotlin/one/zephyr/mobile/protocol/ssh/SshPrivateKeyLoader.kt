package one.zephyr.mobile.protocol.ssh

import com.hierynomus.sshj.common.KeyDecryptionFailedException
import com.hierynomus.sshj.userauth.keyprovider.OpenSSHKeyV1KeyFile
import java.util.Base64
import net.schmizz.sshj.userauth.keyprovider.FileKeyProvider
import net.schmizz.sshj.userauth.keyprovider.KeyFormat
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.keyprovider.KeyProviderUtil
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile
import net.schmizz.sshj.userauth.keyprovider.PuTTYKeyFile
import net.schmizz.sshj.userauth.password.PasswordUtils
import org.bouncycastle.openssl.EncryptionException

/**
 * Loads an in-memory private key for SSH public-key auth.
 *
 * SSHJ's older [OpenSSHKeyFile] only understands the pre-2014 PEM form. A modern
 * `BEGIN OPENSSH PRIVATE KEY` blob (the default `ssh-keygen` output, including every
 * Ed25519 key) must go through [OpenSSHKeyV1KeyFile]. Feeding the v1 blob to the old
 * parser throws and the UI surfaces it as a generic connect failure.
 */
object SshPrivateKeyLoader {

    private val OPENSSH_V1_MAGIC = "openssh-key-v1\u0000".toByteArray(Charsets.US_ASCII)
    private const val OPENSSH_NONE = "none"

    data class Parsed(
        val format: KeyFormat,
        val pem: String,
        val encrypted: Boolean,
    )

    fun normalize(raw: String): String {
        val trimmed = raw.trim().removePrefix("\uFEFF").replace("\r\n", "\n").replace('\r', '\n')
        val begin = trimmed.indexOf("-----BEGIN ")
        if (begin < 0) return trimmed
        val endToken = trimmed.indexOf("-----END ", begin)
        if (endToken < 0) return trimmed.substring(begin)
        val closing = trimmed.indexOf("-----", endToken + "-----END ".length)
        if (closing < 0) return trimmed.substring(begin)
        return trimmed.substring(begin, closing + 5)
    }

    fun inspect(raw: String): Parsed {
        val pem = normalize(raw)
        require(pem.isNotBlank()) { "私钥为空" }
        val format = try {
            KeyProviderUtil.detectKeyFileFormat(pem, false)
        } catch (error: Exception) {
            throw IllegalArgumentException("私钥格式无法识别", error)
        }
        require(format != KeyFormat.Unknown) { "私钥格式无法识别，请粘贴 OpenSSH 或 PEM 私钥" }
        return Parsed(format = format, pem = pem, encrypted = isEncrypted(pem, format))
    }

    fun isEncrypted(pem: String, format: KeyFormat): Boolean {
        val header = pem.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        if (header.contains("ENCRYPTED", ignoreCase = true)) return true
        if (pem.contains("Proc-Type: 4,ENCRYPTED", ignoreCase = true)) return true
        if (format != KeyFormat.OpenSSHv1) return false
        val cipher = openSshV1CipherName(pem) ?: return false
        return !cipher.equals(OPENSSH_NONE, ignoreCase = true)
    }

    fun load(raw: String, passphrase: CharArray?): KeyProvider {
        val parsed = inspect(raw)
        val finder = passphrase
            ?.takeIf { it.isNotEmpty() }
            ?.let { PasswordUtils.createOneOff(it.copyOf()) }
        if (parsed.encrypted && finder == null) {
            throw IllegalArgumentException("该私钥已加密，请填写口令")
        }
        val provider = providerFor(parsed.format)
        try {
            provider.init(parsed.pem, null, finder)
            // Force a parse now so a bad blob fails before authPublickey talks to the server.
            provider.`private`
            provider.`public`
        } catch (error: Exception) {
            throw wrap(error, parsed, finder != null)
        }
        return provider
    }

    internal fun providerFor(format: KeyFormat): FileKeyProvider = when (format) {
        KeyFormat.OpenSSHv1 -> OpenSSHKeyV1KeyFile()
        KeyFormat.OpenSSH -> OpenSSHKeyFile()
        KeyFormat.PKCS8 -> PKCS8KeyFile()
        KeyFormat.PuTTY -> PuTTYKeyFile()
        KeyFormat.Unknown -> throw IllegalArgumentException("私钥格式无法识别，请粘贴 OpenSSH 或 PEM 私钥")
    }

    internal fun openSshV1CipherName(pem: String): String? {
        val body = pem.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("-----") }
            .joinToString("")
            .filterNot(Char::isWhitespace)
        val decoded = try {
            Base64.getDecoder().decode(body)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (decoded.size < OPENSSH_V1_MAGIC.size + 8) return null
        if (!decoded.copyOf(OPENSSH_V1_MAGIC.size).contentEquals(OPENSSH_V1_MAGIC)) return null
        return readOpenSshString(decoded, OPENSSH_V1_MAGIC.size)
    }

    private fun readOpenSshString(bytes: ByteArray, offset: Int): String? {
        if (offset + 4 > bytes.size) return null
        val length = ((bytes[offset].toInt() and 0xff) shl 24) or
            ((bytes[offset + 1].toInt() and 0xff) shl 16) or
            ((bytes[offset + 2].toInt() and 0xff) shl 8) or
            (bytes[offset + 3].toInt() and 0xff)
        if (length < 0 || offset + 4 + length > bytes.size) return null
        return String(bytes, offset + 4, length, Charsets.US_ASCII)
    }

    private fun wrap(error: Exception, parsed: Parsed, hadPassphrase: Boolean): IllegalArgumentException {
        if (error is IllegalArgumentException) return error
        val decryption = isDecryptionFailure(error)
        val message = when {
            decryption && !hadPassphrase -> "该私钥已加密，请填写口令"
            decryption -> "私钥口令不正确"
            parsed.format == KeyFormat.OpenSSHv1 ->
                "无法解析 OpenSSH 私钥（${error.message ?: error.javaClass.simpleName}）"
            else -> "无法解析私钥（${error.message ?: error.javaClass.simpleName}）"
        }
        return IllegalArgumentException(message, error)
    }

    private fun isDecryptionFailure(error: Throwable): Boolean {
        var current: Throwable? = error
        while (current != null) {
            if (current is KeyDecryptionFailedException || current is EncryptionException) return true
            val text = (current.message ?: current.javaClass.simpleName).lowercase()
            if (
                text.contains("decrypt") ||
                text.contains("passphrase") ||
                text.contains("password") ||
                text.contains("bcrypt") ||
                text.contains("mac check")
            ) {
                return true
            }
            current = current.cause
        }
        return false
    }
}
