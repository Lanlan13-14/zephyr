//! Runtime window-icon theming.
//!
//! Zephyr One ships four palette icons (frost / lava / asagi / cyber) matching
//! the four colour schemes the product UI already exposes, mirroring how Zephyr
//! Agent swaps its icon with the selected theme.
//!
//! Platform reality, from tao's `Window::set_window_icon` contract:
//!   - **Windows** — sets `ICON_SMALL`: the title-bar / taskbar icon. Works.
//!   - **Linux** — GTK window icon. Works.
//!   - **macOS** — *unsupported*. There is no per-window icon; the Dock reads
//!     the bundle's `.icns`. Calling it would silently do nothing, so this
//!     module does not call it and reports `applied: false` with a reason
//!     instead of pretending. macOS therefore always shows the bundled frost
//!     icon, which is also the product default.
//!
//! The PNGs are embedded rather than shipped as Tauri resources on purpose:
//! resource-path resolution has already cost this project real bugs
//! (`resource_dir()` layout differences, the `_up_` prefix), and four 128×128
//! PNGs are a few KB each. `include_bytes!` cannot fail at runtime.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Runtime};
/* `webview_windows()` comes from the Manager trait, and the only call site is
 * the non-macOS branch below. Importing it unconditionally would warn on a
 * macOS build. */
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

/// Palette id → embedded 128×128 PNG.
///
/// 128 is deliberate: Windows derives `ICON_SMALL` (16×16 base) by downscaling,
/// and 128 is an exact multiple of both 16 and 32, so HiDPI title bars get a
/// clean integer-ratio reduction instead of a blurry one.
const ICONS: &[(&str, &[u8])] = &[
    (
        "frost",
        include_bytes!("../../runtime-icons/zephyr-one-frost.png"),
    ),
    (
        "lava",
        include_bytes!("../../runtime-icons/zephyr-one-lava.png"),
    ),
    (
        "asagi",
        include_bytes!("../../runtime-icons/zephyr-one-asagi.png"),
    ),
    (
        "cyber",
        include_bytes!("../../runtime-icons/zephyr-one-cyber.png"),
    ),
];

/// Product default, and the palette baked into the installer icon.
const DEFAULT_THEME: &str = "frost";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconResult {
    /// Whether the window icon actually changed.
    pub applied: bool,
    /// The palette resolved from the request (never empty).
    pub theme: String,
    /// Why it did not apply. Empty when `applied` is true.
    pub reason: String,
}

/// Resolve a requested palette to one that exists.
///
/// `custom` is a real colour scheme in the product UI but has no icon artwork,
/// so it — and anything unknown — falls back to the default rather than
/// erroring: an unrecognised theme must never break app startup.
fn resolve(theme: &str) -> &'static str {
    let want = theme.trim().to_ascii_lowercase();
    ICONS
        .iter()
        .find(|(name, _)| *name == want)
        .map(|(name, _)| *name)
        .unwrap_or(DEFAULT_THEME)
}

/* Only the non-macOS branch decodes artwork; the tests exercise it on every
 * platform, so this is dead only in a non-test macOS build. */
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
fn bytes_for(theme: &str) -> &'static [u8] {
    ICONS
        .iter()
        .find(|(name, _)| *name == theme)
        .map(|(_, bytes)| *bytes)
        // resolve() guarantees a hit; DEFAULT_THEME is present by construction.
        .unwrap_or(ICONS[0].1)
}

/// Apply the palette icon to every window of the app.
pub fn set_theme_icon<R: Runtime>(app: &AppHandle<R>, theme: &str) -> IconResult {
    let resolved = resolve(theme);

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return IconResult {
            applied: false,
            theme: resolved.to_string(),
            reason: "macOS 无窗口级图标，Dock 使用安装包内的凝霜蓝图标".into(),
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        let image = match tauri::image::Image::from_bytes(bytes_for(resolved)) {
            Ok(image) => image,
            Err(error) => {
                return IconResult {
                    applied: false,
                    theme: resolved.to_string(),
                    reason: format!("解码内置图标失败: {error}"),
                };
            }
        };

        let windows = app.webview_windows();
        if windows.is_empty() {
            return IconResult {
                applied: false,
                theme: resolved.to_string(),
                reason: "尚无窗口可设置图标".into(),
            };
        }

        let mut failures = Vec::new();
        for (label, window) in windows {
            if let Err(error) = window.set_icon(image.clone()) {
                failures.push(format!("{label}: {error}"));
            }
        }

        if failures.is_empty() {
            IconResult {
                applied: true,
                theme: resolved.to_string(),
                reason: String::new(),
            }
        } else {
            IconResult {
                applied: false,
                theme: resolved.to_string(),
                reason: failures.join("; "),
            }
        }
    }
}

/// Extract `settings.appearance.colorScheme` from `GET /api/me/settings`.
///
/// Kept separate from the HTTP call so the JSON contract can be tested without
/// a running core. Returns `None` when the field is absent, which the caller
/// treats as "leave the icon alone" rather than as a reason to fall back — a
/// transient shape change must not flip a themed icon back to frost.
fn scheme_from_settings_json(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .get("settings")?
        .get("appearance")?
        .get("colorScheme")?
        .as_str()
        .map(|s| s.to_string())
}

/// Poll interval for the colour-scheme watcher.
///
/// The request is a loopback GET against a local child process, so the cost is
/// negligible; 3s keeps the icon feeling responsive to a theme change without
/// being a busy loop.
const WATCH_INTERVAL: Duration = Duration::from_secs(3);

static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Track the core's effective colour scheme and keep the window icon in step.
///
/// Why polling over IPC: after the shell calls `window.location.replace()` the
/// page is served by the Node core on `http://127.0.0.1:<port>`, a *remote*
/// origin as far as Tauri's ACL is concerned. Letting that page call `invoke`
/// would mean granting a capability `remote.urls` entry — and since the port is
/// picked at runtime, the only static pattern that matches is
/// `http://127.0.0.1:*`, which would hand the IPC layer to *any* server the
/// user happens to run on loopback. Reading the core's own HTTP API from Rust
/// needs no capability at all and keeps the product's web JS free of any
/// Tauri coupling.
///
/// `GET /api/me/settings` returns the *effective* appearance (global settings
/// merged with the user's personal overrides), and the embedded core adopts the
/// local account for cookie-less requests, so no auth handling is needed here.
///
/// The base URL is re-read from `runtime::info()` every tick instead of being
/// captured, so a core restart on a fresh port is picked up automatically.
pub fn spawn_theme_watcher<R: Runtime>(app: &AppHandle<R>) {
    // macOS has no window icon at all, so polling would be pure waste.
    if cfg!(target_os = "macos") {
        return;
    }
    // `runtime_start` is callable more than once (retry after a failure); only
    // one watcher should ever exist.
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let mut current = String::new();
        loop {
            std::thread::sleep(WATCH_INTERVAL);

            let base_url = crate::runtime::info().base_url;
            if base_url.is_empty() {
                // Core stopped. Forget the applied scheme so the icon is
                // re-applied when it comes back, possibly on a new window.
                current.clear();
                continue;
            }

            let url = format!("{}/api/me/settings", base_url.trim_end_matches('/'));
            let body = match ureq::get(&url).timeout(Duration::from_secs(3)).call() {
                Ok(resp) if resp.status() == 200 => match resp.into_string() {
                    Ok(text) => text,
                    Err(_) => continue,
                },
                _ => continue,
            };

            let Some(scheme) = scheme_from_settings_json(&body) else {
                continue;
            };
            let resolved = resolve(&scheme);
            if resolved == current {
                continue;
            }

            let result = set_theme_icon(&app, resolved);
            if result.applied {
                current = resolved.to_string();
            } else {
                // Keep `current` unset so the next tick retries. A window may
                // simply not exist yet on the first pass.
                eprintln!(
                    "zephyr-one: window icon not applied (theme={}): {}",
                    result.theme, result.reason
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_palette_has_embedded_artwork() {
        // The product UI offers exactly these four palettes plus `custom`.
        for name in ["frost", "lava", "asagi", "cyber"] {
            assert_eq!(resolve(name), name, "{name} must resolve to itself");
            assert!(
                !bytes_for(name).is_empty(),
                "{name} must have embedded bytes"
            );
        }
    }

    #[test]
    fn embedded_artwork_is_png() {
        // include_bytes! cannot fail, but a build that wired up the wrong file
        // would ship something Image::from_bytes rejects at runtime.
        const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        for (name, bytes) in ICONS {
            assert!(
                bytes.starts_with(PNG_MAGIC),
                "{name} artwork must be a PNG"
            );
        }
    }

    #[test]
    fn unknown_and_custom_themes_fall_back_to_default() {
        // `custom` is a real scheme with no artwork; it must not error.
        for name in ["custom", "", "  ", "nope", "FROSTY"] {
            assert_eq!(resolve(name), DEFAULT_THEME, "{name:?} must fall back");
        }
    }

    #[test]
    fn palette_matching_is_case_insensitive_and_trims() {
        assert_eq!(resolve("  Lava "), "lava");
        assert_eq!(resolve("CYBER"), "cyber");
    }

    #[test]
    fn default_theme_is_the_bundled_one() {
        // The installer icon is generated from the frost SVG, so the fallback
        // must be frost or the window icon would disagree with the Dock/taskbar
        // icon on first launch.
        assert_eq!(DEFAULT_THEME, "frost");
        assert_eq!(ICONS[0].0, DEFAULT_THEME);
    }
}
