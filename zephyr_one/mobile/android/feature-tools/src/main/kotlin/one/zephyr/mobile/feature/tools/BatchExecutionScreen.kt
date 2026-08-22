@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package one.zephyr.mobile.feature.tools

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import one.zephyr.mobile.ui.component.AlertDialog
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.component.Checkbox
import one.zephyr.mobile.ui.component.CircularProgressIndicator
import one.zephyr.mobile.ui.component.HorizontalDivider
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.IconButton
import one.zephyr.mobile.ui.component.LinearProgressIndicator
import one.zephyr.mobile.ui.component.OutlinedButton
import one.zephyr.mobile.ui.component.OutlinedTextField
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import one.zephyr.mobile.ui.component.GroupCard
import one.zephyr.mobile.ui.component.PrimaryButton
import one.zephyr.mobile.ui.component.SettingsRow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.model.ActionGate
import one.zephyr.mobile.model.PageState
import one.zephyr.mobile.ui.component.MonoEndpoint
import one.zephyr.mobile.ui.component.SectionHeader
import one.zephyr.mobile.ui.chrome.PushedPageActionBar
import one.zephyr.mobile.ui.island.islandContentBottomInset
import one.zephyr.mobile.ui.state.PageStateScaffold
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * S41 批量执行.
 *
 * Stateless: every input is a value and the only output is [onIntent], so a Compose test can drive
 * a fail-fast abort or a denied target without an SSH engine behind it.
 *
 * Two rules from the frozen spec are visible in the layout rather than left to the reader. Denied
 * hosts are rendered in their own section below the run, never interleaved with executed hosts
 * (SCREEN_CATALOG.md 16), and every status is a text label beside its colour so the screen still
 * reads correctly without colour perception (SCREEN_CATALOG.md 26).
 */
@Composable
fun BatchExecutionScreen(
    state: PageState<BatchContent>,
    onIntent: (BatchIntent) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    PageStateScaffold(state = state, onRetry = onRetry, modifier = modifier.fillMaxSize()) { content ->
        var confirmCancel by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = ZephyrSpacing.lg,
                    end = ZephyrSpacing.lg,
                    top = 2.dp,
                    bottom = 190.dp,
                ),
            ) {
                item("targets-label") { DemoSectionLabel("目标（需 execute · 未连接会自动拨号）", compact = true) }
                item("targets") {
                    GroupCard {
                        content.targets.forEachIndexed { index, target ->
                            val gate = BatchTargets.gate(target)
                            val available = gate.isAllowed
                            SettingsRow(
                                title = target.name,
                                subtitle = if (available) target.host else "无 execute 能力 · 将被跳过",
                                showDivider = index != content.targets.lastIndex,
                                trailing = {
                                    Switch(
                                        checked = available && target.connectionId in content.plan.selectedIds,
                                        onCheckedChange = if (available && !content.isRunning) {
                                            { onIntent(BatchIntent.ToggleTarget(target.connectionId)) }
                                        } else {
                                            null
                                        },
                                        enabled = available && !content.isRunning,
                                    )
                                },
                            )
                        }
                    }
                }
                item("command-label") { DemoSectionLabel("命令") }
                item("command") {
                    GroupCard {
                        one.zephyr.mobile.ui.component.FieldRow(
                            label = "命令",
                            value = content.plan.command,
                            onValueChange = { onIntent(BatchIntent.Command(it)) },
                            mono = true,
                            singleLine = false,
                        )
                        SettingsRow(
                            title = "超时",
                            value = "${content.plan.timeoutSeconds} 秒（1–300）",
                            showChevron = true,
                            onClick = {
                                val values = listOf(30, 60, 120, 300)
                                val current = values.indexOf(content.plan.timeoutSeconds)
                                onIntent(BatchIntent.Timeout(values[(current + 1).coerceAtLeast(0) % values.size]))
                            },
                        )
                        SettingsRow(
                            title = "并发",
                            value = content.plan.concurrency.toString(),
                            showChevron = true,
                            onClick = {
                                val values = listOf(1, 2, 4, 8, 16)
                                val current = values.indexOf(content.plan.concurrency)
                                onIntent(BatchIntent.Concurrency(values[(current + 1).coerceAtLeast(0) % values.size]))
                            },
                        )
                        SettingsRow(
                            title = "fail-fast",
                            subtitle = "一台失败即取消剩余目标",
                            showDivider = false,
                            trailing = {
                                Switch(
                                    checked = content.plan.failFast,
                                    onCheckedChange = { onIntent(BatchIntent.FailFast(it)) },
                                    enabled = !content.isRunning,
                                )
                            },
                        )
                    }
                }
                item("results-label") { DemoSectionLabel("结果") }
                item("results") {
                    GroupCard {
                        if (content.run == null) {
                            Text(
                                "尚未执行 · 审计只保存截断 metadata",
                                color = ZephyrTheme.palette.onFloatingSubtle,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth().padding(16.dp),
                            )
                        } else {
                            RunProgress(content.run)
                            content.run.executableTargets.forEach { row ->
                                ResultRow(
                                    row = row,
                                    cancellable = !row.isTerminal,
                                    onCancel = { onIntent(BatchIntent.CancelTarget(row.target.connectionId)) },
                                )
                            }
                            content.run.deniedTargets.forEach { DeniedRow(it) }
                        }
                    }
                }
                if (!content.engineAvailable) {
                    item("engine") { EngineUnavailableNotice() }
                }
            }
            PushedPageActionBar(Modifier.align(Alignment.BottomCenter)) {
                PrimaryButton(
                    onClick = {
                        if (content.isRunning) confirmCancel = true else onIntent(BatchIntent.ClearSelection)
                    },
                    modifier = Modifier.weight(1f),
                    ghost = true,
                ) { Text("取消") }
                PrimaryButton(
                    onClick = { onIntent(BatchIntent.Run) },
                    modifier = Modifier.weight(1.4f),
                    enabled = content.canRun,
                ) { Text("执行") }
            }
            if (confirmCancel) {
                AlertDialog(
                    onDismissRequest = { confirmCancel = false },
                    title = { Text(stringResource(R.string.tools_batch_cancel_title)) },
                    text = { Text(stringResource(R.string.tools_batch_cancel_message)) },
                    confirmButton = {
                        TextButton(onClick = {
                            confirmCancel = false
                            onIntent(BatchIntent.CancelRun)
                        }) { Text(stringResource(R.string.tools_batch_cancel_confirm)) }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmCancel = false }) {
                            Text(stringResource(R.string.tools_dialog_cancel))
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun DemoSectionLabel(text: String, compact: Boolean = false) {
    Text(
        text = text.uppercase(),
        color = ZephyrTheme.palette.onFloatingSubtle,
        style = ZephyrTheme.typography.caption,
        modifier = Modifier.padding(start = 4.dp, top = if (compact) 4.dp else 22.dp, bottom = 10.dp),
    )
}

@Composable
private fun EngineUnavailableNotice() {
    // Stated as a build limitation rather than a transient failure: retrying cannot make an unlinked
    // engine appear, so no retry affordance is offered here.
    Text(
        text = stringResource(R.string.tools_batch_engine_unavailable),
        style = ZephyrTheme.typography.caption,
        color = ZephyrTheme.palette.status.warning,
        modifier = Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.sm),
    )
}

@Composable
private fun CommandField(content: BatchContent, onIntent: (BatchIntent) -> Unit) {
    OutlinedTextField(
        value = content.plan.command,
        onValueChange = { onIntent(BatchIntent.Command(it)) },
        label = { Text(stringResource(R.string.tools_batch_command_label)) },
        supportingText = {
            val issue = content.issueFor(BatchPlan.FIELD_COMMAND)
            Text(issue ?: stringResource(R.string.tools_batch_command_hint))
        },
        isError = content.issueFor(BatchPlan.FIELD_COMMAND) != null,
        enabled = !content.isRunning,
        singleLine = false,
        textStyle = ZephyrTheme.typography.mono,
        modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
    )
}

@Composable
private fun LimitsRow(content: BatchContent, onIntent: (BatchIntent) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.md),
    ) {
        NumberField(
            value = content.plan.timeoutSeconds,
            label = stringResource(R.string.tools_batch_timeout_label),
            issue = content.issueFor(BatchPlan.FIELD_TIMEOUT),
            enabled = !content.isRunning,
            onValue = { onIntent(BatchIntent.Timeout(it)) },
            modifier = Modifier.weight(1f),
        )
        NumberField(
            value = content.plan.concurrency,
            label = stringResource(R.string.tools_batch_concurrency_label),
            issue = content.issueFor(BatchPlan.FIELD_CONCURRENCY),
            enabled = !content.isRunning,
            onValue = { onIntent(BatchIntent.Concurrency(it)) },
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * Numeric entry that keeps the user's keystrokes.
 *
 * The clamp lives in [BatchPlan.clamped], not here: clamping mid-typing would rewrite "3" to "30"
 * while the user was still reaching for the second digit. A non-numeric edit is ignored rather than
 * reset, so a backspace to empty does not silently substitute a value the user did not choose.
 */
@Composable
private fun NumberField(
    value: Int,
    label: String,
    issue: String?,
    enabled: Boolean,
    onValue: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = value.toString(),
        onValueChange = { text -> text.trim().toIntOrNull()?.let(onValue) },
        label = { Text(label) },
        isError = issue != null,
        supportingText = issue?.let { { Text(it) } },
        enabled = enabled,
        singleLine = true,
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Number),
        textStyle = ZephyrTheme.typography.tabularNumeric,
        modifier = modifier,
    )
}

@Composable
private fun FailFastRow(plan: BatchPlan, onIntent: (BatchIntent) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().sizeIn(minHeight = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.tools_batch_fail_fast_label), style = ZephyrTextStyles.body)
            Text(
                text = stringResource(R.string.tools_batch_fail_fast_hint),
                style = ZephyrTheme.typography.caption,
                color = ZephyrTheme.palette.onFloatingMuted,
            )
        }
        Switch(
            checked = plan.failFast,
            onCheckedChange = { onIntent(BatchIntent.FailFast(it)) },
            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
        )
    }
}

@Composable
private fun TargetsHeader(content: BatchContent, onIntent: (BatchIntent) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        SectionHeader(stringResource(R.string.tools_batch_targets_title))
        Text(
            text = stringResource(
                R.string.tools_batch_selected_count,
                content.selectedEligibleCount,
                content.selectedDeniedCount,
            ),
            style = ZephyrTheme.typography.tabularNumeric,
            color = ZephyrTheme.palette.onFloatingMuted,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
            TextButton(
                onClick = { onIntent(BatchIntent.SelectAllEligible) },
                enabled = !content.isRunning,
                modifier = Modifier.sizeIn(minHeight = 48.dp),
            ) { Text(stringResource(R.string.tools_batch_select_all)) }
            TextButton(
                onClick = { onIntent(BatchIntent.ClearSelection) },
                enabled = !content.isRunning,
                modifier = Modifier.sizeIn(minHeight = 48.dp),
            ) { Text(stringResource(R.string.tools_batch_clear_selection)) }
        }
    }
}

@Composable
private fun TargetPickerRow(
    target: BatchTarget,
    selected: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
) {
    val gate = BatchTargets.gate(target)
    val denialReason = (gate as? ActionGate.Disabled)?.reason
    Row(
        modifier = Modifier.fillMaxWidth().sizeIn(minHeight = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(
            checked = selected,
            // A denied host cannot be selected at all, so the run's counts can never include a host
            // it never attempted.
            onCheckedChange = if (gate.isAllowed) ({ onToggle() }) else null,
            enabled = enabled && gate.isAllowed,
            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(target.name, style = ZephyrTextStyles.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            MonoEndpoint(host = target.host, port = target.port)
            denialReason?.let {
                Text(it, style = ZephyrTheme.typography.caption, color = ZephyrTheme.palette.status.warning)
            }
        }
    }
}

@Composable
private fun RunActions(content: BatchContent, onIntent: (BatchIntent) -> Unit) {
    FlowRow(
        modifier = Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
    ) {
        OutlinedButton(
            onClick = { onIntent(BatchIntent.Run) },
            enabled = content.canRun,
            modifier = Modifier.sizeIn(minHeight = 48.dp),
        ) { Text(stringResource(R.string.tools_batch_run)) }

        if (content.run?.isComplete == true) {
            OutlinedButton(
                onClick = { onIntent(BatchIntent.Export) },
                modifier = Modifier.sizeIn(minHeight = 48.dp),
            ) { Text(stringResource(R.string.tools_batch_export)) }
        }
    }
    (content.runGate as? ActionGate.Disabled)?.let { disabled ->
        Text(
            text = disabled.reason,
            style = ZephyrTheme.typography.caption,
            color = ZephyrTheme.palette.onFloatingMuted,
        )
    }
}

@Composable
private fun RunProgress(run: BatchRunState) {
    val counts = run.summary
    Column(Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.sm)) {
        val progressText = stringResource(
            R.string.tools_batch_progress,
            counts.percent,
            counts.finished,
            counts.total,
        )
        Text(progressText, style = ZephyrTheme.typography.tabularNumeric)
        LinearProgressIndicator(
            progress = { counts.fraction },
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = ZephyrSpacing.xs)
                // The bar is decoration; the readable percentage above carries the value, which is
                // what SCREEN_CATALOG.md 26 requires.
                .semantics { contentDescription = progressText },
        )
        Text(
            text = stringResource(
                R.string.tools_batch_counts,
                counts.succeeded,
                counts.failed,
                counts.timedOut,
                counts.cancelled,
            ),
            style = ZephyrTheme.typography.tabularNumeric,
            color = ZephyrTheme.palette.onFloatingMuted,
        )
        if (run.stoppedByFailFast) {
            Text(
                text = stringResource(R.string.tools_batch_fail_fast_stopped),
                style = ZephyrTheme.typography.caption,
                color = ZephyrTheme.palette.status.warning,
            )
        }
    }
}

@Composable
private fun ResultRow(row: BatchTargetState, cancellable: Boolean, onCancel: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = ZephyrSpacing.xs)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(row.target.name, style = ZephyrTextStyles.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                MonoEndpoint(host = row.target.host, port = row.target.port)
            }
            StatusLabel(row.status)
            if (row.status == BatchTargetStatus.RUNNING) {
                Spacer(Modifier.width(ZephyrSpacing.sm))
                CircularProgressIndicator(modifier = Modifier.sizeIn(maxWidth = 20.dp, maxHeight = 20.dp))
            }
            if (cancellable) {
                IconButton(
                    onClick = onCancel,
                    modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
                ) {
                    Icon(
                        ZephyrIcons.Cancel,
                        contentDescription = stringResource(R.string.tools_batch_cancel_target),
                    )
                }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm)) {
            row.exitCode?.let { ReadOnlyBadge(stringResource(R.string.tools_batch_exit_code, it)) }
            row.durationMs?.let { ReadOnlyBadge(stringResource(R.string.tools_batch_duration, it)) }
        }
        row.error?.let { error ->
            Text(
                text = error.message,
                style = ZephyrTheme.typography.caption,
                color = ZephyrTheme.palette.status.error,
            )
        }
        OutputBlock(label = stringResource(R.string.tools_batch_stdout), text = row.stdout)
        OutputBlock(label = stringResource(R.string.tools_batch_stderr), text = row.stderr)
        HorizontalDivider(color = ZephyrTheme.palette.surfaces.outline)
    }
}

/**
 * A value the user reads, not a control.
 *
 * Deliberately not an AssistChip: a chip is focusable and clickable, so exit code and duration would
 * be announced as actionable buttons that do nothing when tapped. SCREEN_CATALOG.md 26 requires every
 * icon/button to carry a real action label, and the honest fix for a label is to not make it a button.
 */
@Composable
private fun ReadOnlyBadge(text: String) {
    Surface(
        color = ZephyrTheme.palette.surfaces.elevated,
        contentColor = ZephyrTheme.palette.onBackground,
        shape = RoundedCornerShape(ZephyrRadius.pill),
        border = BorderStroke(1.dp, ZephyrTheme.palette.surfaces.outline),
    ) {
        Text(
            text = text,
            style = ZephyrTheme.typography.tabularNumeric,
            modifier = Modifier.padding(horizontal = ZephyrSpacing.md, vertical = ZephyrSpacing.xs),
        )
    }
}
/** Collapsed by default: a full journal in a list row would bury the next host's status. */
@Composable
private fun OutputBlock(label: String, text: String) {
    if (text.isEmpty()) return
    var expanded by remember(text) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        TextButton(
            onClick = { expanded = !expanded },
            modifier = Modifier.sizeIn(minHeight = 48.dp),
        ) {
            Text(
                if (expanded) {
                    stringResource(R.string.tools_batch_output_hide, label)
                } else {
                    stringResource(R.string.tools_batch_output_show, label, text.length)
                },
            )
        }
        if (expanded) {
            Text(text, style = ZephyrTheme.typography.mono, modifier = Modifier.fillMaxWidth())
        }
    }
}

/**
 * Status as text plus colour.
 *
 * The label is the signal and the colour is the aid, never the reverse (SCREEN_CATALOG.md 26).
 */
@Composable
private fun StatusLabel(status: BatchTargetStatus) {
    val palette = ZephyrTheme.palette
    val (labelRes, color) = when (status) {
        BatchTargetStatus.PENDING -> R.string.tools_batch_status_pending to palette.status.offline
        BatchTargetStatus.RUNNING -> R.string.tools_batch_status_running to palette.brand.accent
        BatchTargetStatus.SUCCEEDED -> R.string.tools_batch_status_succeeded to palette.status.success
        BatchTargetStatus.FAILED -> R.string.tools_batch_status_failed to palette.status.error
        BatchTargetStatus.TIMED_OUT -> R.string.tools_batch_status_timed_out to palette.status.warning
        BatchTargetStatus.CANCELLED -> R.string.tools_batch_status_cancelled to palette.status.offline
        BatchTargetStatus.DENIED -> R.string.tools_batch_status_denied to palette.status.warning
    }
    Text(text = stringResource(labelRes), style = ZephyrTheme.typography.tabularNumeric, color = color)
}

@Composable
private fun DeniedHeader(count: Int) {
    Column(Modifier.fillMaxWidth()) {
        SectionHeader(stringResource(R.string.tools_batch_denied_section, count))
        Text(
            text = stringResource(R.string.tools_batch_denied_hint),
            style = ZephyrTheme.typography.caption,
            color = ZephyrTheme.palette.onFloatingMuted,
        )
    }
}

@Composable
private fun DeniedRow(row: BatchTargetState) {
    Row(
        modifier = Modifier.fillMaxWidth().sizeIn(minHeight = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.target.name, style = ZephyrTextStyles.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            MonoEndpoint(host = row.target.host, port = row.target.port)
            row.error?.let {
                Text(it.message, style = ZephyrTheme.typography.caption, color = ZephyrTheme.palette.status.warning)
            }
        }
        StatusLabel(BatchTargetStatus.DENIED)
    }
}
