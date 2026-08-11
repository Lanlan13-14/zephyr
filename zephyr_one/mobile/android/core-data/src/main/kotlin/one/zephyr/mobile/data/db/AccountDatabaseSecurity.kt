package one.zephyr.mobile.data.db

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.ProviderException
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import one.zephyr.mobile.security.KeystoreMasterKey

/** Exact server, user and binding generation which own a local mirror. */
class AccountDatabaseScope(
    val serverId: String,
    val userId: String,
    val generation: String,
) {
    init {
        require(serverId.isNotBlank()) { "serverId must not be blank" }
        require(userId.isNotBlank()) { "userId must not be blank" }
        require(generation.isNotBlank()) { "generation must not be blank" }
    }

    internal fun authenticatedBytes(): ByteArray = ByteArrayOutputStream().use { bytes ->
        DataOutputStream(bytes).use { output ->
            output.write(SCOPE_DOMAIN)
            listOf(serverId, userId, generation).forEach { value ->
                val encoded = value.toByteArray(Charsets.UTF_8)
                output.writeInt(encoded.size)
                output.write(encoded)
            }
        }
        bytes.toByteArray()
    }

    override fun equals(other: Any?): Boolean =
        other is AccountDatabaseScope &&
            serverId == other.serverId &&
            userId == other.userId &&
            generation == other.generation

    override fun hashCode(): Int = 31 * (31 * serverId.hashCode() + userId.hashCode()) + generation.hashCode()

    /** Raw account identifiers must not accidentally enter logs. */
    override fun toString(): String = "AccountDatabaseScope(<redacted>)"

    private companion object {
        val SCOPE_DOMAIN: ByteArray = "zephyr.one.account-database.scope.v1\u0000".toByteArray(Charsets.UTF_8)
    }
}

@JvmInline
internal value class AccountDatabaseNamespace(val value: String) {
    init {
        require(value.length == NAMESPACE_HEX_LENGTH && value.all { it in '0'..'9' || it in 'a'..'f' }) {
            "invalid account database namespace"
        }
    }

    private companion object {
        const val NAMESPACE_HEX_LENGTH = 64
    }
}

internal fun interface AccountNamespaceDeriver {
    fun derive(scope: AccountDatabaseScope): AccountDatabaseNamespace
}

/** HMAC makes filenames opaque even when server and user identifiers are guessable. */
internal class HmacAccountNamespaceDeriver(
    private val keyProvider: () -> SecretKey,
) : AccountNamespaceDeriver {
    override fun derive(scope: AccountDatabaseScope): AccountDatabaseNamespace {
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(keyProvider())
        return AccountDatabaseNamespace(mac.doFinal(scope.authenticatedBytes()).toHex())
    }

    private companion object {
        const val HMAC_ALGORITHM = "HmacSHA256"
    }
}

internal object AndroidKeystoreAccountNamespaceKey {
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALGORITHM = KeyProperties.KEY_ALGORITHM_HMAC_SHA256
    private const val ALIAS = "zephyr.one.accountdb.namespace.v1"

    @Synchronized
    fun getOrCreate(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return generate(strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setKeySize(256)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    setUnlockedDeviceRequired(true)
                    if (strongBox) setIsStrongBoxBacked(true)
                }
            }
            .build()
        return try {
            KeyGenerator.getInstance(ALGORITHM, PROVIDER).run {
                init(spec)
                generateKey()
            }
        } catch (unavailable: ProviderException) {
            if (!strongBox) throw unavailable
            generate(strongBox = false)
        }
    }
}

internal interface AccountDatabaseKeyCipher {
    fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray
    fun open(ciphertext: ByteArray, aad: ByteArray): ByteArray
}

internal object KeystoreAccountDatabaseKeyCipher : AccountDatabaseKeyCipher {
    private const val WRAPPING_KEY_ALIAS = "zephyr.one.accountdb.wrap.v1"

    @Synchronized
    override fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray =
        KeystoreMasterKey.seal(
            key = KeystoreMasterKey.getOrCreate(WRAPPING_KEY_ALIAS),
            plaintext = plaintext,
            aad = aad,
        )

    @Synchronized
    override fun open(ciphertext: ByteArray, aad: ByteArray): ByteArray =
        KeystoreMasterKey.open(
            key = KeystoreMasterKey.getOrCreate(WRAPPING_KEY_ALIAS),
            blob = ciphertext,
            aad = aad,
        )
}

internal fun interface FileModeApplier {
    fun apply(file: File, mode: Int)
}

internal object AndroidFileModeApplier : FileModeApplier {
    override fun apply(file: File, mode: Int) {
        Os.chmod(file.absolutePath, mode)
    }
}

internal class AccountDatabaseKeyStore(
    internal val directory: File,
    private val namespaceDeriver: AccountNamespaceDeriver,
    private val cipher: AccountDatabaseKeyCipher,
    private val modeApplier: FileModeApplier,
    private val random: SecureRandom = SecureRandom(),
) {
    init {
        ensurePrivateDirectory(directory, modeApplier)
    }

    @Synchronized
    fun loadOrCreate(scope: AccountDatabaseScope): ByteArray {
        val namespace = namespaceDeriver.derive(scope)
        val envelope = envelopeFile(namespace)
        deleteStaleTemps(envelope)
        if (envelope.exists()) {
            require(envelope.isFile && envelope.length() in 1..MAX_ENVELOPE_BYTES) {
                "account database key envelope is invalid"
            }
            modeApplier.apply(envelope, MODE_FILE)
            val databaseKey = cipher.open(envelope.readBytes(), scope.authenticatedBytes())
            try {
                validateDatabaseKey(databaseKey)
                return databaseKey
            } catch (failure: Throwable) {
                databaseKey.fill(0)
                throw failure
            }
        }

        val databaseKey = ByteArray(DATABASE_KEY_BYTES).also(random::nextBytes)
        try {
            val sealed = cipher.seal(databaseKey, scope.authenticatedBytes())
            require(sealed.size in 1..MAX_ENVELOPE_BYTES) { "account database key envelope is invalid" }
            writePrivateAtomically(envelope, sealed, modeApplier)
            return databaseKey.copyOf()
        } finally {
            databaseKey.fill(0)
        }
    }

    @Synchronized
    fun delete(scope: AccountDatabaseScope) {
        delete(namespaceDeriver.derive(scope))
    }

    @Synchronized
    fun delete(namespace: AccountDatabaseNamespace) {
        val envelope = envelopeFile(namespace)
        deleteStaleTemps(envelope)
        check(!envelope.exists() || envelope.delete()) { "could not erase account database key" }
    }

    internal fun envelopeFile(namespace: AccountDatabaseNamespace): File =
        File(directory, "account-${namespace.value}.key")

    private fun deleteStaleTemps(envelope: File) {
        directory.listFiles()
            .orEmpty()
            .filter { it.name.startsWith(envelope.name + ".tmp-") }
            .forEach { stale -> check(stale.delete()) { "could not erase stale database key temporary file" } }
    }

    private fun validateDatabaseKey(key: ByteArray) {
        require(key.size == DATABASE_KEY_BYTES) { "account database key has the wrong length" }
    }

    private companion object {
        const val DATABASE_KEY_BYTES = 32
        const val MAX_ENVELOPE_BYTES = 4096L
    }
}

internal class AccountDatabaseFiles(
    val root: File,
    val namespace: AccountDatabaseNamespace,
    private val modeApplier: FileModeApplier,
) {
    val database: File = File(root, "account-${namespace.value}.db")
    val tombstone: File = File(File(root, "erased"), "account-${namespace.value}.erased")

    init {
        ensurePrivateDirectory(root, modeApplier)
        ensurePrivateDirectory(tombstone.parentFile!!, modeApplier)
    }

    fun isErased(): Boolean = tombstone.isFile

    fun markErased() {
        if (!tombstone.exists()) {
            writePrivateAtomically(tombstone, TOMBSTONE_BYTES, modeApplier)
        } else {
            modeApplier.apply(tombstone, MODE_FILE)
        }
    }

    fun hardenDatabaseFiles() {
        databaseArtifacts().filter(File::exists).forEach { modeApplier.apply(it, MODE_FILE) }
    }

    fun eraseDatabaseFiles() {
        databaseArtifacts().filter(File::exists).forEach { file ->
            check(file.delete()) { "could not erase account database artifact" }
        }
    }

    internal fun databaseArtifacts(): List<File> =
        root.listFiles()
            .orEmpty()
            .filter { isOwnedDatabaseArtifact(it.name) }

    private fun isOwnedDatabaseArtifact(name: String): Boolean =
        name == database.name ||
            name == database.name + "-wal" ||
            name == database.name + "-shm" ||
            name == database.name + "-journal" ||
            name.startsWith(database.name + "-mj ") ||
            name.startsWith(database.name + ".tmp-")

    internal companion object {
        val TOMBSTONE_BYTES = "erased-v1\n".toByteArray(Charsets.US_ASCII)

        fun erasedNamespaces(root: File): List<AccountDatabaseNamespace> =
            File(root, "erased").listFiles()
                .orEmpty()
                .asSequence()
                .filter(File::isFile)
                .mapNotNull { file ->
                    TOMBSTONE_PATTERN.matchEntire(file.name)
                        ?.groupValues
                        ?.get(1)
                        ?.let(::AccountDatabaseNamespace)
                }
                .sortedBy(AccountDatabaseNamespace::value)
                .toList()

        private val TOMBSTONE_PATTERN = Regex("account-([0-9a-f]{64})\\.erased")
    }
}

/** Completes crash-interrupted erasure without needing the deleted binding row or raw identity. */
internal class AccountDatabaseErasureSweeper(
    private val root: File,
    private val keyStore: AccountDatabaseKeyStore,
    private val modeApplier: FileModeApplier,
) {
    fun sweep() {
        var failure: Throwable? = null
        AccountDatabaseFiles.erasedNamespaces(root).forEach { namespace ->
            val files = AccountDatabaseFiles(root, namespace, modeApplier)
            runCatching { keyStore.delete(namespace) }
                .onFailure { if (failure == null) failure = it }
            runCatching { files.eraseDatabaseFiles() }
                .onFailure { if (failure == null) failure = it }
        }
        failure?.let { throw it }
    }
}

internal fun ensurePrivateDirectory(directory: File, modeApplier: FileModeApplier) {
    check((directory.isDirectory || directory.mkdirs()) && directory.isDirectory) {
        "could not create private account database directory"
    }
    modeApplier.apply(directory, MODE_DIRECTORY)
}

internal fun writePrivateAtomically(destination: File, bytes: ByteArray, modeApplier: FileModeApplier) {
    ensurePrivateDirectory(destination.parentFile!!, modeApplier)
    val temporary = File(
        destination.parentFile,
        destination.name + ".tmp-" + Thread.currentThread().id + "-" + System.nanoTime(),
    )
    try {
        FileOutputStream(temporary).use { output ->
            output.write(bytes)
            output.fd.sync()
        }
        modeApplier.apply(temporary, MODE_FILE)
        Files.move(
            temporary.toPath(),
            destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
        )
        modeApplier.apply(destination, MODE_FILE)
    } finally {
        temporary.delete()
    }
}

private fun ByteArray.toHex(): String = joinToString(separator = "") { byte ->
    "%02x".format(byte.toInt() and 0xff)
}

internal const val MODE_DIRECTORY = 448 // 0700
internal const val MODE_FILE = 384 // 0600
