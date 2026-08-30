package one.zephyr.mobile.feature.connections

import one.zephyr.mobile.ui.icon.ZephyrIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import one.zephyr.mobile.ui.component.Icon
import one.zephyr.mobile.ui.component.Surface
import one.zephyr.mobile.ui.component.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import one.zephyr.mobile.model.Protocol
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.component.CleartextProtocolWarning
import one.zephyr.mobile.ui.component.pressScale
import one.zephyr.mobile.ui.theme.ZephyrRadius
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTextStyles
import one.zephyr.mobile.ui.theme.ZephyrTheme

/**
 * Demo page-conntype. New connections pick a protocol first so the editor opens with the
 * right port, sections and Telnet warning already in place.
 */
@Composable
fun ProtocolPickerScreen(
    onSelect: (Protocol) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxSize()
            .background(ZephyrTheme.palette.surfaces.background),
    ) {
        PushedPageHeader(
            title = stringResource(R.string.editor_title_create),
            onBack = onBack,
        )
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = stringResource(R.string.protocol_picker_lead),
                color = ZephyrTheme.palette.onFloatingSubtle,
                style = ZephyrTextStyles.section,
                modifier = Modifier.padding(start = 4.dp, top = 4.dp).semantics { heading() },
            )
            Protocol.entries.forEach { protocol ->
                ProtocolCard(protocol = protocol, onClick = { onSelect(protocol) })
            }
            Spacer(Modifier.height(ZephyrSpacing.xxl))
        }
    }
}

@Composable
private fun ProtocolCard(protocol: Protocol, onClick: () -> Unit) {
    val palette = ZephyrTheme.palette
    val interaction = remember { MutableInteractionSource() }
    val protocolColor = when (protocol) {
        Protocol.SSH -> palette.protocol.ssh
        Protocol.TELNET -> palette.protocol.telnet
        Protocol.RDP -> palette.protocol.rdp
        Protocol.VNC -> palette.protocol.vnc
    }
    val (title, detail) = when (protocol) {
        Protocol.SSH -> stringResource(R.string.protocol_ssh_title) to stringResource(R.string.protocol_ssh_detail)
        Protocol.TELNET -> stringResource(R.string.protocol_telnet_title) to stringResource(R.string.protocol_telnet_detail)
        Protocol.RDP -> stringResource(R.string.protocol_rdp_title) to stringResource(R.string.protocol_rdp_detail)
        Protocol.VNC -> stringResource(R.string.protocol_vnc_title) to stringResource(R.string.protocol_vnc_detail)
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .pressScale(0.98f, interaction = interaction)
            .clickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            ),
        color = palette.surfaces.content,
        shape = RoundedCornerShape(ZephyrRadius.md),
    ) {
        Row(
            Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(protocolColor.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (protocol == Protocol.TELNET) "TEL" else protocol.wireName,
                    color = protocolColor,
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.ExtraBold,
                )
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    if (protocol == Protocol.TELNET) {
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(palette.status.conflict.copy(alpha = 0.14f))
                                .padding(horizontal = 8.dp, vertical = 2.dp),
                        ) {
                            Text("未加密", color = palette.status.conflict, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                Text(detail, fontSize = 12.sp, color = palette.onFloatingSubtle)
            }
            Icon(ZephyrIcons.Chevron, contentDescription = null, tint = palette.onFloatingMuted)
        }
    }
}

fun protocolPickerCopy(protocol: Protocol): Pair<String, String> = when (protocol) {
    Protocol.SSH -> "SSH" to "安全 Shell · 支持 SFTP、代码片段、批量执行、JumpHost 多级隧道"
    Protocol.TELNET -> "Telnet" to "未加密 · 账号口令与终端内容明文传输 · 仅用于可信内网或设备 console"
    Protocol.RDP -> "RDP" to "Windows 远程桌面 · 声音/剪贴板/存储等通道重定向"
    Protocol.VNC -> "VNC" to "跨平台远程桌面 · 未知弱安全模式不自动降级"
}
