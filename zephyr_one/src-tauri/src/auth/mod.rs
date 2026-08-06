//! System unlock — OS authenticators only, never an app-invented password.
//!
//! | Platform | Implementation |
//! |----------|----------------|
//! | Android / iOS | `tauri-plugin-biometric` (BiometricPrompt / LocalAuthentication) |
//! | macOS | LocalAuthentication via `localauthentication-rs` |
//! | Windows | UserConsentVerifier (Windows Hello / PIN) via `windows` crate |
//! | Linux | no portable system unlock; reports unavailable |
//!
//! Setting "启动时要求系统解锁" defaults OFF in the shell UI.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

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

pub fn capabilities<R: Runtime>(app: &AppHandle<R>) -> AuthCapabilities {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        use tauri_plugin_biometric::BiometricExt;
        match app.biometric().status() {
            Ok(status) => {
                if status.is_available {
                    return AuthCapabilities {
                        available: true,
                        biometry: true,
                        reason: "系统生物识别 / 设备凭据可用".into(),
                    };
                }
                // Device credential may still work when biometry not enrolled
                return AuthCapabilities {
                    available: true,
                    biometry: false,
                    reason: status
                        .error
                        .unwrap_or_else(|| "将回退到系统锁屏密码/图案".into()),
                };
            }
            Err(err) => {
                return AuthCapabilities {
                    available: false,
                    biometry: false,
                    reason: format!("生物识别插件不可用: {err}"),
                };
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return AuthCapabilities {
            available: true,
            biometry: true,
            reason: "macOS LocalAuthentication（Touch ID / 密码）".into(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return AuthCapabilities {
            available: true,
            biometry: true,
            reason: "Windows Hello / 设备 PIN".into(),
        };
    }

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return AuthCapabilities {
            available: false,
            biometry: false,
            reason: "Linux 无统一系统解锁 API".into(),
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
        let _ = app;
        AuthCapabilities {
            available: false,
            biometry: false,
            reason: "unsupported platform".into(),
        }
    }
}

pub fn unlock<R: Runtime>(app: &AppHandle<R>, reason: &str) -> UnlockResult {
    #[cfg(feature = "dev-system-unlock-bypass")]
    {
        let _ = (app, reason);
        return UnlockResult {
            ok: true,
            method: Some("dev-system-unlock-bypass".into()),
            error: None,
        };
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        use tauri_plugin_biometric::{AuthOptions, BiometricExt};
        let options = AuthOptions {
            allow_device_credential: true,
            cancel_title: Some("取消".into()),
            fallback_title: Some("使用设备密码".into()),
            title: Some("Zephyr One".into()),
            subtitle: Some(reason.to_string()),
            confirmation_required: Some(false),
        };
        return match app.biometric().authenticate(reason.to_string(), options) {
            Ok(()) => UnlockResult {
                ok: true,
                method: Some("system_biometric_or_device_credential".into()),
                error: None,
            },
            Err(err) => UnlockResult {
                ok: false,
                method: None,
                error: Some(err.to_string()),
            },
        };
    }

    #[cfg(target_os = "macos")]
    {
        return unlock_macos(reason);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return unlock_windows(reason);
    }

    #[cfg(target_os = "linux")]
    {
        let _ = (app, reason);
        return UnlockResult {
            ok: false,
            method: None,
            error: Some("Linux 当前不支持系统解锁，请保持开关关闭".into()),
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
        let _ = (app, reason);
        UnlockResult {
            ok: false,
            method: None,
            error: Some("unsupported platform".into()),
        }
    }
}

#[cfg(target_os = "macos")]
fn unlock_macos(reason: &str) -> UnlockResult {
    // LocalAuthentication: deviceOwnerAuthentication allows biometry + password.
    use localauthentication_rs::{LAPolicy, LocalAuthentication};
    let la = LocalAuthentication::new();
    // DeviceOwnerAuthentication allows biometry + watch + account password.
    let policy = LAPolicy::DeviceOwnerAuthentication;
    // crate may only export DeviceOwnerAuthenticationWithBiometrics on some versions;
    // evaluate_policy accepts LAPolicy.
    let ok = la.evaluate_policy(policy, reason);
    if ok {
        UnlockResult {
            ok: true,
            method: Some("localauthentication".into()),
            error: None,
        }
    } else {
        UnlockResult {
            ok: false,
            method: None,
            error: Some("macOS 系统解锁失败或已取消".into()),
        }
    }
}

#[cfg(target_os = "windows")]
fn unlock_windows(reason: &str) -> UnlockResult {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier,
    };
    let msg = HSTRING::from(reason);
    match UserConsentVerifier::RequestVerificationAsync(&msg) {
        Ok(op) => match op.get() {
            Ok(UserConsentVerificationResult::Verified) => UnlockResult {
                ok: true,
                method: Some("windows_hello".into()),
                error: None,
            },
            Ok(other) => UnlockResult {
                ok: false,
                method: None,
                error: Some(format!("Windows Hello 结果: {other:?}")),
            },
            Err(e) => UnlockResult {
                ok: false,
                method: None,
                error: Some(format!("Windows Hello 错误: {e}")),
            },
        },
        Err(e) => UnlockResult {
            ok: false,
            method: None,
            error: Some(format!("无法启动 Windows Hello: {e}")),
        },
    }
}
