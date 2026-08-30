package one.zephyr.mobile.app

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import one.zephyr.mobile.ui.component.Button
import one.zephyr.mobile.ui.component.CircularProgressIndicator
import one.zephyr.mobile.ui.component.FieldRow
import one.zephyr.mobile.ui.component.GroupCard
import one.zephyr.mobile.ui.component.HorizontalDivider
import one.zephyr.mobile.ui.component.Switch
import one.zephyr.mobile.ui.component.Text
import one.zephyr.mobile.ui.component.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import one.zephyr.mobile.app.binding.BindingCompletionResult
import one.zephyr.mobile.app.binding.BindingCoordinator
import one.zephyr.mobile.app.di.AppContainer
import one.zephyr.mobile.model.MobileError
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.network.ApiResult
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.util.UUID

private enum class BindStep { SERVER, WAITING, WORKING }

@Composable
fun BindingScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onBound: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var step by remember { mutableStateOf(BindStep.SERVER) }
    var baseUrl by remember { mutableStateOf("https://") }
    var displayName by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf("Zephyr One") }
    var allowInsecureTls by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var prepared by remember { mutableStateOf<BindingCoordinator.PreparedEnrollment?>(null) }

    fun fail(message: String) {
        busy = false
        status = message
        onMessage(message)
    }

    DisposableEffect(Unit) {
        onDispose {
            // PendingDeviceIdentity becomes a no-op after the coordinator commits ownership to the
            // durable account graph, so screen disposal is safe on both cancellation and success.
            prepared?.identity?.wipe()
        }
    }

    // NOTE: only `prepared` may be a key here. `step` must NOT be: the loop itself sets
    // step = WORKING on approval, and a key change cancels this coroutine mid-flight —
    // killing the consume/bootstrap work silently and leaving the screen spinning on
    // WORKING forever with no error. That was the actual cause of the endless spinner.
    LaunchedEffect(prepared) {
        val current = prepared ?: return@LaunchedEffect
        if (step != BindStep.WAITING) return@LaunchedEffect
        while (true) {
            delay(current.created.pollMinIntervalMs.coerceAtLeast(800L))
            when (val poll = container.bindingCoordinator.pollEnrollment(current)) {
                is ApiResult.Failure -> {
                    if (poll.error.code == "enrollment_expired") {
                        fail("绑定请求已过期，请重新开始")
                        current.identity.wipe()
                        prepared = null
                        step = BindStep.SERVER
                        return@LaunchedEffect
                    }
                }
                is ApiResult.Success -> when (poll.value.status) {
                    "approved" -> {
                        step = BindStep.WORKING
                        status = "主端已批准，正在完成本机绑定…"
                        val result = try {
                            // Hard ceiling on the whole completion path. OkHttp's callTimeout is
                            // 120s and execute() is not cancellable, so this must fire first —
                            // otherwise the coroutine times out but the HTTP call keeps running
                            // and the result is never delivered to the UI.
                            withTimeout(45_000) {
                                container.bindingCoordinator.consumePreparedEnrollment(
                                    prepared = current,
                                    intervalSec = 300,
                                    automaticEnabled = true,
                                    networkPolicy = NetworkPolicy.ANY,
                                )
                            }
                        } catch (timeout: kotlinx.coroutines.TimeoutCancellationException) {
                            BindingCompletionResult.Failed(
                                MobileError.local(
                                    "bind_completion_timeout",
                                    "完成绑定超时（45 秒），请检查手机能否访问服务器后重试",
                                ),
                            )
                        }
                        when (result) {
                            is BindingCompletionResult.Completed -> {
                                onMessage(
                                    if (result.bootstrapSucceeded) "已绑定并完成首次同步"
                                    else "已绑定，首次同步未完成，可稍后点立即同步",
                                )
                                prepared = null
                                onBound()
                                return@LaunchedEffect
                            }
                            BindingCompletionResult.AuthenticationRequired -> fail("绑定会话已失效，请重试")
                            is BindingCompletionResult.Failed -> {
                                if (result.error.code == "enrollment_not_approved") {
                                    step = BindStep.WAITING
                                    status = "还在等待主端批准…"
                                } else {
                                    fail(result.error.message)
                                    current.identity.wipe()
                                    prepared = null
                                    step = BindStep.SERVER
                                    return@LaunchedEffect
                                }
                            }
                        }
                    }
                    "denied" -> {
                        fail("主端拒绝了这台设备")
                        current.identity.wipe()
                        prepared = null
                        step = BindStep.SERVER
                        return@LaunchedEffect
                    }
                    "expired", "consumed" -> {
                        fail("绑定请求已失效，请重新开始")
                        current.identity.wipe()
                        prepared = null
                        step = BindStep.SERVER
                        return@LaunchedEffect
                    }
                }
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "Zephyr Link", onBack = onBack)
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(ZephyrSpacing.md),
        ) {
            Text(
                "绑定 Zephyr 主端后才能同步账号数据。本机工作区里的连接和笔记会保留，不会自动上传。批准在系统浏览器完成，One 不保存账号密码、TOTP 或 Passkey。",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 13.sp,
            )
            if (status.isNotBlank()) {
                GroupCard {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        // status.warning is a bare yellow: unreadable on the light palette's
                        // near-white surfaces. In-progress copy is neutral muted; it is a
                        // step description, not an alert.
                        Text(
                            status,
                            color = ZephyrTheme.palette.onFloatingMuted,
                            fontSize = 13.sp,
                        )
                    }
                }
            }
            when (step) {
                BindStep.SERVER -> {
                    GroupCard {
                        FieldRow(
                            label = "服务器",
                            value = baseUrl,
                            onValueChange = { baseUrl = it },
                            placeholder = "https://your-zephyr-host",
                            mono = true,
                        )
                        FieldRow(
                            label = "显示名",
                            value = displayName,
                            onValueChange = { displayName = it },
                            placeholder = "可选",
                        )
                        FieldRow(
                            label = "设备名",
                            value = deviceName,
                            onValueChange = { deviceName = it },
                            placeholder = "Zephyr One",
                            showDivider = false,
                        )
                    }
                    GroupCard {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("允许不安全的证书", fontWeight = FontWeight.Medium)
                                Text(
                                    "仅用于自签或内网证书。默认关闭，正规 CA 不要打开。",
                                    color = ZephyrTheme.palette.onFloatingMuted,
                                    fontSize = 12.sp,
                                )
                            }
                            Switch(checked = allowInsecureTls, onCheck = { allowInsecureTls = it })
                        }
                    }
                    Button(
                        enabled = !busy,
                        onClick = {
                            val url = baseUrl.trim().trimEnd('/')
                            if (!url.startsWith("https://") || url.length < 12) {
                                fail("只接受 https:// 地址")
                                return@Button
                            }
                            busy = true
                            status = "正在创建设备身份…"
                            scope.launch {
                                val profile = ServerProfile(
                                    id = UUID.randomUUID().toString(),
                                    baseUrl = url,
                                    displayName = displayName.ifBlank { url },
                                    tlsPolicy = if (allowInsecureTls) TlsPolicy.InsecureTrust else TlsPolicy.SystemTrust,
                                    createdAt = System.currentTimeMillis(),
                                    lastUsedAt = null,
                                )
                                when (
                                    val result = container.bindingCoordinator.startEnrollment(
                                        profile = profile,
                                        deviceName = deviceName.trim().ifBlank { "Zephyr One" },
                                        intervalSec = 300,
                                        networkPolicy = NetworkPolicy.ANY,
                                    )
                                ) {
                                    is ApiResult.Failure -> fail(result.error.message)
                                    is ApiResult.Success -> {
                                        busy = false
                                        prepared = result.value
                                        step = BindStep.WAITING
                                        status = "在系统浏览器批准这台设备"
                                    }
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (busy) "准备中…" else "开始绑定") }
                }
                BindStep.WAITING -> {
                    val current = prepared
                    if (current != null) {
                        EnrollmentWaitingCard(
                            userCode = current.created.userCode,
                            sas = current.created.sas,
                            fingerprint = current.created.fingerprint,
                            qrDataUrl = current.created.qrDataUrl,
                            onOpenBrowser = {
                                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(current.created.verificationUri)).apply {
                                    addCategory(Intent.CATEGORY_BROWSABLE)
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                                runCatching { context.startActivity(intent) }
                                    .onFailure { fail("无法打开系统浏览器") }
                            },
                            onCancel = {
                                current.identity.wipe()
                                prepared = null
                                step = BindStep.SERVER
                                status = ""
                            },
                        )
                    }
                }
                BindStep.WORKING -> {
                    GroupCard {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                            )
                            Text(
                                "正在写入设备密钥并同步账号数据…",
                                color = ZephyrTheme.palette.onBackground,
                                fontSize = 14.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EnrollmentWaitingCard(
    userCode: String,
    sas: String,
    fingerprint: String,
    qrDataUrl: String?,
    onOpenBrowser: () -> Unit,
    onCancel: () -> Unit,
) {
    val palette = ZephyrTheme.palette
    val qrBitmap = remember(qrDataUrl) { decodeQr(qrDataUrl) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (qrBitmap != null) {
            GroupCard {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Image(
                        bitmap = qrBitmap.asImageBitmap(),
                        contentDescription = "绑定二维码",
                        modifier = Modifier
                            .size(200.dp)
                            .clip(RoundedCornerShape(12.dp)),
                        contentScale = ContentScale.Fit,
                    )
                }
            }
        }
        GroupCard {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("短码", color = palette.onFloatingMuted, fontSize = 12.sp)
                Text(
                    userCode,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 2.sp,
                    color = palette.onBackground,
                )
            }
            HorizontalDivider(Modifier.padding(horizontal = 14.dp))
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("安全码 SAS", color = palette.onFloatingMuted, fontSize = 12.sp)
                Text(
                    sas,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = FontFamily.Monospace,
                    color = palette.onBackground,
                )
            }
            HorizontalDivider(Modifier.padding(horizontal = 14.dp))
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("设备指纹", color = palette.onFloatingMuted, fontSize = 12.sp)
                Text(
                    fingerprint.take(24),
                    fontSize = 13.sp,
                    fontFamily = FontFamily.Monospace,
                    color = palette.onFloatingSubtle,
                )
            }
        }
        Button(onClick = onOpenBrowser, modifier = Modifier.fillMaxWidth()) {
            Text("在系统浏览器批准")
        }
        Text(
            "登录、Passkey、TOTP 和验证码都在系统浏览器完成。One 不会保存账号密码。",
            color = palette.onFloatingMuted,
            fontSize = 12.5.sp,
        )
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            TextButton(onClick = onCancel) { Text("取消绑定") }
        }
    }
}

private fun decodeQr(dataUrl: String?): android.graphics.Bitmap? {
    if (dataUrl.isNullOrBlank()) return null
    val comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    val bytes = runCatching { Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT) }.getOrNull()
        ?: return null
    return runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull()
}
