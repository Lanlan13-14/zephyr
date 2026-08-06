//! Local Zephyr core runtime.
//!
//! Product architecture:
//! - Zephyr One embeds/runs a full Zephyr instance for UI + SSH/RDP/VNC/notes/AI.
//! - Remote Zephyr main is used **only** for optional account data sync
//!   (`/api/one/*`), not as the day-to-day UI host.
//!
//! Implementation: spawn Node.js with the staged zephyr core (server.js + public).
//! Desktop uses system/bundled node; Android may use node-android-build binary.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager};

static RUNTIME: OnceCell<Mutex<RuntimeState>> = OnceCell::new();

#[derive(Default)]
struct RuntimeState {
    child: Option<Child>,
    port: u16,
    base_url: String,
    data_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub running: bool,
    pub base_url: String,
    pub port: u16,
    pub data_dir: String,
    pub mode: String,
}

fn state() -> &'static Mutex<RuntimeState> {
    RUNTIME.get_or_init(|| Mutex::new(RuntimeState::default()))
}

fn pick_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn wait_http_ready(url: &str, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if let Ok(resp) = ureq::get(url).timeout(Duration::from_secs(2)).call() {
            if resp.status() >= 200 && resp.status() < 500 {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Resolve staged zephyr core directory next to the resource dir or dev path.
pub fn resolve_core_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Dev: repo zephyr_one/../ (monorepo) or zephyr_one/zephyr-core
    let candidates = [
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("zephyr-core")),
        app.path()
            .resource_dir()
            .ok()
            .map(|p| p.join("resources").join("zephyr-core")),
        // dev: zephyr_one/zephyr-core
        std::env::current_dir()
            .ok()
            .map(|p| p.join("zephyr-core")),
        std::env::current_dir()
            .ok()
            .map(|p| p.join("..").join("zephyr-core")),
        // monorepo root when running from zephyr_one/
        std::env::current_dir().ok().map(|p| p.join("..")),
    ];
    for c in candidates.into_iter().flatten() {
        if c.join("server.js").is_file() && c.join("public").is_dir() {
            return Ok(c.canonicalize().unwrap_or(c));
        }
    }
    Err(
        "未找到本地 Zephyr 核心（server.js + public）。请先运行 scripts/stage-zephyr-core.sh"
            .into(),
    )
}

fn resolve_node_bin(app: &AppHandle) -> PathBuf {
    // Prefer bundled node (Android node-android-build / desktop sidecar)
    if let Ok(res) = app.path().resource_dir() {
        for name in ["node", "bin/node", "node-android/bin/node"] {
            let p = res.join(name);
            if p.is_file() {
                return p;
            }
        }
    }
    // PATH fallback
    PathBuf::from("node")
}

/// Start local Zephyr HTTP (cleartext loopback) for the WebView.
pub fn ensure_started(app: &AppHandle) -> Result<RuntimeInfo, String> {
    let mut st = state().lock();
    if let Some(child) = st.child.as_mut() {
        // still alive?
        match child.try_wait() {
            Ok(None) => {
                return Ok(RuntimeInfo {
                    running: true,
                    base_url: st.base_url.clone(),
                    port: st.port,
                    data_dir: st.data_dir.to_string_lossy().into_owned(),
                    mode: "local-node".into(),
                });
            }
            _ => {
                st.child = None;
            }
        }
    }

    let core = resolve_core_dir(app)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zephyr-data");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let port = pick_port().map_err(|e| e.to_string())?;
    let node = resolve_node_bin(app);

    // Local-only HTTP. PUBLIC_ORIGIN must match what the WebView loads so
    // requireSameOrigin accepts write APIs.
    let public_origin = format!("http://127.0.0.1:{port}");
    let mut cmd = Command::new(&node);
    cmd.current_dir(&core)
        .env("ZEPHYR_DATA_DIR", &data_dir)
        .env("HTTP_ENABLED", "true")
        .env("HTTPS_ENABLED", "false")
        .env("PORT", port.to_string())
        .env("PUBLIC_ORIGIN", &public_origin)
        .env("ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN", "true")
        .env("TRUST_PROXY", "false")
        // One profile: mark for future server-side UI filters
        .env("ZEPHYR_ONE_EMBEDDED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Prefer server.js
    let server_js = core.join("server.js");
    if !server_js.is_file() {
        return Err(format!("server.js missing under {}", core.display()));
    }
    cmd.arg(server_js);

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动本地 Node/Zephyr 失败: {e}（node={}）", node.display()))?;

    let health = format!("{public_origin}/healthz");
    if !wait_http_ready(&health, Duration::from_secs(45)) {
        // leave child for diagnostics; still return error
        st.child = Some(child);
        st.port = port;
        st.base_url = public_origin.clone();
        st.data_dir = data_dir.clone();
        return Err(format!(
            "本地 Zephyr 启动超时（{health}）。请检查 node 与 zephyr-core 依赖是否已 stage。"
        ));
    }

    st.child = Some(child);
    st.port = port;
    st.base_url = public_origin.clone();
    st.data_dir = data_dir.clone();

    Ok(RuntimeInfo {
        running: true,
        base_url: public_origin,
        port,
        data_dir: data_dir.to_string_lossy().into_owned(),
        mode: "local-node".into(),
    })
}

pub fn stop() {
    let mut st = state().lock();
    if let Some(mut child) = st.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    st.port = 0;
    st.base_url.clear();
}

pub fn info() -> RuntimeInfo {
    let st = state().lock();
    RuntimeInfo {
        running: st.child.is_some(),
        base_url: st.base_url.clone(),
        port: st.port,
        data_dir: st.data_dir.to_string_lossy().into_owned(),
        mode: if st.child.is_some() {
            "local-node".into()
        } else {
            "stopped".into()
        },
    }
}

/// Optional: pull remote snapshot into local data (sync-only interconnect).
pub fn sync_note() -> &'static str {
    "Remote main is sync-only. Use One Client bind APIs against the remote host; local UI always targets loopback Zephyr."
}

#[allow(dead_code)]
pub fn core_exists(path: &Path) -> bool {
    path.join("server.js").is_file() && path.join("public").is_dir()
}
