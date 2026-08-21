package one.zephyr.mobile.protocol.ssh

import java.io.File
import java.util.Locale
import java.util.Properties

interface SshKnownHostsBook {
    fun find(host: String, port: Int): HostKey?
    fun put(host: String, port: Int, key: HostKey)
    fun remove(host: String, port: Int)

    companion object {
        fun key(host: String, port: Int): String =
            host.trim().lowercase(Locale.ROOT) + ":" + port
    }
}

class MemorySshKnownHostsBook : SshKnownHostsBook {
    private val values = LinkedHashMap<String, HostKey>()

    @Synchronized
    override fun find(host: String, port: Int): HostKey? = values[SshKnownHostsBook.key(host, port)]

    @Synchronized
    override fun put(host: String, port: Int, key: HostKey) {
        values[SshKnownHostsBook.key(host, port)] = key
    }

    @Synchronized
    override fun remove(host: String, port: Int) {
        values.remove(SshKnownHostsBook.key(host, port))
    }
}

class FileSshKnownHostsBook(private val file: File) : SshKnownHostsBook {
    private val lock = Any()

    override fun find(host: String, port: Int): HostKey? = synchronized(lock) {
        load()[SshKnownHostsBook.key(host, port)]
    }

    override fun put(host: String, port: Int, key: HostKey) {
        synchronized(lock) {
            val values = load()
            values[SshKnownHostsBook.key(host, port)] = key
            save(values)
        }
    }

    override fun remove(host: String, port: Int) {
        synchronized(lock) {
            val values = load()
            if (values.remove(SshKnownHostsBook.key(host, port)) != null) save(values)
        }
    }

    private fun load(): LinkedHashMap<String, HostKey> {
        val values = LinkedHashMap<String, HostKey>()
        if (!file.isFile) return values
        val properties = Properties()
        file.inputStream().use { properties.load(it) }
        for ((rawKey, rawValue) in properties) {
            val key = (rawKey as? String)?.trim().orEmpty()
            val raw = (rawValue as? String)?.trim().orEmpty()
            if (key.isNotEmpty() && raw.isNotEmpty()) {
                val parsed = parseHostKey(raw)
                if (parsed != null) values[key] = parsed
            }
        }
        return values
    }

    private fun save(values: Map<String, HostKey>) {
        file.parentFile?.mkdirs()
        val properties = Properties()
        for ((key, value) in values) {
            properties[key] = serializeHostKey(value)
        }
        val staging = File(file.parentFile, file.name + ".tmp")
        staging.outputStream().use { properties.store(it, "Zephyr One SSH known hosts") }
        if (!staging.renameTo(file)) {
            staging.copyTo(file, overwrite = true)
            staging.delete()
        }
    }

    companion object {
        fun serializeHostKey(key: HostKey): String =
            key.algorithm + " " + encodeBase64(key.blob)

        fun parseHostKey(raw: String): HostKey? {
            val trimmed = raw.trim()
            val space = trimmed.indexOf(' ')
            if (space <= 0 || space >= trimmed.length - 1) return null
            val algo = trimmed.substring(0, space).trim()
            val b64 = trimmed.substring(space + 1).trim()
            val blob = decodeBase64(b64) ?: return null
            if (algo.isEmpty() || blob.isEmpty()) return null
            return HostKey(algorithm = algo, blob = blob)
        }

        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

        fun encodeBase64(bytes: ByteArray): String {
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
                    out.append("==")
                }
                2 -> {
                    val chunk = ((bytes[index].toInt() and 0xFF) shl 16) or
                        ((bytes[index + 1].toInt() and 0xFF) shl 8)
                    out.append(ALPHABET[(chunk shr 18) and 0x3F])
                    out.append(ALPHABET[(chunk shr 12) and 0x3F])
                    out.append(ALPHABET[(chunk shr 6) and 0x3F])
                    out.append("=")
                }
            }
            return out.toString()
        }

        fun decodeBase64(raw: String): ByteArray? {
            val s = raw.trim().trimEnd('=')
            if (s.isEmpty()) return ByteArray(0)
            val alphabet = ALPHABET
            val out = ArrayList<Byte>(s.length * 3 / 4)
            var index = 0
            while (index < s.length) {
                val rem = s.length - index
                if (rem >= 4) {
                    val c0 = alphabet.indexOf(s[index]); if (c0 < 0) return null
                    val c1 = alphabet.indexOf(s[index + 1]); if (c1 < 0) return null
                    val c2 = alphabet.indexOf(s[index + 2]); if (c2 < 0) return null
                    val c3 = alphabet.indexOf(s[index + 3]); if (c3 < 0) return null
                    val chunk = (c0 shl 18) or (c1 shl 12) or (c2 shl 6) or c3
                    out.add(((chunk shr 16) and 0xFF).toByte())
                    out.add(((chunk shr 8) and 0xFF).toByte())
                    out.add((chunk and 0xFF).toByte())
                    index += 4
                } else if (rem == 3) {
                    val c0 = alphabet.indexOf(s[index]); if (c0 < 0) return null
                    val c1 = alphabet.indexOf(s[index + 1]); if (c1 < 0) return null
                    val c2 = alphabet.indexOf(s[index + 2]); if (c2 < 0) return null
                    val chunk = (c0 shl 18) or (c1 shl 12) or (c2 shl 6)
                    out.add(((chunk shr 16) and 0xFF).toByte())
                    out.add(((chunk shr 8) and 0xFF).toByte())
                    index += 3
                } else if (rem == 2) {
                    val c0 = alphabet.indexOf(s[index]); if (c0 < 0) return null
                    val c1 = alphabet.indexOf(s[index + 1]); if (c1 < 0) return null
                    val chunk = (c0 shl 18) or (c1 shl 12)
                    out.add(((chunk shr 16) and 0xFF).toByte())
                    index += 2
                } else {
                    return null
                }
            }
            val result = ByteArray(out.size)
            for (i in out.indices) result[i] = out[i]
            return result
        }
    }
}
