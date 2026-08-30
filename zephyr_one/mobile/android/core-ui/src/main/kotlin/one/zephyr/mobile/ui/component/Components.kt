package one.zephyr.mobile.ui.component

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import one.zephyr.mobile.contracts.BindingState
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.model.SecretPresence
import one.zephyr.mobile.model.SyncStatus
import one.zephyr.mobile.ui.R
import one.zephyr.mobile.ui.icon.ZephyrIcons
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme

@Composable
fun ProtocolChip(protocol: Protocol, modifier: Modifier = Modifier) {
    val palette = ZephyrTheme.palette
    val color = when (protocol) {
        Protocol.SSH -> palette.protocol.ssh
        Protocol.TELNET -> palette.protocol.telnet
        Protocol.RDP -> palette.protocol.rdp
        Protocol.VNC -> palette.protocol.vnc
    }
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs),
    ) {
        Spacer(
            Modifier
                .size(8.dp)
                .clip(RoundedCornerShape(ZephyrRadius.pill))
                .background(color),
        )
        Text(text = protocol.wireName, style = ZephyrTextStyles.tabularNumeric)
    }
}

@Composable
fun CleartextProtocolWarning(protocol: Protocol, modifier: Modifier = Modifier) {
    if (!protocol.isCleartext) return
    val palette = ZephyrTheme.palette
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = palette.status.warning.copy(alpha = 0.14f),
        contentColor = palette.onBackground,
        shape = RoundedCornerShape(ZephyrRadius.md),
        border = BorderStroke(1.dp, palette.status.warning.copy(alpha = 0.45f)),
    ) {
        Row(
            modifier = Modifier.padding(ZephyrSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.sm),
        ) {
            Icon(ZephyrIcons.Warn, contentDescription = null, tint = palette.status.warning)
            Text(stringResource(R.string.protocol_cleartext_warning))
        }
    }
}

@Composable
fun SecretPresenceField(
    label: String,
    presence: SecretPresence,
    onReveal: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val stateText = if (presence.hasValue) {
        stringResource(R.string.secret_masked)
    } else {
        stringResource(R.string.secret_not_set)
    }
    Column(modifier = modifier.fillMaxWidth()) {
        Text(label, style = ZephyrTextStyles.caption, color = ZephyrTheme.palette.onFloatingMuted)
        Spacer(Modifier.size(ZephyrSpacing.xs))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = if (presence.hasValue) SecretPresence.MASK else stateText,
                style = ZephyrTextStyles.mono,
                modifier = Modifier.semantics { contentDescription = label + "，" + stateText },
            )
            if (presence.hasValue && onReveal != null) {
                Spacer(Modifier.width(ZephyrSpacing.sm))
                OutlinedButton(onClick = onReveal) { Text(stringResource(R.string.secret_reveal)) }
            }
        }
    }
}

@Composable
fun SyncStatusPill(status: SyncStatus, modifier: Modifier = Modifier) {
    val palette = ZephyrTheme.palette
    val (text, color) = when {
        status.conflictCount > 0 -> "冲突 " + status.conflictCount to palette.status.conflict
        status.bindingState == BindingState.REAUTH_REQUIRED -> "需要重新绑定" to palette.status.warning
        status.bindingState == BindingState.REVOKED -> "设备已撤销" to palette.status.error
        status.bindingState == BindingState.FATAL_INCOMPATIBLE -> "版本不兼容" to palette.status.error
        status.isRunning -> "同步中" to palette.brand.accent
        status.pendingCount > 0 -> "待同步 " + status.pendingCount to palette.status.pendingSync
        status.lastError != null -> status.lastError.code.take(22) to palette.status.error
        status.lastSuccessAt != null -> "已同步" to palette.status.success
        else -> "未同步" to palette.status.offline
    }
    Surface(
        modifier = modifier,
        color = color.copy(alpha = 0.16f),
        contentColor = palette.onBackground,
        shape = RoundedCornerShape(ZephyrRadius.pill),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = ZephyrSpacing.md, vertical = ZephyrSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ZephyrSpacing.xs),
        ) {
            Spacer(
                Modifier
                    .size(8.dp)
                    .clip(RoundedCornerShape(ZephyrRadius.pill))
                    .background(color),
            )
            Text(text, style = ZephyrTextStyles.tabularNumeric)
        }
    }
}

@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier) {
    Text(
        text = title.uppercase(),
        style = ZephyrTextStyles.section,
        color = ZephyrTheme.palette.onFloatingSubtle,
        modifier = modifier.padding(
            start = ZephyrSpacing.lg,
            end = ZephyrSpacing.lg,
            top = ZephyrSpacing.lg,
            bottom = ZephyrSpacing.sm,
        ),
    )
}

@Composable
fun MonoEndpoint(host: String, port: Int, modifier: Modifier = Modifier) {
    Text(
        text = host + ":" + port,
        style = ZephyrTextStyles.monoHost,
        color = ZephyrTheme.palette.onFloatingMuted,
        modifier = modifier,
    )
}
