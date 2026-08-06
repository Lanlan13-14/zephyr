use crate::auth;
use crate::fs::{self, FileStat, FsState};
use crate::runtime;
use crate::token::{TokenRecord, TokenState};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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

/// Start embedded Zephyr core (full product). Remote main is sync-only.
#[tauri::command]
pub fn runtime_start(app: AppHandle) -> Result<runtime::RuntimeInfo, String> {
    runtime::ensure_started(&app)
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        let (path, _name) = fs::default_share_path();
        if path.is_empty() {
            return Ok(None);
        }
        return Ok(Some(path));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let folder = app.dialog().file().blocking_pick_folder();
        Ok(folder.map(|p| match p.into_path() {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(fp) => fp.to_string(),
        }))
    }
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
