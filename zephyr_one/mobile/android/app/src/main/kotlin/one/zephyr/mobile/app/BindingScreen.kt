package one.zephyr.mobile.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import one.zephyr.mobile.app.binding.BindingAuthenticationResult
import one.zephyr.mobile.app.binding.BindingCompletionResult
import one.zephyr.mobile.app.binding.CompleteBindingRequest
import one.zephyr.mobile.app.di.AppContainer
import one.zephyr.mobile.model.NetworkPolicy
import one.zephyr.mobile.model.ServerProfile
import one.zephyr.mobile.model.TlsPolicy
import one.zephyr.mobile.ui.chrome.PushedPageHeader
import one.zephyr.mobile.ui.theme.ZephyrSpacing
import one.zephyr.mobile.ui.theme.ZephyrTheme
import java.util.UUID

private enum class BindStep { SERVER, CREDENTIALS, TOTP, TOKEN, WORKING }

@Composable
fun BindingScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onBound: () -> Unit,
    onMessage: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(BindStep.SERVER) }
    var baseUrl by remember { mutableStateOf("https://") }
    var displayName by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var tokenId by remember { mutableStateOf("") }
    var tokenName by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf("Zephyr One") }
    var intervalSec by remember { mutableStateOf("300") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }

    fun fail(message: String) {
        busy = false
        status = message
        onMessage(message)
    }

    Column(Modifier.fillMaxSize()) {
        PushedPageHeader(title = "连接服务器", onBack = onBack)
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = ZephyrSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(ZephyrSpacing.md),
        ) {
            Text(
                "绑定 Zephyr 主端后才能同步。本地工作区里的连接和笔记会保留在本机，不会自动上传。",
                color = ZephyrTheme.palette.onFloatingMuted,
                fontSize = 13.sp,
            )
            if (status.isNotBlank()) {
                Text(status, color = ZephyrTheme.palette.status.warning, fontSize = 13.sp)
            }
            when (step) {
                BindStep.SERVER -> {
                    OutlinedTextField(baseUrl, { baseUrl = it.trim() }, label = { Text("服务器地址（HTTPS）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(displayName, { displayName = it }, label = { Text("显示名（可选）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    Button(
                        onClick = {
                            val url = baseUrl.trim().trimEnd('/')
                            if (!url.startsWith("https://") || url.length < 12) {
                                fail("只接受 https:// 地址")
                                return@Button
                            }
                            step = BindStep.CREDENTIALS
                            status = ""
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("下一步") }
                }
                BindStep.CREDENTIALS -> {
                    OutlinedTextField(username, { username = it }, label = { Text("账号") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(
                        password,
                        { password = it },
                        label = { Text("密码") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    )
                    Button(
                        enabled = !busy && username.isNotBlank() && password.isNotBlank(),
                        onClick = {
                            busy = true
                            status = "正在验证…"
                            scope.launch {
                                val profile = ServerProfile(
                                    id = UUID.randomUUID().toString(),
                                    baseUrl = baseUrl.trim().trimEnd('/'),
                                    displayName = displayName.ifBlank { baseUrl.trim() },
                                    tlsPolicy = TlsPolicy.SystemTrust,
                                    createdAt = System.currentTimeMillis(),
                                    lastUsedAt = null,
                                )
                                when (val result = container.bindingCoordinator.login(profile, username, password.toCharArray())) {
                                    is BindingAuthenticationResult.Authenticated -> {
                                        busy = false
                                        status = "已登录 ${result.username}"
                                        step = BindStep.TOKEN
                                    }
                                    BindingAuthenticationResult.TotpRequired -> {
                                        busy = false
                                        status = "需要 TOTP"
                                        step = BindStep.TOTP
                                    }
                                    BindingAuthenticationResult.PasswordChangeRequired -> fail("主端要求先改默认密码，请在主端完成后再绑定")
                                    is BindingAuthenticationResult.Failed -> fail(result.error.message)
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (busy) "验证中…" else "登录") }
                }
                BindStep.TOTP -> {
                    OutlinedTextField(
                        totp,
                        { totp = it.filter(Char::isDigit).take(8) },
                        label = { Text("TOTP 动态码") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    Button(
                        enabled = !busy && totp.length >= 6,
                        onClick = {
                            busy = true
                            scope.launch {
                                when (val result = container.bindingCoordinator.verifyTotp(totp.toCharArray())) {
                                    is BindingAuthenticationResult.Authenticated -> {
                                        busy = false
                                        status = "已登录 ${result.username}"
                                        step = BindStep.TOKEN
                                    }
                                    BindingAuthenticationResult.TotpRequired -> fail("验证码无效")
                                    BindingAuthenticationResult.PasswordChangeRequired -> fail("主端要求先改默认密码")
                                    is BindingAuthenticationResult.Failed -> fail(result.error.message)
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("验证 TOTP") }
                }
                BindStep.TOKEN -> {
                    Text("Client Token 必须先在主端创建。绑定会消费一次敏感验证（密码或 TOTP）。", color = ZephyrTheme.palette.onFloatingMuted, fontSize = 12.sp)
                    OutlinedTextField(tokenId, { tokenId = it.trim() }, label = { Text("Token ID") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(tokenName, { tokenName = it }, label = { Text("Token 名称（本机标签）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(deviceName, { deviceName = it }, label = { Text("设备名") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(intervalSec, { intervalSec = it.filter(Char::isDigit) }, label = { Text("同步间隔（秒）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(
                        password,
                        { password = it },
                        label = { Text("再次输入密码或 TOTP 以完成敏感验证") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                    )
                    Button(
                        enabled = !busy && tokenId.isNotBlank() && deviceName.isNotBlank() && password.isNotBlank(),
                        onClick = {
                            busy = true
                            status = "正在绑定…"
                            step = BindStep.WORKING
                            scope.launch {
                                val interval = intervalSec.toIntOrNull()?.coerceIn(30, 86_400) ?: 300
                                when (
                                    val result = container.bindingCoordinator.completeBinding(
                                        CompleteBindingRequest(
                                            deviceName = deviceName.trim().ifBlank { "Zephyr One" },
                                            tokenId = tokenId.trim(),
                                            tokenName = tokenName.trim().ifBlank { tokenId.trim() },
                                            automaticEnabled = true,
                                            intervalSec = interval,
                                            networkPolicy = NetworkPolicy.ANY,
                                        ),
                                        verificationSecret = password.toCharArray(),
                                    )
                                ) {
                                    is BindingCompletionResult.Completed -> {
                                        busy = false
                                        onMessage(if (result.bootstrapSucceeded) "已绑定并完成首次同步" else "已绑定，首次同步未完成，可稍后点立即同步")
                                        onBound()
                                    }
                                    BindingCompletionResult.AuthenticationRequired -> {
                                        busy = false
                                        step = BindStep.CREDENTIALS
                                        fail("会话已过期，请重新登录")
                                    }
                                    is BindingCompletionResult.Failed -> {
                                        busy = false
                                        step = BindStep.TOKEN
                                        fail(result.error.message)
                                    }
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("绑定并同步") }
                }
                BindStep.WORKING -> Text("正在写入设备密钥并拉取镜像…")
            }
        }
    }
}
