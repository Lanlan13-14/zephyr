//! System unlock — OS authenticators only, never an app-invented password.
//!
//! | Platform | Implementation |
//! |----------|----------------|
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

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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
    // Verified against the published localauthentication-rs 0.1.0 crate source:
    //   LocalAuthentication::new() -> Self                          (src/lib.rs:42)
    //   can_evaluate_policy(&self, LAPolicy) -> bool                (src/lib.rs:75)
    //   evaluate_policy(&self, LAPolicy, &str) -> bool              (src/lib.rs:116)
    //   LAPolicy::DeviceOwnerAuthentication                         (src/lib.rs:129)
    use localauthentication_rs::{LAPolicy, LocalAuthentication};
    let la = LocalAuthentication::new();
    // DeviceOwnerAuthentication = biometry OR Apple Watch OR account password;
    // the biometrics-only policy would lock out Macs without Touch ID.
    let policy = LAPolicy::DeviceOwnerAuthentication;
    // The crate docs require checking evaluability before evaluating
    // (src/lib.rs:84); on a Mac with no password or biometry enrolled the
    // prompt could never succeed, so report that honestly.
    if !la.can_evaluate_policy(policy) {
        return UnlockResult {
            ok: false,
            method: None,
            error: Some("macOS 系统解锁不可用：未设置登录密码或生物识别".into()),
        };
    }
    // evaluate_policy BLOCKS the calling thread until the prompt resolves: the
    // Swift shim parks on a DispatchSemaphore (swift-lib/src/lib.swift:18-27).
    // Tauri runs sync commands on the main thread, which is where LAContext
    // belongs, so no extra dispatch is needed here.
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
