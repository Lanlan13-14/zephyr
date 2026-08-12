mod agent;
mod auth;
mod commands;
mod fs;
mod icon;
mod rdp;
mod rdp_picker;
mod rdp_surface;
mod runtime;
mod token;
mod unlock_bridge;
#[cfg(target_os = "windows")]
mod windows_runtime_launcher;

#[cfg(target_os = "windows")]
pub fn try_run_windows_runtime_launcher() -> Option<i32> {
    windows_runtime_launcher::try_run()
}

/// Desktop-only entry point (Windows / macOS / Linux). Zephyr One no longer
/// ships Android or iOS: the core is a spawned Node child process, which iOS
/// forbids outright, and the Android path needed a libnode.so + APK-asset
/// pipeline that is not worth maintaining alongside the desktop product.
pub fn run() {
    let rdp_sessions = std::sync::Arc::new(rdp::SessionRegistry::new());
    let rdp_broker = std::sync::Arc::new(rdp::broker::NativeRdpBroker::new());
    let rdp_surfaces = std::sync::Arc::new(rdp_surface::NativeRdpSurfaceRegistry::new(
        rdp_sessions.clone(),
    ));
    let rdp_surface_state = std::sync::Arc::new(commands::NativeRdpSurfaceState::new(
        rdp_sessions.clone(),
        rdp_surfaces.clone(),
    ));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    let app = builder
        .manage(fs::FsState::default())
        .manage(token::TokenState::default())
        /* The renderer never receives a native-RDP grant. WebView ownership,
         * one-shot connect authorization, and every session operation are
         * enforced by this process-local broker. */
        .manage(rdp_broker)
        /* One registry for every RDP session, owned by the shell rather than by
         * a window: a session must outlive a tab being re-attached, and the
         * loop thread needs somewhere stable to be reaped from. */
        .manage(rdp_sessions)
        /* Native platform render targets live outside WebView ownership. The
         * surface registry consumes borrowed FreeRDP frames in-process; only
         * the owner-checked AI capture command can obtain an encoded copy. */
        .manage(rdp_surfaces)
        /* Own the generation leases and serialize native-window lifecycle with
         * FreeRDP start/stop. It also keeps pixel-free session telemetry. */
        .manage(rdp_surface_state)
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
            commands::rdp_native_capabilities,
            commands::rdp_native_connect,
            commands::rdp_native_disconnect,
            commands::rdp_native_sessions,
            commands::rdp_native_send_mouse,
            commands::rdp_native_send_key,
            commands::rdp_native_send_text,
            commands::rdp_native_resize,
            commands::rdp_native_set_clipboard,
            commands::rdp_native_request_full_frame,
            commands::rdp_native_session_state,
            commands::rdp_surface::rdp_native_surface_create,
            commands::rdp_surface::rdp_native_surface_show,
            commands::rdp_surface::rdp_native_surface_close,
            commands::rdp_surface::rdp_native_surface_resize,
            commands::rdp_surface::rdp_native_surface_focus,
            commands::rdp_surface::rdp_native_surface_status,
            commands::rdp_surface::rdp_native_surface_capture,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Zephyr One");

    let configured_autostart = std::env::var("ZEPHYR_ONE_AUTOSTART_RUNTIME").ok();
    let windows_release = cfg!(target_os = "windows") && !cfg!(debug_assertions);
    let autostart = runtime::should_autostart(configured_autostart.as_deref(), windows_release);
    let mut autostart_dispatched = false;

    app.run(move |handle, event| match event {
        /* `Ready` is the first point at which Tauri's event loop and all
         * plugins are initialized. Windows release builds start here even if
         * WebView JavaScript never loads; the UI's runtime_start command stays
         * as an idempotent retry path. */
        tauri::RunEvent::Ready if autostart && !autostart_dispatched => {
            autostart_dispatched = true;
            runtime::spawn_autostart(handle.clone());
        }
        /* Stop the child when the application exits, not whenever an
         * individual window is destroyed. Window recreation must not tear
         * down a healthy local core while the Tauri process is still alive. */
        tauri::RunEvent::Exit => runtime::stop(),
        _ => {}
    });
}
