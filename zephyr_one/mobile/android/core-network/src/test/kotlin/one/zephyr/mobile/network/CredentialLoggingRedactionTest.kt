package one.zephyr.mobile.network

import one.zephyr.mobile.network.dto.BindResponseDto
import one.zephyr.mobile.network.dto.DeviceDto
import one.zephyr.mobile.network.dto.AuthUserDto
import one.zephyr.mobile.network.dto.LoginRequestDto
import one.zephyr.mobile.network.dto.LoginResponseDto
import one.zephyr.mobile.network.dto.RefreshRequestDto
import one.zephyr.mobile.network.dto.RefreshResponseDto
import one.zephyr.mobile.network.dto.TotpRequestDto
import org.junit.Assert.assertFalse
import org.junit.Test

class CredentialLoggingRedactionTest {

    @Test
    fun `secret bearing DTO strings are redacted`() {
        val secret = "must-not-reach-a-log"
        val device = DeviceDto(
            deviceId = "device",
            ownerUserId = "user",
            deviceName = "Phone",
            platform = "android",
            appVersion = "test",
            tokenId = "token",
            enabled = true,
            automaticEnabled = true,
            syncIntervalSec = 300,
            createdAt = 1L,
        )
        val values = listOf(
            LoginRequestDto("alice", secret, captchaToken = secret, returnSid = true),
            LoginResponseDto(ok = true, requireTotp = true, tempToken = secret),
            LoginResponseDto(
                ok = true,
                sid = secret,
                user = AuthUserDto("user", "alice"),
                mustChangePassword = false,
            ),
            TotpRequestDto(tempToken = secret, code = secret, returnSid = true),
            RefreshRequestDto("device", secret),
            BindResponseDto(
                ok = true,
                device = device,
                accessCredential = secret,
                accessExpiresAt = 100L,
                refreshCredential = secret,
                registryHash = "registry",
                bootstrapRequired = true,
            ),
            RefreshResponseDto(
                ok = true,
                device = device,
                accessCredential = secret,
                accessExpiresAt = 100L,
                refreshCredential = secret,
                registryHash = "registry",
            ),
        )

        for (value in values) assertFalse(value.toString().contains(secret))
    }
}
