//! Local Zephyr core runtime (full product).
//!
//! Node resolution (open-box, no first-run extract UI):
//! - **Android**: `libnode.so` shipped in `jniLibs/<abi>/` — PackageManager
//!   extracts native libs at install into `nativeLibraryDir`; we exec that path.
//! - **Desktop**: PATH `node`, or bundled resource `node` / `bin/node`.
//!
//! Remote Zephyr main is sync-only; day-to-day UI is always this loopback core.
//!
//! **Android core embedding**: Tauri `resource_dir()` returns `"asset://localhost/"`
//! (a virtual URI, not a filesystem path). APK assets are not accessible via
//! `std::fs`, and NDK `AAssetDir_getNextFileName` does **not** list subdirectories.
//! Shipping thousands of individual asset files is therefore broken for nested
//! trees (`public/`, `node_modules/`, …).
//!
//! Fix: package one plain `assets/zephyr-core.tar` and stream it from NDK
//! `AAssetManager_open` directly into `tar`, extracting to
//! `app_data_dir/zephyr-core/` without a temporary archive. The APK ZIP already
//! provides compression; an inner `.tar.gz` is renamed by Android's asset
//! packaging and cannot be addressed reliably at runtime. Re-extract when the
//! app version marker changes.

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

/// A streaming reader over one APK asset. `Drop` closes the NDK handle.
///
/// This avoids first writing the whole 136 MB tar to filesDir, then reading it
/// back for extraction. `tar::Archive` consumes this reader directly.
#[cfg(target_os = "android")]
struct AndroidAssetReader {
    asset: *mut std::ffi::c_void,
}

#[cfg(target_os = "android")]
impl std::io::Read for AndroidAssetReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let read = unsafe {
            AAsset_read(
                self.asset,
                buf.as_mut_ptr().cast::<std::ffi::c_void>(),
                buf.len(),
            )
        };
        if read < 0 {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("AAsset_read 错误: {read}"),
            ))
        } else {
            Ok(read as usize)
        }
    }
}

#[cfg(target_os = "android")]
impl Drop for AndroidAssetReader {
    fn drop(&mut self) {
        if !self.asset.is_null() {
            unsafe { AAsset_close(self.asset) };
            self.asset = std::ptr::null_mut();
        }
    }
}

#[cfg(target_os = "android")]
#[link(name = "android")]
extern "C" {
    fn AAssetManager_fromJava(
        env: *mut jni::sys::JNIEnv,
        asset_manager: jni::sys::jobject,
    ) -> *mut std::ffi::c_void;
    fn AAssetManager_open(
        manager: *mut std::ffi::c_void,
        filename: *const std::ffi::c_char,
        mode: std::ffi::c_int,
    ) -> *mut std::ffi::c_void;
    fn AAsset_read(
        asset: *mut std::ffi::c_void,
        buffer: *mut std::ffi::c_void,
        count: usize,
    ) -> std::ffi::c_int;
    fn AAsset_close(asset: *mut std::ffi::c_void);
}

/// Open exactly one APK asset as a `Read` stream via NDK AAssetManager.
///
/// Directory enumeration is intentionally never used: it cannot recursively
/// enumerate public/ and node_modules/ in Android assets.
#[cfg(target_os = "android")]
fn open_asset_reader(asset_path: &str) -> Result<AndroidAssetReader, String> {
    const AASSET_MODE_STREAMING: std::ffi::c_int = 2;

    let ctx = ndk_context::android_context();
    let vm_ptr = ctx.vm();
    let context_ptr = ctx.context();
    if vm_ptr.is_null() || context_ptr.is_null() {
        return Err("ndk-context 未初始化（vm/context 为 null）".into());
    }

    let vm = unsafe { jni::JavaVM::from_raw(vm_ptr.cast()) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    // ndk-context owns this global Context ref. Do not let jni-rs delete it.
    let context = unsafe { jni::objects::JObject::from_raw(context_ptr.cast()) };
    let asset_manager = env
        .call_method(
            &context,
            "getAssets",
            "()Landroid/content/res/AssetManager;",
            &[],
        )
        .map_err(|e| format!("getAssets(): {e}"))?
        .l()
        .map_err(|e| format!("getAssets() non-object: {e}"))?;
    std::mem::forget(context);

    let manager = unsafe { AAssetManager_fromJava(env.get_raw(), asset_manager.as_raw()) };
    if manager.is_null() {
        return Err("AAssetManager_fromJava returned null".into());
    }
    let path = std::ffi::CString::new(asset_path).map_err(|e| e.to_string())?;
    let asset = unsafe { AAssetManager_open(manager, path.as_ptr(), AASSET_MODE_STREAMING) };
    if asset.is_null() {
        return Err(format!(
            "AAssetManager_open 失败: {asset_path}（APK 中可能缺少该 asset）"
        ));
    }
    Ok(AndroidAssetReader { asset })
}

/// Extract `assets/zephyr-core.tar` into `dest/zephyr-core/`.
///
/// Build ships one archive because AAssetDir cannot recurse into subdirs. This
/// is deliberately a plain tar: Android turns a `.tar.gz` asset into `.tar`,
/// and the outer APK ZIP performs compression already.
#[cfg(target_os = "android")]
fn extract_assets_core_tarball(dest: &Path) -> Result<PathBuf, String> {
    use tar::Archive;

    let core_dest = dest.join("zephyr-core");
    let staging = dest.join("zephyr-core.extracting");

    // Clean a previous partial extract before opening the asset stream.
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目录失败: {e}"))?;
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    // Stream directly from the APK to tar. No 136 MB temporary .tar is written
    // into filesDir, so first launch has less I/O and lower free-space demand.
    let reader = open_asset_reader("zephyr-core.tar")?;
    let mut archive = Archive::new(reader);
    archive
        .unpack(&staging)
        .map_err(|e| format!("解压 zephyr-core.tar 失败: {e}"))?;

    // stage-zephyr-core packs the *contents* of zephyr-core/ at archive root
    // (server.js, public/, …). Accept either layout.
    let unpacked = if staging.join("server.js").is_file() {
        staging.clone()
    } else if staging.join("zephyr-core").join("server.js").is_file() {
        staging.join("zephyr-core")
    } else {
        // single top-level dir?
        let mut found = None;
        if let Ok(rd) = std::fs::read_dir(&staging) {
            for ent in rd.flatten() {
                let p = ent.path();
                if p.is_dir() && p.join("server.js").is_file() {
                    found = Some(p);
                    break;
                }
            }
        }
        found.ok_or_else(|| "解压后未找到 server.js（tarball 布局异常）".to_string())?
    };

    if !unpacked.join("public").is_dir() {
        return Err("解压后未找到 public/ 目录".into());
    }

    // Atomic-ish replace: prefer rename, fall back to recursive copy
    let _ = std::fs::remove_dir_all(&core_dest);
    let move_or_copy = |from: &Path, to: &Path| -> Result<(), String> {
        match std::fs::rename(from, to) {
            Ok(()) => Ok(()),
            Err(rename_err) => {
                copy_dir_recursive(from, to)
                    .map_err(|e| format!("rename({rename_err}) 且 copy 失败: {e}"))?;
                let _ = std::fs::remove_dir_all(from);
                Ok(())
            }
        }
    };
    if unpacked == staging {
        move_or_copy(&staging, &core_dest)?;
    } else {
        move_or_copy(&unpacked, &core_dest)?;
        let _ = std::fs::remove_dir_all(&staging);
    }

    if !core_dest.join("server.js").is_file() {
        return Err("最终 core 缺少 server.js".into());
    }
    Ok(core_dest)
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
    // Android: filesDir staged core
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
                for abi in ["arm64", "arm64-v8a", "armeabi-v7a", "arm", "x86_64", "x86"] {
                    candidates.push(app_root.join("lib").join(abi).join("libnode.so"));
                }
            }
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

    // Android: extract zephyr-core.tar from APK assets to filesDir on first
    // run / version change. A single plain-tar asset avoids both AAssetDir
    // nested-directory loss and Android's `.tar.gz` asset-name rewrite.
    #[cfg(target_os = "android")]
    {
        let data_dir_check = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let core_dest = data_dir_check.join("zephyr-core");
        let version_marker = data_dir_check.join(".zephyr-one-app-version");
        let current_version = env!("CARGO_PKG_VERSION");
        let needs_copy = match std::fs::read_to_string(&version_marker) {
            Ok(v) => {
                v.trim() != current_version
                    || !core_dest.join("server.js").is_file()
                    || !core_dest.join("public").is_dir()
            }
            Err(_) => true,
        };
        if needs_copy {
            eprintln!(
                "[zephyr-one] extracting zephyr-core.tar (version {current_version})…"
            );
            extract_assets_core_tarball(&data_dir_check)?;
            let _ = std::fs::write(&version_marker, current_version);
            eprintln!("[zephyr-one] zephyr-core ready at {}", core_dest.display());
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
        // Be explicit instead of relying only on Node's Android platform label:
        // this core must never attempt the desktop better-sqlite3 addon.
        .env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Android: writable HOME/TMP + node stderr log (Stdio::null hides crash reasons)
    #[cfg(target_os = "android")]
    {
        if let Ok(data) = app.path().app_data_dir() {
            cmd.env("HOME", &data);
            cmd.env("TMPDIR", data.join("tmp"));
            let _ = std::fs::create_dir_all(data.join("tmp"));
            // Help Node find itself / avoid dlopen issues when invoked as libnode.so
            if let Some(dir) = node.parent() {
                let prev = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
                let joined = if prev.is_empty() {
                    dir.display().to_string()
                } else {
                    format!("{}:{}", dir.display(), prev)
                };
                cmd.env("LD_LIBRARY_PATH", joined);
            }
            let log_path = data.join("zephyr-node-stderr.log");
            match std::fs::File::create(&log_path) {
                Ok(f) => {
                    cmd.stderr(Stdio::from(f));
                }
                Err(e) => {
                    eprintln!("[zephyr-one] cannot open node stderr log: {e}");
                }
            }
        }
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
        // Keep child around so a subsequent runtime_start can inspect / retry
        // against the same port if still alive; surface timeout to UI.
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
