use crate::auth;
use crate::fs::{self, FileStat, FsState};
use crate::icon;
use crate::rdp;
use crate::rdp_picker;
use crate::runtime;
use crate::token::{TokenRecord, TokenState};
use crate::unlock_bridge;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub mod rdp_surface;
pub use rdp_surface::NativeRdpSurfaceState;

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
    runtime::append_runtime_log(&watcher_app, "runtime_start command entered");
    let info = tauri::async_runtime::spawn_blocking(move || runtime::ensure_started(&app))
        .await
        .map_err(|error| format!("本地运行时任务异常退出：{error}"))??;
    runtime::append_runtime_log(&watcher_app, "runtime_start command completed");
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
pub async fn runtime_enter(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<runtime::RuntimeInfo, String> {
    if window.label() != "main" {
        return Err("runtime_enter is restricted to the trusted main shell".into());
    }
    runtime::append_runtime_log(&app, "runtime_enter command entered");
    let log_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || runtime::enter(&app))
        .await
        .map_err(|error| format!("local product entry task failed: {error}"))?;
    match result {
        Ok(info) => {
            runtime::append_runtime_log(&log_app, "runtime_enter command completed");
            Ok(info)
        }
        Err(error) => {
            runtime::append_runtime_log(
                &log_app,
                &format!("runtime_enter command failed: {error}"),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn local_app_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let log_app = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || runtime::mark_local_app_ready(&app, &window))
            .await
            .map_err(|error| format!("local product ready task failed: {error}"))?;
    match result {
        Ok(()) => {
            runtime::append_runtime_log(&log_app, "local_app_ready command completed");
            Ok(())
        }
        Err(error) => {
            runtime::append_runtime_log(
                &log_app,
                &format!("local_app_ready command failed: {error}"),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn local_app_restart(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<runtime::RuntimeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || runtime::restart_from_local_app(&app, &window))
        .await
        .map_err(|error| format!("local product recovery task failed: {error}"))?
}

#[tauri::command]
pub fn runtime_info() -> runtime::RuntimeInfo {
    runtime::info()
}

#[tauri::command]
pub fn runtime_stop(app: AppHandle) -> Result<(), String> {
    runtime::stop(&app)
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
pub fn agent_fs_mkdir(state: State<'_, FsState>, root: String, path: String) -> Result<(), String> {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpCapabilities {
    /// False when this binary was built with ZEPHYR_ONE_SKIP_NATIVE_RDP=1.
    pub available: bool,
    /// FreeRDP major version linked in, or null when unavailable.
    pub freerdp_major: Option<i32>,
    /// False when the linked FreeRDP lacks Zephyr's pre-allocation cliprdr cap.
    pub clipboard_available: bool,
    pub clipboard_reason: String,
    pub folder_mapping_available: bool,
    pub folder_mapping_reason: String,
    /// Why, when unavailable. Empty when it is.
    pub reason: String,
}

#[tauri::command]
pub fn rdp_native_capabilities() -> RdpCapabilities {
    let available = rdp::is_available();
    RdpCapabilities {
        available,
        freerdp_major: rdp::freerdp_major(),
        clipboard_available: rdp::clipboard_available(),
        clipboard_reason: if rdp::clipboard_available() {
            String::new()
        } else {
            "Clipboard redirection is disabled because this FreeRDP build lacks the required bounded cliprdr reassembler.".to_string()
        },
        folder_mapping_available: false,
        folder_mapping_reason:
            "Native drive mapping is disabled until a handle-based channel is available."
                .to_string(),
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

/// The renderer's complete authority: name one saved connection and one native
/// surface. Targets, credentials, security, channels, and filesystem paths are
/// deliberately absent and unknown fields are rejected by serde.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RdpConnectRequest {
    pub connection_id: String,
    pub session_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl RdpConnectRequest {
    fn into_intent(self) -> rdp::broker::OpenIntent {
        let defaults = rdp::Config::default();
        rdp::broker::OpenIntent {
            connection_id: self.connection_id,
            session_id: self.session_id,
            width: self.width.unwrap_or(defaults.width),
            height: self.height.unwrap_or(defaults.height),
        }
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
    app: AppHandle,
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    surfaces: State<'_, std::sync::Arc<NativeRdpSurfaceState>>,
    request: RdpConnectRequest,
) -> Result<RdpConnectResult, String> {
    connect_native_rdp(&app, window.label(), &broker, &surfaces, request)
}

pub(super) fn connect_native_rdp(
    app: &AppHandle,
    owner_label: &str,
    broker: &rdp::broker::NativeRdpBroker,
    surfaces: &NativeRdpSurfaceState,
    request: RdpConnectRequest,
) -> Result<RdpConnectResult, String> {
    let intent = request.into_intent();
    let session_id = intent.session_id.clone();
    broker.authorize_and_open(
        owner_label,
        &intent,
        || {
            runtime::authorize_native_rdp(
                &app,
                &intent.connection_id,
                &intent.session_id,
                owner_label,
            )
        },
        |binding| {
            let approval = crate::auth::unlock(
                &app,
                &format!(
                    "Authorize Remote Desktop connection to {}:{}",
                    binding.host, binding.port
                ),
            );
            if approval.ok {
                Ok(())
            } else {
                Err(format!(
                    "rdp_native_user_authorization_required: {}",
                    approval
                        .error
                        .unwrap_or_else(|| "system authorization was cancelled".to_string())
                ))
            }
        },
        |config| surfaces.start_session(&session_id, config),
    )?;

    Ok(RdpConnectResult {
        session_id,
        started: true,
    })
}

#[tauri::command]
pub fn rdp_native_disconnect(
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    surfaces: State<'_, std::sync::Arc<NativeRdpSurfaceState>>,
    session_id: String,
) -> Result<bool, String> {
    broker.close_owned(window.label(), &session_id, || {
        surfaces.disconnect_session(&session_id)
    })
}

#[tauri::command]
pub fn rdp_native_sessions(
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    surfaces: State<'_, std::sync::Arc<NativeRdpSurfaceState>>,
) -> Vec<String> {
    surfaces.reap_closed_surfaces();
    // Reap first so a session that ended on its own does not linger in the list
    // the UI renders as live tabs.
    registry.reap();
    let live = registry
        .ids()
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    broker
        .owned_active_ids(window.label())
        .into_iter()
        .filter(|session_id| live.contains(session_id))
        .collect()
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
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    surfaces: State<'_, std::sync::Arc<NativeRdpSurfaceState>>,
    session_id: String,
) -> Result<RdpSessionState, String> {
    broker.assert_active_owner(window.label(), &session_id)?;
    let handle = registry
        .get(&session_id)
        .ok_or_else(|| rdp_err(rdp::Error::NoSuchSession))?;
    let recorded = surfaces.telemetry(&session_id);

    Ok(RdpSessionState {
        live: handle.is_live(),
        stopping: handle.is_stopping(),
        frames: recorded.frames,
        bytes: recorded.bytes,
        events: recorded.events,
    })
}

fn with_session<R>(
    broker: &rdp::broker::NativeRdpBroker,
    owner_label: &str,
    registry: &rdp::SessionRegistry,
    session_id: &str,
    f: impl FnOnce(rdp::SessionHandle) -> R,
) -> Result<R, String> {
    broker.with_active(owner_label, session_id, || match registry.get(session_id) {
        Some(handle) => Ok(f(handle)),
        None => Err(rdp_err(rdp::Error::NoSuchSession)),
    })?
}

#[tauri::command]
pub fn rdp_native_send_mouse(
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    flags: u16,
    x: u16,
    y: u16,
    extended: Option<bool>,
) -> Result<(), String> {
    with_session(&broker, window.label(), &registry, &session_id, |handle| {
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
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    flags: u16,
    code: u16,
    unicode: Option<bool>,
) -> Result<(), String> {
    with_session(&broker, window.label(), &registry, &session_id, |handle| {
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
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    text: String,
) -> Result<u32, String> {
    with_session(&broker, window.label(), &registry, &session_id, |handle| {
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
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    with_session(&broker, window.label(), &registry, &session_id, |handle| {
        handle.resize(width, height)
    })
}

#[tauri::command]
pub fn rdp_native_set_clipboard(
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    with_session(&broker, window.label(), &registry, &session_id, |handle| {
        handle.set_clipboard(&text).map_err(rdp_err)
    })?
}

#[tauri::command]
pub fn rdp_native_request_full_frame(
    window: tauri::WebviewWindow,
    broker: State<'_, std::sync::Arc<rdp::broker::NativeRdpBroker>>,
    registry: State<'_, std::sync::Arc<rdp::SessionRegistry>>,
    session_id: String,
) -> Result<(), String> {
    with_session(&broker, window.label(), &registry, &session_id, |handle| {
        handle.request_full_frame()
    })
}

#[cfg(test)]
mod native_rdp_security_tests {
    use super::*;

    #[test]
    fn renderer_intent_accepts_only_opaque_ids_and_dimensions() {
        let request: RdpConnectRequest = serde_json::from_value(serde_json::json!({
            "connectionId": "connection-1",
            "sessionId": "session-1",
            "width": 1280,
            "height": 720
        }))
        .unwrap();
        let intent = request.into_intent();
        assert_eq!(intent.connection_id, "connection-1");
        assert_eq!(intent.session_id, "session-1");

        for forbidden in [
            "host",
            "password",
            "path",
            "drivePath",
            "folderPath",
            "folderGrant",
            "security",
        ] {
            let mut payload = serde_json::json!({
                "connectionId": "connection-1",
                "sessionId": "session-1"
            });
            payload[forbidden] = serde_json::Value::String("attacker-controlled".into());
            assert!(serde_json::from_value::<RdpConnectRequest>(payload).is_err());
        }
    }

    #[test]
    fn connect_result_serialization_contains_no_target_credential_or_grant() {
        let serialized = serde_json::to_value(RdpConnectResult {
            session_id: "session-1".to_owned(),
            started: true,
        })
        .unwrap();
        assert_eq!(serialized["sessionId"], "session-1");
        for forbidden in [
            "host",
            "port",
            "username",
            "password",
            "path",
            "grant",
            "authorization",
        ] {
            assert!(serialized.get(forbidden).is_none());
        }
    }

    #[test]
    fn folder_mapping_capability_is_fail_closed() {
        let capabilities = rdp_native_capabilities();
        assert!(!capabilities.folder_mapping_available);
        assert!(!capabilities.folder_mapping_reason.is_empty());
    }
}
