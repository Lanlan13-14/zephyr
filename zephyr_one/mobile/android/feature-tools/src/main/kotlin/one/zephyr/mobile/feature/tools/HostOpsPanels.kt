package one.zephyr.mobile.feature.tools

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import one.zephyr.mobile.protocol.ssh.DockerContainerAction
import one.zephyr.mobile.protocol.ssh.DockerContainerInfo
import one.zephyr.mobile.protocol.ssh.DockerEngineStatus
import one.zephyr.mobile.protocol.ssh.DockerImageInfo
import one.zephyr.mobile.protocol.ssh.HostProcessInfo
import one.zephyr.mobile.protocol.ssh.HostStatsSample
import one.zephyr.mobile.protocol.ssh.HostStatsSnapshot
import one.zephyr.mobile.protocol.ssh.ProcessSignal
import one.zephyr.mobile.protocol.ssh.SshRemoteOps
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.AssistChip
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.LinearProgress
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.PrimaryButton
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import one.zephyr.mobile.ui.theme.ZephyrTheme

interface RemoteShell {
    suspend fun run(command: String): RemoteShellResult

    fun stream(command: String): kotlinx.coroutines.flow.Flow<RemoteShellChunk> =
        kotlinx.coroutines.flow.flow {
            val result = run(command)
            if (result.stdout.isNotEmpty()) emit(RemoteShellChunk.Output(result.stdout))
            if (result.stderr.isNotEmpty()) emit(RemoteShellChunk.Output(result.stderr))
            emit(RemoteShellChunk.Closed(result.exitCode))
        }
}

fun RemoteShell(block: suspend (String) -> RemoteShellResult): RemoteShell = object : RemoteShell {
    override suspend fun run(command: String): RemoteShellResult = block(command)
}

data class RemoteShellResult(val exitCode: Int, val stdout: String, val stderr: String) {
    fun text(): String = stdout.ifBlank { stderr }
}

sealed interface RemoteShellChunk {
    data class Output(val text: String) : RemoteShellChunk
    data class Closed(val exitCode: Int) : RemoteShellChunk
}

private enum class DockerTab { CONTAINERS, IMAGES, MIRRORS }
private enum class ProcessSort { CPU, MEM, PID }

@Composable
fun HostMonitorPanel(
    shell: RemoteShell?,
    modifier: Modifier = Modifier,
    onOpenDocker: (() -> Unit)? = null,
    onMessage: (String) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var tab by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var snapshot by remember { mutableStateOf<HostStatsSnapshot?>(null) }
    var sample by remember { mutableStateOf<HostStatsSample?>(null) }
    var query by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf(ProcessSort.CPU) }
    var pendingKill by remember { mutableStateOf<HostProcessInfo?>(null) }
    var tick by remember { mutableIntStateOf(0) }

    suspend fun refresh() {
        val client = shell
        if (client == null) {
            loading = false
            error = "当前没有已连接的 SSH 会话"
            return
        }
        if (snapshot == null) loading = true
        runCatching {
            val result = client.run(SshRemoteOps.statsCommand)
            if (result.exitCode != 0 && result.stdout.isBlank()) {
                error(result.stderr.ifBlank { "读取远端监控失败" })
            }
            SshRemoteOps.parseRemoteStats(result.stdout, sample)
        }.onSuccess {
            snapshot = it
            sample = it.sample
            error = null
        }.onFailure {
            if (snapshot == null) error = it.message ?: "读取远端监控失败"
            else onMessage(it.message ?: "刷新监控失败")
        }
        loading = false
    }

    LaunchedEffect(shell, tick) { refresh() }
    LaunchedEffect(shell) {
        if (shell == null) return@LaunchedEffect
        while (isActive) {
            delay(5_000)
            tick++
        }
    }

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilterChip(selected = tab == 0, onClick = { tab = 0 }, label = { Text("概览") })
            FilterChip(selected = tab == 1, onClick = { tab = 1 }, label = { Text("进程") })
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { tick++ }, enabled = shell != null && !loading) { Text("刷新") }
        }
        when {
            loading && snapshot == null -> HostOpsEmpty(error ?: "正在读取远端监控…")
            error != null && snapshot == null -> HostOpsEmpty(error ?: "监控失败")
            snapshot != null && tab == 0 -> MonitorOverview(
                snapshot = snapshot!!,
                onCopy = { value ->
                    clipboard.setText(AnnotatedString(value))
                    onMessage("已复制")
                },
                onOpenDocker = onOpenDocker,
            )
            snapshot != null -> ProcessList(
                processes = snapshot!!.processes,
                query = query,
                sort = sort,
                onQuery = { query = it },
                onSort = { sort = it },
                onSignal = { process, signal ->
                    if (signal == ProcessSignal.KILL) pendingKill = process
                    else scope.launch { sendSignal(shell, process, signal, onMessage) { tick++ } }
                },
            )
        }
    }

    pendingKill?.let { process ->
        AlertDialog(
            onDismissRequest = { pendingKill = null },
            title = { Text("强制结束进程 ${process.pid}？") },
            text = { Text(process.command + " " + process.args) },
            confirmButton = {
                TextButton(onClick = {
                    val target = process
                    pendingKill = null
                    scope.launch { sendSignal(shell, target, ProcessSignal.KILL, onMessage) { tick++ } }
                }) { Text("强制结束") }
            },
            dismissButton = { TextButton(onClick = { pendingKill = null }) { Text("取消") } },
        )
    }
}

@Composable
fun HostDockerPanel(
    shell: RemoteShell?,
    modifier: Modifier = Modifier,
    onMessage: (String) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(DockerTab.CONTAINERS) }
    var loading by remember { mutableStateOf(true) }
    var status by remember { mutableStateOf<DockerEngineStatus?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var containers by remember { mutableStateOf<List<DockerContainerInfo>>(emptyList()) }
    var images by remember { mutableStateOf<List<DockerImageInfo>>(emptyList()) }
    var mirrors by remember { mutableStateOf<List<String>>(emptyList()) }
    var pullImage by remember { mutableStateOf("") }
    var pullLog by remember { mutableStateOf("") }
    var pulling by remember { mutableStateOf(false) }
    var mirrorDraft by remember { mutableStateOf("") }
    var logTarget by remember { mutableStateOf<DockerContainerInfo?>(null) }
    var logText by remember { mutableStateOf("") }
    var logFollow by remember { mutableStateOf(true) }
    var logPaused by remember { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<DockerContainerInfo?>(null) }
    var pendingImage by remember { mutableStateOf<Pair<DockerImageInfo, String?>?>(null) }
    var confirmRestart by remember { mutableStateOf(false) }

    suspend fun loadAll(forceCheck: Boolean = false) {
        val client = shell
        if (client == null) {
            loading = false
            error = "当前没有已连接的 SSH 会话"
            return
        }
        if (status == null) loading = true
        runCatching {
            if (forceCheck || status == null) {
                val checked = client.run(SshRemoteOps.dockerCheckCommand)
                status = SshRemoteOps.parseDockerStatus(checked.text())
            }
            val current = status
            if (current?.installed != true) return@runCatching
            val listed = client.run(SshRemoteOps.dockerListContainersCommand)
            containers = SshRemoteOps.parseDockerContainers(listed.stdout)
            val imageRaw = client.run(SshRemoteOps.dockerListImagesCommand)
            images = SshRemoteOps.parseDockerImages(imageRaw.stdout)
            val mirrorRaw = client.run(SshRemoteOps.dockerMirrorsGetCommand)
            mirrors = SshRemoteOps.parseDockerMirrors(mirrorRaw.stdout)
        }.onFailure {
            error = it.message ?: "Docker 操作失败"
        }
        loading = false
    }

    LaunchedEffect(shell) { loadAll(forceCheck = true) }

    LaunchedEffect(shell, logTarget, logFollow) {
        val client = shell
        val container = logTarget
        if (client == null || container == null || !logFollow) return@LaunchedEffect
        runCatching {
            client.stream(SshRemoteOps.dockerLogsCommand(container.target, tail = 200, follow = true)).collect { chunk ->
                when (chunk) {
                    is RemoteShellChunk.Output -> {
                        logText = (logText + chunk.text).takeLast(80_000)
                    }
                    is RemoteShellChunk.Closed -> {
                        logFollow = false
                        if (chunk.exitCode != 0) onMessage("日志流结束（exit ${chunk.exitCode}）")
                    }
                }
            }
        }.onFailure { failure ->
            logFollow = false
            onMessage(failure.message ?: "日志流中断")
        }
    }

    fun run(label: String, command: String, after: (RemoteShellResult) -> Unit = {}) {
        val client = shell ?: return
        scope.launch {
            runCatching {
                val result = client.run(command)
                if (result.exitCode != 0 && result.stdout.isBlank()) {
                    error(result.stderr.ifBlank { "$label 失败" })
                }
                after(result)
                onMessage(label)
                loadAll()
            }.onFailure { onMessage(it.message ?: "$label 失败") }
        }
    }

    Column(modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                status?.version?.ifBlank { if (status?.installed == true) "Docker 已安装" else "未检测到 Docker" } ?: "检测中",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 11.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
            )
            TextButton(onClick = { confirmRestart = true }, enabled = status?.installed == true) { Text("重启 Docker") }
            TextButton(onClick = { scope.launch { loadAll(forceCheck = true) } }, enabled = shell != null) { Text("刷新") }
        }
        when {
            loading && status == null -> HostOpsEmpty(error ?: "正在检测 Docker…")
            status?.installed != true -> HostOpsEmpty(
                (error ?: "未检测到 Docker，请先安装 Docker") + "\ncurl -fsSL https://get.docker.com | bash",
            )
            logTarget != null -> DockerLogPane(
                title = "容器日志 · ${logTarget!!.name}",
                text = logText,
                following = logFollow,
                paused = logPaused,
                onTogglePause = { logPaused = !logPaused },
                onClose = { logTarget = null; logText = ""; logFollow = false },
            )
            else -> {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(selected = tab == DockerTab.CONTAINERS, onClick = { tab = DockerTab.CONTAINERS }, label = { Text("容器") })
                    FilterChip(selected = tab == DockerTab.IMAGES, onClick = { tab = DockerTab.IMAGES }, label = { Text("镜像") })
                    FilterChip(selected = tab == DockerTab.MIRRORS, onClick = { tab = DockerTab.MIRRORS }, label = { Text("镜像加速器") })
                }
                when (tab) {
                    DockerTab.CONTAINERS -> DockerContainerList(
                        containers = containers,
                        onStart = { run("已启动 ${it.name}", SshRemoteOps.dockerContainerActionCommand(DockerContainerAction.START, it.target)) },
                        onStop = { run("已停止 ${it.name}", SshRemoteOps.dockerContainerActionCommand(DockerContainerAction.STOP, it.target)) },
                        onRestart = { run("已重启 ${it.name}", SshRemoteOps.dockerContainerActionCommand(DockerContainerAction.RESTART, it.target)) },
                        onLogs = { container ->
                            logTarget = container
                            logText = ""
                            logFollow = true
                            logPaused = false
                        },
                        onRemove = { pendingRemove = it },
                    )
                    DockerTab.IMAGES -> DockerImageList(
                        images = images,
                        pullImage = pullImage,
                        pullLog = pullLog,
                        pulling = pulling,
                        onPullChange = { pullImage = it },
                        onPull = {
                            val image = pullImage.trim()
                            if (image.isEmpty()) {
                                onMessage("请输入镜像名，例如 nginx:alpine")
                                return@DockerImageList
                            }
                            pulling = true
                            pullLog = "开始拉取 $image…\n"
                            scope.launch {
                                val client = shell
                                if (client == null) {
                                    pulling = false
                                    return@launch
                                }
                                runCatching {
                                    var code = 0
                                    client.stream(SshRemoteOps.dockerPullCommand(image)).collect { chunk ->
                                        when (chunk) {
                                            is RemoteShellChunk.Output -> pullLog = (pullLog + chunk.text).takeLast(20_000)
                                            is RemoteShellChunk.Closed -> code = chunk.exitCode
                                        }
                                    }
                                    if (code != 0) error("镜像拉取失败（exit $code）")
                                    onMessage("镜像拉取完成")
                                    loadAll()
                                }.onFailure { failure ->
                                    pullLog += "\n${failure.message ?: "镜像拉取失败"}"
                                    onMessage(failure.message ?: "镜像拉取失败")
                                }
                                pulling = false
                            }
                        },
                        onDelete = { image ->
                            scope.launch {
                                val client = shell ?: return@launch
                                val used = runCatching { client.run(SshRemoteOps.dockerUsedByCommand(image.reference)).stdout.trim() }.getOrDefault("")
                                pendingImage = image to used.ifBlank { null }
                            }
                        },
                    )
                    DockerTab.MIRRORS -> DockerMirrorList(
                        mirrors = mirrors,
                        draft = mirrorDraft,
                        onDraft = { mirrorDraft = it },
                        onChange = { index, value ->
                            mirrors = mirrors.toMutableList().also { it[index] = value }
                        },
                        onRemove = { index -> mirrors = mirrors.toMutableList().also { it.removeAt(index) } },
                        onAdd = {
                            if (!SshRemoteOps.isValidMirror(mirrorDraft)) {
                                onMessage("镜像地址必须以 http:// 或 https:// 开头")
                                return@DockerMirrorList
                            }
                            mirrors = (mirrors + SshRemoteOps.sanitizeMirror(mirrorDraft)).distinct()
                            mirrorDraft = ""
                        },
                        onSave = {
                            run("镜像加速器已保存，请重启 Docker 服务", SshRemoteOps.dockerMirrorsSetCommand(mirrors.filter(SshRemoteOps::isValidMirror)))
                        },
                    )
                }
            }
        }
    }

    pendingRemove?.let { container ->
        AlertDialog(
            onDismissRequest = { pendingRemove = null },
            title = { Text("确认删除容器 ${container.name}?") },
            text = { Text(container.image) },
            confirmButton = {
                TextButton(onClick = {
                    val target = container
                    pendingRemove = null
                    run("已删除 ${target.name}", SshRemoteOps.dockerContainerActionCommand(DockerContainerAction.REMOVE, target.target))
                }) { Text("删除") }
            },
            dismissButton = { TextButton(onClick = { pendingRemove = null }) { Text("取消") } },
        )
    }
    pendingImage?.let { (image, usedBy) ->
        AlertDialog(
            onDismissRequest = { pendingImage = null },
            title = { Text(if (usedBy == null) "确认删除镜像 ${image.reference}?" else "该镜像正在被容器使用") },
            text = { Text(usedBy ?: image.id) },
            confirmButton = {
                TextButton(onClick = {
                    val target = image
                    val force = usedBy != null
                    pendingImage = null
                    run("已删除镜像", SshRemoteOps.dockerDeleteImageCommand(target.reference, force))
                }) { Text(if (usedBy == null) "删除" else "强制删除") }
            },
            dismissButton = { TextButton(onClick = { pendingImage = null }) { Text("取消") } },
        )
    }
    if (confirmRestart) {
        AlertDialog(
            onDismissRequest = { confirmRestart = false },
            title = { Text("重启目标主机 Docker 服务？") },
            text = { Text("会短暂中断该主机上的全部容器。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRestart = false
                    run("Docker 服务已重启", SshRemoteOps.dockerRestartServiceCommand)
                }) { Text("重启") }
            },
            dismissButton = { TextButton(onClick = { confirmRestart = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun MonitorOverview(
    snapshot: HostStatsSnapshot,
    onCopy: (String) -> Unit,
    onOpenDocker: (() -> Unit)?,
) {
    val palette = ZephyrTheme.palette
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(8.dp, 4.dp, 8.dp, 24.dp)) {
        item("host") {
            OverviewCard("主机", snapshot.hostName, snapshot.os)
        }
        item("cpu") {
            OverviewCard(
                "CPU",
                snapshot.cpu.model,
                "${snapshot.cpu.freq} · ${snapshot.cpu.cores} 核心",
                snapshot.cpu.usagePercent.toFloat() / 100f,
                "${"%.1f".format(snapshot.cpu.usagePercent)}%",
            )
        }
        item("mem") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) {
                    OverviewCard(
                        "内存",
                        "${gb(snapshot.memory.memUsedMb)} / ${gb(snapshot.memory.memTotalMb)} GB",
                        null,
                        snapshot.memory.memPercent.toFloat() / 100f,
                    )
                }
                Box(Modifier.weight(1f)) {
                    OverviewCard(
                        "Swap",
                        "${gb(snapshot.memory.swapUsedMb)} / ${gb(snapshot.memory.swapTotalMb)} GB",
                        null,
                        snapshot.memory.swapPercent.toFloat() / 100f,
                    )
                }
            }
        }
        items(snapshot.disks, key = { it.id }) { disk ->
            OverviewCard(
                disk.mountpoint,
                "${"%.1f".format(disk.usedGb)} / ${"%.1f".format(disk.totalGb)} GB",
                "已用 ${disk.percent}% · 读 ${"%.1f".format(disk.readKBps)} KB/s · 写 ${"%.1f".format(disk.writeKBps)} KB/s",
                disk.percent / 100f,
                warn = disk.percent >= 80,
            )
        }
        item("net") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f)) { OverviewCard("下载", "${"%.1f".format(snapshot.network.rxMbps)} Mbps") }
                Box(Modifier.weight(1f)) { OverviewCard("上传", "${"%.1f".format(snapshot.network.txMbps)} Mbps") }
            }
        }
        item("ip") {
            Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                IpRow("IPv4", snapshot.ipv4, onCopy)
                IpRow("IPv6", snapshot.ipv6, onCopy)
            }
        }
        if (onOpenDocker != null) {
            item("docker") {
                PrimaryButton(onClick = onOpenDocker, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    Text("打开 Docker 管理")
                }
            }
        }
        item("note") {
            Text(
                "每 5 秒刷新一次 · 速率需要至少两帧采样",
                color = palette.onFloatingSubtle,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 14.dp),
            )
        }
    }
}

@Composable
private fun ProcessList(
    processes: List<HostProcessInfo>,
    query: String,
    sort: ProcessSort,
    onQuery: (String) -> Unit,
    onSort: (ProcessSort) -> Unit,
    onSignal: (HostProcessInfo, ProcessSignal) -> Unit,
) {
    val filtered = remember(processes, query, sort) {
        val needle = query.trim().lowercase()
        processes.filter { process ->
            needle.isEmpty() ||
                process.pid.toString().contains(needle) ||
                process.user.lowercase().contains(needle) ||
                process.command.lowercase().contains(needle) ||
                process.args.lowercase().contains(needle)
        }.sortedWith(
            when (sort) {
                ProcessSort.CPU -> compareByDescending { it.cpuPercent }
                ProcessSort.MEM -> compareByDescending { it.memPercent }
                ProcessSort.PID -> compareBy { it.pid }
            },
        ).take(60)
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            singleLine = true,
            placeholder = { Text("搜索 PID / 用户 / 命令") },
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilterChip(selected = sort == ProcessSort.CPU, onClick = { onSort(ProcessSort.CPU) }, label = { Text("CPU") })
            FilterChip(selected = sort == ProcessSort.MEM, onClick = { onSort(ProcessSort.MEM) }, label = { Text("内存优先") })
            FilterChip(selected = sort == ProcessSort.PID, onClick = { onSort(ProcessSort.PID) }, label = { Text("PID") })
            Text("${processes.size} 个进程", color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp)
        }
        if (filtered.isEmpty()) {
            HostOpsEmpty("暂无进程数据")
        } else {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
                items(filtered, key = { it.pid }) { process ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(process.command, color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1)
                            Text("PID ${process.pid}", color = ZephyrTheme.palette.onFloatingSubtle, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                        }
                        Text(process.args, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 11.sp, maxLines = 2)
                        Text(
                            "${process.user} · ${process.stat} · CPU ${"%.1f".format(process.cpuPercent)}% · MEM ${"%.1f".format(process.memPercent)}%",
                            color = ZephyrTheme.palette.onFloatingMuted,
                            fontSize = 11.sp,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                            AssistChip(onClick = { onSignal(process, ProcessSignal.TERM) }, label = { Text("结束") })
                            AssistChip(onClick = { onSignal(process, ProcessSignal.KILL) }, label = { Text("强制") })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DockerContainerList(
    containers: List<DockerContainerInfo>,
    onStart: (DockerContainerInfo) -> Unit,
    onStop: (DockerContainerInfo) -> Unit,
    onRestart: (DockerContainerInfo) -> Unit,
    onLogs: (DockerContainerInfo) -> Unit,
    onRemove: (DockerContainerInfo) -> Unit,
) {
    if (containers.isEmpty()) {
        HostOpsEmpty("暂无容器")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
        items(containers, key = { it.id.ifBlank { it.name } }) { container ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(ZephyrTheme.palette.surfaces.content)
                    .padding(10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(container.name, color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1)
                    Text(
                        container.status,
                        color = if (container.running) ZephyrTheme.palette.status.success else ZephyrTheme.palette.onFloatingSubtle,
                        fontSize = 11.sp,
                    )
                }
                Text(container.image, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 11.sp, maxLines = 1)
                Text(
                    "${SshRemoteOps.shortId(container.id)} · ${container.ports} · ${container.createdAt}",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
                Row(
                    Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    AssistChip(onClick = { onStart(container) }, enabled = !container.running, label = { Text("启动") })
                    AssistChip(onClick = { onStop(container) }, enabled = container.running, label = { Text("停止") })
                    AssistChip(onClick = { onRestart(container) }, label = { Text("重启") })
                    AssistChip(onClick = { onLogs(container) }, label = { Text("日志") })
                    AssistChip(onClick = { onRemove(container) }, label = { Text("删除") })
                }
            }
        }
    }
}

@Composable
private fun DockerImageList(
    images: List<DockerImageInfo>,
    pullImage: String,
    pullLog: String,
    pulling: Boolean,
    onPullChange: (String) -> Unit,
    onPull: () -> Unit,
    onDelete: (DockerImageInfo) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = pullImage,
                onValueChange = onPullChange,
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text("镜像名，例如 nginx:alpine") },
            )
            PrimaryButton(onClick = onPull, enabled = !pulling) { Text("拉取") }
        }
        if (pullLog.isNotBlank()) {
            Text(
                pullLog.takeLast(2000),
                color = ZephyrTheme.palette.onFloatingMuted,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                modifier = Modifier.fillMaxWidth().height(88.dp).padding(horizontal = 10.dp).verticalScroll(rememberScrollState()),
            )
        }
        if (images.isEmpty()) {
            HostOpsEmpty("暂无镜像")
        } else {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
                items(images, key = { it.id + it.tag }) { image ->
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(image.repository, color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(
                                "${image.tag} · ${image.size} · ${image.createdAt} · ${SshRemoteOps.shortId(image.id)}",
                                color = ZephyrTheme.palette.onFloatingSubtle,
                                fontSize = 11.sp,
                                maxLines = 1,
                            )
                        }
                        AssistChip(onClick = { onDelete(image) }, label = { Text("删除") })
                    }
                }
            }
        }
    }
}

@Composable
private fun DockerMirrorList(
    mirrors: List<String>,
    draft: String,
    onDraft: (String) -> Unit,
    onChange: (Int, String) -> Unit,
    onRemove: (Int) -> Unit,
    onAdd: () -> Unit,
    onSave: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(horizontal = 8.dp)) {
        Text(
            "配置 Docker registry-mirrors 后，请重启 Docker 服务使配置生效。",
            color = ZephyrTheme.palette.onFloatingSubtle,
            fontSize = 12.sp,
            modifier = Modifier.padding(vertical = 8.dp),
        )
        if (mirrors.isEmpty()) {
            Text("尚未配置镜像加速器", color = ZephyrTheme.palette.onFloatingMuted, modifier = Modifier.padding(vertical = 8.dp))
        }
        mirrors.forEachIndexed { index, mirror ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 6.dp)) {
                OutlinedTextField(value = mirror, onValueChange = { onChange(index, it) }, modifier = Modifier.weight(1f), singleLine = true)
                TextButton(onClick = { onRemove(index) }) { Text("删除") }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text("https://mirror.ccs.tencentyun.com") },
            )
            AssistChip(onClick = onAdd, label = { Text("添加") })
            PrimaryButton(onClick = onSave) { Text("保存配置") }
        }
    }
}

@Composable
private fun DockerLogPane(
    title: String,
    text: String,
    following: Boolean,
    paused: Boolean,
    onTogglePause: () -> Unit,
    onClose: () -> Unit,
) {
    val scroll = rememberScrollState()
    LaunchedEffect(text, paused) {
        if (!paused) scroll.animateScrollTo(scroll.maxValue)
    }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, color = ZephyrTheme.palette.onFloating, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1)
            TextButton(onClick = onTogglePause) { Text(if (paused) "继续滚动" else "暂停滚动") }
            TextButton(onClick = onClose) { Text("关闭") }
        }
        Text(
            if (following) "跟随中 · docker logs --timestamps -f" else "日志流已结束",
            color = ZephyrTheme.palette.onFloatingSubtle,
            fontSize = 10.sp,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 2.dp),
        )
        Text(
            text.ifBlank { "暂无日志" },
            color = ZephyrTheme.palette.onFloating,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            modifier = Modifier.fillMaxSize().padding(horizontal = 10.dp).verticalScroll(scroll),
        )
    }
}

@Composable
private fun OverviewCard(
    title: String,
    value: String,
    subtitle: String? = null,
    progress: Float? = null,
    badge: String? = null,
    warn: Boolean = false,
) {
    val palette = ZephyrTheme.palette
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(palette.surfaces.content)
            .border(1.dp, palette.surfaces.outlineSoft, RoundedCornerShape(10.dp))
            .padding(12.dp),
    ) {
        Row {
            Text(title, color = palette.onFloatingMuted, fontSize = 11.sp, modifier = Modifier.weight(1f))
            if (badge != null) Text(badge, color = if (warn) palette.status.warning else palette.onFloatingMuted, fontSize = 11.sp)
        }
        Text(value, color = if (warn) palette.status.warning else palette.onFloating, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
        if (subtitle != null) Text(subtitle, color = palette.onFloatingSubtle, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
        if (progress != null) {
            LinearProgress(
                progress = progress,
                color = if (warn) palette.status.warning else palette.brand.accent,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

@Composable
private fun IpRow(label: String, value: String, onCopy: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(ZephyrTheme.palette.surfaces.content)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = ZephyrTheme.palette.onFloatingMuted, fontSize = 11.sp, modifier = Modifier.width(40.dp))
        Text(value, color = ZephyrTheme.palette.onFloating, fontFamily = FontFamily.Monospace, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 1)
        TextButton(onClick = { onCopy(value) }, enabled = value != "N/A") { Text("复制") }
    }
}

@Composable
private fun HostOpsEmpty(message: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(message, color = ZephyrTheme.palette.onFloatingSubtle)
    }
}

private fun gb(mb: Double): String = "%.1f".format(mb / 1024.0)

private suspend fun sendSignal(
    shell: RemoteShell?,
    process: HostProcessInfo,
    signal: ProcessSignal,
    onMessage: (String) -> Unit,
    onDone: () -> Unit,
) {
    val client = shell ?: return
    runCatching {
        val result = client.run(SshRemoteOps.processSignalCommand(process.pid, signal))
        if (result.exitCode != 0) error(result.stderr.ifBlank { "信号发送失败" })
        onMessage("${if (signal == ProcessSignal.KILL) "强制结束" else "结束"}进程 ${process.pid} 的信号已发送")
        onDone()
    }.onFailure { onMessage(it.message ?: "进程操作失败") }
}
