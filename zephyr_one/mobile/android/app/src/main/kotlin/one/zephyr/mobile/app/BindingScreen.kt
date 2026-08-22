package one.zephyr.mobile.app

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import one.zephyr.mobile.ui.component.Button
import one.zephyr.mobile.ui.component.OutlinedTextField
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
import one.zephyr.mobile.app.binding.BindingCompletionResult
import one.zephyr.mobile.app.binding.BindingCoordinator
import one.zephyr.mobile.app.di.AppContainer
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
            prepared?.identity?.wipe()
        }
    }

    LaunchedEffect(prepared, step) {
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
                        when (
                            val result = container.bindingCoordinator.consumePreparedEnrollment(
                                prepared = current,
                                intervalSec = 300,
                                automaticEnabled = true,
                                networkPolicy = NetworkPolicy.ANY,
                            )
                        ) {
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
        PushedPageHeader(title = "文件同步", onBack = onBack)
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
                Text(status, color = ZephyrTheme.palette.status.warning, fontSize = 13.sp)
            }
            when (step) {
                BindStep.SERVER -> {
                    OutlinedTextField(
                        baseUrl,
                        { baseUrl = it.trim() },
                        label = { Text("服务器地址（HTTPS）") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        displayName,
                        { displayName = it },
                        label = { Text("显示名（可选）") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        deviceName,
                        { deviceName = it },
                        label = { Text("设备名") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
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
                                    tlsPolicy = TlsPolicy.SystemTrust,
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
                BindStep.WORKING -> Text("正在写入设备密钥并拉取镜像…")
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
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (qrBitmap != null) {
            Image(
                bitmap = qrBitmap.asImageBitmap(),
                contentDescription = "绑定二维码",
                modifier = Modifier
                    .size(196.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(palette.surfaces.content)
                    .padding(10.dp),
                contentScale = ContentScale.Fit,
            )
        }
        Text("短码", color = palette.onFloatingMuted, fontSize = 12.sp)
        Text(userCode, fontSize = 28.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
        Text("安全码 SAS", color = palette.onFloatingMuted, fontSize = 12.sp)
        Text(sas, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
        Text(
            "指纹 " + fingerprint.take(16),
            color = palette.onFloatingSubtle,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
        )
        Button(onClick = onOpenBrowser, modifier = Modifier.fillMaxWidth()) {
            Text("在系统浏览器批准")
        }
        Text(
            "登录、Passkey、TOTP 和验证码都在系统浏览器完成。One 不会保存账号密码。",
            color = palette.onFloatingMuted,
            fontSize = 12.5.sp,
        )
        TextButton(onClick = onCancel) { Text("取消绑定") }
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
