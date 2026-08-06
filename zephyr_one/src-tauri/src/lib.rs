mod agent;
mod auth;
mod commands;
mod fs;
mod runtime;
mod token;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(fs::FsState::default())
        .manage(token::TokenState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_app_version,
            commands::auth_capabilities,
            commands::auth_unlock,
            commands::runtime_start,
            commands::runtime_info,
            commands::runtime_stop,
            commands::agent_pick_directory,
            commands::agent_default_share_path,
            commands::agent_fs_list,
            commands::agent_fs_stat,
            commands::agent_fs_open,
            commands::agent_fs_read,
            commands::agent_fs_write,
            commands::agent_fs_close,
            commands::agent_fs_mkdir,
            commands::agent_fs_delete,
            commands::agent_fs_rename,
            commands::agent_fs_truncate,
            commands::token_list_local,
            commands::token_add_local,
            commands::token_remove_local,
            commands::token_export_local,
            commands::token_import_local,
        ])
        .setup(|app| {
            // Start local Zephyr core ASAP so first paint can navigate.
            // Failure is non-fatal at setup; UI can retry via runtime_start.
            if let Err(err) = runtime::ensure_started(app.handle()) {
                eprintln!("[zephyr-one] local runtime not started yet: {err}");
            }
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                runtime::stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Zephyr One");
}
