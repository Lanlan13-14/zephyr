package one.zephyr.mobile.protocol.ssh

/**
 * Desktop-parity Docker / host-monitor command builders and parsers.
 *
 * The desktop terminal talks to `server.js` over WebSocket; Mobile already has a live SSH
 * exec channel, so the same remote shell snippets run here and the JSON / marker output is
 * parsed locally. Keeping the command text and the parsers in one file is what stops the
 * drawer UI from inventing a second, thinner protocol.
 */
object SshRemoteOps {

    const val MARKER_INSTALLED = "__DOCKER_INSTALLED__="
    const val MARKER_SOCKET = "__DOCKER_SOCKET__="
    const val MARKER_CPU = "__END_CPU__"
    const val MARKER_MEM = "__END_MEM__"
    const val MARKER_DISK = "__END_DISK__"
    const val MARKER_DISKSTATS = "__END_DISKSTATS__"
    const val MARKER_NET = "__END_NET__"
    const val MARKER_IP4 = "__END_IP4__"
    const val MARKER_IP6 = "__END_IP6__"
    const val MARKER_CPUINFO = "__END_CPUINFO__"
    const val MARKER_UNAME = "__END_UNAME__"
    const val MARKER_PROC = "__END_PROC__"

    val dockerCheckCommand: String = listOf(
        "if command -v docker >/dev/null 2>&1; then",
        "  echo ${MARKER_INSTALLED}1; docker --version 2>/dev/null || true;",
        "  if [ -S /var/run/docker.sock ]; then echo ${MARKER_SOCKET}1; else echo ${MARKER_SOCKET}0; fi;",
        "else echo ${MARKER_INSTALLED}0; fi",
    ).joinToString(" ")

    val dockerListContainersCommand: String =
        "docker ps -a --no-trunc --format '{{json .}}'"

    val dockerListImagesCommand: String =
        "docker image ls --no-trunc --format '{{json .}}'"

    val dockerMirrorsGetCommand: String =
        "if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json; else printf '{}'; fi"

    val dockerRestartServiceCommand: String = listOf(
        "set -e",
        "if [ \"\$(id -u)\" = \"0\" ]; then SUDO=\"\"; else SUDO=\"sudo -n\"; fi",
        "if command -v systemctl >/dev/null 2>&1; then",
        "  \$SUDO systemctl restart docker",
        "elif command -v service >/dev/null 2>&1; then",
        "  \$SUDO service docker restart",
        "else",
        "  echo \"未找到 systemctl/service，无法自动重启 Docker\" >&2",
        "  exit 1",
        "fi",
        "echo \"Docker 服务已重启\"",
    ).joinToString("\n")

    val statsCommand: String = listOf(
        "cat /proc/stat || true",
        "printf '\\n$MARKER_CPU\\n'",
        "cat /proc/meminfo || true",
        "printf '\\n$MARKER_MEM\\n'",
        "df -kP -x tmpfs -x devtmpfs -x squashfs -x overlay || true",
        "printf '\\n$MARKER_DISK\\n'",
        "cat /proc/diskstats || true",
        "printf '\\n$MARKER_DISKSTATS\\n'",
        "cat /proc/net/dev || true",
        "printf '\\n$MARKER_NET\\n'",
        "if command -v curl >/dev/null 2>&1; then curl -4 -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org || curl -4 -fsS --connect-timeout 3 --max-time 5 https://ifconfig.me/ip || true; else true; fi",
        "printf '\\n$MARKER_IP4\\n'",
        "if command -v curl >/dev/null 2>&1; then curl -6 -fsS --connect-timeout 3 --max-time 5 https://api64.ipify.org || curl -6 -fsS --connect-timeout 3 --max-time 5 https://ifconfig.co/ip || true; else true; fi",
        "printf '\\n$MARKER_IP6\\n'",
        "cat /proc/cpuinfo || true",
        "printf '\\n$MARKER_CPUINFO\\n'",
        "uname -srmo 2>/dev/null || true",
        "printf '\\n$MARKER_UNAME\\n'",
        "ps -eo pid=,user=,pcpu=,pmem=,stat=,comm=,args= --sort=-pcpu 2>/dev/null | head -n 61 || true",
        "printf '\\n$MARKER_PROC\\n'",
        "hostname 2>/dev/null || true",
    ).joinToString(" && ")

    fun shellQuote(value: String): String =
        "'" + value.replace("'", "'\\''") + "'"

    fun dockerContainerActionCommand(action: DockerContainerAction, target: String): String {
        val quoted = shellQuote(target)
        return when (action) {
            DockerContainerAction.START -> "docker start $quoted"
            DockerContainerAction.STOP -> "docker stop $quoted"
            DockerContainerAction.RESTART -> "docker restart $quoted"
            DockerContainerAction.REMOVE -> "docker rm -f $quoted"
            DockerContainerAction.PAUSE -> "docker pause $quoted"
            DockerContainerAction.UNPAUSE -> "docker unpause $quoted"
        }
    }

    fun dockerLogsCommand(container: String, tail: Int = 400, follow: Boolean = false): String {
        val flags = buildString {
            append("--tail ")
            append(tail.coerceIn(1, 2000))
            if (follow) append(" -f")
        }
        return "docker logs $flags ${shellQuote(container)}"
    }

    fun dockerUsedByCommand(image: String): String =
        "docker ps -a --filter ${shellQuote("ancestor=$image")} --format '{{.ID}} {{.Names}}' || true"

    fun dockerDeleteImageCommand(image: String, force: Boolean): String =
        if (force) "docker rmi -f ${shellQuote(image)}" else "docker rmi ${shellQuote(image)}"

    fun dockerPullCommand(image: String): String = "docker pull ${shellQuote(image)}"

    fun dockerMirrorsSetCommand(mirrors: List<String>): String {
        val encoded = java.util.Base64.getEncoder()
            .encodeToString(jsonArray(mirrors.map(::sanitizeMirror)).toByteArray(Charsets.UTF_8))
        return """
set -e
PY=$(command -v python3 || command -v python || true)
[ -n "${'$'}PY" ] || { echo "目标主机需要 python3/python 才能安全更新 daemon.json" >&2; exit 1; }
TMP=$(mktemp)
OUT=$(mktemp)
if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json > "${'$'}TMP"; else printf '{}' > "${'$'}TMP"; fi
"${'$'}PY" - "${'$'}TMP" "${'$'}OUT" ${shellQuote(encoded)} <<'PY'
import base64, json, sys
src, out, encoded = sys.argv[1:4]
try:
    with open(src, 'r', encoding='utf-8') as fh:
        data = json.load(fh)
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
data['registry-mirrors'] = json.loads(base64.b64decode(encoded).decode('utf-8'))
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
PY
if [ "${'$'}(id -u)" = "0" ]; then
  mkdir -p /etc/docker && cp "${'$'}OUT" /etc/docker/daemon.json
else
  sudo -n mkdir -p /etc/docker && sudo -n cp "${'$'}OUT" /etc/docker/daemon.json
fi
rm -f "${'$'}TMP" "${'$'}OUT"
echo "Docker registry-mirrors 已更新，请重启 Docker 服务使配置生效。"
""".trimIndent()
    }

    fun processSignalCommand(pid: Int, signal: ProcessSignal): String {
        require(pid > 1) { "PID 无效或不允许操作系统关键进程" }
        val name = if (signal == ProcessSignal.KILL) "KILL" else "TERM"
        return "kill -s $name $pid"
    }

    fun parseDockerStatus(raw: String): DockerEngineStatus {
        val installed = raw.contains("${MARKER_INSTALLED}1")
        val socket = raw.contains("${MARKER_SOCKET}1")
        val version = raw.lineSequence()
            .map(String::trim)
            .firstOrNull { it.lowercase().startsWith("docker version") }
            .orEmpty()
        return DockerEngineStatus(installed = installed, socket = socket, version = version, raw = raw)
    }

    fun parseJsonLines(raw: String): List<Map<String, String>> =
        raw.lineSequence()
            .map(String::trim)
            .filter { it.startsWith("{") && it.endsWith("}") }
            .mapNotNull { line -> runCatching { parseFlatJsonObject(line) }.getOrNull() }
            .toList()

    fun parseDockerContainers(raw: String): List<DockerContainerInfo> =
        parseJsonLines(raw).map { row ->
            val id = first(row, "ID", "Id", "id")
            val name = first(row, "Names", "Name", "names").trimStart('/')
            val image = first(row, "Image", "image")
            val status = first(row, "Status", "status")
            val state = first(row, "State", "state").ifBlank {
                if (status.contains("up", ignoreCase = true) || status.contains("running", ignoreCase = true)) {
                    "running"
                } else {
                    "exited"
                }
            }
            DockerContainerInfo(
                id = id,
                name = name.ifBlank { shortId(id) },
                image = image,
                status = status.ifBlank { state },
                state = state,
                ports = first(row, "Ports", "ports").ifBlank { "—" },
                createdAt = first(row, "CreatedAt", "Created", "createdAt"),
            )
        }

    fun parseDockerImages(raw: String): List<DockerImageInfo> =
        parseJsonLines(raw).map { row ->
            DockerImageInfo(
                id = first(row, "ID", "Id", "ImageID", "id"),
                repository = first(row, "Repository", "repository").ifBlank { "<none>" },
                tag = first(row, "Tag", "tag").ifBlank { "<none>" },
                size = first(row, "Size", "size"),
                createdAt = first(row, "CreatedAt", "CreatedSince", "Created", "createdAt"),
            )
        }

    fun parseDockerMirrors(raw: String): List<String> {
        val text = raw.trim()
        if (text.isEmpty()) return emptyList()
        val key = "\"registry-mirrors\""
        val keyIndex = text.indexOf(key)
        if (keyIndex < 0) return emptyList()
        val bracket = text.indexOf('[', keyIndex)
        if (bracket < 0) return emptyList()
        val end = text.indexOf(']', bracket)
        if (end < 0) return emptyList()
        val body = text.substring(bracket + 1, end)
        return body.split(',')
            .map { it.trim().trim('"').trim() }
            .filter { it.startsWith("http://") || it.startsWith("https://") }
            .distinct()
    }

    fun parseRemoteStats(raw: String, previous: HostStatsSample? = null, nowMs: Long = System.currentTimeMillis()): HostStatsSnapshot {
        val sections = splitStatsSections(raw)
        val cpuStat = parseCpuStat(sections.cpu)
        val mem = parseMemory(sections.mem)
        val disk = parseDisk(sections.disk)
        val diskStats = parseDiskStats(sections.diskstats)
        val netValues = parseNet(sections.net)
        val elapsedSec = previous?.timestampMs?.let { (nowMs - it) / 1000.0 } ?: 0.0
        val cpuUsage = computeCpuUsage(cpuStat, previous?.cpu)
        val netRates = computeNetRates(netValues, previous?.net, elapsedSec)
        val disks = computeDiskRates(disk, diskStats, previous?.diskStats, elapsedSec)
        return HostStatsSnapshot(
            hostName = sections.hostname.trim().ifBlank { "N/A" },
            os = sections.uname.trim().ifBlank { "N/A" },
            cpu = HostCpuInfo(
                usagePercent = cpuUsage,
                model = parseCpuModel(sections.cpuinfo),
                freq = parseCpuFreq(sections.cpuinfo),
                cores = parseCpuCores(sections.cpuinfo),
            ),
            memory = mem,
            disks = disks,
            network = netRates,
            ipv4 = parseIp(sections.ip4),
            ipv6 = parseIp(sections.ip6),
            processes = parseProcesses(sections.processes),
            sample = HostStatsSample(
                cpu = cpuStat,
                net = netValues,
                diskStats = diskStats,
                timestampMs = nowMs,
            ),
        )
    }

    fun shortId(id: String): String = id.removePrefix("sha256:").take(12)

    fun sanitizeMirror(value: String): String = value.trim().trimEnd('/')

    fun isValidMirror(value: String): Boolean {
        val trimmed = sanitizeMirror(value)
        return trimmed.startsWith("http://") || trimmed.startsWith("https://")
    }

    internal fun splitStatsSections(raw: String): StatsSections {
        fun cut(source: String, marker: String): Pair<String, String> {
            val idx = source.indexOf("\n$marker\n")
            if (idx < 0) return source to ""
            return source.substring(0, idx) to source.substring(idx + marker.length + 2)
        }
        val (cpu, rest1) = cut(raw, MARKER_CPU)
        val (mem, rest2) = cut(rest1, MARKER_MEM)
        val (disk, rest3) = cut(rest2, MARKER_DISK)
        val (diskstats, rest4) = cut(rest3, MARKER_DISKSTATS)
        val (net, rest5) = cut(rest4, MARKER_NET)
        val (ip4, rest6) = cut(rest5, MARKER_IP4)
        val (ip6, rest7) = cut(rest6, MARKER_IP6)
        val (cpuinfo, rest8) = cut(rest7, MARKER_CPUINFO)
        val (uname, rest9) = cut(rest8, MARKER_UNAME)
        val (processes, hostname) = cut(rest9, MARKER_PROC)
        return StatsSections(cpu, mem, disk, diskstats, net, ip4, ip6, cpuinfo, uname, processes, hostname)
    }

    internal fun parseCpuStat(raw: String): CpuStat? {
        val line = raw.lineSequence().firstOrNull { it.startsWith("cpu ") } ?: return null
        val parts = line.trim().split(Regex("\\s+")).drop(1).mapNotNull(String::toLongOrNull)
        if (parts.isEmpty()) return null
        val idle = parts.getOrElse(3) { 0L } + parts.getOrElse(4) { 0L }
        return CpuStat(idle = idle, total = parts.sum())
    }

    internal fun parseMemory(raw: String): HostMemoryInfo {
        var memTotal = 0.0
        var memAvail = 0.0
        var swapTotal = 0.0
        var swapFree = 0.0
        raw.lineSequence().forEach { line ->
            when {
                line.startsWith("MemTotal") -> memTotal = kibToMb(line)
                line.startsWith("MemAvailable") -> memAvail = kibToMb(line)
                line.startsWith("SwapTotal") -> swapTotal = kibToMb(line)
                line.startsWith("SwapFree") -> swapFree = kibToMb(line)
            }
        }
        return HostMemoryInfo(
            memUsedMb = (memTotal - memAvail).coerceAtLeast(0.0),
            memTotalMb = memTotal,
            swapUsedMb = (swapTotal - swapFree).coerceAtLeast(0.0),
            swapTotalMb = swapTotal,
        )
    }

    internal fun parseDisk(raw: String): List<HostDiskDevice> {
        return raw.trim().lineSequence().drop(1).mapNotNull { line ->
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size < 6) return@mapNotNull null
            val filesystem = parts[0]
            val blocks = parts[1].toDoubleOrNull() ?: return@mapNotNull null
            val used = parts[2].toDoubleOrNull() ?: 0.0
            val percent = parts[4].trimEnd('%').toIntOrNull() ?: 0
            val mount = parts[5]
            HostDiskDevice(
                id = "disk-${filesystem.replace(Regex("[^A-Za-z0-9_-]"), "")}-${mount.replace(Regex("[^A-Za-z0-9_-]"), "")}",
                filesystem = filesystem,
                mountpoint = mount,
                diskName = diskBaseName(filesystem),
                usedGb = used / 1024.0 / 1024.0,
                totalGb = blocks / 1024.0 / 1024.0,
                percent = percent,
                readKBps = 0.0,
                writeKBps = 0.0,
            )
        }.toList()
    }

    internal fun parseDiskStats(raw: String): Map<String, DiskCounters> {
        val stats = linkedMapOf<String, DiskCounters>()
        raw.lineSequence().forEach { line ->
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size < 14) return@forEach
            stats[parts[2]] = DiskCounters(
                reads = parts[5].toLongOrNull() ?: 0L,
                writes = parts[9].toLongOrNull() ?: 0L,
            )
        }
        return stats
    }

    internal fun parseNet(raw: String): NetCounters {
        var rx = 0L
        var tx = 0L
        raw.lineSequence().forEach { line ->
            val cleaned = line.replace(":", " ")
            val parts = cleaned.trim().split(Regex("\\s+"))
            if (parts.size < 17) return@forEach
            val iface = parts[0]
            if (iface == "lo" || iface.startsWith("docker") || iface.startsWith("veth") || iface.startsWith("br-")) {
                return@forEach
            }
            rx += parts[1].toLongOrNull() ?: 0L
            tx += parts[9].toLongOrNull() ?: 0L
        }
        return NetCounters(rx = rx, tx = tx)
    }

    internal fun parseProcesses(raw: String): List<HostProcessInfo> =
        raw.lineSequence().mapNotNull { line ->
            val match = PROCESS_LINE.matchEntire(line.trim()) ?: return@mapNotNull null
            HostProcessInfo(
                pid = match.groupValues[1].toIntOrNull() ?: return@mapNotNull null,
                user = match.groupValues[2],
                cpuPercent = match.groupValues[3].toDoubleOrNull() ?: 0.0,
                memPercent = match.groupValues[4].toDoubleOrNull() ?: 0.0,
                stat = match.groupValues[5],
                command = match.groupValues[6],
                args = match.groupValues[7].ifBlank { match.groupValues[6] }.take(500),
            )
        }.filter { it.pid > 0 }.toList()

    internal fun parseIp(raw: String): String {
        raw.lineSequence().forEach { line ->
            val trimmed = line.trim()
            if (trimmed.isEmpty()) return@forEach
            if (IPV4.matches(trimmed)) return trimmed
            if (trimmed.contains(':') && HEX_ADDR.matches(trimmed.lowercase()) &&
                !trimmed.startsWith("fe80", ignoreCase = true) && trimmed != "::1"
            ) {
                return trimmed
            }
        }
        return "N/A"
    }

    internal fun parseCpuModel(raw: String): String =
        raw.lineSequence().firstOrNull { it.startsWith("model name") }
            ?.substringAfter(':')
            ?.trim()
            .orEmpty()
            .ifBlank { "N/A" }

    internal fun parseCpuFreq(raw: String): String {
        val mhz = raw.lineSequence().firstOrNull { it.startsWith("cpu MHz") }
            ?.substringAfter(':')
            ?.trim()
            ?.toDoubleOrNull()
        return if (mhz == null) "N/A" else "${mhz.toInt()} MHz"
    }

    internal fun parseCpuCores(raw: String): Int {
        val count = raw.lineSequence().count { it.startsWith("processor") }
        return if (count == 0) 1 else count
    }

    internal fun computeCpuUsage(current: CpuStat?, previous: CpuStat?): Double {
        if (current == null || previous == null) return 0.0
        val totalDiff = current.total - previous.total
        val idleDiff = current.idle - previous.idle
        if (totalDiff <= 0L) return 0.0
        return ((1.0 - idleDiff.toDouble() / totalDiff.toDouble()) * 100.0).coerceIn(0.0, 100.0)
    }

    internal fun computeNetRates(current: NetCounters, previous: NetCounters?, elapsedSec: Double): HostNetworkRates {
        if (previous == null || elapsedSec <= 0.0) return HostNetworkRates(0.0, 0.0)
        val rx = ((current.rx - previous.rx).coerceAtLeast(0L) * 8.0) / elapsedSec / 1024.0 / 1024.0
        val tx = ((current.tx - previous.tx).coerceAtLeast(0L) * 8.0) / elapsedSec / 1024.0 / 1024.0
        return HostNetworkRates(rxMbps = rx, txMbps = tx)
    }

    internal fun computeDiskRates(
        devices: List<HostDiskDevice>,
        current: Map<String, DiskCounters>,
        previous: Map<String, DiskCounters>?,
        elapsedSec: Double,
    ): List<HostDiskDevice> = devices.map { device ->
        val now = device.diskName?.let { current[it] }
        val before = device.diskName?.let { previous?.get(it) }
        if (now == null || before == null || elapsedSec <= 0.0) return@map device
        val read = (now.reads - before.reads).coerceAtLeast(0L) / 2.0 / elapsedSec
        val write = (now.writes - before.writes).coerceAtLeast(0L) / 2.0 / elapsedSec
        device.copy(readKBps = read, writeKBps = write)
    }

    internal data class StatsSections(
        val cpu: String,
        val mem: String,
        val disk: String,
        val diskstats: String,
        val net: String,
        val ip4: String,
        val ip6: String,
        val cpuinfo: String,
        val uname: String,
        val processes: String,
        val hostname: String,
    )

    private fun kibToMb(line: String): Double =
        (line.split(Regex("\\s+")).getOrNull(1)?.toDoubleOrNull() ?: 0.0) / 1024.0

    private fun diskBaseName(filesystem: String): String? {
        if (filesystem.isBlank()) return null
        val name = filesystem.removePrefix("/dev/").removePrefix("mapper/")
        return when {
            Regex("""^nvme\d+n\d+p\d+$""").matches(name) -> name.replace(Regex("p\\d+$"), "")
            Regex("""^mmcblk\d+p\d+$""").matches(name) -> name.replace(Regex("p\\d+$"), "")
            else -> name.replace(Regex("\\d+$"), "")
        }
    }

    private fun first(row: Map<String, String>, vararg keys: String): String {
        for (key in keys) {
            val value = row[key]
            if (!value.isNullOrBlank()) return value
        }
        return ""
    }

    private fun jsonArray(values: List<String>): String =
        values.joinToString(prefix = "[", postfix = "]") { value ->
            "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        }

    /**
     * Tiny object parser for `docker --format '{{json .}}'` lines.
     *
     * Only string values are produced by that format; numbers and nested objects are stored as
     * their raw token text. That is enough for ID / Names / Status / Ports / Size.
     */
    internal fun parseFlatJsonObject(raw: String): Map<String, String> {
        val out = linkedMapOf<String, String>()
        val body = raw.trim().removePrefix("{").removeSuffix("}")
        var index = 0
        fun skipWs() {
            while (index < body.length && body[index].isWhitespace()) index++
        }
        fun readString(): String {
            require(body[index] == '"') { "expected string" }
            index++
            val built = StringBuilder()
            while (index < body.length) {
                val ch = body[index++]
                when (ch) {
                    '\\' -> {
                        if (index >= body.length) break
                        val next = body[index++]
                        built.append(
                            when (next) {
                                'n' -> '\n'
                                't' -> '\t'
                                'r' -> '\r'
                                '"' -> '"'
                                '\\' -> '\\'
                                'u' -> {
                                    val hex = body.substring(index, (index + 4).coerceAtMost(body.length))
                                    index += hex.length
                                    hex.toIntOrNull(16)?.toChar() ?: '?'
                                }
                                else -> next
                            },
                        )
                    }
                    '"' -> return built.toString()
                    else -> built.append(ch)
                }
            }
            return built.toString()
        }
        fun readToken(): String {
            val start = index
            var depth = 0
            while (index < body.length) {
                val ch = body[index]
                if (ch == '{' || ch == '[') depth++
                if (ch == '}' || ch == ']') {
                    if (depth == 0) break
                    depth--
                }
                if (ch == ',' && depth == 0) break
                index++
            }
            return body.substring(start, index).trim().trim('"')
        }
        while (index < body.length) {
            skipWs()
            if (index >= body.length) break
            if (body[index] != '"') {
                index++
                continue
            }
            val key = readString()
            skipWs()
            if (index >= body.length || body[index] != ':') break
            index++
            skipWs()
            val value = if (index < body.length && body[index] == '"') readString() else readToken()
            out[key] = value
            skipWs()
            if (index < body.length && body[index] == ',') index++
        }
        return out
    }

    private val PROCESS_LINE =
        Regex("""^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*(.*)$""")
    private val IPV4 = Regex("""^(?:\d{1,3}\.){3}\d{1,3}$""")
    private val HEX_ADDR = Regex("""^[0-9a-f:]+$""")
}

enum class DockerContainerAction { START, STOP, RESTART, REMOVE, PAUSE, UNPAUSE }

enum class ProcessSignal { TERM, KILL }

data class DockerEngineStatus(
    val installed: Boolean,
    val socket: Boolean,
    val version: String,
    val raw: String = "",
)

data class DockerContainerInfo(
    val id: String,
    val name: String,
    val image: String,
    val status: String,
    val state: String,
    val ports: String,
    val createdAt: String,
) {
    val running: Boolean
        get() = state.equals("running", ignoreCase = true) ||
            status.contains("up", ignoreCase = true) ||
            status.contains("running", ignoreCase = true)

    val target: String get() = id.ifBlank { name }
}

data class DockerImageInfo(
    val id: String,
    val repository: String,
    val tag: String,
    val size: String,
    val createdAt: String,
) {
    val reference: String
        get() = if (repository != "<none>" && tag != "<none>" && repository.isNotBlank()) {
            "$repository:$tag"
        } else {
            id
        }
}

data class CpuStat(val idle: Long, val total: Long)

data class NetCounters(val rx: Long, val tx: Long)

data class DiskCounters(val reads: Long, val writes: Long)

data class HostStatsSample(
    val cpu: CpuStat?,
    val net: NetCounters,
    val diskStats: Map<String, DiskCounters>,
    val timestampMs: Long,
)

data class HostCpuInfo(
    val usagePercent: Double,
    val model: String,
    val freq: String,
    val cores: Int,
)

data class HostMemoryInfo(
    val memUsedMb: Double,
    val memTotalMb: Double,
    val swapUsedMb: Double,
    val swapTotalMb: Double,
) {
    val memPercent: Double
        get() = if (memTotalMb <= 0.0) 0.0 else (memUsedMb / memTotalMb * 100.0).coerceIn(0.0, 100.0)

    val swapPercent: Double
        get() = if (swapTotalMb <= 0.0) 0.0 else (swapUsedMb / swapTotalMb * 100.0).coerceIn(0.0, 100.0)
}

data class HostDiskDevice(
    val id: String,
    val filesystem: String,
    val mountpoint: String,
    val diskName: String?,
    val usedGb: Double,
    val totalGb: Double,
    val percent: Int,
    val readKBps: Double,
    val writeKBps: Double,
)

data class HostNetworkRates(val rxMbps: Double, val txMbps: Double)

data class HostProcessInfo(
    val pid: Int,
    val user: String,
    val cpuPercent: Double,
    val memPercent: Double,
    val stat: String,
    val command: String,
    val args: String,
)

data class HostStatsSnapshot(
    val hostName: String,
    val os: String,
    val cpu: HostCpuInfo,
    val memory: HostMemoryInfo,
    val disks: List<HostDiskDevice>,
    val network: HostNetworkRates,
    val ipv4: String,
    val ipv6: String,
    val processes: List<HostProcessInfo>,
    val sample: HostStatsSample,
    val capturedAt: Long = sample.timestampMs,
)
