//! Local Zephyr core runtime (full product), desktop only.
//!
//! Node resolution (open-box, no first-run extract UI): the bundled
//! `desktop-runtime/node[.exe]` shipped as a Tauri resource, with `PATH` as a
//! development fallback.
//!
//! Remote Zephyr main is sync-only; day-to-day UI is always this loopback core.

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
    node_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub running: bool,
    pub base_url: String,
    pub port: u16,
    pub data_dir: String,
    pub mode: String,
    pub node_path: String,
}

fn state() -> &'static Mutex<RuntimeState> {
    RUNTIME.get_or_init(|| Mutex::new(RuntimeState::default()))
}

fn pick_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn wait_http_ready(child: &mut Child, url: &str, timeout: Duration) -> Result<(), String> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => return Err(format!("本地 Zephyr 进程提前退出（{status}）")),
            Ok(None) => {}
            Err(error) => return Err(format!("无法读取本地 Zephyr 进程状态：{error}")),
        }
        if let Ok(resp) = ureq::get(url).timeout(Duration::from_secs(2)).call() {
            if resp.status() >= 200 && resp.status() < 500 {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("本地 Zephyr 启动超时（{url}）"))
}

fn resource_candidates(resource_dir: &Path, relative: &str) -> Vec<PathBuf> {
    vec![
        resource_dir.join(relative),
        resource_dir.join("_up_").join(relative),
        resource_dir.join("resources").join(relative),
        resource_dir.join("resources").join("_up_").join(relative),
    ]
}

/// Node.js 22 cannot use Windows verbatim paths (`\\?\C:\...`) as the main
/// script argument: it parses the drive prefix as a directory named `C:` and
/// exits with EISDIR. Keep canonicalization for reliable discovery, then turn
/// only the Windows verbatim spelling back into the equivalent normal path
/// before passing it to `Command`.
#[cfg(target_os = "windows")]
fn node_compatible_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(target_os = "windows"))]
fn node_compatible_path(path: PathBuf) -> PathBuf {
    path
}

/// Locate the staged `zephyr-core` directory (`server.js` + `public/`).
pub fn resolve_core_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.extend(resource_candidates(&res, "zephyr-core"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("zephyr-core"));
        candidates.push(cwd.join("..").join("zephyr-core"));
        candidates.push(cwd.join("..")); // monorepo root with server.js
    }
    // Dev fallback: app data can host a manually staged core during local debug.
    if let Ok(data) = app.path().app_data_dir() {
        candidates.push(data.join("zephyr-core"));
    }
    for c in candidates {
        if c.join("server.js").is_file() && c.join("public").is_dir() {
            return Ok(node_compatible_path(c.canonicalize().unwrap_or(c)));
        }
    }
    Err(
        "未找到本地 Zephyr 核心（server.js + public）。构建前请运行 scripts/stage-zephyr-core.sh"
            .into(),
    )
}

/// Resolve Node binary for open-box execution.
///
/// The installer ships `desktop-runtime/node[.exe]` as a Tauri resource;
/// `ZEPHYR_NODE_PATH` and then `PATH` act as development fallbacks.
pub fn resolve_node_bin(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("ZEPHYR_NODE_PATH") {
        let candidate = PathBuf::from(value);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        for root in resource_candidates(&res, "desktop-runtime") {
            for name in ["node.exe", "node", "bin/node"] {
                let candidate = root.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        for name in ["node.exe", "node", "bin/node", "nodejs/bin/node"] {
            let candidate = res.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for name in ["desktop-runtime/node.exe", "desktop-runtime/node"] {
            let candidate = cwd.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    // PATH
    if let Some(node) = which_node() {
        return Ok(node);
    }
    Err("安装包缺少内置 Node 运行时，请重新安装 Zephyr One。".into())
}


fn which_node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in ["node.exe", "node", "nodejs"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn ensure_started(app: &AppHandle) -> Result<RuntimeInfo, String> {
    let mut st = state().lock();
    if let Some(child) = st.child.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(RuntimeInfo {
                    running: true,
                    base_url: st.base_url.clone(),
                    port: st.port,
                    data_dir: st.data_dir.to_string_lossy().into_owned(),
                    mode: "local-node".into(),
                    node_path: st.node_path.to_string_lossy().into_owned(),
                });
            }
            _ => {
                st.child = None;
            }
        }
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zephyr-data");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let core = resolve_core_dir(app)?;

    let node = node_compatible_path(resolve_node_bin(app)?);
    let port = pick_port().map_err(|e| e.to_string())?;
    let public_origin = format!("http://127.0.0.1:{port}");

    let mut cmd = Command::new(&node);
    cmd.current_dir(&core).arg(core.join("server.js"));

    cmd.env("ZEPHYR_DATA_DIR", &data_dir)
        .env("HTTP_ENABLED", "true")
        .env("HTTPS_ENABLED", "false")
        .env("PORT", port.to_string())
        .env("PUBLIC_ORIGIN", &public_origin)
        .env("ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN", "true")
        .env("TRUST_PROXY", "false")
        .env("ZEPHYR_ONE_EMBEDDED", "1")
        .env("ZEPHYR_VERSION", env!("CARGO_PKG_VERSION"))
        /* Use Node's built-in SQLite rather than better-sqlite3's native addon.
         * Two independent reasons, both structural:
         *   1. ABI coupling. stage-desktop-runtime.mjs bundles the *build
         *      machine's* own Node (copyFileSync(process.execPath, ...)), while
         *      the addon is compiled against whatever ABI `npm ci` saw. Those
         *      agree only by coincidence of running on one runner.
         *   2. Architecture. The macOS job installs both aarch64- and
         *      x86_64-apple-darwin targets, but `npm ci` on an arm64 runner
         *      emits an arm64-only better_sqlite3.node, which cannot load in an
         *      x86_64 slice.
         * node:sqlite is compiled into the Node binary, so it always matches the
         * arch and ABI of the runtime actually shipped. sqlite-driver.js aligns
         * its named-parameter semantics with better-sqlite3 in both directions. */
        .env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1");


    cmd.stdin(Stdio::null());

    let log_path = data_dir.join("zephyr-node.log");
    // Definitive breadcrumb for smoke tests: proves ensure_started chose this
    // data_dir even when Node stdout never appears (fd redirect / hang).
    {
        let marker = data_dir.join("runtime-boot.json");
        let body = format!(
            "{{\"pid_parent\":{},\"node\":{},\"data_dir\":{},\"log\":{},\"ts_ms\":{}}}\n",
            std::process::id(),
            serde_json::to_string(&node.display().to_string()).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(&data_dir.display().to_string()).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(&log_path.display().to_string()).unwrap_or_else(|_| "\"\"".into()),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        );
        let _ = std::fs::write(&marker, body);
    }
    // Truncate once, then share FDs for stdout+stderr. Prefer write so Node can
    // flush progress as it boots. If open fails, fall back to null (marker still
    // records the intended path).
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
        Ok(log) => {
            if let Ok(stdout) = log.try_clone() {
                cmd.stdout(Stdio::from(stdout));
            } else {
                cmd.stdout(Stdio::null());
            }
            cmd.stderr(Stdio::from(log));
        }
        Err(error) => {
            let _ = std::fs::write(
                data_dir.join("runtime-boot-log-open-error.txt"),
                format!("open {log_path:?}: {error}\n"),
            );
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    /* Windows: spawn the core without a console.
     *
     * `main.rs` carries `windows_subsystem = "windows"`, which only detaches the
     * *shell's* own console. A GUI process still has no console to inherit, so
     * spawning a console subsystem binary like node.exe makes Windows allocate a
     * fresh one — that is the black window sitting next to the Zephyr One frame.
     * CREATE_NO_WINDOW suppresses it. stdout/stderr are already redirected to
     * zephyr-node.log, so no diagnostics are lost. */
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "启动本地 Node/Zephyr 失败: {e}（node={} core={}）",
            node.display(),
            core.display()
        )
    })?;

    let health = format!("{public_origin}/healthz");
    if let Err(reason) = wait_http_ready(&mut child, &health, Duration::from_secs(60)) {
        let _ = child.kill();
        let _ = child.wait();
        let details = std::fs::read_to_string(&log_path)
            .ok()
            .map(|text| text.chars().rev().take(4000).collect::<String>().chars().rev().collect::<String>())
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!("\n\n运行日志：\n{text}"))
            .unwrap_or_default();
        return Err(format!("{reason}{details}"));
    }

    st.child = Some(child);
    st.port = port;
    st.base_url = public_origin.clone();
    st.data_dir = data_dir.clone();
    st.node_path = node.clone();

    Ok(RuntimeInfo {
        running: true,
        base_url: public_origin,
        port,
        data_dir: data_dir.to_string_lossy().into_owned(),
        mode: "local-node".into(),
        node_path: node.to_string_lossy().into_owned(),
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
    let mut st = state().lock();
    let exited = st
        .child
        .as_mut()
        .and_then(|child| child.try_wait().ok().flatten())
        .is_some();
    if exited {
        st.child = None;
        st.port = 0;
        st.base_url.clear();
    }
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
        node_path: st.node_path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{node_compatible_path, resource_candidates};
    use std::path::{Path, PathBuf};

    #[test]
    fn packaged_parent_resources_are_discoverable() {
        let candidates = resource_candidates(Path::new("C:/Program/Zephyr One"), "zephyr-core");
        assert!(candidates.iter().any(|path| path.ends_with("_up_/zephyr-core")));
        let runtime = resource_candidates(Path::new("C:/Program/Zephyr One"), "desktop-runtime");
        assert!(runtime.iter().any(|path| path.ends_with("_up_/desktop-runtime")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_verbatim_paths_are_safe_for_node() {
        assert_eq!(
            node_compatible_path(PathBuf::from(
                r"\\?\C:\Users\Test User\AppData\Local\Zephyr One\_up_\zephyr-core",
            )),
            PathBuf::from(
                r"C:\Users\Test User\AppData\Local\Zephyr One\_up_\zephyr-core",
            ),
        );
        assert_eq!(
            node_compatible_path(PathBuf::from(r"\\?\UNC\server\share\zephyr-core")),
            PathBuf::from(r"\\server\share\zephyr-core"),
        );
    }
}
