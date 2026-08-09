mod agent;
mod auth;
mod commands;
mod fs;
mod icon;
mod rdp_picker;
mod runtime;
mod token;
mod unlock_bridge;

use tauri::Manager;

/// Desktop-only entry point (Windows / macOS / Linux). Zephyr One no longer
/// ships Android or iOS: the core is a spawned Node child process, which iOS
/// forbids outright, and the Android path needed a libnode.so + APK-asset
/// pipeline that is not worth maintaining alongside the desktop product.
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    builder
        .manage(fs::FsState::default())
        .manage(token::TokenState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_app_version,
            commands::auth_capabilities,
            commands::auth_unlock,
            commands::set_theme_icon,
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
            // Default: the frontend invokes async `runtime_start` once the boot
            // UI is visible, so a slow core start never blocks first paint.
            // CI/install smoke sets ZEPHYR_ONE_AUTOSTART_RUNTIME=1 so the
            // embedded Node core comes up even if the WebView never finishes
            // loading JS.
            let _ = app.get_webview_window("main");
            let autostart = std::env::var("ZEPHYR_ONE_AUTOSTART_RUNTIME")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if autostart {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    match runtime::ensure_started(&handle) {
                        Ok(info) => {
                            eprintln!(
                                "zephyr-one: autostart ok base_url={} node={}",
                                info.base_url, info.node_path
                            );
                        }
                        Err(error) => {
                            eprintln!("zephyr-one: autostart failed: {error}");
                        }
                    }
                });
            }
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
