package one.zephyr.mobile.feature.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import one.zephyr.mobile.ui.component.ActionSheet
import one.zephyr.mobile.ui.component.ActionSheetGroup
import one.zephyr.mobile.ui.component.ActionSheetItem
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.GroupCard
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.PrimaryButton
import one.zephyr.mobile.ui.component.SettingsRow
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import one.zephyr.mobile.ui.icon.ZephyrIcons
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import one.zephyr.mobile.data.repository.NoteRepository
import one.zephyr.mobile.model.Snippet
import one.zephyr.mobile.ui.chrome.HeaderAddButton
import one.zephyr.mobile.ui.chrome.PushedPageActionBar
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.util.UUID

class SnippetListViewModel(
    private val notes: NoteRepository,
    private val ownerUserId: String,
) : ViewModel() {
    private val rows = MutableStateFlow<List<Snippet>>(emptyList())
    val snippets: StateFlow<List<Snippet>> = rows.asStateFlow()

    init {
        viewModelScope.launch {
            notes.observeSnippets(ownerUserId).collect { list ->
                rows.value = list.filter { it.deletedAt == null }.sortedByDescending(Snippet::updatedAt)
            }
        }
    }

    fun delete(snippet: Snippet) {
        viewModelScope.launch { runCatching { notes.deleteSnippet(snippet, ownerUserId) } }
    }

    companion object {
        fun factory(notes: NoteRepository, ownerUserId: String): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    SnippetListViewModel(notes, ownerUserId) as T
            }
    }
}

class SnippetEditorViewModel(
    private val notes: NoteRepository,
    private val ownerUserId: String,
    private val snippetId: String?,
    private val newIdFactory: () -> String,
) : ViewModel() {
    private val draftState = MutableStateFlow<SnippetDraft?>(null)
    val draft: StateFlow<SnippetDraft?> = draftState.asStateFlow()
    private val messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val message: SharedFlow<String> = messages
    private val done = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val finished: SharedFlow<Unit> = done

    init {
        viewModelScope.launch {
            val existing = notes.observeSnippets(ownerUserId)
            existing.collect { all ->
                val live = all.filter { it.deletedAt == null }
                if (snippetId == null) {
                    if (draftState.value == null) {
                        draftState.value = SnippetDraft.create(ownerUserId, newIdFactory(), existingCount = live.size)
                    }
                    return@collect
                }
                val found = live.firstOrNull { it.id == snippetId }
                if (found == null) {
                    draftState.value = null
                } else if (draftState.value == null || draftState.value?.isDirty != true) {
                    draftState.value = SnippetDraft.edit(found, existingCount = live.size)
                }
            }
        }
    }

    fun edit(block: (SnippetDraft) -> SnippetDraft) {
        draftState.value = draftState.value?.let(block)
    }

    fun save() {
        val current = draftState.value ?: return
        val issues = current.validate()
        if (issues.isNotEmpty() || !current.isDirty) {
            viewModelScope.launch { messages.emit(snippetIssueText(issues.firstOrNull())) }
            return
        }
        viewModelScope.launch {
            runCatching {
                notes.saveSnippet(
                    snippet = current.normalized().copy(updatedAt = System.currentTimeMillis()),
                    mask = current.changedFields(),
                    ownerUserId = ownerUserId,
                    createdLocally = current.isCreate,
                )
            }.onSuccess {
                messages.emit("已保存，待同步")
                done.emit(Unit)
            }.onFailure { messages.emit(it.message ?: "保存未完成") }
        }
    }

    companion object {
        fun factory(
            notes: NoteRepository,
            ownerUserId: String,
            snippetId: String?,
            newIdFactory: () -> String = { UUID.randomUUID().toString() },
        ): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                SnippetEditorViewModel(notes, ownerUserId, snippetId, newIdFactory) as T
        }
    }
}

private fun snippetIssueText(issue: SnippetIssue?): String = when (issue?.code) {
    SnippetIssueCode.NAME_REQUIRED -> "请输入名称"
    SnippetIssueCode.NAME_TOO_LONG -> "名称不能超过 60 字"
    SnippetIssueCode.COMMAND_REQUIRED -> "请输入命令"
    SnippetIssueCode.COMMAND_TOO_LONG -> "命令不能超过 20000 字"
    SnippetIssueCode.GROUP_TOO_LONG -> "分组不能超过 40 字"
    SnippetIssueCode.ACCOUNT_LIMIT_REACHED -> "已达到 500 条上限"
    null -> "无法保存"
}

@Composable
fun SnippetListRoute(
    viewModel: SnippetListViewModel,
    onBack: () -> Unit,
    onOpen: (Snippet) -> Unit,
    onCreate: () -> Unit,
    onInsert: (Snippet) -> Unit,
    onRun: (Snippet) -> Unit,
) {
    val rows by viewModel.snippets.collectAsState()
    var pending by remember { mutableStateOf<Snippet?>(null) }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.snippets_title), onBack = onBack) {
            HeaderAddButton(stringResource(R.string.snippets_create), onCreate)
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 140.dp),
        ) {
            item("snippets") {
                GroupCard {
                    rows.forEachIndexed { index, snippet ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    snippet.command.lineSequence().firstOrNull().orEmpty(),
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    maxLines = 1,
                                )
                                Text(
                                    buildList {
                                        add(snippet.name)
                                        if (snippet.group.isNotBlank()) add(snippet.group)
                                        if (snippet.autoRun) add("autoRun")
                                    }.joinToString(" · "),
                                    color = ZephyrTheme.palette.onFloatingSubtle,
                                    fontSize = 11.5.sp,
                                )
                            }
                            SnippetMiniButton("插入", active = false) { onInsert(snippet) }
                            SnippetMiniButton("执行", active = true) { onRun(snippet) }
                        }
                        if (index != rows.lastIndex) {
                            Box(Modifier.fillMaxWidth().height(1.dp).background(ZephyrTheme.palette.surfaces.outlineSoft))
                        }
                    }
                }
            }
            item("limits") {
                Text(
                    "name 60 / command 20000 / group 40 · 最多 500 条 · 删除进入同步 tombstone",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
                )
            }
        }
    }

    pending?.let { target ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(stringResource(R.string.snippets_delete_title)) },
            text = { Text(stringResource(R.string.snippets_delete_message, target.name)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.delete(target)
                    pending = null
                }) { Text(stringResource(R.string.snippets_delete)) }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text("取消") } },
        )
    }
}

@Composable
fun SnippetEditorRoute(
    viewModel: SnippetEditorViewModel,
    onBack: () -> Unit,
    onMessage: suspend (String) -> Unit,
) {
    val draft by viewModel.draft.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(viewModel) { viewModel.message.collect { onMessage(it) } }
    LaunchedEffect(viewModel) { viewModel.finished.collect { onBack() } }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(
            title = if (draft?.isCreate == true) stringResource(R.string.snippets_create) else stringResource(R.string.snippets_edit),
            onBack = onBack,
        )
        val current = draft
        if (current == null) {
            Text(stringResource(R.string.snippets_missing), modifier = Modifier.padding(ZephyrSpacing.lg))
            return
        }
        Box(Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 190.dp),
            ) {
                GroupCard(Modifier.padding(top = 4.dp)) {
                    one.zephyr.mobile.ui.component.FieldRow(
                        label = "名称",
                        value = current.current.name,
                        onValueChange = { viewModel.edit { d -> d.withName(it) } },
                        placeholder = "最多 60 字",
                    )
                    one.zephyr.mobile.ui.component.FieldRow(
                        label = "分组",
                        value = current.current.group,
                        onValueChange = { viewModel.edit { d -> d.withGroup(it) } },
                        placeholder = "最多 40 字",
                    )
                    one.zephyr.mobile.ui.component.FieldRow(
                        label = "命令",
                        value = current.current.command,
                        onValueChange = { viewModel.edit { d -> d.withCommand(it) } },
                        mono = true,
                        singleLine = false,
                    )
                    SettingsRow(
                        title = "autoRun",
                        subtitle = "插入终端后立即执行 · 仍需 execute 权限",
                        showDivider = false,
                        trailing = {
                            Switch(
                                checked = current.current.autoRun,
                                onCheckedChange = { viewModel.edit { d -> d.withAutoRun(it) } },
                            )
                        },
                    )
                }
                Text(
                    "插入不需要 execute 权限；实际执行需要 connection 的 execute 能力，危险命令仍走确认策略",
                    color = ZephyrTheme.palette.onFloatingSubtle,
                    fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp),
                )
            }
            PushedPageActionBar(Modifier.align(Alignment.BottomCenter)) {
                PrimaryButton(
                    onClick = { scope.launch { onMessage("已插入当前终端（未执行）") } },
                    modifier = Modifier.weight(1f),
                    ghost = true,
                ) { Text("插入终端") }
                PrimaryButton(
                    onClick = viewModel::save,
                    enabled = current.canSave,
                    modifier = Modifier.weight(1.4f),
                ) { Text("保存") }
            }
        }
    }
}

@Composable
private fun SnippetMiniButton(label: String, active: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (active) Color(0xFF7EE787) else ZephyrTheme.palette.onFloatingMuted,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (active) ZephyrTheme.palette.status.success.copy(alpha = 0.22f)
                else ZephyrTheme.palette.surfaces.elevated,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    )
}

@Composable
fun SftpBrowserRoute(
    connections: List<one.zephyr.mobile.model.Connection>,
    port: SftpPort,
    onBack: () -> Unit,
    onMessage: (String) -> Unit = {},
) {
    val available = connections.filter { it.protocol.supportsFiles && it.capabilities.canReadFiles }
    val ids = available.joinToString("\u0000") { it.id }
    var tabs by remember { mutableStateOf(SftpHostTabs()) }
    var addOpen by remember { mutableStateOf(false) }
    var clipboard by remember { mutableStateOf<SftpClipboard?>(null) }
    LaunchedEffect(ids) {
        val gone = tabs.openIds.filter { id -> available.none { it.id == id } }
        gone.forEach { tabs = tabs.close(it) }
    }
    val focused = available.firstOrNull { it.id == tabs.focusedId }
    val openHosts = tabs.openIds.mapNotNull { id -> available.firstOrNull { it.id == id } }
    val addable = available.filter { it.id !in tabs.openIds }
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "SFTP · ${focused?.name ?: "选择主机"}", onBack = onBack)
        if (available.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("没有可读取文件的 SSH 连接", color = ZephyrTheme.palette.onFloatingSubtle)
            }
            return
        }
        if (tabs.isEmpty) {
            SftpHostPicker(
                hosts = available,
                onPick = { tabs = tabs.open(it.id) },
            )
        } else {
            SftpHostRail(
                hosts = openHosts,
                focusedId = tabs.focusedId,
                canAdd = addable.isNotEmpty(),
                onFocus = { tabs = tabs.focus(it) },
                onClose = { tabs = tabs.close(it) },
                onAdd = { addOpen = true },
            )
            Box(Modifier.fillMaxSize()) {
                openHosts.sortedBy { if (it.id == tabs.focusedId) 1 else 0 }.forEach { host ->
                    key(host.id) {
                        SftpBrowserPane(
                            port = port,
                            connectionId = host.id,
                            connectionName = host.name,
                            clipboard = clipboard,
                            onClipboard = { clipboard = it },
                            modifier = Modifier
                                .fillMaxSize()
                                .graphicsLayer { alpha = if (host.id == tabs.focusedId) 1f else 0f },
                            onMessage = onMessage,
                        )
                    }
                }
            }
        }
    }
    ActionSheet(
        visible = addOpen,
        onDismiss = { addOpen = false },
        groups = listOf(
            ActionSheetGroup(
                title = "再开一台主机",
                items = addable.map { host ->
                    ActionSheetItem(
                        label = host.name,
                        subtitle = host.displayAddress,
                        onClick = {
                            addOpen = false
                            tabs = tabs.open(host.id)
                        },
                    )
                },
            ),
            ActionSheetGroup(
                items = listOf(
                    ActionSheetItem(
                        label = "取消",
                        cancel = true,
                        onClick = { addOpen = false },
                    ),
                ),
            ),
        ),
    )
}

@Composable
private fun SftpHostPicker(
    hosts: List<one.zephyr.mobile.model.Connection>,
    onPick: (one.zephyr.mobile.model.Connection) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 140.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text(
                "先选一台主机。打开后会自动连接，不必先去首页连上。点加号可以再开一台，从 A 复制到 B。",
                color = ZephyrTheme.palette.onFloatingSubtle,
                fontSize = 13.sp,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        items(hosts, key = { it.id }) { host ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(ZephyrTheme.palette.surfaces.content)
                    .clickable { onPick(host) }
                    .padding(horizontal = 14.dp, vertical = 12.dp),
            ) {
                Text(host.name, fontWeight = FontWeight.SemiBold)
                Text(host.displayAddress, color = ZephyrTheme.palette.onFloatingSubtle, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun SftpHostRail(
    hosts: List<one.zephyr.mobile.model.Connection>,
    focusedId: String?,
    canAdd: Boolean,
    onFocus: (String) -> Unit,
    onClose: (String) -> Unit,
    onAdd: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(palette.surfaces.content)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        hosts.forEach { host ->
            val on = host.id == focusedId
            Row(
                modifier = Modifier
                    .height(34.dp)
                    .padding(end = 8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (on) palette.brand.accent.copy(alpha = 0.22f) else palette.surfaces.elevated)
                    .clickable { onFocus(host.id) }
                    .padding(start = 10.dp, end = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(if (on) palette.status.success else palette.onFloatingSubtle),
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    host.name,
                    color = if (on) palette.onFloating else palette.onFloatingMuted,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                    maxLines = 1,
                )
                Text(
                    "×",
                    color = palette.onFloatingSubtle,
                    fontSize = 14.sp,
                    modifier = Modifier
                        .padding(start = 6.dp)
                        .clickable { onClose(host.id) },
                )
            }
        }
        if (canAdd) {
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(palette.surfaces.elevated)
                    .clickable(onClick = onAdd),
                contentAlignment = Alignment.Center,
            ) {
                Icon(ZephyrIcons.Plus, "再开一台", tint = palette.onFloatingMuted, modifier = Modifier.size(14.dp))
            }
        }
    }
}

@Composable
fun DownloadsRoute(
    downloads: List<FileDownload>,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = stringResource(R.string.library_downloads_title), onBack = onBack)
        if (downloads.isEmpty()) {
            Text(
                stringResource(R.string.library_downloads_empty),
                color = ZephyrTheme.palette.onFloatingMuted,
                modifier = Modifier.padding(ZephyrSpacing.lg),
            )
        } else {
            LazyColumn(contentPadding = PaddingValues(ZephyrSpacing.lg)) {
                items(downloads, key = { it.id }) { item ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                        Text(item.fileName, fontWeight = FontWeight.SemiBold)
                        Text(
                            "${item.connectionName} · ${item.state.name} · ${item.percentComplete?.let { "$it%" } ?: "${item.transferredBytes} B"}",
                            color = ZephyrTheme.palette.onFloatingMuted,
                            fontSize = 12.sp,
                        )
                    }
                }
            }
        }
    }
}
