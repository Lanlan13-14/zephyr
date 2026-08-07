//! zephyr-one-rdp — native FreeRDP session helper for Zephyr One.
//!
//! One process per RDP session. The Node core spawns it, writes input frames to
//! its stdin, and reads framebuffer/event frames from its stdout; see proto.rs
//! for the wire format.
//!
//! Why a separate process rather than a thread inside the Tauri shell:
//!   * The WebView that shows the session is served from the loopback Node core,
//!     which is a *remote* origin as far as Tauri is concerned and therefore
//!     cannot invoke Rust commands at all. The core is the only component both
//!     sides can talk to, so the session has to be reachable from Node.
//!   * A crash in the RDP stack (a codec bug on a hostile server) takes down one
//!     tab instead of the whole application.
//!
//! Credentials arrive in the first stdin frame, never in argv or the
//! environment: argv is world-readable through `ps` on every desktop platform.
//!
//! Threading:
//!   main thread   — blocks in zephyr_rdp_run(), which owns the FreeRDP instance
//!   stdin thread  — decodes input frames, enqueues into the shim's queue
//!   paint thread  — coalesces damage and emits at most `max_fps` frames/sec
//!   writer thread — the *only* writer to stdout, so frames cannot interleave
//!
//! The paint thread exists because the frame callback runs on the RDP loop
//! thread. Writing an 8 MB full-screen frame straight to a 64 KB pipe would
//! block that loop until Node drained it, and a stalled reader would then stall
//! the protocol itself until the server timed the session out. Coalescing into a
//! framebuffer keeps the loop non-blocking and collapses redundant repaints.

mod ffi;
mod proto;

use serde::Deserialize;
use std::ffi::{CStr, CString};
use std::io::{self, Write};
use std::os::raw::{c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Config as sent by the Node bridge. camelCase to match the JS side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireConfig {
    host: String,
    #[serde(default = "default_port")]
    port: u32,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    domain: String,

    #[serde(default = "default_width")]
    width: u32,
    #[serde(default = "default_height")]
    height: u32,
    #[serde(default = "default_depth")]
    color_depth: u32,

    /// "auto" | "nla" | "tls" | "rdp"
    #[serde(default = "default_security")]
    security: String,
    #[serde(default)]
    ignore_certificate: bool,

    /// "local" | "remote" | "off"
    #[serde(default = "default_audio")]
    audio_mode: String,
    #[serde(default)]
    microphone: bool,
    #[serde(default = "default_true")]
    clipboard: bool,

    #[serde(default)]
    drive_name: String,
    #[serde(default)]
    drive_path: String,
    #[serde(default)]
    drive_read_only: bool,

    #[serde(default = "default_true")]
    dynamic_resolution: bool,
    #[serde(default)]
    gfx: bool,

    #[serde(default)]
    disable_wallpaper: bool,
    #[serde(default)]
    disable_themes: bool,
    #[serde(default)]
    disable_menu_anims: bool,
    #[serde(default)]
    disable_full_window_drag: bool,
    #[serde(default = "default_true")]
    allow_font_smoothing: bool,

    /// Upper bound on emitted frames per second. 0 falls back to 60.
    #[serde(default)]
    max_fps: u32,
}

fn default_port() -> u32 {
    3389
}
fn default_width() -> u32 {
    1920
}
fn default_height() -> u32 {
    1080
}
fn default_depth() -> u32 {
    32
}
fn default_security() -> String {
    "auto".into()
}
fn default_audio() -> String {
    "local".into()
}
fn default_true() -> bool {
    true
}

fn security_code(value: &str) -> i32 {
    match value {
        "nla" => ffi::SEC_NLA,
        "tls" => ffi::SEC_TLS,
        "rdp" => ffi::SEC_RDP,
        _ => ffi::SEC_AUTO,
    }
}

fn audio_code(value: &str) -> i32 {
    match value {
        "remote" => ffi::AUDIO_REMOTE,
        "off" => ffi::AUDIO_OFF,
        _ => ffi::AUDIO_LOCAL,
    }
}

/// Owns every CString the C config points into. Dropping this after the session
/// is freed is what keeps those pointers valid for the whole session: FreeRDP
/// reads drive_name/drive_path during PreConnect, which happens well after
/// zephyr_rdp_new returns.
struct OwnedStrings {
    host: CString,
    username: CString,
    password: CString,
    domain: CString,
    drive_name: Option<CString>,
    drive_path: Option<CString>,
}

impl OwnedStrings {
    fn new(cfg: &WireConfig) -> Result<Self, String> {
        let mk = |name: &str, value: &str| -> Result<CString, String> {
            CString::new(value)
                .map_err(|_| format!("{name} contains an interior NUL byte"))
        };
        Ok(Self {
            host: mk("host", &cfg.host)?,
            username: mk("username", &cfg.username)?,
            password: mk("password", &cfg.password)?,
            domain: mk("domain", &cfg.domain)?,
            drive_name: if cfg.drive_name.is_empty() {
                None
            } else {
                Some(mk("driveName", &cfg.drive_name)?)
            },
            drive_path: if cfg.drive_path.is_empty() {
                None
            } else {
                Some(mk("drivePath", &cfg.drive_path)?)
            },
        })
    }
}

fn build_config(cfg: &WireConfig, owned: &OwnedStrings) -> ffi::Config {
    ffi::Config {
        host: owned.host.as_ptr(),
        port: cfg.port,
        username: owned.username.as_ptr(),
        password: owned.password.as_ptr(),
        domain: owned.domain.as_ptr(),
        width: cfg.width,
        height: cfg.height,
        color_depth: cfg.color_depth,
        security: security_code(&cfg.security),
        ignore_certificate: cfg.ignore_certificate as i32,
        audio_mode: audio_code(&cfg.audio_mode),
        microphone: cfg.microphone as i32,
        clipboard: cfg.clipboard as i32,
        drive_name: owned
            .drive_name
            .as_ref()
            .map_or(std::ptr::null(), |c| c.as_ptr()),
        drive_path: owned
            .drive_path
            .as_ref()
            .map_or(std::ptr::null(), |c| c.as_ptr()),
        drive_read_only: cfg.drive_read_only as i32,
        dynamic_resolution: cfg.dynamic_resolution as i32,
        gfx: cfg.gfx as i32,
        disable_wallpaper: cfg.disable_wallpaper as i32,
        disable_themes: cfg.disable_themes as i32,
        disable_menu_anims: cfg.disable_menu_anims as i32,
        disable_full_window_drag: cfg.disable_full_window_drag as i32,
        allow_font_smoothing: cfg.allow_font_smoothing as i32,
    }
}

/// Accumulated framebuffer plus the union of damage since the last emit.
struct Surface {
    width: u32,
    height: u32,
    /// RGBA, tightly packed, `width * height * 4` bytes.
    pixels: Vec<u8>,
    /// Inclusive-exclusive damage bounds; `None` means nothing changed.
    dirty: Option<(u32, u32, u32, u32)>,
}

impl Surface {
    fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; (width as usize) * (height as usize) * 4],
            dirty: None,
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        self.pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        // A fresh surface is entirely undefined, so the next emit must be full.
        self.dirty = Some((0, 0, width, height));
    }

    /// Copy one damage rect in and widen the dirty bounds.
    fn blit(&mut self, x: u32, y: u32, w: u32, h: u32, src: &[u8]) {
        if w == 0 || h == 0 {
            return;
        }
        // Clamp against the current surface: a resize can race a rect that was
        // measured against the previous geometry, and trusting it would write
        // out of bounds.
        let x_end = (x + w).min(self.width);
        let y_end = (y + h).min(self.height);
        if x >= self.width || y >= self.height {
            return;
        }
        let copy_w = x_end - x;
        let copy_h = y_end - y;
        let src_stride = (w as usize) * 4;
        let dst_stride = (self.width as usize) * 4;
        for row in 0..copy_h as usize {
            let src_off = row * src_stride;
            let dst_off = (y as usize + row) * dst_stride + (x as usize) * 4;
            let len = (copy_w as usize) * 4;
            if src_off + len > src.len() || dst_off + len > self.pixels.len() {
                break;
            }
            self.pixels[dst_off..dst_off + len]
                .copy_from_slice(&src[src_off..src_off + len]);
        }
        self.dirty = Some(match self.dirty {
            None => (x, y, x + copy_w, y + copy_h),
            Some((x0, y0, x1, y1)) => (
                x0.min(x),
                y0.min(y),
                x1.max(x + copy_w),
                y1.max(y + copy_h),
            ),
        });
    }

    /// Take the dirty region as a packed RGBA sub-image, clearing the damage.
    fn take_dirty(&mut self) -> Option<(u16, u16, u16, u16, Vec<u8>)> {
        let (x0, y0, x1, y1) = self.dirty.take()?;
        let w = x1.saturating_sub(x0);
        let h = y1.saturating_sub(y0);
        if w == 0 || h == 0 {
            return None;
        }
        let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
        let dst_stride = (self.width as usize) * 4;
        for row in 0..h as usize {
            let off = (y0 as usize + row) * dst_stride + (x0 as usize) * 4;
            let len = (w as usize) * 4;
            if off + len > self.pixels.len() {
                break;
            }
            out.extend_from_slice(&self.pixels[off..off + len]);
        }
        Some((x0 as u16, y0 as u16, w as u16, h as u16, out))
    }
}

/// Shared between the C callbacks, the paint thread and the writer thread.
struct Shared {
    surface: Mutex<Surface>,
    out: Sender<Vec<u8>>,
    stopping: AtomicBool,
}

impl Shared {
    /// Send a JSON event. Errors are ignored on purpose: a closed channel means
    /// the writer thread already exited, which happens during teardown, and
    /// panicking inside a C callback would unwind across the FFI boundary.
    fn event(&self, json: &str) {
        let _ = self.out.send(proto::encode_event(json));
    }
}

/// SAFETY: `user` is the `Arc<Shared>` raw pointer handed to zephyr_rdp_new,
/// which main keeps alive until after zephyr_rdp_free. `pixels` is valid for
/// `len` bytes for the duration of the call, as documented in zephyr_rdp.h.
unsafe extern "C" fn on_frame(
    user: *mut c_void,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    pixels: *const u8,
    len: usize,
) {
    if user.is_null() || pixels.is_null() || w <= 0 || h <= 0 {
        return;
    }
    let shared = &*(user as *const Shared);
    let src = std::slice::from_raw_parts(pixels, len);
    // A poisoned lock means another thread panicked while holding it. Recovering
    // the guard is correct here: the surface is plain pixel data with no
    // invariant that a panic could have broken halfway.
    let mut surface = match shared.surface.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    surface.blit(x as u32, y as u32, w as u32, h as u32, src);
}

/// SAFETY: same contract as `on_frame`; `text` is either NULL or NUL-terminated.
unsafe extern "C" fn on_event(
    user: *mut c_void,
    code: i32,
    a: i32,
    b: i32,
    text: *const c_char,
) {
    if user.is_null() {
        return;
    }
    let shared = &*(user as *const Shared);
    let message = if text.is_null() {
        String::new()
    } else {
        CStr::from_ptr(text).to_string_lossy().into_owned()
    };

    match code {
        ffi::EV_CONNECTED => {
            shared.event(&serde_json::json!({
                "type": "connected", "width": a, "height": b
            }).to_string());
        }
        ffi::EV_DISCONNECTED => {
            shared.stopping.store(true, Ordering::SeqCst);
            shared.event(&serde_json::json!({
                "type": "disconnected", "code": a
            }).to_string());
        }
        ffi::EV_ERROR => {
            shared.event(&serde_json::json!({
                "type": "error", "code": a, "message": message
            }).to_string());
        }
        ffi::EV_RESIZE => {
            if a > 0 && b > 0 {
                let mut surface = match shared.surface.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                surface.resize(a as u32, b as u32);
            }
            shared.event(&serde_json::json!({
                "type": "resize", "width": a, "height": b
            }).to_string());
        }
        ffi::EV_CLIPBOARD => {
            shared.event(&serde_json::json!({
                "type": "clipboard", "text": message
            }).to_string());
        }
        ffi::EV_CURSOR => {
            shared.event(&serde_json::json!({
                "type": "cursor", "x": a, "y": b
            }).to_string());
        }
        /* The shim routes the peer's TLS certificate fingerprint through
         * EV_LOG from VerifyCertificateEx. Labelling it `certificate` rather
         * than folding it into a generic log line matters: it is the only
         * record of which certificate the session actually trusted, and the
         * host surfaces it so an unexpected fingerprint is visible instead of
         * buried in log noise. */
        ffi::EV_LOG => {
            shared.event(&serde_json::json!({
                "type": "certificate", "fingerprint": message
            }).to_string());
        }
        /* A virtual channel came up. Reported separately from the certificate
         * event because both used to share EV_LOG, which made every channel
         * name surface as `{"type":"certificate","fingerprint":"rdpdr"}` — so
         * an operator checking which certificate the session trusted saw three
         * bogus fingerprints alongside the real one. `rdpdr` here is also the
         * wire-level confirmation that folder mapping was accepted. */
        ffi::EV_CHANNEL => {
            shared.event(&serde_json::json!({
                "type": "channel", "name": message
            }).to_string());
        }
        /* Unknown codes are forwarded rather than dropped: a future shim event
         * should show up as something inspectable, not vanish. */
        _ => {
            shared.event(&serde_json::json!({
                "type": "log", "code": code, "message": message
            }).to_string());
        }
    }
}

/// Read the first stdin frame, which must be the config.
fn read_config() -> Result<WireConfig, String> {
    let mut stdin = io::stdin().lock();
    let body = proto::read_frame(&mut stdin)
        .map_err(|error| format!("reading config frame: {error}"))?
        .ok_or_else(|| "stdin closed before the config frame arrived".to_string())?;
    match proto::decode(&body) {
        Ok(proto::Inbound::Config(json)) => serde_json::from_slice::<WireConfig>(&json)
            .map_err(|error| format!("config JSON: {error}")),
        Ok(other) => Err(format!("expected a config frame first, got {other:?}")),
        Err(error) => Err(format!("config frame: {error}")),
    }
}

fn fatal(message: &str) -> ! {
    // Emitted on stdout as a protocol event so the bridge can surface it in the
    // UI. stderr also gets it for the log file.
    let json = serde_json::json!({ "type": "error", "code": 0, "message": message })
        .to_string();
    let frame = proto::encode_event(&json);
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(&frame);
    let _ = stdout.flush();
    eprintln!("zephyr-one-rdp: {message}");
    std::process::exit(1);
}

/// Take sole ownership of the protocol channel.
///
/// Must run before anything else in `main`: FreeRDP's WLog console appender
/// writes to stdout, and a single log line inside a length-prefixed frame
/// desynchronises the bridge permanently. After this call fd 1 is stderr, so
/// stray library output becomes diagnostics instead of corruption, and frames go
/// to a descriptor nothing else knows about.
///
/// Falls back to inherited stdout if the dup fails, which is strictly better
/// than refusing to start: the corruption is a possibility, not a certainty.
fn take_protocol_stdout() -> Box<dyn Write + Send> {
    let raw = unsafe { ffi::zephyr_rdp_isolate_stdout() };
    if raw < 0 {
        eprintln!(
            "zephyr-one-rdp: could not isolate stdout; \
             library log output may corrupt the frame stream"
        );
        return Box::new(io::stdout());
    }
    #[cfg(unix)]
    {
        use std::os::unix::io::FromRawFd;
        // SAFETY: `raw` is a descriptor the C side just dup'd and handed over;
        // this is its only owner.
        Box::new(unsafe { std::fs::File::from_raw_fd(raw as std::os::unix::io::RawFd) })
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::FromRawHandle;
        // SAFETY: `raw` is the OS HANDLE behind the dup'd CRT descriptor, owned
        // by this process and by nothing else.
        Box::new(unsafe {
            std::fs::File::from_raw_handle(raw as std::os::windows::io::RawHandle)
        })
    }
}

fn main() {
    /* First statement in main, deliberately: any earlier write to stdout — ours
     * or a library's — would already be in the frame stream. */
    let protocol_out = take_protocol_stdout();

    // Layout guard. A mismatch between the Rust mirror of zephyr_rdp_config and
    // the C struct would read a pointer field as an int and corrupt memory, and
    // nothing else in the pipeline would notice. Checked at startup rather than
    // only in tests so a mis-built binary refuses to run.
    let mismatches = ffi::layout_mismatches();
    if !mismatches.is_empty() {
        fatal(&format!(
            "zephyr_rdp_config layout mismatch between Rust and C: {}",
            mismatches.join("; ")
        ));
    }

    let cfg = match read_config() {
        Ok(cfg) => cfg,
        Err(error) => fatal(&error),
    };

    if cfg.host.trim().is_empty() {
        fatal("host is required");
    }

    let owned = match OwnedStrings::new(&cfg) {
        Ok(owned) => owned,
        Err(error) => fatal(&error),
    };

    // Validate the folder mapping before connecting. FreeRDP's
    // add_device_channel stats the path and fails the whole settings assembly
    // when it is gone, which would otherwise surface as an unexplained connect
    // failure. Verified against FreeRDP 2.11.7.
    if let (Some(name), Some(path)) = (&owned.drive_name, &owned.drive_path) {
        let code = unsafe { ffi::zephyr_rdp_validate_drive(name.as_ptr(), path.as_ptr()) };
        if code != ffi::DRIVE_OK {
            fatal(&ffi::drive_error_message(code, &cfg.drive_path, &cfg.drive_name));
        }
    }

    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    // Single stdout owner. Two threads writing frames would interleave bytes and
    // desynchronise the length-prefixed stream permanently.
    let writer = std::thread::Builder::new()
        .name("rdp-writer".into())
        .spawn(move || {
            /* The private dup of the original stdout, moved in so this thread is
             * the only writer to the frame channel. */
            let mut out = protocol_out;
            for frame in rx {
                if proto::write_all(&mut out, &frame).is_err() {
                    // Node closed the pipe: the tab is gone. Stop quietly.
                    break;
                }
            }
        })
        .unwrap_or_else(|error| fatal(&format!("spawning writer thread: {error}")));

    let shared = Arc::new(Shared {
        surface: Mutex::new(Surface::new(cfg.width, cfg.height)),
        out: tx,
        stopping: AtomicBool::new(false),
    });

    /* Announce which FreeRDP is actually live, plus whether a folder mapping
     * survived validation.
     *
     * This is not decoration. The shim compiles against FreeRDP 2 *or* 3 from
     * one source, so "which major is running" is a genuine runtime unknown that
     * shapes bug reports — and `driveMapped` is the single fact a user needs
     * when a mapped folder does not appear in the remote session: it separates
     * "Zephyr never asked for it" from "Windows declined it". Emitted before
     * connecting so it survives even a failed handshake. */
    shared.event(
        &serde_json::json!({
            "type": "hello",
            "freerdpMajor": unsafe { ffi::zephyr_rdp_freerdp_major() },
            "driveMapped": owned.drive_name.is_some() && owned.drive_path.is_some(),
            "driveName": cfg.drive_name,
        })
        .to_string(),
    );

    let ffi_config = build_config(&cfg, &owned);
    let user = Arc::as_ptr(&shared) as *mut c_void;

    let session = unsafe { ffi::zephyr_rdp_new(&ffi_config, on_frame, on_event, user) };
    if session.is_null() {
        fatal("failed to build the RDP session (settings assembly rejected)");
    }

    // Paint thread: bounded emit rate, one coalesced rect per tick.
    let fps = if cfg.max_fps == 0 { 60 } else { cfg.max_fps.clamp(1, 240) };
    let interval = Duration::from_micros(1_000_000 / fps as u64);
    let paint_shared = Arc::clone(&shared);
    let paint = std::thread::Builder::new()
        .name("rdp-paint".into())
        .spawn(move || {
            while !paint_shared.stopping.load(Ordering::SeqCst) {
                std::thread::sleep(interval);
                let taken = {
                    let mut surface = match paint_shared.surface.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    surface.take_dirty()
                };
                if let Some((x, y, w, h, pixels)) = taken {
                    if paint_shared
                        .out
                        .send(proto::encode_frame(x, y, w, h, &pixels))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        })
        .unwrap_or_else(|error| fatal(&format!("spawning paint thread: {error}")));

    // stdin thread: decode input and hand it to the shim's queue.
    //
    // `session` is a raw pointer shared with this thread. That is sound because
    // every zephyr_rdp_send_* entry point is documented and implemented as
    // "append to a mutex-protected queue, then SetEvent" — it never touches the
    // FreeRDP instance itself. The pointer is wrapped rather than passed raw
    // because a bare *mut is not Send.
    struct SendPtr(*mut ffi::Session);
    // SAFETY: see the comment above — only queue-appending functions are called
    // through this pointer, and the session outlives the thread (main joins it
    // before zephyr_rdp_free).
    unsafe impl Send for SendPtr {}
    let session_ptr = SendPtr(session);
    let input_shared = Arc::clone(&shared);
    let input = std::thread::Builder::new()
        .name("rdp-stdin".into())
        .spawn(move || {
            let handle = session_ptr;
            let mut stdin = io::stdin().lock();
            loop {
                match proto::read_frame(&mut stdin) {
                    Ok(Some(body)) => match proto::decode(&body) {
                        Ok(message) => {
                            if apply_input(handle.0, message) {
                                break; // Stop requested.
                            }
                        }
                        Err(error) => {
                            // A malformed frame means the stream is
                            // desynchronised; continuing would misread every
                            // later frame, so report and stop.
                            input_shared.event(
                                &serde_json::json!({
                                    "type": "error", "code": 0,
                                    "message": format!("input stream: {error}")
                                })
                                .to_string(),
                            );
                            break;
                        }
                    },
                    Ok(None) => break, // stdin EOF: the bridge closed.
                    Err(_) => break,
                }
            }
            unsafe { ffi::zephyr_rdp_stop(handle.0) };
        })
        .unwrap_or_else(|error| fatal(&format!("spawning stdin thread: {error}")));

    // Blocks until the session ends.
    let rc = unsafe { ffi::zephyr_rdp_run(session) };

    shared.stopping.store(true, Ordering::SeqCst);
    let _ = paint.join();

    // The stdin thread may still be blocked in read_frame. It exits on EOF when
    // the bridge closes the pipe, and the process is about to exit regardless,
    // so it is detached rather than joined to avoid hanging shutdown.
    drop(input);

    unsafe { ffi::zephyr_rdp_free(session) };
    // Only now may the CStrings die: FreeRDP read them for the session's life.
    drop(owned);

    // Dropping the last sender closes the channel, which ends the writer loop.
    drop(shared);
    let _ = writer.join();

    std::process::exit(if rc == 0 { 0 } else { 1 });
}

/// Apply one decoded input message. Returns true when the peer asked to stop.
fn apply_input(session: *mut ffi::Session, message: proto::Inbound) -> bool {
    unsafe {
        match message {
            proto::Inbound::Mouse { flags, x, y } => {
                ffi::zephyr_rdp_send_mouse(session, flags, x, y)
            }
            proto::Inbound::MouseEx { flags, x, y } => {
                ffi::zephyr_rdp_send_mouse_ex(session, flags, x, y)
            }
            proto::Inbound::Scancode { flags, code } => {
                ffi::zephyr_rdp_send_scancode(session, flags, code)
            }
            proto::Inbound::Unicode { flags, code } => {
                ffi::zephyr_rdp_send_unicode(session, flags, code)
            }
            proto::Inbound::Sync { toggles } => ffi::zephyr_rdp_send_sync(session, toggles),
            proto::Inbound::Resize { width, height } => {
                ffi::zephyr_rdp_resize(session, width, height)
            }
            proto::Inbound::Clipboard(text) => {
                // An interior NUL cannot reach the C API; drop the payload
                // rather than truncating it into something different.
                if let Ok(value) = CString::new(text) {
                    ffi::zephyr_rdp_set_clipboard(session, value.as_ptr());
                }
            }
            proto::Inbound::FullFrame => ffi::zephyr_rdp_request_full_frame(session),
            proto::Inbound::Stop => return true,
            // A second config frame mid-session is meaningless; ignore it rather
            // than reconnecting behind the user's back.
            proto::Inbound::Config(_) => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn security_and_audio_strings_map_to_codes() {
        assert_eq!(security_code("nla"), ffi::SEC_NLA);
        assert_eq!(security_code("tls"), ffi::SEC_TLS);
        assert_eq!(security_code("rdp"), ffi::SEC_RDP);
        assert_eq!(security_code("auto"), ffi::SEC_AUTO);
        // Unknown values fall back to AUTO rather than failing the connect: the
        // UI's select is the source of truth and a new option should degrade to
        // negotiation, not to a dead session.
        assert_eq!(security_code("nonsense"), ffi::SEC_AUTO);

        assert_eq!(audio_code("local"), ffi::AUDIO_LOCAL);
        assert_eq!(audio_code("remote"), ffi::AUDIO_REMOTE);
        assert_eq!(audio_code("off"), ffi::AUDIO_OFF);
        assert_eq!(audio_code("nonsense"), ffi::AUDIO_LOCAL);
    }

    fn wire(json: &str) -> WireConfig {
        serde_json::from_str(json).expect("config should parse")
    }

    #[test]
    fn minimal_config_gets_product_defaults() {
        let cfg = wire(r#"{"host":"10.0.0.5"}"#);
        assert_eq!(cfg.port, 3389);
        assert_eq!(cfg.width, 1920);
        assert_eq!(cfg.height, 1080);
        assert_eq!(cfg.color_depth, 32);
        assert_eq!(cfg.security, "auto");
        assert_eq!(cfg.audio_mode, "local");
        // Clipboard and dynamic resolution default on; the folder mapping does
        // not, because mapping a folder the user never chose would expose it.
        assert!(cfg.clipboard);
        assert!(cfg.dynamic_resolution);
        assert!(cfg.drive_name.is_empty());
        assert!(cfg.drive_path.is_empty());
        assert!(!cfg.gfx);
    }

    #[test]
    fn unknown_config_field_is_rejected() {
        // deny_unknown_fields is deliberate: a typo in the bridge (rdpStorage vs
        // driveName) would otherwise silently produce a session with no folder
        // mapped, which is exactly the class of bug this work is fixing.
        let result = serde_json::from_str::<WireConfig>(
            r#"{"host":"h","rdpStorageFolder":"/tmp"}"#,
        );
        assert!(result.is_err(), "unknown field must not be ignored");
    }

    #[test]
    fn folder_mapping_fields_round_trip() {
        let cfg = wire(
            r#"{"host":"h","driveName":"文件夹","drivePath":"/tmp/x","driveReadOnly":true}"#,
        );
        assert_eq!(cfg.drive_name, "文件夹");
        assert_eq!(cfg.drive_path, "/tmp/x");
        assert!(cfg.drive_read_only);

        let owned = OwnedStrings::new(&cfg).expect("CStrings build");
        let ffi_cfg = build_config(&cfg, &owned);
        assert!(!ffi_cfg.drive_name.is_null());
        assert!(!ffi_cfg.drive_path.is_null());
        assert_eq!(ffi_cfg.drive_read_only, 1);
    }

    #[test]
    fn absent_folder_mapping_leaves_null_pointers() {
        let cfg = wire(r#"{"host":"h"}"#);
        let owned = OwnedStrings::new(&cfg).expect("CStrings build");
        let ffi_cfg = build_config(&cfg, &owned);
        // NULL rather than an empty string: apply_config keys the whole RDPDR
        // branch off non-empty, and an empty CString would still be non-NULL.
        assert!(ffi_cfg.drive_name.is_null());
        assert!(ffi_cfg.drive_path.is_null());
    }

    #[test]
    fn interior_nul_in_credentials_is_rejected() {
        let cfg = wire("{\"host\":\"h\",\"password\":\"a\\u0000b\"}");
        assert!(
            OwnedStrings::new(&cfg).is_err(),
            "interior NUL must be refused, not silently truncated"
        );
    }

    #[test]
    fn surface_blit_marks_only_the_touched_region() {
        let mut surface = Surface::new(4, 4);
        assert!(surface.dirty.is_none(), "a new surface has no damage");
        let red = [255u8, 0, 0, 255, 255, 0, 0, 255];
        surface.blit(1, 2, 2, 1, &red);
        assert_eq!(surface.dirty, Some((1, 2, 3, 3)));

        let (x, y, w, h, pixels) = surface.take_dirty().expect("damage present");
        assert_eq!((x, y, w, h), (1, 2, 2, 1));
        assert_eq!(pixels, red);
        assert!(surface.dirty.is_none(), "take_dirty clears the damage");
    }

    #[test]
    fn surface_unions_separate_rects_into_one_emit() {
        let mut surface = Surface::new(8, 8);
        surface.blit(0, 0, 1, 1, &[1, 2, 3, 4]);
        surface.blit(6, 7, 1, 1, &[5, 6, 7, 8]);
        // Two far-apart pixels coalesce into their bounding box: one frame
        // instead of two, which is the whole point of the paint thread.
        assert_eq!(surface.dirty, Some((0, 0, 7, 8)));
        let (x, y, w, h, pixels) = surface.take_dirty().expect("damage present");
        assert_eq!((x, y, w, h), (0, 0, 7, 8));
        assert_eq!(pixels.len(), 7 * 8 * 4);
        // Both writes survived the coalescing.
        assert_eq!(&pixels[0..4], &[1, 2, 3, 4]);
        let last_row = 7 * 7 * 4;
        assert_eq!(&pixels[last_row + 6 * 4..last_row + 7 * 4], &[5, 6, 7, 8]);
    }

    #[test]
    fn surface_clamps_rects_that_exceed_its_bounds() {
        let mut surface = Surface::new(2, 2);
        // A server may invalidate against the pre-resize geometry. Writing it
        // unclamped would corrupt memory past the buffer.
        let big = vec![9u8; 4 * 4 * 4];
        surface.blit(1, 1, 4, 4, &big);
        assert_eq!(surface.dirty, Some((1, 1, 2, 2)));
        let (_, _, w, h, pixels) = surface.take_dirty().expect("damage present");
        assert_eq!((w, h), (1, 1));
        assert_eq!(pixels.len(), 4);
    }

    #[test]
    fn blit_fully_outside_the_surface_is_dropped() {
        let mut surface = Surface::new(2, 2);
        surface.blit(5, 5, 1, 1, &[1, 2, 3, 4]);
        assert!(surface.dirty.is_none(), "off-surface damage must not be recorded");
    }

    #[test]
    fn resize_forces_a_full_repaint() {
        let mut surface = Surface::new(2, 2);
        surface.blit(0, 0, 1, 1, &[1, 2, 3, 4]);
        surface.resize(4, 3);
        // The new surface holds no old content, so anything less than a full
        // rect would leave the client showing a stretched stale frame.
        assert_eq!(surface.dirty, Some((0, 0, 4, 3)));
        assert_eq!(surface.pixels.len(), 4 * 3 * 4);
    }

    #[test]
    fn take_dirty_returns_none_when_clean() {
        let mut surface = Surface::new(2, 2);
        assert!(surface.take_dirty().is_none());
    }
}
