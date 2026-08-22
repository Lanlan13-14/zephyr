@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.component.AssistChip
import one.zephyr.mobile.ui.component.Button
import one.zephyr.mobile.ui.component.DropdownMenu
import one.zephyr.mobile.ui.component.DropdownMenuItem
import one.zephyr.mobile.ui.component.FilterChip
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.IconButton
import one.zephyr.mobile.ui.component.OutlinedButton
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Slider
import one.zephyr.mobile.ui.component.SegmentedControl
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.model.Connection
import one.zephyr.mobile.model.ConnectionMode
import one.zephyr.mobile.model.FileSyncDirectoryIntent
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.RdpFps
import one.zephyr.mobile.model.RdpQuality
import one.zephyr.mobile.model.RdpResolution
import one.zephyr.mobile.model.RdpSettings
import one.zephyr.mobile.model.RdpSoundMode
import one.zephyr.mobile.model.RdpTouchMode
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SecretState
import one.zephyr.mobile.model.TerminalEncoding
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.chrome.PushedPageActionBar
import one.zephyr.mobile.ui.component.CleartextProtocolWarning
import one.zephyr.mobile.ui.component.GroupCard
import one.zephyr.mobile.ui.component.FieldRow
import one.zephyr.mobile.ui.component.HorizontalDivider
import one.zephyr.mobile.ui.component.PrimaryButton
import one.zephyr.mobile.ui.component.SectionLabel
import one.zephyr.mobile.ui.component.SettingsRow
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * S11 连接编辑器.
 *
 * Renders [ConnectionEditorUiState.sections] in order rather than hardcoding the eight sections, so
 * the frozen order in SCREEN_CATALOG.md 6 has exactly one definition ([EditorSection]) and a
 * protocol that has no RDP section simply produces a shorter list.
 *
 * Stateless apart from two genuinely visual pieces of state: the discard dialog and which dropdown
 * is open. Everything else is hoisted into the ViewModel.
 */
@Composable
fun ConnectionEditorScreen(
    state: PageState<ConnectionEditorUiState>,
    isCreate: Boolean,
    onIntent: (EditorIntent) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmDiscard by remember { mutableStateOf(false) }

    Box(modifier.fillMaxSize()) {
    Column(
        Modifier
            .fillMaxSize()
            .background(ZephyrTheme.palette.surfaces.background),
    ) {
        PushedPageHeader(
            title = stringResource(
                if (isCreate) R.string.editor_title_create else R.string.editor_title_edit,
            ),
            onBack = {
                val dirty = (state as? PageState.Content)?.value?.draft?.isDirty == true
                if (dirty) confirmDiscard = true else onBack()
            },
            backDescription = stringResource(R.string.editor_back),
        )

        PageStateScaffold(state = state, modifier = Modifier.fillMaxSize()) { ui ->
            Box(Modifier.fillMaxSize()) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = ZephyrSpacing.lg)
                        .padding(bottom = 190.dp),
                ) {
                    for (section in ui.sections.filterNot { it == EditorSection.FILE_SYNC }) {
                        SectionCard(title = sectionTitle(section), compact = section == EditorSection.BASIC) {
                            when (section) {
                                EditorSection.BASIC -> BasicSection(ui, onIntent)
                                EditorSection.AUTH -> AuthSection(ui, onIntent)
                                EditorSection.ROUTE -> RouteSection(ui, onIntent)
                                EditorSection.RDP_CHANNELS -> RdpChannelSection(ui, onIntent)
                                EditorSection.RDP_DISPLAY -> RdpDisplaySection(ui, onIntent)
                                EditorSection.FILE_SYNC -> FileSyncSection(ui, onIntent)
                                EditorSection.METADATA -> MetadataSection(ui, onIntent)
                            }
                        }
                    }
                    ui.testResult?.let {
                        Box(Modifier.padding(horizontal = 4.dp, vertical = 12.dp)) {
                            TestResultText(it)
                        }
                    }
                }
                PushedPageActionBar(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth(),
                ) {
                    FixedActions(ui = ui, onIntent = onIntent)
                }
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(stringResource(R.string.editor_discard_title)) },
            text = { Text(stringResource(R.string.editor_discard_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDiscard = false
                        onBack()
                    },
                ) { Text(stringResource(R.string.editor_discard_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDiscard = false }) {
                    Text(stringResource(R.string.editor_keep_editing))
                }
            },
        )
    }
    }
}

/** One user action on the editor. An interface rather than 20 lambdas keeps the screen signature usable. */
sealed interface EditorIntent {
    data class Name(val value: String) : EditorIntent
    data class Host(val value: String) : EditorIntent
    data class Port(val value: String) : EditorIntent
    data class Username(val value: String) : EditorIntent
    data class Remark(val value: String) : EditorIntent
    data class Tags(val value: List<String>) : EditorIntent
    data class ProtocolChanged(val value: Protocol) : EditorIntent
    data class Encoding(val value: TerminalEncoding) : EditorIntent
    data class Mode(val value: ConnectionMode) : EditorIntent
    data class ProxySelected(val value: String?) : EditorIntent
    data class SshKeySelected(val value: String?) : EditorIntent
    data class JumpAdded(val value: String) : EditorIntent
    data class JumpRemoved(val value: String) : EditorIntent
    data class JumpMoved(val from: Int, val to: Int) : EditorIntent
    data class Password(val value: SecretState) : EditorIntent
    data class PrivateKey(val value: SecretState) : EditorIntent
    data class Rdp(val value: RdpSettings) : EditorIntent
    data class FileSync(val value: FileSyncDirectoryIntent) : EditorIntent
    data class Visibility(val value: String) : EditorIntent
    data class RepairRoute(val field: String) : EditorIntent
    data object Test : EditorIntent
    data class EditRevealedPassword(val value: String) : EditorIntent

    data object RevealPassword : EditorIntent

    data object HidePassword : EditorIntent

    data object Save : EditorIntent
    data object SaveAndConnect : EditorIntent
    data object ConnectWithoutSaving : EditorIntent
}

@Composable
private fun sectionTitle(section: EditorSection): String = when (section) {
    EditorSection.BASIC -> stringResource(R.string.editor_section_basic)
    EditorSection.AUTH -> stringResource(R.string.editor_section_auth)
    EditorSection.ROUTE -> stringResource(R.string.editor_section_route)
    EditorSection.RDP_CHANNELS -> stringResource(R.string.editor_section_rdp_channels)
    EditorSection.RDP_DISPLAY -> stringResource(R.string.editor_section_rdp_display)
    EditorSection.FILE_SYNC -> stringResource(R.string.editor_section_file_sync)
    EditorSection.METADATA -> stringResource(R.string.editor_section_metadata)
}

@Composable
private fun SectionCard(title: String, compact: Boolean, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            text = title.uppercase(),
            style = ZephyrTheme.typography.section,
            color = ZephyrTheme.palette.onFloatingSubtle,
            modifier = Modifier.padding(start = 4.dp, top = if (compact) 4.dp else 22.dp, bottom = 10.dp),
        )
        GroupCard { content() }
    }
}

// ---- sections ----------------------------------------------------------------------------------

@Composable
private fun BasicSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val draft = ui.draft
    Field(
        label = stringResource(R.string.editor_field_name),
        value = draft.current.name,
        issue = ui.issueFor("name"),
        onChange = { onIntent(EditorIntent.Name(it)) },
    )

    HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.editor_field_protocol), style = ZephyrTheme.typography.caption, color = ZephyrTheme.palette.onFloatingMuted, modifier = Modifier.width(72.dp))
        SegmentedControl(
            options = Protocol.entries.map { it.wireName },
            selectedIndex = Protocol.entries.indexOf(draft.current.protocol),
            onSelect = { onIntent(EditorIntent.ProtocolChanged(Protocol.entries[it])) },
            modifier = Modifier.weight(1f),
        )
    }
    if (draft.current.protocol.isCleartext) {
        CleartextProtocolWarning(draft.current.protocol)
    }

    HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
    Field(
        label = stringResource(R.string.editor_field_host),
        value = draft.current.host,
        issue = ui.issueFor("host"),
        onChange = { onIntent(EditorIntent.Host(it)) },
    )

    HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
    Field(
        label = stringResource(R.string.editor_field_port),
        value = draft.current.port.toString(),
        issue = ui.issueFor("port"),
        keyboardType = KeyboardType.Number,
        onChange = { onIntent(EditorIntent.Port(it)) },
    )

    HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
    Field(
        label = stringResource(R.string.editor_field_username),
        value = draft.current.username,
        issue = ui.issueFor("username"),
        onChange = { onIntent(EditorIntent.Username(it)) },
    )

    if (draft.showsDomainField) {
        HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
        Field(
            label = stringResource(R.string.editor_field_domain),
            value = draft.current.rdp.domain,
            issue = null,
            onChange = { onIntent(EditorIntent.Rdp(draft.current.rdp.copy(domain = it))) },
        )
    }

    if (draft.showsEncodingField) {
        HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.editor_field_encoding), style = ZephyrTheme.typography.caption, color = ZephyrTheme.palette.onFloatingMuted, modifier = Modifier.width(72.dp))
            SegmentedControl(
                options = ConnectionDraft.availableEncodings(draft.current.protocol).map { it.wireName },
                selectedIndex = ConnectionDraft.availableEncodings(draft.current.protocol).indexOf(draft.current.encoding).coerceAtLeast(0),
                onSelect = { index ->
                    onIntent(EditorIntent.Encoding(ConnectionDraft.availableEncodings(draft.current.protocol)[index]))
                },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun AuthSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val draft = ui.draft
    SecretEditor(
        label = stringResource(R.string.editor_field_password),
        stored = draft.original?.password ?: SecretPresence.absent,
        state = draft.password,
        revealAllowed = ui.passwordRevealAllowed,
        revealedValue = ui.revealedPassword,
        onReveal = { onIntent(EditorIntent.RevealPassword) },
        onHide = { onIntent(EditorIntent.HidePassword) },
        onEditRevealed = { onIntent(EditorIntent.EditRevealedPassword(it)) },
        onChange = { onIntent(EditorIntent.Password(it)) },
    )

    if (draft.showsSshKeyField) {
        HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
        val keyNames = ui.sshKeys.associate { it.id to it.name }
        Selector(
            label = stringResource(R.string.editor_field_ssh_key),
            selectedId = draft.current.sshKeyId,
            options = keyNames,
            issue = ui.issueFor("sshKeyId"),
            onSelect = { onIntent(EditorIntent.SshKeySelected(it)) },
            onRepair = { onIntent(EditorIntent.RepairRoute("sshKeyId")) },
        )
    }
}

@Composable
private fun RouteSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val draft = ui.draft
    val mode = draft.current.connectionMode
    SettingsRow(
        title = "方式",
        value = when (mode) {
            ConnectionMode.DIRECT -> modeLabel(mode)
            ConnectionMode.PROXY -> modeLabel(mode)
            ConnectionMode.JUMP -> "JumpHost · ${draft.current.jumpHostIds.size} 级"
        },
        showChevron = true,
        showDivider = mode != ConnectionMode.DIRECT,
        onClick = {
            val next = ConnectionMode.entries[(ConnectionMode.entries.indexOf(mode) + 1) % ConnectionMode.entries.size]
            onIntent(EditorIntent.Mode(next))
        },
    )

    when (mode) {
        ConnectionMode.DIRECT -> Unit

        ConnectionMode.PROXY -> {
            Selector(
                label = stringResource(R.string.editor_mode_proxy),
                selectedId = draft.current.proxyId,
                options = ui.proxies.associate { it.id to (it.name + " · " + it.host + ":" + it.port) },
                issue = ui.issueFor("proxyId"),
                onSelect = { onIntent(EditorIntent.ProxySelected(it)) },
                onRepair = { onIntent(EditorIntent.RepairRoute("proxyId")) },
            )
        }

        ConnectionMode.JUMP -> {
            val names = ui.jumpHosts.associate { it.id to it.name }
            SettingsRow(
                title = draft.current.jumpHostIds.joinToString(" → ") { names[it] ?: it }.ifBlank { "未选择 JumpHost" },
                subtitle = "服务器列表中的 SSH 连接都可作为跳板机 · 依赖均有 use 能力",
                showChevron = true,
                showDivider = false,
                onClick = {
                    ui.jumpHosts.firstOrNull {
                        it.id !in draft.current.jumpHostIds && it.id in ui.inventory.usableJumpHostIds
                    }?.let { onIntent(EditorIntent.JumpAdded(it.id)) }
                },
            )
        }
    }
}

/**
 * Ordered jump chain.
 *
 * Reordering uses explicit up/down buttons rather than a drag handle: the chain is at most 8 rows,
 * order is semantically load-bearing, and buttons carry accessibility labels a drag gesture cannot
 * (SCREEN_CATALOG.md 26).
 */
@Composable
private fun JumpChainEditor(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val chain = ui.draft.current.jumpHostIds
    val names = ui.jumpHosts.associate { it.id to it.name }

    Text(
        text = stringResource(R.string.editor_jump_chain, Connection.MAX_JUMP_DEPTH),
        style = ZephyrTheme.typography.caption,
    )
    ui.issueFor("jumpHostIds")?.let { IssueText(it) }

    chain.forEachIndexed { index, id ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = (index + 1).toString() + ". " + (names[id] ?: id),
                style = ZephyrTheme.typography.mono,
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { onIntent(EditorIntent.JumpMoved(index, index - 1)) },
                enabled = index > 0,
            ) {
                Icon(ZephyrIcons.ArrowUp, contentDescription = stringResource(R.string.editor_jump_up))
            }
            IconButton(
                onClick = { onIntent(EditorIntent.JumpMoved(index, index + 1)) },
                enabled = index < chain.size - 1,
            ) {
                Icon(ZephyrIcons.ArrowDown, contentDescription = stringResource(R.string.editor_jump_down))
            }
            IconButton(onClick = { onIntent(EditorIntent.JumpRemoved(id)) }) {
                Icon(ZephyrIcons.Close, contentDescription = stringResource(R.string.editor_jump_remove))
            }
        }
    }

    val addable = ui.jumpHosts.filter { it.id !in chain && it.id in ui.inventory.usableJumpHostIds }
    if (addable.isNotEmpty() && chain.size < Connection.MAX_JUMP_DEPTH) {
        var expanded by remember { mutableStateOf(false) }
        OutlinedButton(onClick = { expanded = true }) {
            Text(stringResource(R.string.editor_jump_add))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for (host in addable) {
                DropdownMenuItem(
                    text = { Text(host.name) },
                    onClick = {
                        expanded = false
                        onIntent(EditorIntent.JumpAdded(host.id))
                    },
                )
            }
        }
    }
}

@Composable
private fun RdpChannelSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val rdp = ui.draft.current.rdp
    SettingsRow(
        title = stringResource(R.string.editor_rdp_sound),
        value = when (rdp.soundMode) {
            RdpSoundMode.LOCAL -> "在此设备播放"
            RdpSoundMode.REMOTE -> "在远端播放"
            RdpSoundMode.OFF -> "关闭"
        },
        showChevron = true,
        onClick = {
            val next = RdpSoundMode.entries[(RdpSoundMode.entries.indexOf(rdp.soundMode) + 1) % RdpSoundMode.entries.size]
            onIntent(EditorIntent.Rdp(rdp.copy(soundMode = next)))
        },
    )
    ToggleRow(stringResource(R.string.editor_rdp_clipboard), rdp.clipboard) {
        onIntent(EditorIntent.Rdp(rdp.copy(clipboard = it)))
    }
    ToggleRow(stringResource(R.string.editor_rdp_microphone), rdp.microphone, "会话请求时才申请权限") {
        onIntent(EditorIntent.Rdp(rdp.copy(microphone = it)))
    }
    ToggleRow(stringResource(R.string.editor_rdp_camera), rdp.camera) {
        onIntent(EditorIntent.Rdp(rdp.copy(camera = it)))
    }
    ToggleRow("存储（文件 drive）", rdp.storage, "只读在 provider 层执行", showDivider = !rdp.storage) {
        onIntent(EditorIntent.Rdp(rdp.copy(storage = it)))
    }
    if (rdp.storage) {
        SettingsRow(
            title = "映射目录",
            subtitle = "本机共享目录授权",
            value = when (ui.draft.current.fileSyncIntent) {
                FileSyncDirectoryIntent.OFF -> "未映射"
                FileSyncDirectoryIntent.ASK -> "会话时选择"
                FileSyncDirectoryIntent.LOCAL_SHARE -> "下载/ZephyrDrive"
                FileSyncDirectoryIntent.SERVER_BRIDGE -> "主端桥接"
            },
            showChevron = true,
            onClick = {
                val values = FileSyncDirectoryIntent.entries
                val current = values.indexOf(ui.draft.current.fileSyncIntent)
                onIntent(EditorIntent.FileSync(values[(current + 1) % values.size]))
            },
        )
        SettingsRow(
            title = "只读",
            showDivider = false,
            trailing = { Switch(checked = true, onCheckedChange = null, enabled = false) },
        )
    }
}

@Composable
private fun RdpDisplaySection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    val rdp = ui.draft.current.rdp
    SettingsRow(title = stringResource(R.string.editor_rdp_resolution), value = if (rdp.resolution == RdpResolution.AUTO) "自动（匹配此设备）" else rdp.resolution.wireName, showChevron = true, onClick = {
        val next = RdpResolution.entries[(RdpResolution.entries.indexOf(rdp.resolution) + 1) % RdpResolution.entries.size]
        onIntent(EditorIntent.Rdp(rdp.copy(resolution = next)))
    })
    SettingsRow(title = stringResource(R.string.editor_rdp_quality), value = qualityLabel(rdp.quality), showChevron = true, onClick = {
        val next = RdpQuality.entries[(RdpQuality.entries.indexOf(rdp.quality) + 1) % RdpQuality.entries.size]
        onIntent(EditorIntent.Rdp(rdp.copy(quality = next)))
    })
    SettingsRow(title = stringResource(R.string.editor_rdp_fps), value = "${rdp.fps.value} FPS", showChevron = true, onClick = {
        val next = RdpFps.entries[(RdpFps.entries.indexOf(rdp.fps) + 1) % RdpFps.entries.size]
        onIntent(EditorIntent.Rdp(rdp.copy(fps = next)))
    })
    SettingsRow(title = "触控方式", value = touchModeLabel(rdp.touchMode), showChevron = true, onClick = {
        val next = RdpTouchMode.entries[(RdpTouchMode.entries.indexOf(rdp.touchMode) + 1) % RdpTouchMode.entries.size]
        onIntent(EditorIntent.Rdp(rdp.copy(touchMode = next)))
    })
    SettingsRow(
        title = "触控板灵敏度",
        value = "%.1f".format(rdp.touchSensitivity),
        showChevron = true,
        showDivider = false,
        onClick = {
            val next = if (rdp.touchSensitivity >= RdpSettings.MAX_SENSITIVITY) RdpSettings.MIN_SENSITIVITY else rdp.touchSensitivity + 0.1f
            onIntent(EditorIntent.Rdp(rdp.copy(touchSensitivity = RdpSettings.clampSensitivity(next))))
        },
    )
}

@Composable
private fun FileSyncSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
        for (intent in FileSyncDirectoryIntent.entries) {
            FilterChip(
                selected = ui.draft.current.fileSyncIntent == intent,
                onClick = { onIntent(EditorIntent.FileSync(intent)) },
                label = { Text(fileSyncLabel(intent)) },
            )
        }
    }
    Spacer(Modifier.height(ZephyrSpacing.sm))
    Text(
        text = stringResource(R.string.editor_file_sync_note),
        style = ZephyrTheme.typography.caption,
        color = ZephyrTheme.palette.onFloatingMuted,
    )
}

@Composable
private fun MetadataSection(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    Field(
        label = stringResource(R.string.editor_field_tags),
        value = ui.draft.current.tags.joinToString(","),
        issue = null,
        // Split here rather than in the draft so the raw text stays exactly what the user typed
        // until they leave the field; the draft normalises on save.
        onChange = { onIntent(EditorIntent.Tags(it.split(',').map(String::trim))) },
    )

    HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
    Field(
        label = stringResource(R.string.editor_field_remark),
        value = ui.draft.current.remark,
        issue = null,
        onChange = { onIntent(EditorIntent.Remark(it)) },
    )

    HorizontalDivider(color = ZephyrTheme.palette.surfaces.outlineSoft)
    SettingsRow(
        title = "共享",
        value = if (ui.draft.current.visibility == "private") "私有" else ui.draft.current.visibility,
        showChevron = true,
        showDivider = false,
        onClick = {
            val current = VISIBILITY_OPTIONS.indexOf(ui.draft.current.visibility).coerceAtLeast(0)
            onIntent(EditorIntent.Visibility(VISIBILITY_OPTIONS[(current + 1) % VISIBILITY_OPTIONS.size]))
        },
    )
}

/**
 * The three fixed actions.
 *
 * Order and presence are frozen by SCREEN_CATALOG.md 6.8. 保存 stays enabled while the form is
 * dirty even if validation would fail, because pressing it is how the user asks to see what is
 * wrong; the ViewModel answers with issues instead of a silent no-op.
 */
@Composable
private fun RowScope.FixedActions(ui: ConnectionEditorUiState, onIntent: (EditorIntent) -> Unit) {
    PrimaryButton(
        onClick = { onIntent(EditorIntent.Test) },
        enabled = !ui.testing && !ui.saving,
        modifier = Modifier.weight(1f),
        ghost = true,
    ) { Text(stringResource(R.string.editor_action_test)) }
    PrimaryButton(
        onClick = { onIntent(EditorIntent.ConnectWithoutSaving) },
        enabled = !ui.saving,
        modifier = Modifier.weight(1f),
        ghost = true,
    ) { Text(stringResource(R.string.editor_action_connect_unsaved)) }
    PrimaryButton(
        onClick = { onIntent(EditorIntent.Save) },
        enabled = !ui.saving,
        modifier = Modifier.weight(1.4f),
    ) { Text(stringResource(R.string.editor_action_save)) }
}

@Composable
private fun TestResultText(result: ConnectionTestResult) {
    val palette = ZephyrTheme.palette
    val (text, color) = when (result) {
        is ConnectionTestResult.Reachable ->
            stringResource(R.string.editor_test_reachable, result.roundTripMs) to palette.status.success
        is ConnectionTestResult.Authenticated ->
            stringResource(R.string.editor_test_authenticated, result.roundTripMs) to palette.status.success
        // The structured message and its requestId are shown as-is: a test that failed because the
        // engine is unavailable must not read like a wrong password.
        is ConnectionTestResult.Failed -> result.error.message to palette.status.error
    }
    Text(text, style = ZephyrTheme.typography.caption, color = color)
    if (result is ConnectionTestResult.Failed) {
        Text(result.error.diagnosticText(), style = ZephyrTheme.typography.monoCaption)
    }
    Spacer(Modifier.height(ZephyrSpacing.sm))
}

// ---- reusable pieces ---------------------------------------------------------------------------

@Composable
private fun Field(
    label: String,
    value: String,
    issue: DraftIssue?,
    onChange: (String) -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    supporting: String? = null,
) {
    FieldRow(
        label = label,
        value = value,
        onValueChange = onChange,
        mono = keyboardType == KeyboardType.Number ||
            label == stringResource(R.string.editor_field_host) ||
            label == stringResource(R.string.editor_field_username),
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboardType),
        showDivider = false,
    )
    (issue?.message ?: supporting)?.let {
        Text(
            text = it,
            style = ZephyrTheme.typography.caption,
            color = if (issue != null) ZephyrTheme.palette.status.error else ZephyrTheme.palette.onFloatingSubtle,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun IssueText(issue: DraftIssue) {
    Text(issue.message, style = ZephyrTheme.typography.caption, color = ZephyrTheme.palette.status.error)
}

/**
 * Secret tri-state.
 *
 * The three modes derive from the [SecretState] the draft already holds, so there is no second
 * source of truth and a masked placeholder can never be mistaken for typed input
 * (ZEPHYR_PARITY.md 5.3). The stored value is described, never rendered.
 */
@Composable
private fun SecretEditor(
    label: String,
    stored: SecretPresence,
    state: SecretState,
    revealAllowed: Boolean = false,
    revealedValue: String? = null,
    onReveal: () -> Unit = {},
    onHide: () -> Unit = {},
    onEditRevealed: (String) -> Unit = {},
    onChange: (SecretState) -> Unit,
    multiline: Boolean = false,
) {
    val replacement = state as? SecretState.Replace
    val showInput = !stored.hasValue || replacement != null || revealedValue != null
    if (showInput) {
        InlineSecretInput(
            label = if (stored.hasValue) stringResource(R.string.editor_secret_new_value) else label,
            value = replacement?.editingText() ?: revealedValue.orEmpty(),
            existingHidden = stored.hasValue && revealedValue == null && replacement == null,
            multiline = multiline,
            revealed = revealedValue != null,
            onValueChange = { value ->
                if (revealedValue != null) onEditRevealed(value) else onChange(SecretState.Replace(value))
            },
        )
        if (replacement != null && stored.hasValue && revealedValue == null) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(onClick = { onChange(SecretState.Unchanged) }) {
                    Text(stringResource(R.string.editor_secret_keep))
                }
            }
        }
        return
    }

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            label,
            style = ZephyrTheme.typography.caption,
            color = ZephyrTheme.palette.onFloatingMuted,
            modifier = Modifier.width(72.dp),
        )
        Text(
            text = ConnectionDraft.presenceFor(state, stored).let {
                if (it.hasValue) SecretPresence.MASK else stringResource(R.string.editor_secret_clear)
            },
            style = ZephyrTheme.typography.mono,
            color = ZephyrTheme.palette.onFloatingMuted,
            modifier = Modifier.weight(1f),
        )
        Row(
            modifier = Modifier.width(if (revealAllowed) 196.dp else 128.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (revealAllowed && state is SecretState.Unchanged) {
                IconButton(onClick = if (revealedValue == null) onReveal else onHide) {
                    Icon(
                        imageVector = if (revealedValue == null) ZephyrIcons.Eye else ZephyrIcons.EyeOff,
                        contentDescription = stringResource(
                            if (revealedValue == null) R.string.editor_secret_reveal else R.string.editor_secret_hide,
                        ),
                        tint = ZephyrTheme.palette.onFloatingMuted,
                    )
                }
            }
            OutlinedButton(
                onClick = { onChange(SecretState.Replace("")) },
                modifier = Modifier.weight(1f),
            ) { Text(stringResource(R.string.editor_secret_replace), maxLines = 1) }
            if (state !is SecretState.Clear) {
                OutlinedButton(
                    onClick = { onChange(SecretState.Clear) },
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(R.string.editor_secret_clear), maxLines = 1) }
            }
        }
    }
}

@Composable
private fun InlineSecretInput(
    label: String,
    value: String,
    existingHidden: Boolean,
    multiline: Boolean,
    revealed: Boolean,
    onValueChange: (String) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            label,
            style = ZephyrTheme.typography.caption,
            color = ZephyrTheme.palette.onFloatingMuted,
            modifier = Modifier.width(72.dp),
        )
        androidx.compose.foundation.text.BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = !multiline,
            textStyle = ZephyrTheme.typography.mono.copy(color = ZephyrTheme.palette.onBackground),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(ZephyrTheme.palette.brand.accent),
            visualTransformation = if (multiline || revealed) {
                androidx.compose.ui.text.input.VisualTransformation.None
            } else {
                PasswordVisualTransformation()
            },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = if (multiline || revealed) KeyboardType.Text else KeyboardType.Password,
            ),
            modifier = Modifier.weight(1f).heightIn(min = 32.dp),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(
                            if (existingHidden) SecretPresence.MASK else "可选",
                            color = ZephyrTheme.palette.onFloatingSubtle,
                        )
                    }
                    inner()
                }
            },
        )
    }
}

/**
 * Dependency picker with a repair affordance.
 *
 * When the current selection is not in [options] the row shows the repair action instead of
 * silently rendering an empty selection, which is what SCREEN_CATALOG.md 6 means by
 * "路由需要修复".
 */
@Composable
private fun Selector(
    label: String,
    selectedId: String?,
    options: Map<String, String>,
    issue: DraftIssue?,
    onSelect: (String?) -> Unit,
    onRepair: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        SettingsRow(
            title = if (label.contains("Key", ignoreCase = true)) "已保存的 SSH Key" else label,
            subtitle = selectedId?.let { options[it] ?: it } ?: stringResource(R.string.editor_none),
            showChevron = true,
            showDivider = false,
            onClick = { if (issue == null) expanded = true else onRepair() },
        )
        issue?.let { IssueText(it) }

        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.editor_none)) },
                onClick = {
                    expanded = false
                    onSelect(null)
                },
            )
            for ((id, name) in options) {
                DropdownMenuItem(
                    text = { Text(name) },
                    onClick = {
                        expanded = false
                        onSelect(id)
                    },
                )
            }
        }
    }
}

@Composable
private fun ToggleRow(
    label: String,
    checked: Boolean,
    subtitle: String? = null,
    showDivider: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    SettingsRow(
        title = label,
        subtitle = subtitle,
        showDivider = showDivider,
        trailing = { Switch(checked = checked, onCheckedChange = onChange) },
    )
}

private fun qualityLabel(value: RdpQuality): String = when (value) {
    RdpQuality.BALANCED -> "平衡"
    RdpQuality.PERFORMANCE -> "性能"
    RdpQuality.QUALITY -> "画质"
}

private fun touchModeLabel(value: RdpTouchMode): String = when (value) {
    RdpTouchMode.DIRECT -> "直接触控"
    RdpTouchMode.RELATIVE -> "触控板"
}

@Composable
private fun modeLabel(mode: ConnectionMode): String = when (mode) {
    ConnectionMode.DIRECT -> stringResource(R.string.editor_mode_direct)
    ConnectionMode.PROXY -> stringResource(R.string.editor_mode_proxy)
    ConnectionMode.JUMP -> stringResource(R.string.editor_mode_jump)
}

@Composable
private fun fileSyncLabel(intent: FileSyncDirectoryIntent): String = when (intent) {
    FileSyncDirectoryIntent.OFF -> stringResource(R.string.editor_file_sync_off)
    FileSyncDirectoryIntent.ASK -> stringResource(R.string.editor_file_sync_ask)
    FileSyncDirectoryIntent.LOCAL_SHARE -> stringResource(R.string.editor_file_sync_local_share)
    FileSyncDirectoryIntent.SERVER_BRIDGE -> stringResource(R.string.editor_file_sync_server_bridge)
}

/** Zephyr's connection visibility values. Kept as the wire strings because the server owns them. */
private val VISIBILITY_OPTIONS = listOf("private", "shared_users", "shared_admins", "shared_all")
