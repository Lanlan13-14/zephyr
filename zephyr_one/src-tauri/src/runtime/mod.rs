//! Local Zephyr core runtime (full product).
//!
//! Node resolution (open-box, no first-run extract UI):
//! - **Android**: `libnode.so` shipped in `jniLibs/<abi>/` — PackageManager
//!   extracts native libs at install into `nativeLibraryDir`; we exec that path.
//! - **Desktop**: bundled `desktop-runtime/node[.exe]`, with PATH as a dev fallback.
//!
//! Remote Zephyr main is sync-only; day-to-day UI is always this loopback core.
//!
//! **Android no-extract embedding**: the dependency-complete server entry is one
//! `assets/zephyr-core.cjs` file streamed directly to Node stdin. Public files
//! stay in `base.apk`; the Node core reads individual ZIP entries on demand.
//! First launch never expands the product core into app data.

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

/// A streaming reader over one APK asset. `Drop` closes the NDK handle.
///
/// Used to stream one build-time asset directly into the child process.
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

#[cfg(target_os = "android")]
fn run_on_android_context<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: for<'env, 'activity> FnOnce(
            &mut jni::JNIEnv<'env>,
            &jni::objects::JObject<'activity>,
        ) -> Result<T, String>
        + Send
        + 'static,
{
    let webview = app
        .webviews()
        .into_values()
        .next()
        .ok_or_else(|| "Android WebView 尚未初始化".to_string())?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |webview| {
            webview
                .jni_handle()
                .exec(move |env, activity, _webview| {
                    let _ = tx.send(operation(env, activity));
                });
        })
        .map_err(|error| format!("无法调度 Android JNI 操作: {error}"))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|error| format!("等待 Android JNI 操作超时: {error}"))?
}

/// Open exactly one APK asset as a `Read` stream via Tauri's initialized JNI
/// context and the NDK AAssetManager. The opaque AAsset is opened on the
/// WebView thread, then exclusively owned and read by the startup worker.
#[cfg(target_os = "android")]
fn open_asset_reader(app: &AppHandle, asset_path: &str) -> Result<AndroidAssetReader, String> {
    const AASSET_MODE_STREAMING: std::ffi::c_int = 2;
    let path = asset_path.to_string();
    let asset = run_on_android_context(app, move |env, activity| {
        let asset_manager = env
            .call_method(
                activity,
                "getAssets",
                "()Landroid/content/res/AssetManager;",
                &[],
            )
            .map_err(|error| format!("getAssets(): {error}"))?
            .l()
            .map_err(|error| format!("getAssets() non-object: {error}"))?;
        let manager = unsafe { AAssetManager_fromJava(env.get_raw(), asset_manager.as_raw()) };
        if manager.is_null() {
            return Err("AAssetManager_fromJava returned null".into());
        }
        let c_path = std::ffi::CString::new(path.as_str()).map_err(|error| error.to_string())?;
        let asset = unsafe { AAssetManager_open(manager, c_path.as_ptr(), AASSET_MODE_STREAMING) };
        if asset.is_null() {
            Err(format!("AAssetManager_open 失败: {path}（APK 中可能缺少该 asset）"))
        } else {
            Ok(asset as usize)
        }
    })?;
    Ok(AndroidAssetReader {
        asset: asset as *mut std::ffi::c_void,
    })
}

#[cfg(target_os = "android")]
fn android_apk_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = run_on_android_context(app, |env, activity| {
        let value = env
            .call_method(
                activity,
                "getPackageResourcePath",
                "()Ljava/lang/String;",
                &[],
            )
            .map_err(|error| format!("getPackageResourcePath(): {error}"))?
            .l()
            .map_err(|error| format!("getPackageResourcePath() non-object: {error}"))?;
        let value = jni::objects::JString::from(value);
        let path: String = env
            .get_string(&value)
            .map_err(|error| format!("读取 APK 路径失败: {error}"))?
            .into();
        Ok(path)
    })?;
    if path.is_empty() {
        Err("Android 返回了空 APK 路径".into())
    } else {
        Ok(PathBuf::from(path))
    }
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
    // Android: filesDir staged core
    if let Ok(data) = app.path().app_data_dir() {
        candidates.push(data.join("zephyr-core"));
        candidates.push(data.join("..").join("zephyr-core"));
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
                // jniLibs are executable after installation. chmod is both
                // unnecessary and denied by Android SELinux for APK files.
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
}

#[cfg(not(target_os = "android"))]
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

    #[cfg(not(target_os = "android"))]
    let core = resolve_core_dir(app)?;

    let node = node_compatible_path(resolve_node_bin(app)?);
    let port = pick_port().map_err(|e| e.to_string())?;
    let public_origin = format!("http://127.0.0.1:{port}");

    let mut cmd = Command::new(&node);
    #[cfg(not(target_os = "android"))]
    cmd.current_dir(&core).arg(core.join("server.js"));
    #[cfg(target_os = "android")]
    cmd.current_dir(&data_dir).arg("-");

    cmd.env("ZEPHYR_DATA_DIR", &data_dir)
        .env("HTTP_ENABLED", "true")
        .env("HTTPS_ENABLED", "false")
        .env("PORT", port.to_string())
        .env("PUBLIC_ORIGIN", &public_origin)
        .env("ALLOW_DEFAULT_PASSWORD_REMOTE_LOGIN", "true")
        .env("TRUST_PROXY", "false")
        .env("ZEPHYR_ONE_EMBEDDED", "1")
        .env("ZEPHYR_VERSION", env!("CARGO_PKG_VERSION"))
        // Be explicit instead of relying only on Node's Android platform label:
        // this core must never attempt the desktop better-sqlite3 addon.
        .env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1");

    #[cfg(not(target_os = "android"))]
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "android")]
    cmd.stdin(Stdio::piped());

    let log_path = data_dir.join("zephyr-node.log");
    if let Ok(log) = std::fs::File::create(&log_path) {
        if let Ok(stdout) = log.try_clone() {
            cmd.stdout(Stdio::from(stdout));
        }
        cmd.stderr(Stdio::from(log));
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }

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
            let apk_path = android_apk_path(app)?;
            cmd.env("ZEPHYR_ANDROID_APK_PATH", apk_path);
            cmd.env("ZEPHYR_ANDROID_PUBLIC_PREFIX", "assets/zephyr-public");
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        #[cfg(not(target_os = "android"))]
        let core_display = core.display().to_string();
        #[cfg(target_os = "android")]
        let core_display = "APK assets/zephyr-core.cjs".to_string();
        format!(
            "启动本地 Node/Zephyr 失败: {e}（node={} core={}）",
            node.display(),
            core_display
        )
    })?;

    #[cfg(target_os = "android")]
    {
        use std::io::Write;
        let mut source = open_asset_reader(app, "zephyr-core.cjs")?;
        let mut stdin = child.stdin.take().ok_or_else(|| "无法打开 Node 标准输入".to_string())?;
        if let Err(error) = std::io::copy(&mut source, &mut stdin).and_then(|_| stdin.flush()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("向 Node 流式载入内置核心失败：{error}"));
        }
        drop(stdin);
    }

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

#[cfg(all(test, not(target_os = "android")))]
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
