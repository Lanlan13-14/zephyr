use crate::auth;
use crate::fs::{self, FileStat, FsState};
use crate::icon;
use crate::rdp;
use crate::rdp_picker;
use crate::runtime;
use crate::unlock_bridge;
use crate::token::{TokenRecord, TokenState};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub family: String,
}

#[tauri::command]
pub fn get_platform() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
    }
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn auth_capabilities(app: AppHandle) -> auth::AuthCapabilities {
    auth::capabilities(&app)
}

#[tauri::command]
pub fn auth_unlock(app: AppHandle, reason: Option<String>) -> auth::UnlockResult {
    auth::unlock(&app, reason.as_deref().unwrap_or("Unlock Zephyr One"))
}

/// Swap the window icon to the palette the product UI is using.
///
/// Mirrors Zephyr Agent's theme-following icon. Windows and Linux apply it;
/// macOS has no per-window icon and keeps the bundled frost artwork, which the
/// returned `applied: false` + `reason` reports honestly instead of silently
/// doing nothing.
#[tauri::command]
pub fn set_theme_icon(app: AppHandle, theme: Option<String>) -> icon::IconResult {
    icon::set_theme_icon(&app, theme.as_deref().unwrap_or("frost"))
}

/// Start embedded Zephyr core (full product). Remote main is sync-only.
#[tauri::command]
pub async fn runtime_start(app: AppHandle) -> Result<runtime::RuntimeInfo, String> {
    // `app` is moved into the blocking closure; the watcher needs its own handle.
    let watcher_app = app.clone();
    let info = tauri::async_runtime::spawn_blocking(move || runtime::ensure_started(&app))
        .await
        .map_err(|error| format!("本地运行时任务异常退出：{error}"))??;
    /* The core is now serving, so its colour scheme is readable. Start the
     * watcher only on success: before that there is no base_url to poll, and
     * the shell may retry runtime_start after a failure (the watcher itself is
     * idempotent, so a retry cannot stack threads). */
    icon::spawn_theme_watcher(&watcher_app);
    /* RDP folder mapping needs a *native* directory dialog, and the WebView
     * showing the product UI is on a remote origin (the loopback core), so it
     * cannot invoke a Tauri command. The page therefore files a pick request
     * with the core and this watcher — which runs in the shell, where the
     * dialog is possible — claims it, opens the dialog, and posts the chosen
     * path back. Same polling shape as the theme watcher above, and idempotent
     * for the same reason. */
    rdp_picker::spawn_picker_watcher(&watcher_app);
    /* The product UI's security switch needs a real OS authenticator, and the
     * page cannot invoke a command for the same remote-origin reason as the
     * folder picker. This watcher publishes what this platform can do and then
     * serves unlock requests. Started here rather than in `setup` because it
     * needs a running core to talk to. */
    unlock_bridge::spawn_unlock_watcher(&watcher_app);
    Ok(info)
}

#[tauri::command]
pub fn runtime_info() -> runtime::RuntimeInfo {
    runtime::info()
}

#[tauri::command]
pub fn runtime_stop() {
    runtime::stop();
}

#[tauri::command]
pub fn agent_pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|p| match p.into_path() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(fp) => fp.to_string(),
    }))
}

#[tauri::command]
pub fn agent_default_share_path() -> serde_json::Value {
    let (path, name) = fs::default_share_path();
    serde_json::json!({ "path": path, "name": name })
}

fn map_fs_err(e: fs::FsError) -> String {
    format!("{}: {}", e.code(), e)
}

#[tauri::command]
pub fn agent_fs_list(
    state: State<'_, FsState>,
    root: String,
    path: String,
) -> Result<Vec<FileStat>, String> {
    state.list(&root, &path).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_stat(
    state: State<'_, FsState>,
    root: String,
    path: String,
) -> Result<FileStat, String> {
    state.stat(&root, &path).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_open(
    state: State<'_, FsState>,
    root: String,
    path: String,
    mode: String,
) -> Result<String, String> {
    state.open(&root, &path, &mode).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_read(
    state: State<'_, FsState>,
    handle: String,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    state.read(&handle, offset, length).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_write(
    state: State<'_, FsState>,
    handle: String,
    offset: u64,
    data: Vec<u8>,
) -> Result<u64, String> {
    state.write(&handle, offset, &data).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_close(state: State<'_, FsState>, handle: String) -> Result<(), String> {
    state.close(&handle).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_mkdir(
    state: State<'_, FsState>,
    root: String,
    path: String,
) -> Result<(), String> {
    state.mkdir(&root, &path).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_delete(
    state: State<'_, FsState>,
    root: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    state.delete(&root, &path, recursive).map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_rename(
    state: State<'_, FsState>,
    root: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    state
        .rename(&root, &old_path, &new_path)
        .map_err(map_fs_err)
}

#[tauri::command]
pub fn agent_fs_truncate(
    state: State<'_, FsState>,
    root: String,
    path: String,
    size: u64,
) -> Result<(), String> {
    state.truncate(&root, &path, size).map_err(map_fs_err)
}

fn ensure_token_path(app: &AppHandle, tokens: &TokenState) {
    if let Ok(dir) = app.path().app_data_dir() {
        tokens.set_path(dir.join("agent-tokens-one.json"));
    }
}

#[tauri::command]
pub fn token_list_local(app: AppHandle, tokens: State<'_, TokenState>) -> Vec<TokenRecord> {
    ensure_token_path(&app, &tokens);
    tokens.list()
}

#[tauri::command]
pub fn token_add_local(
    app: AppHandle,
    tokens: State<'_, TokenState>,
    token: String,
    name: String,
) -> Result<TokenRecord, String> {
    ensure_token_path(&app, &tokens);
    tokens.add(token, name, None)
}

#[tauri::command]
pub fn token_remove_local(
    app: AppHandle,
    tokens: State<'_, TokenState>,
    id: String,
) -> Result<(), String> {
    ensure_token_path(&app, &tokens);
    tokens.remove(&id)
}

#[tauri::command]
pub fn token_export_local(app: AppHandle, tokens: State<'_, TokenState>) -> Result<String, String> {
    ensure_token_path(&app, &tokens);
    tokens.export_json()
}

#[tauri::command]
pub fn token_import_local(
    app: AppHandle,
    tokens: State<'_, TokenState>,
    raw: String,
) -> Result<usize, String> {
    ensure_token_path(&app, &tokens);
    tokens.import_json(&raw)
}


/* -- Native RDP -------------------------------------------------------------
 *
 * FreeRDP linked into this process, replacing the Go/WASM client One inherited
 * from browser Zephyr. `native/freerdp-core` had been compiled and tested by CI
 * for a while with no consumer; these commands are that consumer.
 *
 * What deliberately does NOT appear below: any command that streams pixels to
 * JavaScript. The development spec requires the native core to emit protocol and
 * dirty rectangles while the platform layer owns the surface, and forbids
 * high-frequency frames crossing the Node core or being repainted in a Web
 * canvas. A `rdp_native_poll_frame` returning pixel bytes would rebuild exactly
 * the sidecar architecture b0e5a9c removed. Frames therefore stay inside Rust,
 * behind `rdp::FrameSink`; what crosses to the UI is session *state* --
 * connected, resized, channel up, certificate fingerprint, frame counters.
 */

/// Session-scoped sink that keeps counters and a bounded event log.
///
/// Events reach the UI by being read through `rdp_native_session_state` rather
/// than pushed: an emit per event would put clipboard text and cursor motion on
/// the IPC channel at input frequency, and the UI only ever renders the latest
/// state anyway.
pub type NativeRdpSinks =
    parking_lot::Mutex<std::collections::HashMap<String, std::sync::Arc<rdp::RecordingSink>>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpCapabilities {
    /// False when this binary was built with ZEPHYR_ONE_SKIP_NATIVE_RDP=1.
    pub available: bool,
    /// FreeRDP major version linked in, or null when unavailable.
    pub freerdp_major: Option<i32>,
    /// Why, when unavailable. Empty when it is.
    pub reason: String,
}

#[tauri::command]
pub fn rdp_native_capabilities() -> RdpCapabilities {
    let available = rdp::is_available();
    RdpCapabilities {
        available,
        freerdp_major: rdp::freerdp_major(),
        reason: if available {
            String::new()
        } else {
            /* Named precisely rather than "unavailable": the UI must be able to
             * tell the user this is a build-time choice, not a runtime failure
             * they can retry. */
            "\u{6b64}\u{7248}\u{672c}\u{672a}\u{7f16}\u{8bd1}\u{539f}\u{751f} RDP \u{5f15}\u{64ce}\u{ff08}ZEPHYR_ONE_SKIP_NATIVE_RDP=1\u{ff09}".to_string()
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpFolderCheck {
    pub ok: bool,
    /// Stable code the UI maps to a specific message: a missing path means the
    /// user never picked a folder, a bad name is a different fix entirely.
    pub code: String,
    pub message: String,
}

/// Check a folder mapping before connecting.
///
/// Separate command because `freerdp_client_add_device_channel` stats the path
/// and fails the *entire* settings assembly when it is gone, so a folder that was
/// valid when picked but has since been unmounted would otherwise surface as a
/// generic connect failure.
#[tauri::command]
pub fn rdp_native_validate_folder(name: String, path: String) -> RdpFolderCheck {
    match rdp::validate_drive(&name, &path) {
        Ok(()) => RdpFolderCheck {
            ok: true,
            code: String::new(),
            message: String::new(),
        },
        Err(error) => RdpFolderCheck {
            ok: false,
            code: error.code().to_string(),
            message: error.to_string(),
        },
    }
}

/// What the product UI sends to open a session.
///
/// Field names match the saved connection record so the page does not have to
/// translate; `Option` on the toggles means "leave at the engine default" rather
/// than silently forcing false, which would disable clipboard and dynamic
/// resolution for every caller that omitted them.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConnectRequest {
    pub session_id: String,
    pub host: String,
    pub port: Option<u32>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub domain: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub security: Option<String>,
    pub ignore_certificate: Option<bool>,
    pub audio_mode: Option<String>,
    pub microphone: Option<bool>,
    pub clipboard: Option<bool>,
    pub folder_name: Option<String>,
    pub folder_path: Option<String>,
    pub folder_read_only: Option<bool>,
    pub dynamic_resolution: Option<bool>,
    pub gfx: Option<bool>,
    pub disable_wallpaper: Option<bool>,
    pub disable_themes: Option<bool>,
    pub disable_menu_anims: Option<bool>,
    pub disable_full_window_drag: Option<bool>,
    pub allow_font_smoothing: Option<bool>,
}

impl RdpConnectRequest {
    fn into_config(self) -> Result<(String, rdp::Config), String> {
        let session_id = self.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("\u{7f3a}\u{5c11}\u{4f1a}\u{8bdd} id".to_string());
        }
        if self.host.trim().is_empty() {
            return Err("\u{4e3b}\u{673a}\u{4e0d}\u{80fd}\u{4e3a}\u{7a7a}".to_string());
        }

        let defaults = rdp::Config::default();

        /* An unrecognised security or audio spelling is refused rather than
         * defaulted. Defaulting `security: "plaintxet"` to Auto would silently
         * negotiate something weaker than the user asked for, which is the one
         * mistake in this struct that must never be quiet. */
        let security = match self.security.as_deref() {
            None => defaults.security,
            Some(value) => rdp::Security::parse(value)
                .ok_or_else(|| format!("\u{65e0}\u{6cd5}\u{8bc6}\u{522b}\u{7684} RDP \u{5b89}\u{5168}\u{6a21}\u{5f0f}\u{ff1a}{value}"))?,
        };
        let audio = match self.audio_mode.as_deref() {
            None => defaults.audio,
            Some(value) => rdp::AudioMode::parse(value)
                .ok_or_else(|| format!("\u{65e0}\u{6cd5}\u{8bc6}\u{522b}\u{7684}\u{97f3}\u{9891}\u{6a21}\u{5f0f}\u{ff1a}{value}"))?,
        };

        Ok((
            session_id,
            rdp::Config {
                host: self.host.trim().to_string(),
                port: self.port.unwrap_or(defaults.port),
                username: self.username.unwrap_or_default(),
                password: self.password.unwrap_or_default(),
                domain: self.domain.unwrap_or_default(),
                width: self.width.unwrap_or(defaults.width),
                height: self.height.unwrap_or(defaults.height),
                color_depth: defaults.color_depth,
                security,
                ignore_certificate: self
                    .ignore_certificate
                    .unwrap_or(defaults.ignore_certificate),
                audio,
                microphone: self.microphone.unwrap_or(defaults.microphone),
                clipboard: self.clipboard.unwrap_or(defaults.clipboard),
                drive_name: self.folder_name.unwrap_or_default(),
                drive_path: self.folder_path.unwrap_or_default(),
                drive_read_only: self.folder_read_only.unwrap_or(defaults.drive_read_only),
                dynamic_resolution: self
                    .dynamic_resolution
                    .unwrap_or(defaults.dynamic_resolution),
                gfx: self.gfx.unwrap_or(defaults.gfx),
                disable_wallpaper: self.disable_wallpaper.unwrap_or(defaults.disable_wallpaper),
                disable_themes: self.disable_themes.unwrap_or(defaults.disable_themes),
                disable_menu_anims: self
                    .disable_menu_anims
                    .unwrap_or(defaults.disable_menu_anims),
                disable_full_window_drag: self
                    .disable_full_window_drag
                    .unwrap_or(defaults.disable_full_window_drag),
                allow_font_smoothing: self
                    .allow_font_smoothing
                    .unwrap_or(defaults.allow_font_smoothing),
            },
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpConnectResult {
    pub session_id: String,
    /// True once the loop thread is running. Deliberately not "connected": the
    /// connect happens inside the blocking loop, so claiming success here would
    /// show a live tab for a session that is still negotiating, or that failed.
    pub started: bool,
}

fn rdp_err(error: rdp::Error) -> String {
    format!("{}: {}", error.code(), error)
}

#[tauri::command]
pub fn rdp_native_connect(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    sinks: State<'_, NativeRdpSinks>,
    request: RdpConnectRequest,
) -> Result<RdpConnectResult, String> {
    let (session_id, config) = request.into_config()?;

    /* Reject a duplicate id instead of silently replacing: the old session's
     * thread would keep running with nothing able to stop it, which is a leaked
     * connection to a remote machine. */
    if registry.get(&session_id).is_some() {
        return Err(format!("rdp_session_exists: \u{4f1a}\u{8bdd} {session_id} \u{5df2}\u{5b58}\u{5728}"));
    }

    let sink = std::sync::Arc::new(rdp::RecordingSink::default());
    registry
        .start(&session_id, config, sink.clone())
        .map_err(rdp_err)?;
    sinks.lock().insert(session_id.clone(), sink);

    Ok(RdpConnectResult {
        session_id,
        started: true,
    })
}

#[tauri::command]
pub fn rdp_native_disconnect(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    sinks: State<'_, NativeRdpSinks>,
    session_id: String,
) -> bool {
    let closed = registry.close(&session_id);
    sinks.lock().remove(&session_id);
    closed
}

#[tauri::command]
pub fn rdp_native_sessions(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
) -> Vec<String> {
    // Reap first so a session that ended on its own does not linger in the list
    // the UI renders as live tabs.
    registry.reap();
    registry.ids()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpSessionState {
    pub live: bool,
    pub stopping: bool,
    pub frames: u64,
    pub bytes: u64,
    /// Human-readable event log, newest last, bounded by the sink.
    pub events: Vec<String>,
}

/// Read session state, including the bounded event log.
///
/// Pulled rather than pushed: emitting per event would put cursor motion on the
/// IPC channel at input frequency for a UI that only renders the latest state.
#[tauri::command]
pub fn rdp_native_session_state(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    sinks: State<'_, NativeRdpSinks>,
    session_id: String,
) -> Result<RdpSessionState, String> {
    let handle = registry
        .get(&session_id)
        .ok_or_else(|| rdp_err(rdp::Error::NoSuchSession))?;
    let recorded = sinks
        .lock()
        .get(&session_id)
        .map(|sink| sink.snapshot())
        .unwrap_or_default();

    Ok(RdpSessionState {
        live: handle.is_live(),
        stopping: handle.is_stopping(),
        frames: recorded.frames,
        bytes: recorded.bytes,
        events: recorded
            .events
            .iter()
            .map(|event| format!("{event:?}"))
            .collect(),
    })
}

fn with_session<R>(
    registry: &rdp::SessionRegistry,
    session_id: &str,
    f: impl FnOnce(rdp::SessionHandle) -> R,
) -> Result<R, String> {
    match registry.get(session_id) {
        Some(handle) => Ok(f(handle)),
        None => Err(rdp_err(rdp::Error::NoSuchSession)),
    }
}

#[tauri::command]
pub fn rdp_native_send_mouse(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    flags: u16,
    x: u16,
    y: u16,
    extended: Option<bool>,
) -> Result<(), String> {
    with_session(&registry, &session_id, |handle| {
        /* The two side buttons travel on a different PDU. Folding them into the
         * primary call would send button 4/5 as a left click. */
        if extended.unwrap_or(false) {
            handle.send_mouse_ex(flags, x, y);
        } else {
            handle.send_mouse(flags, x, y);
        }
    })
}

#[tauri::command]
pub fn rdp_native_send_key(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    flags: u16,
    code: u16,
    unicode: Option<bool>,
) -> Result<(), String> {
    with_session(&registry, &session_id, |handle| {
        /* Unicode is how IME and CJK text reach the session: a scancode cannot
         * express a composed character. */
        if unicode.unwrap_or(false) {
            handle.send_unicode(flags, code);
        } else {
            handle.send_scancode(flags, code);
        }
    })
}

/// Send a whole string as unicode key events.
///
/// Exists so the UI does not have to encode UTF-16 itself: a caller that split on
/// `char` would send astral-plane input (emoji) as one unit, which RDP carries as
/// a surrogate pair.
#[tauri::command]
pub fn rdp_native_send_text(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    text: String,
) -> Result<u32, String> {
    with_session(&registry, &session_id, |handle| {
        let mut sent = 0u32;
        for unit in text.encode_utf16() {
            // 0 = key down, 0x8000 (KBD_FLAGS_RELEASE) = key up. Both are needed
            // or the remote side sees a key that never lifts.
            handle.send_unicode(0, unit);
            handle.send_unicode(0x8000, unit);
            sent += 1;
        }
        sent
    })
}

#[tauri::command]
pub fn rdp_native_resize(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    with_session(&registry, &session_id, |handle| handle.resize(width, height))
}

#[tauri::command]
pub fn rdp_native_set_clipboard(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let handle = registry
        .get(&session_id)
        .ok_or_else(|| rdp_err(rdp::Error::NoSuchSession))?;
    handle.set_clipboard(&text).map_err(rdp_err)
}

#[tauri::command]
pub fn rdp_native_request_full_frame(
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    with_session(&registry, &session_id, |handle| handle.request_full_frame())
}
