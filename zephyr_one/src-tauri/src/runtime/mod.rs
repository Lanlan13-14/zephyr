//! Local Zephyr core runtime (full product).
//!
//! Node resolution (open-box, no first-run extract UI):
//! - **Android**: `libnode.so` shipped in `jniLibs/<abi>/` — PackageManager
//!   extracts native libs at install into `nativeLibraryDir`; we exec that path.
//! - **Desktop**: PATH `node`, or bundled resource `node` / `bin/node`.
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

pub fn resolve_core_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("zephyr-core"));
        candidates.push(res.join("resources").join("zephyr-core"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("zephyr-core"));
        candidates.push(cwd.join("..").join("zephyr-core"));
        candidates.push(cwd.join("..")); // monorepo root with server.js
    }
    // Android: filesDir / native adjacent staged core
    if let Ok(data) = app.path().app_data_dir() {
        candidates.push(data.join("zephyr-core"));
        candidates.push(data.join("..").join("zephyr-core"));
    }
    for c in candidates {
        if c.join("server.js").is_file() && c.join("public").is_dir() {
            return Ok(c.canonicalize().unwrap_or(c));
        }
    }
    Err(
        "未找到本地 Zephyr 核心（server.js + public）。构建前请运行 scripts/stage-zephyr-core.sh"
            .into(),
    )
}

/// Resolve Node binary for open-box execution.
///
/// Android: install-time extracted `libnode.so` under nativeLibraryDir
/// (placed via jniLibs — NOT app-runtime download/extract).
pub fn resolve_node_bin(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        // libnode.so is packaged under jniLibs and extracted by the OS at install
        // into ApplicationInfo.nativeLibraryDir — not unpacked by app code.
        let mut candidates: Vec<PathBuf> = Vec::new();
        for key in ["ANDROID_NATIVE_LIB_DIR", "ZEPHYR_NATIVE_LIB_DIR"] {
            if let Ok(v) = std::env::var(key) {
                candidates.push(PathBuf::from(&v).join("libnode.so"));
                candidates.push(PathBuf::from(v));
            }
        }
        if let Ok(v) = std::env::var("ZEPHYR_NODE_PATH") {
            candidates.push(PathBuf::from(v));
        }
        if let Ok(data) = app.path().app_data_dir() {
            // dataDir ≈ /data/user/0/com.zephyr.one/files
            // native libs ≈ /data/app/~~…/com.zephyr.one-…/lib/<abi>/libnode.so
            if let Some(app_root) = data.parent() {
                for abi in [
                    "arm64",
                    "arm64-v8a",
                    "armeabi-v7a",
                    "arm",
                    "x86_64",
                    "x86",
                ] {
                    candidates.push(app_root.join("lib").join(abi).join("libnode.so"));
                }
            }
            // walk up to find …/lib/*/libnode.so under /data/app
            candidates.push(data.join("libnode.so"));
        }
        if let Ok(res) = app.path().resource_dir() {
            candidates.push(res.join("libnode.so"));
        }
        // Best-effort scan near this process maps for libnode.so
        if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
            for line in maps.lines() {
                if let Some(path) = line.split_whitespace().last() {
                    if path.contains("libnode.so") {
                        candidates.push(PathBuf::from(path));
                    }
                    // same directory as other extracted .so
                    if path.ends_with(".so") {
                        if let Some(dir) = Path::new(path).parent() {
                            candidates.push(dir.join("libnode.so"));
                        }
                    }
                }
            }
        }
        for p in candidates {
            if p.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = std::fs::metadata(&p) {
                        let mut perms = meta.permissions();
                        perms.set_mode(perms.mode() | 0o755);
                        let _ = std::fs::set_permissions(&p, perms);
                    }
                }
                return Ok(p);
            }
        }
        return Err(
            "Android 未找到 libnode.so（构建应写入 jniLibs/<abi>/libnode.so，安装时由系统解压）"
                .into(),
        );
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        if let Ok(res) = app.path().resource_dir() {
            for name in ["node", "bin/node", "nodejs/bin/node"] {
                let p = res.join(name);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
        // PATH
        if which_node().is_some() {
            return Ok(PathBuf::from("node"));
        }
        Err("未找到 Node.js。桌面请安装 Node ≥ 20，或将 node 放入资源目录。".into())
    }
}

#[cfg(not(target_os = "android"))]
fn which_node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in ["node", "nodejs"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// On Android, ensure zephyr-core lives under app filesDir (writable for sqlite etc.).
/// Core is shipped as APK assets/resources and copied once if missing — not the Node binary.
fn ensure_core_on_device(app: &AppHandle, staged: &Path) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let dest = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("zephyr-core");
        let marker = dest.join("ZEPHYR_ONE_CORE.json");
        if marker.is_file() && dest.join("server.js").is_file() {
            return Ok(dest);
        }
        // Copy staged core from resources into filesDir (one-time install layout).
        copy_dir_recursive(staged, &dest).map_err(|e| format!("复制 zephyr-core 失败: {e}"))?;
        return Ok(dest);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(staged.to_path_buf())
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
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

    let staged_core = resolve_core_dir(app)?;
    let core = ensure_core_on_device(app, &staged_core)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zephyr-data");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let node = resolve_node_bin(app)?;
    let port = pick_port().map_err(|e| e.to_string())?;
    let public_origin = format!("http://127.0.0.1:{port}");

    let mut cmd = Command::new(&node);
    cmd.current_dir(&core)
        .arg(core.join("server.js"))
        .env("ZEPHYR_DATA_DIR", &data_dir)
        .env("HTTP_ENABLED", "true")
        .env("HTTPS_ENABLED", "false")
        .env("PORT", port.to_string())
        .env("PUBLIC_ORIGIN", &public_origin)
        .env("ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN", "true")
        .env("TRUST_PROXY", "false")
        .env("ZEPHYR_ONE_EMBEDDED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Android: give node a writable HOME/TMP
    if let Ok(data) = app.path().app_data_dir() {
        cmd.env("HOME", &data);
        cmd.env("TMPDIR", data.join("tmp"));
        let _ = std::fs::create_dir_all(data.join("tmp"));
    }

    let child = cmd.spawn().map_err(|e| {
        format!(
            "启动本地 Node/Zephyr 失败: {e}（node={} core={}）",
            node.display(),
            core.display()
        )
    })?;

    let health = format!("{public_origin}/healthz");
    if !wait_http_ready(&health, Duration::from_secs(60)) {
        st.child = Some(child);
        st.port = port;
        st.base_url = public_origin.clone();
        st.data_dir = data_dir.clone();
        st.node_path = node.clone();
        return Err(format!("本地 Zephyr 启动超时（{health}）"));
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
        node_path: st.node_path.to_string_lossy().into_owned(),
    }
}
