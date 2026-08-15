package one.zephyr.mobile.protocol.rdp

import java.io.File
import java.util.Locale
import java.util.Properties

/**
 * Host:port → SHA-256 fingerprint allowlist for the Android FreeRDP shim.
 *
 * The C ABI only exposes the fingerprint on `ZEPHYR_RDP_EV_LOG` and a boolean
 * `ignore_certificate`. It cannot pause for a UI decision. The engine therefore
 * connects with verification on, captures the fingerprint, and either prompts or
 * retries with `ignore_certificate` when the stored value matches.
 */
interface RdpFingerprintBook {
    fun find(host: String, port: Int): String?
    fun put(host: String, port: Int, fingerprint: String)
    fun remove(host: String, port: Int)

    companion object {
        fun key(host: String, port: Int): String =
            host.trim().lowercase(Locale.ROOT) + ":" + port

        fun normalize(raw: String): String {
            var value = raw.trim()
            val algo = value.substringBefore(':', missingDelimiterValue = "")
            if (algo.equals("sha256", ignoreCase = true) || algo.equals("sha1", ignoreCase = true)) {
                value = value.substringAfter(':')
            }
            val hex = buildString(value.length) {
                for (ch in value) {
                    when (ch) {
                        ' ', '\t', ':', '-' -> Unit
                        in '0'..'9', in 'a'..'f', in 'A'..'F' -> append(ch.uppercaseChar())
                        else -> return ""
                    }
                }
            }
            if (hex.isEmpty() || hex.length % 2 != 0) return ""
            return hex.chunked(2).joinToString(":")
        }
    }
}

class MemoryRdpFingerprintBook : RdpFingerprintBook {
    private val values = LinkedHashMap<String, String>()

    @Synchronized
    override fun find(host: String, port: Int): String? = values[RdpFingerprintBook.key(host, port)]

    @Synchronized
    override fun put(host: String, port: Int, fingerprint: String) {
        val normalized = RdpFingerprintBook.normalize(fingerprint)
        if (normalized.isEmpty()) return
        values[RdpFingerprintBook.key(host, port)] = normalized
    }

    @Synchronized
    override fun remove(host: String, port: Int) {
        values.remove(RdpFingerprintBook.key(host, port))
    }
}

class FileRdpFingerprintBook(private val file: File) : RdpFingerprintBook {
    private val lock = Any()

    override fun find(host: String, port: Int): String? = synchronized(lock) {
        load()[RdpFingerprintBook.key(host, port)]
    }

    override fun put(host: String, port: Int, fingerprint: String) {
        val normalized = RdpFingerprintBook.normalize(fingerprint)
        if (normalized.isEmpty()) return
        synchronized(lock) {
            val values = load()
            values[RdpFingerprintBook.key(host, port)] = normalized
            save(values)
        }
    }

    override fun remove(host: String, port: Int) {
        synchronized(lock) {
            val values = load()
            if (values.remove(RdpFingerprintBook.key(host, port)) != null) save(values)
        }
    }

    private fun load(): LinkedHashMap<String, String> {
        val values = LinkedHashMap<String, String>()
        if (!file.isFile) return values
        val properties = Properties()
        file.inputStream().use { properties.load(it) }
        for ((rawKey, rawValue) in properties) {
            val key = (rawKey as? String)?.trim().orEmpty()
            val value = RdpFingerprintBook.normalize((rawValue as? String).orEmpty())
            if (key.isNotEmpty() && value.isNotEmpty()) values[key] = value
        }
        return values
    }

    private fun save(values: Map<String, String>) {
        file.parentFile?.mkdirs()
        val properties = Properties()
        for ((key, value) in values) properties[key] = value
        val staging = File(file.parentFile, file.name + ".tmp")
        staging.outputStream().use { properties.store(it, "Zephyr One RDP fingerprints") }
        if (!staging.renameTo(file)) {
            staging.copyTo(file, overwrite = true)
            staging.delete()
        }
    }
}
