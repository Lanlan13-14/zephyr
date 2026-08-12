// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    if let Some(code) = zephyr_one_lib::try_run_windows_runtime_launcher() {
        std::process::exit(code);
    }
    zephyr_one_lib::run();
}
