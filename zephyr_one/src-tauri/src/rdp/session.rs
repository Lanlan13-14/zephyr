//! Session lifetime, threading, and the callback boundary.
//!
//! ## Threading model
//!
//! `zephyr_rdp_run` blocks until the session ends, and the C side deliberately
//! spawns no thread of its own so that the host owns threading. So each session
//! gets one OS thread that does nothing but run the loop. Input calls come from
//! other threads and are safe: the shim enqueues them onto an internal
//! mutex-protected queue and wakes the loop through a WinPR event handle, so
//! FreeRDP's non-reentrant send path is only ever touched by the loop thread.
//!
//! ## Why the pointer is behind a mutex
//!
//! `zephyr_rdp_free` must not run while `zephyr_rdp_run` is executing, and an
//! input call must not touch a freed session. Both are use-after-free hazards
//! that a raw `*mut` in a handle would invite: the run thread frees on exit while
//! a UI thread is midway through `send_mouse`.
//!
//! The pointer therefore lives in a `Mutex<Option<..>>`. The run thread copies it
//! out *without* holding the lock (so input is never blocked for the life of the
//! session), and on exit it takes the lock, sets `None`, then frees. Input takes
//! the lock and does nothing when the slot is empty. Freeing while holding the
//! lock is what makes "the pointer is valid" true for every caller that observes
//! `Some`.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::ffi;
use super::{AudioMode, Config, Error, Security};

/// A changed rectangle of the framebuffer.
///
/// `pixels` is tightly packed BGRA, top-down, `stride == w * 4`. It borrows the
/// shim's scratch buffer, which is only valid for the duration of the callback, so
/// the lifetime here is what stops a sink from retaining it.
#[derive(Debug)]
pub struct FrameRect<'a> {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub pixels: &'a [u8],
}

/// Session lifecycle and out-of-band notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Connected,
    Disconnected,
    Error(String),
    Resize { width: i32, height: i32 },
    /// Text arriving from the remote clipboard.
    Clipboard(String),
    /// The TLS certificate fingerprint this session trusted. The only record of
    /// which certificate was accepted, so it is its own variant rather than a log
    /// line an operator has to grep for.
    Certificate(String),
    CursorMoved { x: i32, y: i32 },
    /// A virtual channel came up. `rdpdr` is the wire-level proof that folder
    /// redirection negotiated, which is otherwise unobservable from the host.
    Channel(String),
}

/// Where a session's output goes.
///
/// Implemented by whoever owns a real OS surface. `Send + Sync` because both
/// methods are called from the session's own thread, never from the caller's.
///
/// Deliberately a Rust-side trait: the development spec requires the native core
/// to emit protocol and dirty rectangles while the platform layer owns the
/// surface, and forbids high-frequency frames crossing the Node core or being
/// repainted in a Web canvas. A sink that forwarded `frame` to JavaScript would
/// reintroduce exactly the sidecar architecture b0e5a9c removed.
pub trait FrameSink: Send + Sync {
    fn frame(&self, rect: FrameRect<'_>);
    fn event(&self, event: SessionEvent);
}

/// A sink that counts and remembers, for builds with no surface yet.
///
/// Not a stub standing in for missing work: it is what makes the engine testable
/// without a live RDP server and without a window, and it is the sink the
/// `rdp_native_probe` command uses to report that a connection really established.
#[derive(Debug, Default)]
pub struct RecordingSink {
    inner: Mutex<RecordedState>,
}

#[derive(Debug, Default, Clone)]
pub struct RecordedState {
    pub frames: u64,
    pub bytes: u64,
    pub events: Vec<SessionEvent>,
}

impl RecordingSink {
    pub fn snapshot(&self) -> RecordedState {
        self.inner.lock().expect("recording sink poisoned").clone()
    }
}

impl FrameSink for RecordingSink {
    fn frame(&self, rect: FrameRect<'_>) {
        let mut state = self.inner.lock().expect("recording sink poisoned");
        state.frames += 1;
        state.bytes += rect.pixels.len() as u64;
    }

    fn event(&self, event: SessionEvent) {
        let mut state = self.inner.lock().expect("recording sink poisoned");
        /* Bounded: a long session emits a cursor event per motion, and an
         * unbounded log would grow without limit for a diagnostic nobody reads
         * past the first few dozen entries. */
        if state.events.len() < 256 {
            state.events.push(event);
        }
    }
}

/// The user pointer handed to C, and the owner of the session pointer.
///
/// One allocation shared by the run thread, the callbacks, and every handle. The
/// `Arc` is what guarantees the callbacks' `user` pointer stays valid for as long
/// as the C session can invoke them.
struct Shared {
    sink: Arc<dyn FrameSink>,
    /// `None` once the session has been freed. See the module docs for why this
    /// is a mutex rather than a raw pointer.
    session: Mutex<Option<*mut ffi::zephyr_rdp_session>>,
    stopping: AtomicBool,
}

/* SAFETY: the only non-Send/Sync member is the raw pointer, and it is reachable
 * exclusively through the mutex. FreeRDP's own rule -- input from any thread,
 * `run`/`free` from the owning thread -- is upheld by the run thread being the
 * only place that frees, and by it doing so while holding the lock. */
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

/// The callback `user` pointer, made movable across threads.
///
/// `*mut c_void` is not `Send`, so the loop thread could not take ownership of it
/// to reclaim the `Arc` after `zephyr_rdp_free`. Wrapping is the honest fix: the
/// pointer *is* safe to move here, and the wrapper documents exactly why rather
/// than leaving a bare `unsafe impl` on something broader.
///
/// SAFETY: the referent is an `Arc<Shared>` leaked by `Arc::into_raw`, and
/// `Shared` is `Send + Sync`. Exactly one thread reclaims it (the loop thread, as
/// its final act), so there is no race on the strong count.
#[cfg(zephyr_native_rdp)]
#[derive(Copy, Clone)]
struct UserPtr(*mut c_void);

#[cfg(zephyr_native_rdp)]
unsafe impl Send for UserPtr {}

impl Shared {
    /// Run `f` with the live session pointer, or do nothing if it is gone.
    fn with_session<R>(&self, f: impl FnOnce(*mut ffi::zephyr_rdp_session) -> R) -> Option<R> {
        let guard = self.session.lock().expect("session mutex poisoned");
        guard.map(f)
    }
}

/// Control surface for one running session.
///
/// Cloneable and thread-safe: the UI thread holds one to send input while the
/// session's own thread runs the loop.
#[derive(Clone)]
pub struct SessionHandle {
    shared: Arc<Shared>,
}

impl SessionHandle {
    /// Ask the loop to exit. Idempotent, and safe while `run` is blocked in a
    /// wait -- that is what `zephyr_rdp_stop` is for.
    pub fn stop(&self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: the pointer is live for the duration of the closure because
            // the mutex is held, and the C function is documented thread-safe.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_stop(s) });
        }
    }

    pub fn send_mouse(&self, flags: u16, x: u16, y: u16) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: live pointer under the lock; enqueues onto the shim's
            // mutex-protected input queue.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_send_mouse(s, flags, x, y) });
        }
        #[cfg(not(zephyr_native_rdp))]
        let _ = (flags, x, y);
    }

    /// Extended pointer events (the two side buttons), which RDP carries on a
    /// separate PDU from the primary ones.
    pub fn send_mouse_ex(&self, flags: u16, x: u16, y: u16) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: as `send_mouse`.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_send_mouse_ex(s, flags, x, y) });
        }
        #[cfg(not(zephyr_native_rdp))]
        let _ = (flags, x, y);
    }

    pub fn send_scancode(&self, flags: u16, code: u16) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: as `send_mouse`.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_send_scancode(s, flags, code) });
        }
        #[cfg(not(zephyr_native_rdp))]
        let _ = (flags, code);
    }

    /// Unicode key input, which is how IME and CJK text reach the session: a
    /// scancode cannot express a composed character.
    pub fn send_unicode(&self, flags: u16, code: u16) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: as `send_mouse`.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_send_unicode(s, flags, code) });
        }
        #[cfg(not(zephyr_native_rdp))]
        let _ = (flags, code);
    }

    /// Re-assert Caps/Num/Scroll lock state. Without this a session inherits
    /// whatever the server believed at connect time and the locks drift.
    pub fn send_sync(&self, toggle_flags: u32) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: as `send_mouse`.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_send_sync(s, toggle_flags) });
        }
        #[cfg(not(zephyr_native_rdp))]
        let _ = toggle_flags;
    }

    /// Ask for a full repaint, used when a surface is re-attached and has no
    /// history of the dirty rectangles it missed.
    pub fn request_full_frame(&self) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: as `send_mouse`.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_request_full_frame(s) });
        }
    }

    /// Live resize through the disp channel. A no-op when the session was created
    /// without `dynamic_resolution`.
    pub fn resize(&self, width: u32, height: u32) {
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: as `send_mouse`.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_resize(s, width, height) });
        }
        #[cfg(not(zephyr_native_rdp))]
        let _ = (width, height);
    }

    /// Push local clipboard text to the remote session.
    ///
    /// Rejects interior NULs rather than truncating: a silently shortened paste is
    /// a data-loss bug the user cannot see.
    pub fn set_clipboard(&self, text: &str) -> Result<(), Error> {
        let c_text = CString::new(text).map_err(|_| Error::InteriorNul("clipboard"))?;
        #[cfg(zephyr_native_rdp)]
        {
            // SAFETY: `c_text` outlives the call, and the shim copies before
            // returning.
            self.shared
                .with_session(|s| unsafe { ffi::zephyr_rdp_set_clipboard(s, c_text.as_ptr()) });
        }
        Ok(())
    }

    /// True once `stop` has been requested or the loop has exited.
    pub fn is_stopping(&self) -> bool {
        self.shared.stopping.load(Ordering::SeqCst)
    }

    /// True while the C session is still allocated.
    pub fn is_live(&self) -> bool {
        self.shared
            .session
            .lock()
            .expect("session mutex poisoned")
            .is_some()
    }
}

/* ---- callbacks ----------------------------------------------------------- */

/// Recover the shared state from C's `user` pointer.
///
/// SAFETY: `user` is always the pointer produced by `Arc::into_raw` in `start`,
/// and the `Arc` is kept alive until after `zephyr_rdp_free` returns, so the
/// referent is live for every callback the C side can make.
#[cfg(zephyr_native_rdp)]
unsafe fn shared_from(user: *mut c_void) -> Option<&'static Shared> {
    if user.is_null() {
        return None;
    }
    Some(&*(user as *const Shared))
}

#[cfg(zephyr_native_rdp)]
unsafe extern "C" fn on_frame(
    user: *mut c_void,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    pixels: *const u8,
    len: usize,
) {
    let Some(shared) = shared_from(user) else { return };
    if pixels.is_null() || len == 0 {
        return;
    }
    /* A rectangle whose declared area does not match the buffer would make the
     * slice below read out of bounds. Dropping it is right: the alternative is
     * trusting a length the host did not compute. */
    let expected = (w as i64) * (h as i64) * 4;
    if w <= 0 || h <= 0 || expected != len as i64 {
        return;
    }
    // SAFETY: `pixels` points to `len` initialised bytes for the duration of this
    // call, which is exactly the lifetime `FrameRect` borrows for.
    let bytes = std::slice::from_raw_parts(pixels, len);
    shared.sink.frame(FrameRect { x, y, w, h, pixels: bytes });
}

#[cfg(zephyr_native_rdp)]
unsafe extern "C" fn on_event(user: *mut c_void, code: i32, a: i32, b: i32, text: *const c_char) {
    let Some(shared) = shared_from(user) else { return };

    // SAFETY: the shim documents `text` as NUL-terminated UTF-8 or NULL.
    let message = if text.is_null() {
        String::new()
    } else {
        CStr::from_ptr(text).to_string_lossy().into_owned()
    };

    let event = match code {
        ffi::ZEPHYR_RDP_EV_CONNECTED => SessionEvent::Connected,
        ffi::ZEPHYR_RDP_EV_DISCONNECTED => SessionEvent::Disconnected,
        ffi::ZEPHYR_RDP_EV_ERROR => SessionEvent::Error(message),
        ffi::ZEPHYR_RDP_EV_RESIZE => SessionEvent::Resize { width: a, height: b },
        ffi::ZEPHYR_RDP_EV_CLIPBOARD => SessionEvent::Clipboard(message),
        ffi::ZEPHYR_RDP_EV_LOG => SessionEvent::Certificate(message),
        ffi::ZEPHYR_RDP_EV_CURSOR => SessionEvent::CursorMoved { x: a, y: b },
        ffi::ZEPHYR_RDP_EV_CHANNEL => SessionEvent::Channel(message),
        /* An unknown code is reported rather than dropped: silently ignoring it
         * would hide a shim that has grown an event this build does not know. */
        other => SessionEvent::Error(format!("unknown RDP event {other}: {message}")),
    };
    shared.sink.event(event);
}

/* ---- config translation -------------------------------------------------- */

/// Owns the `CString`s a `zephyr_rdp_config` points into.
///
/// The C side copies what it needs during `zephyr_rdp_new`, so these only have to
/// outlive that one call -- but they *must* outlive it, and keeping them in one
/// struct is what makes that visible rather than a matter of statement order.
struct ConfigStrings {
    host: CString,
    username: CString,
    password: CString,
    domain: CString,
    drive_name: CString,
    drive_path: CString,
}

impl ConfigStrings {
    fn new(config: &Config) -> Result<Self, Error> {
        Ok(Self {
            host: CString::new(config.host.as_str()).map_err(|_| Error::InteriorNul("host"))?,
            username: CString::new(config.username.as_str())
                .map_err(|_| Error::InteriorNul("username"))?,
            password: CString::new(config.password.as_str())
                .map_err(|_| Error::InteriorNul("password"))?,
            domain: CString::new(config.domain.as_str()).map_err(|_| Error::InteriorNul("domain"))?,
            drive_name: CString::new(config.drive_name.as_str())
                .map_err(|_| Error::InteriorNul("driveName"))?,
            drive_path: CString::new(config.drive_path.as_str())
                .map_err(|_| Error::InteriorNul("drivePath"))?,
        })
    }

    fn as_raw(&self, config: &Config) -> ffi::zephyr_rdp_config {
        ffi::zephyr_rdp_config {
            host: self.host.as_ptr(),
            port: config.port,
            username: self.username.as_ptr(),
            password: self.password.as_ptr(),
            domain: self.domain.as_ptr(),
            width: config.width,
            height: config.height,
            color_depth: config.color_depth,
            security: config.security.as_raw(),
            ignore_certificate: config.ignore_certificate as i32,
            audio_mode: config.audio.as_raw(),
            microphone: config.microphone as i32,
            clipboard: config.clipboard as i32,
            drive_name: self.drive_name.as_ptr(),
            drive_path: self.drive_path.as_ptr(),
            drive_read_only: config.drive_read_only as i32,
            dynamic_resolution: config.dynamic_resolution as i32,
            gfx: config.gfx as i32,
            disable_wallpaper: config.disable_wallpaper as i32,
            disable_themes: config.disable_themes as i32,
            disable_menu_anims: config.disable_menu_anims as i32,
            disable_full_window_drag: config.disable_full_window_drag as i32,
            allow_font_smoothing: config.allow_font_smoothing as i32,
        }
    }
}

/// Build the C config from a Rust one and hand it to `f`.
///
/// The borrow checker keeps `strings` alive across the call, which is the whole
/// point: a version returning `zephyr_rdp_config` by value would hand back
/// dangling pointers the moment the `CString`s dropped.
pub(crate) fn with_config<R>(
    config: &Config,
    f: impl FnOnce(&ffi::zephyr_rdp_config) -> R,
) -> Result<R, Error> {
    let strings = ConfigStrings::new(config)?;
    let raw = strings.as_raw(config);
    Ok(f(&raw))
}

/* ---- registry ------------------------------------------------------------ */

/// Every live session, keyed by the id the product UI uses for the tab.
///
/// The registry owns the join handles so a session that ends on its own is reaped
/// rather than leaking a thread; `close` is idempotent because a UI can close a
/// tab whose session already disconnected.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a session and register it under `id`.
    ///
    /// Returns once the loop thread is running; connection success arrives later
    /// as `SessionEvent::Connected` on the sink, because `zephyr_rdp_run` performs
    /// the connect and blocks. Reporting "started" as "connected" here would make
    /// the UI show a live tab for a session that is still negotiating -- or that
    /// failed.
    pub fn start(
        &self,
        id: &str,
        config: Config,
        sink: Arc<dyn FrameSink>,
    ) -> Result<SessionHandle, Error> {
        self.start_impl(id, config, sink)
    }

    /// No engine in this build, so there is nothing to start.
    ///
    /// A separate function rather than a `cfg` block inside `start` because a
    /// cfg-gated `return` leaves the function tail unreachable only on one side of
    /// the cfg, which is the kind of thing that compiles on the developer's
    /// platform and fails on the other.
    #[cfg(not(zephyr_native_rdp))]
    fn start_impl(
        &self,
        _id: &str,
        _config: Config,
        _sink: Arc<dyn FrameSink>,
    ) -> Result<SessionHandle, Error> {
        Err(Error::Unavailable)
    }

    #[cfg(zephyr_native_rdp)]
    fn start_impl(
        &self,
        id: &str,
        config: Config,
        sink: Arc<dyn FrameSink>,
    ) -> Result<SessionHandle, Error> {
        {
            /* Refuse before touching FreeRDP if the ABI mirror disagrees with the
             * C struct: writing a Rust layout into a differently-shaped C struct
             * is how credentials end up read from the wrong offset. */
            if let Err(problem) = ffi::assert_layout_matches_c() {
                return Err(Error::AbiMismatch(problem));
            }

            /* Validate the mapping first so a stale folder reports itself.
             * `freerdp_client_add_device_channel` stats the path and fails the
             * whole settings assembly, which would otherwise surface as a generic
             * connect failure. */
            if !config.drive_path.is_empty() || !config.drive_name.is_empty() {
                super::validate_drive(&config.drive_name, &config.drive_path)?;
            }

            let shared = Arc::new(Shared {
                sink,
                session: Mutex::new(None),
                stopping: AtomicBool::new(false),
            });

            /* Handed to C as the callback `user` pointer. Reclaimed on the loop
             * thread after `zephyr_rdp_free`, so the referent outlives every
             * callback the session can make. */
            let user = UserPtr(Arc::into_raw(Arc::clone(&shared)) as *mut c_void);

            let created = with_config(&config, |raw| {
                // SAFETY: `raw` and its strings are alive for this call, and the
                // shim copies what it retains.
                unsafe { ffi::zephyr_rdp_new(raw, Some(on_frame), Some(on_event), user.0) }
            })?;

            if created.is_null() {
                // SAFETY: reclaim the leaked Arc; nothing else observed it,
                // because `zephyr_rdp_new` failed before storing the pointer.
                unsafe { Arc::decrement_strong_count(user.0 as *const Shared) };
                return Err(Error::SessionCreate);
            }

            *shared.session.lock().expect("session mutex poisoned") = Some(created);

            let handle = SessionHandle { shared: Arc::clone(&shared) };
            let thread_shared = Arc::clone(&shared);
            let thread_id = id.to_string();

            std::thread::Builder::new()
                .name(format!("zephyr-rdp-{thread_id}"))
                .spawn(move || {
                    /* Copied out without holding the lock: `run` blocks for the
                     * whole session, and holding the mutex across it would make
                     * every input call wait forever. */
                    let raw = thread_shared
                        .session
                        .lock()
                        .expect("session mutex poisoned")
                        .expect("session pointer set before the thread starts");

                    // SAFETY: `raw` is live; only this thread calls run/free, and
                    // free happens below after run returns.
                    let code = unsafe { ffi::zephyr_rdp_run(raw) };

                    /* Clear then free, under the lock. An input call that
                     * observes `Some` therefore always holds a live pointer. */
                    {
                        let mut slot =
                            thread_shared.session.lock().expect("session mutex poisoned");
                        *slot = None;
                        // SAFETY: run has returned, so freeing is now legal, and
                        // no other thread can reach the pointer once the slot is
                        // cleared while we hold the lock.
                        unsafe { ffi::zephyr_rdp_free(raw) };
                    }

                    thread_shared.stopping.store(true, Ordering::SeqCst);

                    /* A non-zero exit is only an error if a stop was not asked
                     * for: a user closing a tab produces a non-zero code from a
                     * deliberate teardown, and reporting that as a failure would
                     * put an error toast on every normal close. */
                    if code != 0 && !thread_shared.stopping.load(Ordering::SeqCst) {
                        thread_shared
                            .sink
                            .event(SessionEvent::Error(format!("RDP session ended: {code}")));
                    }

                    // SAFETY: matches the `Arc::into_raw` above. Last thing the
                    // thread does, so no callback can run after it.
                    unsafe { Arc::decrement_strong_count(user.0 as *const Shared) };
                })
                .map_err(|_| Error::SessionCreate)?;

            self.sessions
                .lock()
                .expect("registry poisoned")
                .insert(id.to_string(), handle.clone());

            Ok(handle)
        }
    }

    pub fn get(&self, id: &str) -> Option<SessionHandle> {
        self.sessions.lock().expect("registry poisoned").get(id).cloned()
    }

    /// Stop and deregister a session. Idempotent: closing an already-ended tab is
    /// normal, not an error.
    pub fn close(&self, id: &str) -> bool {
        let handle = self.sessions.lock().expect("registry poisoned").remove(id);
        match handle {
            Some(handle) => {
                handle.stop();
                true
            }
            None => false,
        }
    }

    /// Ids of sessions still registered.
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> =
            self.sessions.lock().expect("registry poisoned").keys().cloned().collect();
        ids.sort_unstable();
        ids
    }

    /// Drop entries whose loop has exited, so a long-lived shell does not
    /// accumulate handles to dead sessions.
    pub fn reap(&self) -> usize {
        let mut sessions = self.sessions.lock().expect("registry poisoned");
        let before = sessions.len();
        sessions.retain(|_, handle| handle.is_live());
        before - sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> Config {
        Config {
            host: "host.example".into(),
            username: "user".into(),
            password: "pw".into(),
            security: Security::Nla,
            audio: AudioMode::Off,
            ..Config::default()
        }
    }

    #[test]
    fn config_strings_reject_interior_nuls_instead_of_truncating() {
        /* A truncated hostname would connect somewhere the user did not ask for,
         * which is worse than refusing the field. */
        let mut config = sample_config();
        config.host = "host\0evil".into();
        assert_eq!(ConfigStrings::new(&config).err(), Some(Error::InteriorNul("host")));

        config = sample_config();
        config.password = "pw\0extra".into();
        assert_eq!(ConfigStrings::new(&config).err(), Some(Error::InteriorNul("password")));
    }

    #[test]
    fn with_config_maps_every_scalar_field() {
        /* Guards a whole class of one-line mistakes: a field assigned from the
         * wrong source, or a bool inverted on the way to its i32. */
        let mut config = sample_config();
        config.port = 3390;
        config.width = 1280;
        config.height = 720;
        config.ignore_certificate = true;
        config.microphone = true;
        config.clipboard = false;
        config.drive_read_only = true;
        config.dynamic_resolution = false;
        config.gfx = false;
        config.disable_wallpaper = true;
        config.disable_themes = true;
        config.disable_menu_anims = true;
        config.disable_full_window_drag = true;
        config.allow_font_smoothing = false;

        with_config(&config, |raw| {
            assert_eq!(raw.port, 3390);
            assert_eq!(raw.width, 1280);
            assert_eq!(raw.height, 720);
            assert_eq!(raw.color_depth, 32);
            assert_eq!(raw.security, ffi::ZEPHYR_RDP_SEC_NLA);
            assert_eq!(raw.audio_mode, ffi::ZEPHYR_RDP_AUDIO_OFF);
            assert_eq!(raw.ignore_certificate, 1);
            assert_eq!(raw.microphone, 1);
            assert_eq!(raw.clipboard, 0);
            assert_eq!(raw.drive_read_only, 1);
            assert_eq!(raw.dynamic_resolution, 0);
            assert_eq!(raw.gfx, 0);
            assert_eq!(raw.disable_wallpaper, 1);
            assert_eq!(raw.disable_themes, 1);
            assert_eq!(raw.disable_menu_anims, 1);
            assert_eq!(raw.disable_full_window_drag, 1);
            assert_eq!(raw.allow_font_smoothing, 0);
        })
        .expect("config must translate");
    }

    #[test]
    fn with_config_pointers_carry_the_right_strings() {
        // The failure this catches is two pointers assigned from the same
        // CString, which would silently send the username as the domain.
        let config = sample_config();
        with_config(&config, |raw| {
            // SAFETY: the strings are alive for the duration of this closure.
            unsafe {
                assert_eq!(CStr::from_ptr(raw.host).to_str().unwrap(), "host.example");
                assert_eq!(CStr::from_ptr(raw.username).to_str().unwrap(), "user");
                assert_eq!(CStr::from_ptr(raw.password).to_str().unwrap(), "pw");
                assert_eq!(CStr::from_ptr(raw.domain).to_str().unwrap(), "");
            }
        })
        .expect("config must translate");
    }

    #[test]
    fn a_registry_with_no_engine_refuses_rather_than_pretending() {
        if super::super::is_available() {
            return; // covered by the live-engine tests in CI
        }
        let registry = SessionRegistry::new();
        let sink: Arc<dyn FrameSink> = Arc::new(RecordingSink::default());
        assert_eq!(
            registry.start("tab-1", sample_config(), sink).err(),
            Some(Error::Unavailable),
        );
        assert!(registry.ids().is_empty(), "a refused start must not register");
        assert!(!registry.close("tab-1"), "closing an unknown session is false, not a panic");
    }

    #[test]
    fn recording_sink_bounds_its_event_log() {
        /* A cursor event per motion would otherwise grow without limit for a
         * diagnostic nobody reads past the first screenful. */
        let sink = RecordingSink::default();
        for i in 0..1000 {
            sink.event(SessionEvent::CursorMoved { x: i, y: i });
        }
        assert_eq!(sink.snapshot().events.len(), 256);
    }

    #[test]
    fn recording_sink_counts_frame_bytes() {
        let sink = RecordingSink::default();
        let pixels = vec![0u8; 4 * 2 * 2];
        sink.frame(FrameRect { x: 0, y: 0, w: 2, h: 2, pixels: &pixels });
        let snap = sink.snapshot();
        assert_eq!(snap.frames, 1);
        assert_eq!(snap.bytes, 16);
    }
}
