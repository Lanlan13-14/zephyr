package one.zephyr.mobile.feature.notes

import one.zephyr.mobile.protocol.ssh.SshFileKinds
import one.zephyr.mobile.protocol.ssh.SshRemoteOps

object SftpTransferOps {

    const val STREAM_CHUNK = 256 * 1024

    fun bundleName(): String {
        val stamp = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMddHHmm"))
        return "zephyr-download-$stamp.tar.gz"
    }

    fun bundleCommand(sources: List<String>, target: String): String {
        require(sources.isNotEmpty()) { "没有可打包的项目" }
        val quoted = sources.joinToString(" ") { SshRemoteOps.shellQuote(it) }
        return "tar -czf ${SshRemoteOps.shellQuote(target)} $quoted"
    }

    fun remoteTempPath(name: String): String = "/tmp/${name.trimStart('/')}"

    fun cleanupCommand(path: String): String = SshFileKinds.recursiveDeleteCommand(path)

    data class Transfer(
        val id: String,
        val label: String,
        val direction: Direction,
        val path: String,
        val loaded: Long = 0L,
        val total: Long = 0L,
        val status: Status = Status.RUNNING,
        val detail: String = "",
    ) {
        val fraction: Float
            get() = if (total <= 0L) 0f else (loaded.toFloat() / total.toFloat()).coerceIn(0f, 1f)
    }

    enum class Direction { UPLOAD, DOWNLOAD, ARCHIVE }

    enum class Status { RUNNING, DONE, ERROR, CANCELLED }
}
