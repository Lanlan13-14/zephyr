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
//! `std::fs`. Instead, we embed `zephyr-core.tar.gz` in the `.so` via
//! `include_bytes!()` and extract it to `app_data_dir/zephyr-core/` on first run.

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

/// Copy bundled zephyr-core from APK assets to `dest/zephyr-core/` using the
/// Android NDK AssetManager. No archive, no decompression — just file copies.
///
/// On Android, Tauri `resource_dir()` returns `"asset://localhost/"` (virtual URI);
/// APK assets are not accessible via `std::fs`. We traverse the AssetManager tree
/// and copy each file individually to the app's filesDir.
#[cfg(target_os = "android")]
fn copy_assets_core(dest: &Path) -> Result<PathBuf, String> {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_void};

    type AAssetManager = c_void;
    type AAssetDir = c_void;
    type AAsset = c_void;
    const AASSET_MODE_STREAMING: c_int = 2;

    #[link(name = "android")]
    extern "C" {
        fn AAssetManager_fromJava(
            env: *mut jni::sys::JNIEnv,
            assetManager: jni::sys::jobject,
        ) -> *mut AAssetManager;
        fn AAssetManager_openDir(
            mgr: *mut AAssetManager,
            dirName: *const c_char,
        ) -> *mut AAssetDir;
        fn AAssetManager_open(
            mgr: *mut AAssetManager,
            filename: *const c_char,
            mode: c_int,
        ) -> *mut AAsset;
        fn AAssetDir_getNextFileName(dir: *mut AAssetDir) -> *const c_char;
        fn AAssetDir_close(dir: *mut AAssetDir);
        fn AAsset_getLength(asset: *mut AAsset) -> i64;
        fn AAsset_read(asset: *mut AAsset, buf: *mut c_void, count: usize) -> c_int;
        fn AAsset_close(asset: *mut AAsset);
    }

    /// Recursively copy `asset_dir` (relative to APK assets root) to `fs_dir`.
    fn copy_dir(
        mgr: *mut AAssetManager,
        asset_dir: &str,
        fs_dir: &Path,
    ) -> Result<(), String> {
        let c_dir = CString::new(asset_dir).map_err(|e| e.to_string())?;
        let dir = unsafe { AAssetManager_openDir(mgr, c_dir.as_ptr()) };
        if dir.is_null() {
            return Err(format!("AAssetManager_openDir failed: {asset_dir}"));
        }
        std::fs::create_dir_all(fs_dir).map_err(|e| e.to_string())?;

        loop {
            let name_ptr = unsafe { AAssetDir_getNextFileName(dir) };
            if name_ptr.is_null() {
                break;
            }
            let name =
                unsafe { CStr::from_ptr(name_ptr) }.to_string_lossy().into_owned();
            let asset_path = if asset_dir.is_empty() {
                name.clone()
            } else {
                format!("{asset_dir}/{name}")
            };
            let dest_file = fs_dir.join(&name);

            // Try opening as a file first
            let c_path = CString::new(asset_path.as_str()).map_err(|e| e.to_string())?;
            let asset =
                unsafe { AAssetManager_open(mgr, c_path.as_ptr(), AASSET_MODE_STREAMING) };

            if !asset.is_null() {
                // It's a file — copy bytes
                if let Some(parent) = dest_file.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                use std::io::Write;
                let mut file =
                    std::fs::File::create(&dest_file).map_err(|e| e.to_string())?;
                let mut buf = vec![0u8; 131072];
                loop {
                    let n = unsafe {
                        AAsset_read(asset, buf.as_mut_ptr() as *mut c_void, buf.len())
                    };
                    if n <= 0 {
                        break;
                    }
                    file.write_all(&buf[..n as usize])
                        .map_err(|e| e.to_string())?;
                }
                unsafe { AAsset_close(asset) };
            } else {
                // Might be a subdirectory — recurse
                copy_dir(mgr, &asset_path, &dest_file)?;
            }
        }
        unsafe { AAssetDir_close(dir) };
        Ok(())
    }

    // ── Get AAssetManager via JNI + ndk-context ──
    let ctx = ndk_context::android_context();
    let vm_raw = ctx.vm as *mut jni::sys::JavaVM;
    let context_raw = ctx.context as jni::sys::jobject;
    if vm_raw.is_null() || context_raw.is_null() {
        return Err("ndk-context 未初始化（vm/context 为 null）".into());
    }

    let vm = unsafe { jni::JavaVM::from_raw(vm_raw) }
        .map_err(|e| format!("JavaVM::from_raw: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach_current_thread: {e}"))?;

    // Context.getAssets() -> AssetManager
    let context = unsafe { jni::objects::JObject::from_raw(context_raw) };
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
    // Prevent DeleteLocalRef on the global ref
    std::mem::forget(context);

    let mgr = unsafe { AAssetManager_fromJava(env.get_raw(), asset_manager.as_raw()) };
    if mgr.is_null() {
        return Err("AAssetManager_fromJava returned null".into());
    }

    // ── Copy assets/zephyr-core/ -> dest/zephyr-core/ ──
    let core_dest = dest.join("zephyr-core");
    let _ = std::fs::remove_dir_all(&core_dest);
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目录失败: {e}"))?;

    copy_dir(mgr, "zephyr-core", &core_dest)?;

    if !core_dest.join("server.js").is_file() {
        return Err("拷贝后未找到 server.js，assets 中可能缺少 zephyr-core".into());
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

    // Android: copy zephyr-core from APK assets to filesDir on first run.
    // Tauri resource_dir() returns "asset://localhost/" (virtual URI) on Android;
    // APK assets are not accessible via std::fs. We use the NDK AssetManager to
    // copy individual files from assets/zephyr-core/ to app_data_dir/zephyr-core/.
    #[cfg(target_os = "android")]
    {
        let data_dir_check = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let core_dest = data_dir_check.join("zephyr-core");
        let version_marker = core_dest.join(".zephyr-one-app-version");
        let current_version = env!("CARGO_PKG_VERSION");
        let needs_copy = match std::fs::read_to_string(&version_marker) {
            Ok(v) => v.trim() != current_version || !core_dest.join("server.js").is_file(),
            Err(_) => true,
        };
        if needs_copy {
            copy_assets_core(&data_dir_check)?;
            let _ = std::fs::write(&version_marker, current_version);
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

    // Android: give node a writable HOME/TMP (default HOME may be unset/inaccessible)
    #[cfg(target_os = "android")]
    {
        if let Ok(data) = app.path().app_data_dir() {
            cmd.env("HOME", &data);
            cmd.env("TMPDIR", data.join("tmp"));
            let _ = std::fs::create_dir_all(data.join("tmp"));
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
