//! Local Zephyr core runtime (full product), desktop only.
//!
//! Node resolution (open-box, no first-run extract UI): the bundled
//! `desktop-runtime/node[.exe]` shipped as a Tauri resource, with `PATH` as a
//! development fallback.
//!
//! Remote Zephyr main is sync-only; day-to-day UI is always this loopback core.

use getrandom::fill as fill_random;
use hmac::{Hmac, Mac};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

#[cfg(target_os = "windows")]
mod windows_child_job;

static RUNTIME: OnceCell<Mutex<RuntimeState>> = OnceCell::new();

const STARTUP_CHALLENGE_ENV: &str = "ZEPHYR_ONE_STARTUP_CHALLENGE";
const READY_PROBE_HEADER: &str = "X-Zephyr-One-Ready-Probe";
const READY_PROOF_HEADER: &str = "X-Zephyr-One-Ready-Proof";
const BOOTSTRAP_HEADER: &str = "X-Zephyr-One-Bootstrap-Challenge";
const READY_CONTEXT: &[u8] = b"zephyr-one-ready-v1\0";

struct StartupChallenge([u8; 32]);

impl StartupChallenge {
    fn generate() -> Result<Self, String> {
        let mut bytes = [0_u8; 32];
        fill_random(&mut bytes)
            .map_err(|error| format!("unable to generate embedded startup challenge: {error}"))?;
        Ok(Self(bytes))
    }

    fn encoded(&self) -> String {
        encode_hex(&self.0)
    }
}

impl Drop for StartupChallenge {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Clone)]
struct AutostartLog {
    lines: Arc<Mutex<Vec<String>>>,
    file: Option<PathBuf>,
}

impl AutostartLog {
    fn append(&self, message: &str) {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        let mut lines = self.lines.lock();
        if lines.len() == 64 {
            lines.remove(0);
        }
        lines.push(format!(
            "{millis} pid={} thread={thread_name} {message}",
            std::process::id()
        ));
        if let Some(ref log_path) = self.file {
            let text = lines.last().map(|l| format!("{l}\n")).unwrap_or_default();
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
                .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
        }
    }
}

/// Windows release builds must not depend on the WebView reaching JavaScript
/// before the local product core is started. The environment variable remains
/// an explicit override for smoke tests, development, and support diagnostics.
pub(crate) fn should_autostart(config: Option<&str>, windows_release: bool) -> bool {
    match config.map(str::trim) {
        Some(value)
            if ["1", "true", "yes", "on"]
                .iter()
                .any(|enabled| value.eq_ignore_ascii_case(enabled)) =>
        {
            true
        }
        Some(value)
            if ["0", "false", "no", "off"]
                .iter()
                .any(|disabled| value.eq_ignore_ascii_case(disabled)) =>
        {
            false
        }
        _ => windows_release,
    }
}

fn spawn_logged_worker<F>(log: AutostartLog, work: F) -> std::io::Result<JoinHandle<()>>
where
    F: FnOnce(AutostartLog) + Send + 'static,
{
    std::thread::Builder::new()
        .name("zephyr-runtime-autostart".into())
        .spawn(move || {
            log.append("worker entered");
            work(log);
        })
}

/// Schedule blocking Node boot after Tauri has built the application, without
/// depending on WebView JavaScript or a platform-specific event callback.
/// Every boundary is logged outside Node so a missing child process still has
/// an actionable cause in the app data directory.
pub(crate) fn spawn_autostart(app: AppHandle) {
    let log_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("zephyr-data").join("zephyr-autostart.log"));
    if let Some(ref lp) = log_path {
        let _ = std::fs::create_dir_all(lp.parent().unwrap_or(std::path::Path::new(".")));
    }
    let log = AutostartLog {
        lines: Arc::new(Mutex::new(Vec::new())),
        file: log_path,
    };
    log.append("ready event received; scheduling worker");
    let worker_log = log.clone();
    match spawn_logged_worker(worker_log, move |worker_log| {
        match ensure_started_inner(&app, false) {
            Ok(info) => worker_log.append(&format!(
                "runtime ready port={} node={}",
                info.port, info.node_path
            )),
            Err(error) => worker_log.append(&format!("runtime start failed: {error}")),
        }
    }) {
        Ok(_handle) => log.append("worker spawned"),
        Err(error) => log.append(&format!("worker spawn failed: {error}")),
    }
}

#[derive(Default)]
struct RuntimeState {
    child: Option<Child>,
    #[cfg(target_os = "windows")]
    child_job: Option<windows_child_job::ChildJob>,
    port: u16,
    base_url: String,
    startup_challenge: Option<StartupChallenge>,
    session_ready: bool,
    session_id: Option<Zeroizing<String>>,
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

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn capture_pipe<R: Read + Send + 'static>(mut pipe: R, log: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 2048];
        while let Ok(count) = pipe.read(&mut chunk) {
            if count == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&chunk[..count]);
            let mut captured = log.lock();
            captured.push_str(&text);
            if captured.len() > 64 * 1024 {
                let split = captured
                    .char_indices()
                    .find(|(index, _)| *index >= captured.len() - 64 * 1024)
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                captured.drain(..split);
            }
        }
    });
}

fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, slot) in decoded.iter_mut().enumerate() {
        let start = index * 2;
        *slot = u8::from_str_radix(&value[start..start + 2], 16).ok()?;
    }
    Some(decoded)
}

fn readiness_mac(challenge: &[u8; 32], probe: &[u8; 32], port: u16) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(challenge).expect("HMAC accepts keys of every length");
    mac.update(READY_CONTEXT);
    mac.update(probe);
    mac.update(b"\0");
    mac.update(port.to_string().as_bytes());
    mac
}

fn readiness_proof_matches(challenge: &[u8; 32], probe: &[u8; 32], port: u16, proof: &str) -> bool {
    let Some(decoded) = decode_hex_32(proof) else {
        return false;
    };
    readiness_mac(challenge, probe, port)
        .verify_slice(&decoded)
        .is_ok()
}

fn wait_http_ready_with_probe(
    child: &mut Child,
    url: &str,
    port: u16,
    challenge: &StartupChallenge,
    probe: &[u8; 32],
    timeout: Duration,
) -> Result<(), String> {
    let probe_hex = encode_hex(probe);
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .build();
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(status)) => return Err(format!("本地 Zephyr 进程提前退出（{status}）")),
            Ok(None) => {}
            Err(error) => return Err(format!("无法读取本地 Zephyr 进程状态：{error}")),
        }
        if let Ok(resp) = agent
            .get(url)
            .set(READY_PROBE_HEADER, &probe_hex)
            .timeout(Duration::from_secs(2))
            .call()
        {
            if resp.status() == 200
                && resp
                    .header(READY_PROOF_HEADER)
                    .is_some_and(|proof| readiness_proof_matches(&challenge.0, probe, port, proof))
            {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("本地 Zephyr 启动超时（{url}）"))
}

fn wait_http_ready(
    child: &mut Child,
    url: &str,
    port: u16,
    challenge: &StartupChallenge,
    timeout: Duration,
) -> Result<(), String> {
    let mut probe = [0_u8; 32];
    fill_random(&mut probe)
        .map_err(|error| format!("unable to generate embedded readiness probe: {error}"))?;
    let result = wait_http_ready_with_probe(child, url, port, challenge, &probe, timeout);
    probe.fill(0);
    result
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
    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("zephyr-core"));
            candidates.push(cwd.join("..").join("zephyr-core"));
            candidates.push(cwd.join(".."));
        }
        if let Ok(data) = app.path().app_data_dir() {
            candidates.push(data.join("zephyr-core"));
        }
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
/// debug builds may use `ZEPHYR_NODE_PATH`, the current tree, or `PATH`.
pub fn resolve_node_bin(app: &AppHandle) -> Result<PathBuf, String> {
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
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("ZEPHYR_NODE_PATH") {
            let candidate = PathBuf::from(value);
            if candidate.is_file() {
                return Ok(candidate);
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
        if let Some(node) = which_node() {
            return Ok(node);
        }
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

fn session_id_from_set_cookie(value: &str) -> Option<&str> {
    let pair = value.split(';').next()?.trim();
    let sid = pair.strip_prefix("zephyr_sid=")?;
    if !(43..=128).contains(&sid.len())
        || !sid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(sid)
}

fn exchange_bootstrap(base_url: &str, challenge: &StartupChallenge) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .build();
    let response = agent
        .post(&format!(
            "{}/__zephyr_one/bootstrap",
            base_url.trim_end_matches('/')
        ))
        .set(BOOTSTRAP_HEADER, &challenge.encoded())
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|error| format!("embedded bootstrap request failed: {error}"))?;
    if response.status() != 204 {
        return Err(format!(
            "embedded bootstrap returned unexpected status {}",
            response.status()
        ));
    }
    let header = response
        .header("Set-Cookie")
        .ok_or_else(|| "embedded bootstrap omitted its session cookie".to_string())?;
    session_id_from_set_cookie(header)
        .map(str::to_owned)
        .ok_or_else(|| "embedded bootstrap returned an invalid session cookie".to_string())
}

fn install_session_cookie(app: &AppHandle, sid: &str) -> Result<(), String> {
    let webviews = app.webview_windows();
    if webviews.is_empty() {
        return Err("embedded bootstrap cannot find the application webview".into());
    }
    for webview in webviews.values() {
        let cookie = tauri::webview::cookie::Cookie::build(("zephyr_sid", sid.to_owned()))
            .domain("127.0.0.1")
            .path("/")
            .http_only(true)
            .same_site(tauri::webview::cookie::SameSite::Strict)
            .build();
        webview
            .set_cookie(cookie)
            .map_err(|error| format!("unable to install the embedded session cookie: {error}"))?;
    }
    Ok(())
}

fn provision_session(
    app: &AppHandle,
    base_url: &str,
    challenge: &StartupChallenge,
) -> Result<Zeroizing<String>, String> {
    let sid = exchange_bootstrap(base_url, challenge)?;
    install_session_cookie(app, &sid)?;
    Ok(Zeroizing::new(sid))
}

fn clear_runtime_state(st: &mut RuntimeState) {
    #[cfg(target_os = "windows")]
    {
        st.child_job = None;
    }
    st.startup_challenge = None;
    st.session_ready = false;
    st.session_id = None;
    st.port = 0;
    st.base_url.clear();
    st.data_dir.clear();
    st.node_path.clear();
}

fn terminate_runtime(st: &mut RuntimeState) {
    if let Some(mut child) = st.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    clear_runtime_state(st);
}

pub fn ensure_started(app: &AppHandle) -> Result<RuntimeInfo, String> {
    ensure_started_inner(app, true)
}

fn ensure_started_inner(app: &AppHandle, provision_webview: bool) -> Result<RuntimeInfo, String> {
    let mut st = state().lock();
    let child_running = st
        .child
        .as_mut()
        .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
    if child_running {
        if provision_webview && !st.session_ready {
            let Some(challenge) = st.startup_challenge.take() else {
                terminate_runtime(&mut st);
                return Err("embedded runtime lost its unconsumed startup challenge".into());
            };
            let base_url = st.base_url.clone();
            let session_id = match provision_session(app, &base_url, &challenge) {
                Ok(session_id) => session_id,
                Err(error) => {
                    terminate_runtime(&mut st);
                    return Err(error);
                }
            };
            st.session_id = Some(session_id);
            st.session_ready = true;
        }
        return Ok(RuntimeInfo {
            running: true,
            base_url: st.base_url.clone(),
            port: st.port,
            data_dir: st.data_dir.to_string_lossy().into_owned(),
            mode: "local-node".into(),
            node_path: st.node_path.to_string_lossy().into_owned(),
        });
    }
    if st.child.is_some() {
        terminate_runtime(&mut st);
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zephyr-data");

    let core = resolve_core_dir(app)?;

    let node = node_compatible_path(resolve_node_bin(app)?);
    let port = pick_port().map_err(|e| e.to_string())?;
    let public_origin = format!("http://127.0.0.1:{port}");
    let startup_challenge = StartupChallenge::generate()?;
    let startup_challenge_encoded = startup_challenge.encoded();

    let mut cmd = {
        let mut command = Command::new(&node);
        command.arg(core.join("server.js"));
        command.current_dir(&core);
        command
    };

    // Process-local authentication for privileged shell handoffs. These values
    // are inherited only by the embedded core and must never enter RuntimeInfo,
    // boot markers, or diagnostics.
    let (shell_secret, shell_instance) = crate::unlock_bridge::shell_identity_env();

    cmd.env("ZEPHYR_DATA_DIR", &data_dir)
        .env("HTTP_ENABLED", "true")
        .env("HTTPS_ENABLED", "false")
        .env("PORT", port.to_string())
        .env("PUBLIC_ORIGIN", &public_origin)
        .env("TRUST_PROXY", "false")
        .env("ZEPHYR_ONE_EMBEDDED", "1")
        .env(STARTUP_CHALLENGE_ENV, &startup_challenge_encoded)
        .env("ZEPHYR_ONE_SHELL_SECRET", shell_secret)
        .env("ZEPHYR_ONE_SHELL_INSTANCE", shell_instance)
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
        .env("ZEPHYR_ONE_USE_BUILTIN_SQLITE", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "启动本地 Node/Zephyr 失败: {e}（node={} core={}）",
            node.display(),
            core.display()
        )
    })?;
    let child_log = Arc::new(Mutex::new(String::new()));
    #[cfg(target_os = "windows")]
    let child_job = match windows_child_job::ChildJob::assign(&child) {
        Ok(job) => Some(job),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "embedded Node cannot enter its Windows cleanup job: {error}"
            ));
        }
    };
    if let Some(stdout) = child.stdout.take() {
        capture_pipe(stdout, child_log.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        capture_pipe(stderr, child_log.clone());
    }

    let health = format!("{public_origin}/healthz");
    if let Err(reason) = wait_http_ready(
        &mut child,
        &health,
        port,
        &startup_challenge,
        Duration::from_secs(60),
    ) {
        let _ = child.kill();
        let _ = child.wait();
        let details = Some(child_log.lock().clone())
            .filter(|text| !text.trim().is_empty())
            .map(|text| format!("\n\n运行日志：\n{text}"))
            .unwrap_or_default();
        return Err(format!("{reason}{details}"));
    }

    let provisioned_session = if provision_webview {
        let session_id = match provision_session(app, &public_origin, &startup_challenge) {
            Ok(session_id) => session_id,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(status)) => {
                return Err(format!(
                    "embedded core exited after bootstrap before handoff ({status})"
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "unable to verify embedded core after bootstrap: {error}"
                ));
            }
        }
        Some(session_id)
    } else {
        None
    };

    st.child = Some(child);
    #[cfg(target_os = "windows")]
    {
        st.child_job = child_job;
    }
    st.port = port;
    st.base_url = public_origin.clone();
    st.startup_challenge = if provision_webview {
        None
    } else {
        Some(startup_challenge)
    };
    st.session_ready = provision_webview;
    st.session_id = provisioned_session;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoreRdpAuthorization {
    connection_id: String,
    session_id: String,
    owner_label: String,
    host: String,
    port: u32,
    username: String,
    password: String,
    domain: String,
    security: String,
    ignore_certificate: bool,
    audio_mode: String,
    microphone: bool,
    clipboard: bool,
    drive_mapping_requested: bool,
    dynamic_resolution: bool,
    gfx: bool,
    disable_wallpaper: bool,
    disable_themes: bool,
    disable_menu_anims: bool,
    disable_full_window_drag: bool,
    allow_font_smoothing: bool,
}

/// Resolve a saved RDP connection through the authenticated embedded core.
///
/// This bridge is intentionally unavailable without both the private shell HMAC
/// and Rust's retained HttpOnly app session. The response is consumed in Rust;
/// neither credentials nor resolved target metadata are returned to WebView JS.
pub(crate) fn authorize_native_rdp(
    app: &AppHandle,
    connection_id: &str,
    session_id: &str,
    owner_label: &str,
) -> Result<crate::rdp::broker::AuthorizedConnection, String> {
    ensure_started(app)?;
    let (base_url, app_session) = {
        let mut st = state().lock();
        let running = st
            .child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
        if !running || !st.session_ready {
            return Err("rdp_broker_core_unavailable: embedded core is not authenticated".into());
        }
        let app_session = st.session_id.as_ref().ok_or_else(|| {
            "rdp_broker_core_unavailable: embedded core session is missing".to_string()
        })?;
        (
            st.base_url.clone(),
            Zeroizing::new(app_session.as_str().to_owned()),
        )
    };

    let body = serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "sessionId": session_id,
        "ownerLabel": owner_label,
    }))
    .map_err(|error| format!("rdp_broker_request_invalid: {error}"))?;
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .build();
    let fields = [connection_id, session_id, owner_label];
    let request = crate::unlock_bridge::signed_request(
        agent
            .post(&format!(
                "{}/api/one/rdp/native/authorize-open",
                base_url.trim_end_matches('/')
            ))
            .set("Content-Type", "application/json")
            .set("Accept", "application/json")
            .set("X-Zephyr-Sid", app_session.as_str())
            .timeout(Duration::from_secs(15)),
        "rdp_native.authorize_open",
        &fields,
    );
    let response = request.send_string(&body).map_err(|error| match error {
        ureq::Error::Status(status, _) => {
            format!("rdp_broker_core_denied: embedded core returned HTTP {status}")
        }
        ureq::Error::Transport(error) => {
            format!("rdp_broker_core_unavailable: embedded core request failed: {error}")
        }
    })?;
    if response.status() != 200
        || !response
            .header("Cache-Control")
            .is_some_and(|value| value.eq_ignore_ascii_case("no-store"))
    {
        return Err(
            "rdp_broker_core_invalid_response: authorization response was not non-cacheable".into(),
        );
    }
    let mut limited = response.into_reader().take(64 * 1024);
    let resolved: CoreRdpAuthorization = serde_json::from_reader(&mut limited)
        .map_err(|_| "rdp_broker_core_invalid_response: malformed authorization".to_string())?;

    if resolved.drive_mapping_requested {
        return Err(
            "rdp_drive_mapping_disabled: native drive mapping requires a handle-based channel"
                .into(),
        );
    }
    if resolved.ignore_certificate {
        return Err(
            "rdp_certificate_bypass_disabled: certificate verification cannot be disabled".into(),
        );
    }
    let security = match resolved.security.trim().to_ascii_lowercase().as_str() {
        "nla" => crate::rdp::Security::Nla,
        "auto" if resolved.password.is_empty() => crate::rdp::Security::Auto,
        "tls" if resolved.password.is_empty() => crate::rdp::Security::Tls,
        "rdp" => {
            return Err(
                "rdp_legacy_security_disabled: Standard RDP Security is not supported".into(),
            )
        }
        _ => {
            return Err(
                "rdp_broker_core_invalid_response: invalid credential security policy".into(),
            )
        }
    };
    let audio = crate::rdp::AudioMode::parse(&resolved.audio_mode).ok_or_else(|| {
        "rdp_broker_core_invalid_response: invalid audio channel policy".to_string()
    })?;
    let defaults = crate::rdp::Config::default();

    Ok(crate::rdp::broker::AuthorizedConnection {
        connection_id: resolved.connection_id,
        session_id: resolved.session_id,
        owner_label: resolved.owner_label,
        config: crate::rdp::Config {
            host: resolved.host,
            port: resolved.port,
            username: resolved.username,
            password: resolved.password,
            domain: resolved.domain,
            width: defaults.width,
            height: defaults.height,
            color_depth: defaults.color_depth,
            security,
            ignore_certificate: false,
            audio,
            microphone: resolved.microphone,
            clipboard: resolved.clipboard && crate::rdp::clipboard_available(),
            drive_name: String::new(),
            drive_path: String::new(),
            drive_read_only: true,
            dynamic_resolution: resolved.dynamic_resolution,
            gfx: resolved.gfx,
            disable_wallpaper: resolved.disable_wallpaper,
            disable_themes: resolved.disable_themes,
            disable_menu_anims: resolved.disable_menu_anims,
            disable_full_window_drag: resolved.disable_full_window_drag,
            allow_font_smoothing: resolved.allow_font_smoothing,
        },
    })
}

pub fn stop() {
    let mut st = state().lock();
    terminate_runtime(&mut st);
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
        clear_runtime_state(&mut st);
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
    // node_compatible_path and PathBuf are only referenced by the
    // cfg(target_os = "windows") test below; importing them unconditionally
    // warns on the Linux and macOS builds.
    #[cfg(target_os = "windows")]
    use super::node_compatible_path;
    use super::{
        encode_hex, readiness_mac, readiness_proof_matches, resource_candidates,
        session_id_from_set_cookie, should_autostart, spawn_logged_worker,
        wait_http_ready_with_probe, AutostartLog, StartupChallenge, STARTUP_CHALLENGE_ENV,
    };
    use hmac::Mac;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    #[cfg(target_os = "windows")]
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::thread::JoinHandle;
    use std::time::Duration;

    #[test]
    fn packaged_parent_resources_are_discoverable() {
        let candidates = resource_candidates(Path::new("C:/Program/Zephyr One"), "zephyr-core");
        assert!(candidates
            .iter()
            .any(|path| path.ends_with("_up_/zephyr-core")));
        let runtime = resource_candidates(Path::new("C:/Program/Zephyr One"), "desktop-runtime");
        assert!(runtime
            .iter()
            .any(|path| path.ends_with("_up_/desktop-runtime")));
    }

    #[test]
    fn startup_challenges_are_256_bit_ascii_and_fresh() {
        let first = StartupChallenge::generate().unwrap();
        let second = StartupChallenge::generate().unwrap();
        assert_eq!(first.0.len() * 8, 256);
        assert_eq!(first.encoded().len(), 64);
        assert!(first.encoded().bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first.0, second.0);
    }

    fn sleeping_child() -> Child {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 10",
            ]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 10"]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn crashing_child() -> Child {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/C", "exit", "23"]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 23"]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn serve_health(listener: TcpListener, proof: String) -> (Arc<AtomicBool>, JoinHandle<()>) {
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
                        let mut request = [0_u8; 2048];
                        let _ = stream.read(&mut request);
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\nX-Zephyr-One-Ready-Proof: {proof}\r\n\r\n{{\"ok\":true}}"
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        (stop, worker)
    }

    #[test]
    fn readiness_proof_is_bound_to_challenge_probe_and_port() {
        let challenge = [0x11; 32];
        let probe = [0x22; 32];
        let proof = encode_hex(
            &readiness_mac(&challenge, &probe, 43123)
                .finalize()
                .into_bytes(),
        );
        assert!(readiness_proof_matches(&challenge, &probe, 43123, &proof));
        assert!(!readiness_proof_matches(&[0x12; 32], &probe, 43123, &proof));
        assert!(!readiness_proof_matches(
            &challenge,
            &[0x23; 32],
            43123,
            &proof
        ));
        assert!(!readiness_proof_matches(&challenge, &probe, 43124, &proof));
    }

    #[test]
    fn a_real_port_takeover_with_fake_health_is_rejected() {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let attacker = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let (stop, worker) = serve_health(attacker, "00".repeat(32));
        let mut child = sleeping_child();
        let result = wait_http_ready_with_probe(
            &mut child,
            &format!("http://127.0.0.1:{port}/healthz"),
            port,
            &StartupChallenge([0x31; 32]),
            &[0x41; 32],
            Duration::from_millis(450),
        );
        let _ = child.kill();
        let _ = child.wait();
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap();
        assert!(
            result.is_err(),
            "an arbitrary 200 response must not become ready"
        );
    }

    #[test]
    fn authenticated_health_from_the_expected_child_is_accepted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let challenge = [0x51; 32];
        let probe = [0x61; 32];
        let proof = encode_hex(
            &readiness_mac(&challenge, &probe, port)
                .finalize()
                .into_bytes(),
        );
        let (stop, worker) = serve_health(listener, proof);
        let mut child = sleeping_child();
        let result = wait_http_ready_with_probe(
            &mut child,
            &format!("http://127.0.0.1:{port}/healthz"),
            port,
            &StartupChallenge(challenge),
            &probe,
            Duration::from_secs(2),
        );
        let _ = child.kill();
        let _ = child.wait();
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap();
        assert!(result.is_ok());
    }

    #[test]
    fn child_crash_wins_over_any_http_status() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut child = crashing_child();
        let result = wait_http_ready_with_probe(
            &mut child,
            &format!("http://127.0.0.1:{port}/healthz"),
            port,
            &StartupChallenge([0x71; 32]),
            &[0x81; 32],
            Duration::from_secs(2),
        );
        let _ = child.wait();
        assert!(result.is_err());
    }

    #[test]
    fn restart_invalidates_the_previous_child_proof() {
        let probe = [0x91; 32];
        let old = [0xa1; 32];
        let new = [0xb1; 32];
        let proof = encode_hex(&readiness_mac(&old, &probe, 45231).finalize().into_bytes());
        assert!(readiness_proof_matches(&old, &probe, 45231, &proof));
        assert!(!readiness_proof_matches(&new, &probe, 45231, &proof));
    }

    #[test]
    fn bootstrap_cookie_parser_rejects_header_injection_and_wrong_names() {
        assert_eq!(
            session_id_from_set_cookie(
                "zephyr_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; Path=/; HttpOnly"
            ),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(session_id_from_set_cookie("other=value; Path=/"), None);
        assert_eq!(session_id_from_set_cookie("zephyr_sid=short; Path=/"), None);
        assert_eq!(
            session_id_from_set_cookie(
                "zephyr_sid=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%0d%0aevil"
            ),
            None
        );
    }

    #[test]
    fn windows_release_autostarts_without_a_webview_or_environment_override() {
        assert!(should_autostart(None, true));
        assert!(should_autostart(Some("unexpected-value"), true));
        assert!(!should_autostart(None, false));
    }

    #[test]
    fn explicit_autostart_setting_overrides_the_release_default() {
        assert!(should_autostart(Some("TRUE"), false));
        assert!(should_autostart(Some(" yes "), false));
        assert!(!should_autostart(Some("false"), true));
        assert!(!should_autostart(Some("OFF"), true));
    }

    #[test]
    fn logged_worker_records_that_it_reached_the_background_thread() {
        let log = AutostartLog {
            lines: Arc::new(parking_lot::Mutex::new(Vec::new())),
            file: None,
        };
        let observed = log.clone();
        let (sender, receiver) = std::sync::mpsc::channel();

        let handle = spawn_logged_worker(log, move |worker_log| {
            worker_log.append("simulated runtime ready");
            sender.send(()).unwrap();
        })
        .unwrap();
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        handle.join().unwrap();

        let contents = observed.lines.lock().join("\n");
        assert!(contents.contains("thread=zephyr-runtime-autostart worker entered"));
        assert!(contents.contains("simulated runtime ready"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_child_uses_private_env_fallback_without_inherited_socket_handle() {
        let challenge = StartupChallenge([0xc1; 32]);
        let encoded = challenge.encoded();
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("$v=$env:{STARTUP_CHALLENGE_ENV}; if (($v.Length -eq 64) -and ($v -cmatch '^[a-f0-9]{{64}}$')) {{ exit 0 }} else {{ exit 19 }}"),
        ]);
        command.env(STARTUP_CHALLENGE_ENV, &encoded);
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!arguments.contains(&encoded));
        assert!(command.status().unwrap().success());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_verbatim_paths_are_safe_for_node() {
        assert_eq!(
            node_compatible_path(PathBuf::from(
                r"\\?\C:\Users\Test User\AppData\Local\Zephyr One\_up_\zephyr-core",
            )),
            PathBuf::from(r"C:\Users\Test User\AppData\Local\Zephyr One\_up_\zephyr-core",),
        );
        assert_eq!(
            node_compatible_path(PathBuf::from(r"\\?\UNC\server\share\zephyr-core")),
            PathBuf::from(r"\\server\share\zephyr-core"),
        );
    }
}
