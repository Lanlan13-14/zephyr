//! System unlock only — never invent an app password.
//!
//! Product rules:
//! - Optional local setting "启动时要求系统解锁" (default OFF) lives in One shell.
//! - When ON, entry must go through OS authenticators:
//!   - Android: BiometricPrompt (DEVICE_CREDENTIAL | BIOMETRIC)
//!   - iOS / macOS: LocalAuthentication `.deviceOwnerAuthentication`
//!   - Windows: Windows Hello / UserConsentVerifier
//!   - Linux: no portable standard; report unavailable unless a real agent is wired
//! - If OS unlock is unavailable, `unlock` returns ok=false. Callers must NOT bypass.
//!
//! Current build: capability probe is honest per OS; `unlock` is a hook that
//! MUST be replaced with real platform prompts before store release. Until then
//! it returns ok=false with a clear error so the UI cannot silently "unlock".

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCapabilities {
    pub available: bool,
    pub biometry: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn capabilities() -> AuthCapabilities {
    #[cfg(target_os = "android")]
    {
        // Platform supports BiometricPrompt; real invoke still required in unlock().
        return AuthCapabilities {
            available: true,
            biometry: true,
            reason: "Android BiometricPrompt / 设备凭据（需系统已配置锁屏）".into(),
        };
    }
    #[cfg(target_os = "ios")]
    {
        return AuthCapabilities {
            available: true,
            biometry: true,
            reason: "iOS LocalAuthentication（Face ID / Touch ID / 密码）".into(),
        };
    }
    #[cfg(target_os = "macos")]
    {
        return AuthCapabilities {
            available: true,
            biometry: true,
            reason: "macOS LocalAuthentication（Touch ID / 密码）".into(),
        };
    }
    #[cfg(target_os = "windows")]
    {
        return AuthCapabilities {
            available: true,
            biometry: true,
            reason: "Windows Hello / 设备凭据".into(),
        };
    }
    #[cfg(target_os = "linux")]
    {
        return AuthCapabilities {
            available: false,
            biometry: false,
            reason: "Linux 无统一系统解锁 API；当前构建不可用".into(),
        };
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "ios",
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        AuthCapabilities {
            available: false,
            biometry: false,
            reason: "unsupported platform".into(),
        }
    }
}

/// Prompt the OS authenticator. Does not collect app passwords.
///
/// SECURITY: Until real platform plugins are linked, this returns failure
/// rather than a fake success. Enabling "require unlock" without a working
/// OS path correctly blocks entry.
pub fn unlock(reason: &str) -> UnlockResult {
    let caps = capabilities();
    if !caps.available {
        return UnlockResult {
            ok: false,
            method: None,
            error: Some(caps.reason),
        };
    }

    let _ = reason;

    // TODO(store): replace with real OS calls:
    // - Android: androidx.biometric.BiometricPrompt
    // - Apple: LAContext.evaluatePolicy(.deviceOwnerAuthentication, ...)
    // - Windows: UserConsentVerifier.RequestVerificationAsync
    //
    // Dev/debug escape hatch only when explicitly compiled with feature.
    #[cfg(feature = "dev-system-unlock-bypass")]
    {
        return UnlockResult {
            ok: true,
            method: Some("dev-system-unlock-bypass".into()),
            error: None,
        };
    }

    #[cfg(not(feature = "dev-system-unlock-bypass"))]
    {
        UnlockResult {
            ok: false,
            method: None,
            error: Some(
                "系统解锁接口尚未接入真实 OS 认证（BiometricPrompt / LocalAuthentication / Windows Hello）。\
请保持「启动时要求系统解锁」关闭，或在后续版本启用平台插件后再打开。"
                    .into(),
            ),
        }
    }
}
