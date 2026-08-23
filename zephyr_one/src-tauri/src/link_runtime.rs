//! Embedded Zephyr Link (ZSL/2) process for the desktop client.
//!
//! Mirrors the mobile embedded-Link shape: the shared Go Link core runs as a
//! loopback-only child process, and the desktop UI drives it over 127.0.0.1
//! HTTP. Rust owns process lifecycle and byte-shuttling only; it never
//! re-implements ZSL/2, so the desktop speaks the byte-identical protocol the
//! server and mobile ends use. The binary ships as `desktop-runtime/zephyr-link`.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

static LINK: OnceCell<Mutex<LinkState>> = OnceCell::new();

const READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct LinkState {
    child: Option<Child>,
    base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkInfo {
    pub base_url: String,
    pub running: bool,
}

fn state() -> &'static Mutex<LinkState> {
    LINK.get_or_init(|| Mutex::new(LinkState::default()))
}

/// Locate the staged `desktop-runtime/zephyr-link` binary shipped as a Tauri
/// resource, with a debug fallback to the source tree and PATH.
fn resolve_link_bin(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        for name in ["zephyr-link.exe", "zephyr-link"] {
            candidates.push(res.join("desktop-runtime").join(name));
            candidates.push(res.join("resources").join("desktop-runtime").join(name));
        }
    }
    if cfg!(debug_assertions) {
        if let Ok(v) = std::env::var("ZEPHYR_LINK_BIN") {
            candidates.push(PathBuf::from(v));
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("desktop-runtime/zephyr-link"));
            candidates.push(cwd.join("../desktop-runtime/zephyr-link"));
            candidates.push(cwd.join("../../zephyr-link/zephyr-link"));
        }
    }
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err("未找到桌面 Zephyr Link 运行时（desktop-runtime/zephyr-link）".into())
}

/// Start (or return the running) embedded Link core and report its loopback URL.
/// The child prints one readiness line — its bound 127.0.0.1 address — then
/// blocks on stdin EOF, which is the lifetime boundary: dropping stdin (or the
/// app exiting) shuts it down.
pub fn ensure_started(app: &AppHandle) -> Result<LinkInfo, String> {
    let mut st = state().lock();
    if let Some(child) = st.child.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(LinkInfo { base_url: st.base_url.clone(), running: true });
            }
            _ => {
                // Died; fall through and respawn.
                st.child = None;
            }
        }
    }
    let bin = resolve_link_bin(app)?;
    let mut child = Command::new(bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Zephyr Link 进程启动失败: {e}"))?;

    // Read the single readiness line with a deadline so a wedged child cannot hang the UI.
    let stdout = child.stdout.take().ok_or("Zephyr Link 无 stdout")?;
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut line = String::new();
    let addr = loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("Zephyr Link 就绪超时".into());
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                let _ = child.kill();
                return Err("Zephyr Link 提前退出".into());
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.starts_with("127.0.0.1:") {
                    break trimmed.to_string();
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let base_url = format!("http://{addr}");
    // Confirm the HTTP surface is actually serving before we hand the URL out.
    probe(&base_url).map_err(|e| {
        let _ = child.kill();
        format!("Zephyr Link 探活失败: {e}")
    })?;
    st.base_url = base_url.clone();
    st.child = Some(child);
    Ok(LinkInfo { base_url, running: true })
}

fn probe(base_url: &str) -> Result<(), String> {
    let addr = base_url.trim_start_matches("http://");
    let mut stream = TcpStream::connect(addr).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn stop() {
    let mut st = state().lock();
    if let Some(mut child) = st.child.take() {
        // Closing stdin is the graceful shutdown signal; kill is the backstop.
        let _ = child.kill();
        let _ = child.wait();
    }
    st.base_url.clear();
}
