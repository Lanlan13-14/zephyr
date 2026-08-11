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
use zeroize::{Zeroize, Zeroizing};

use super::ffi;
use super::{AudioMode, Config, Error, Security};

const MAX_CLIPBOARD_UTF16_BYTES: usize = 4 * 1024 * 1024;

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
    Resize {
        width: i32,
        height: i32,
    },
    /// Text arriving from the remote clipboard.
    Clipboard(String),
    /// The TLS certificate fingerprint this session trusted. The only record of
    /// which certificate was accepted, so it is its own variant rather than a log
    /// line an operator has to grep for.
    Certificate(String),
    CursorMoved {
        x: i32,
        y: i32,
    },
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
struct UserPtr(*const Shared);

impl UserPtr {
    fn new(shared: Arc<Shared>) -> Self {
        Self(Arc::into_raw(shared))
    }

    /// The wrapped pointer, taken by value so that naming it names the wrapper.
    ///
    /// This accessor exists for the capture rules, not for tidiness. Since the
    /// 2021 edition a closure captures the individual *places* its body mentions
    /// rather than whole variables, so a `move` closure whose body said `user.0`
    /// captured that field alone -- a bare `*mut c_void`, which is not `Send` --
    /// and the promise below was never consulted: `spawn` rejected the closure
    /// with "`*mut c_void` cannot be sent between threads safely". Going through
    /// a method makes the mentioned place the whole `UserPtr`, which is the type
    /// the promise is attached to.
    fn as_raw(&self) -> *mut c_void {
        self.0.cast_mut().cast()
    }
}

impl Drop for UserPtr {
    fn drop(&mut self) {
        // SAFETY: `new` creates exactly one raw Arc strong reference and this
        // non-Copy owner is dropped exactly once.
        unsafe { Arc::decrement_strong_count(self.0) };
    }
}

/* SAFETY: the pointer is one strong reference to an `Arc<Shared>`, produced by
 * `Arc::into_raw` in `start_impl`, and `Shared` is itself `Send + Sync`, so the
 * loop thread may both dereference the referent and drop that reference.
 *
 * The wrapper is deliberately non-Copy. Moving it into `RunOwnership` gives one
 * path responsibility for both native free and Arc reclamation, including when
 * `Builder::spawn` rejects and drops the unstarted closure. */
unsafe impl Send for UserPtr {}

type RunFn = unsafe fn(*mut ffi::zephyr_rdp_session) -> i32;
type FreeFn = unsafe fn(*mut ffi::zephyr_rdp_session);

#[cfg(zephyr_native_rdp)]
unsafe fn run_native(session: *mut ffi::zephyr_rdp_session) -> i32 {
    ffi::zephyr_rdp_run(session)
}

#[cfg(zephyr_native_rdp)]
unsafe fn free_native(session: *mut ffi::zephyr_rdp_session) {
    ffi::zephyr_rdp_free(session)
}

/// Sole owner of the native pointer after `zephyr_rdp_new` succeeds.
/// Dropping a rejected thread closure runs the same cleanup as loop exit.
struct RunOwnership {
    shared: Arc<Shared>,
    _user: UserPtr,
    run: RunFn,
    free: FreeFn,
}

impl RunOwnership {
    fn execute(self) {
        let raw = self
            .shared
            .session
            .lock()
            .expect("session mutex poisoned")
            .expect("session pointer set before the thread starts");

        // SAFETY: this value solely owns run/free and the pointer is live.
        let code = unsafe { (self.run)(raw) };
        let stop_requested = self.shared.stopping.load(Ordering::SeqCst);
        {
            let mut slot = self.shared.session.lock().expect("session mutex poisoned");
            let owned = slot.take();
            debug_assert_eq!(owned, Some(raw));
            // SAFETY: run returned and no input can observe the cleared slot
            // while this mutex is held.
            unsafe { (self.free)(raw) };
        }

        self.shared.stopping.store(true, Ordering::SeqCst);
        if code != 0 && !stop_requested {
            self.shared
                .sink
                .event(SessionEvent::Error(format!("RDP session ended: {code}")));
        }
        // Drop sees an empty slot, so it cannot free twice. `_user` then
        // releases the callback Arc after the last possible callback.
    }
}

impl Drop for RunOwnership {
    fn drop(&mut self) {
        let raw = self
            .shared
            .session
            .lock()
            .expect("session mutex poisoned")
            .take();
        if let Some(raw) = raw {
            // SAFETY: execute did not consume this pointer. On failed spawn no
            // run loop or callback can race this cleanup.
            unsafe { (self.free)(raw) };
        }
    }
}

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
        if clipboard_utf16_wire_len(text).is_none() {
            return Err(Error::ClipboardTooLarge);
        }
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
    let Some(shared) = shared_from(user) else {
        return;
    };
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
    shared.sink.frame(FrameRect {
        x,
        y,
        w,
        h,
        pixels: bytes,
    });
}

#[cfg(zephyr_native_rdp)]
unsafe extern "C" fn on_event(user: *mut c_void, code: i32, a: i32, b: i32, text: *const c_char) {
    let Some(shared) = shared_from(user) else {
        return;
    };

    let event = match code {
        ffi::ZEPHYR_RDP_EV_CONNECTED => SessionEvent::Connected,
        ffi::ZEPHYR_RDP_EV_DISCONNECTED => SessionEvent::Disconnected,
        ffi::ZEPHYR_RDP_EV_CLIPBOARD => {
            let Ok(bytes_len) = usize::try_from(a) else {
                return;
            };
            if text.is_null() || bytes_len > MAX_CLIPBOARD_UTF16_BYTES {
                return;
            }
            // SAFETY: the C shim lends exactly `a` validated bytes for this
            // synchronous callback. The hard limit is checked before making a
            // slice or allocating the owned String.
            let bytes = std::slice::from_raw_parts(text.cast::<u8>(), bytes_len);
            let Some(message) = decode_clipboard_utf16le(bytes) else {
                return;
            };
            SessionEvent::Clipboard(message)
        }
        ffi::ZEPHYR_RDP_EV_RESIZE => SessionEvent::Resize {
            width: a,
            height: b,
        },
        ffi::ZEPHYR_RDP_EV_CURSOR => SessionEvent::CursorMoved { x: a, y: b },
        other => {
            // SAFETY: non-clipboard event text remains NUL-terminated UTF-8 or
            // NULL. Clipboard deliberately uses the bounded byte path above.
            let message = if text.is_null() {
                String::new()
            } else {
                CStr::from_ptr(text).to_string_lossy().into_owned()
            };
            match other {
                ffi::ZEPHYR_RDP_EV_ERROR => SessionEvent::Error(message),
                ffi::ZEPHYR_RDP_EV_LOG => SessionEvent::Certificate(message),
                ffi::ZEPHYR_RDP_EV_CHANNEL => SessionEvent::Channel(message),
                /* An unknown code is reported rather than dropped: silently
                 * ignoring it would hide a shim that has grown an event this
                 * build does not know. */
                code => SessionEvent::Error(format!("unknown RDP event {code}: {message}")),
            }
        }
    };
    shared.sink.event(event);
}

fn clipboard_utf8_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 2
        || bytes.len() > MAX_CLIPBOARD_UTF16_BYTES
        || bytes.len() % 2 != 0
        || bytes[bytes.len() - 2..] != [0, 0]
    {
        return None;
    }

    let text_end = bytes.len() - 2;
    let mut offset = 0usize;
    let mut utf8_len = 0usize;
    while offset < text_end {
        let high = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
        if high == 0 {
            return None;
        }
        let scalar = if (0xD800..=0xDBFF).contains(&high) {
            if text_end - offset < 4 {
                return None;
            }
            let low = u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]);
            if !(0xDC00..=0xDFFF).contains(&low) {
                return None;
            }
            offset += 4;
            0x1_0000 + (((high as u32 - 0xD800) << 10) | (low as u32 - 0xDC00))
        } else {
            if (0xDC00..=0xDFFF).contains(&high) {
                return None;
            }
            offset += 2;
            high as u32
        };
        utf8_len = utf8_len.checked_add(char::from_u32(scalar)?.len_utf8())?;
    }
    Some(utf8_len)
}

fn clipboard_utf16_wire_len(text: &str) -> Option<usize> {
    let units = text
        .encode_utf16()
        .try_fold(1usize, |count, _| count.checked_add(1))?;
    let bytes = units.checked_mul(std::mem::size_of::<u16>())?;
    (bytes <= MAX_CLIPBOARD_UTF16_BYTES).then_some(bytes)
}

fn decode_clipboard_utf16le(bytes: &[u8]) -> Option<String> {
    let utf8_len = clipboard_utf8_len(bytes)?;
    let mut text = String::with_capacity(utf8_len);
    let mut offset = 0usize;
    let text_end = bytes.len() - 2;
    while offset < text_end {
        let high = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
        let scalar = if (0xD800..=0xDBFF).contains(&high) {
            let low = u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]);
            offset += 4;
            0x1_0000 + (((high as u32 - 0xD800) << 10) | (low as u32 - 0xDC00))
        } else {
            offset += 2;
            high as u32
        };
        text.push(char::from_u32(scalar)?);
    }
    debug_assert_eq!(text.len(), utf8_len);
    Some(text)
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

fn zeroized_cstring_bytes(value: CString) -> Zeroizing<Box<[u8]>> {
    let mut bytes = Zeroizing::new(value.into_bytes_with_nul().into_boxed_slice());
    bytes.zeroize();
    bytes
}

impl Drop for ConfigStrings {
    fn drop(&mut self) {
        let empty = CString::new(Vec::<u8>::new()).expect("empty CString is valid");
        let password = std::mem::replace(&mut self.password, empty);
        drop(zeroized_cstring_bytes(password));
    }
}

impl ConfigStrings {
    fn new(config: &Config) -> Result<Self, Error> {
        Ok(Self {
            host: CString::new(config.host.as_str()).map_err(|_| Error::InteriorNul("host"))?,
            username: CString::new(config.username.as_str())
                .map_err(|_| Error::InteriorNul("username"))?,
            password: CString::new(config.password.as_str())
                .map_err(|_| Error::InteriorNul("password"))?,
            domain: CString::new(config.domain.as_str())
                .map_err(|_| Error::InteriorNul("domain"))?,
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
            let user = UserPtr::new(Arc::clone(&shared));

            let created = with_config(&config, |raw| {
                // SAFETY: `raw` and its strings are alive for this call, and the
                // shim copies what it retains.
                unsafe { ffi::zephyr_rdp_new(raw, Some(on_frame), Some(on_event), user.as_raw()) }
            })?;

            if created.is_null() {
                return Err(Error::SessionCreate);
            }

            *shared.session.lock().expect("session mutex poisoned") = Some(created);

            let handle = SessionHandle {
                shared: Arc::clone(&shared),
            };
            let thread_id = id.to_string();
            let run_ownership = RunOwnership {
                shared: Arc::clone(&shared),
                _user: user,
                run: run_native,
                free: free_native,
            };

            std::thread::Builder::new()
                .name(format!("zephyr-rdp-{thread_id}"))
                .spawn(move || run_ownership.execute())
                .map_err(|_| Error::SessionCreate)?;

            self.sessions
                .lock()
                .expect("registry poisoned")
                .insert(id.to_string(), handle.clone());

            Ok(handle)
        }
    }

    pub fn get(&self, id: &str) -> Option<SessionHandle> {
        self.sessions
            .lock()
            .expect("registry poisoned")
            .get(id)
            .cloned()
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
        let mut ids: Vec<String> = self
            .sessions
            .lock()
            .expect("registry poisoned")
            .keys()
            .cloned()
            .collect();
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
        let mut config = Config::default();
        config.host = "host.example".into();
        config.username = "user".into();
        config.password = "pw".into();
        config.security = Security::Nla;
        config.audio = AudioMode::Off;
        config
    }

    #[test]
    fn config_strings_reject_interior_nuls_instead_of_truncating() {
        /* A truncated hostname would connect somewhere the user did not ask for,
         * which is worse than refusing the field. */
        let mut config = sample_config();
        config.host = "host\0evil".into();
        assert_eq!(
            ConfigStrings::new(&config).err(),
            Some(Error::InteriorNul("host"))
        );

        config = sample_config();
        config.password = "pw\0extra".into();
        assert_eq!(
            ConfigStrings::new(&config).err(),
            Some(Error::InteriorNul("password"))
        );
    }

    #[test]
    fn ffi_password_cstring_bytes_are_zeroized_before_deallocation() {
        let wiped = zeroized_cstring_bytes(CString::new("ffi-password-secret").unwrap());
        assert_eq!(wiped.len(), "ffi-password-secret".len() + 1);
        assert!(wiped.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn remote_clipboard_decoder_enforces_wire_bounds_before_allocating() {
        let valid = [b'A', 0, 0x3d, 0xd8, 0xc1, 0xdc, 0, 0];
        assert_eq!(
            decode_clipboard_utf16le(&valid).as_deref(),
            Some("A\u{1f4c1}")
        );

        assert_eq!(decode_clipboard_utf16le(&[b'A', 0, 0]), None, "odd length");
        assert_eq!(decode_clipboard_utf16le(&[b'A', 0]), None, "missing NUL");
        assert_eq!(
            decode_clipboard_utf16le(&[b'A', 0, 0, 0, b'B', 0, 0, 0]),
            None,
            "embedded NUL"
        );
        assert_eq!(
            decode_clipboard_utf16le(&[0x3d, 0xd8, 0, 0]),
            None,
            "lone high surrogate"
        );
        assert_eq!(
            decode_clipboard_utf16le(&[0xc1, 0xdc, 0, 0]),
            None,
            "lone low surrogate"
        );
    }

    #[cfg(zephyr_native_rdp)]
    #[test]
    fn c_clipboard_validator_rejects_lengths_before_reading_or_allocating() {
        let valid = [b'A', 0, 0, 0];
        let odd = [b'A', 0, 0];
        // SAFETY: the first two calls lend their exact arrays. The oversized
        // calls intentionally lend only a tiny buffer: C must reject the length
        // before it dereferences based on that length.
        unsafe {
            assert_eq!(
                ffi::zephyr_rdp_test_clipboard_payload(valid.as_ptr(), valid.len()),
                1
            );
            assert_eq!(
                ffi::zephyr_rdp_test_clipboard_payload(odd.as_ptr(), odd.len()),
                0
            );
            assert_eq!(
                ffi::zephyr_rdp_test_clipboard_payload(
                    valid.as_ptr(),
                    MAX_CLIPBOARD_UTF16_BYTES + 2,
                ),
                0
            );
            assert_eq!(
                ffi::zephyr_rdp_test_clipboard_payload(valid.as_ptr(), usize::MAX),
                0
            );
        }
    }

    #[test]
    fn remote_clipboard_decoder_accepts_exact_limit_and_rejects_one_unit_over() {
        let mut boundary = vec![0u8; MAX_CLIPBOARD_UTF16_BYTES];
        for pair in boundary[..MAX_CLIPBOARD_UTF16_BYTES - 2].chunks_exact_mut(2) {
            pair[0] = b'x';
        }
        let decoded = decode_clipboard_utf16le(&boundary).expect("exact wire limit is valid");
        assert_eq!(decoded.len(), MAX_CLIPBOARD_UTF16_BYTES / 2 - 1);

        let mut oversized = boundary;
        oversized.splice(oversized.len() - 2.., [b'x', 0, 0, 0]);
        assert_eq!(oversized.len(), MAX_CLIPBOARD_UTF16_BYTES + 2);
        assert_eq!(decode_clipboard_utf16le(&oversized), None);
    }

    #[test]
    fn local_clipboard_wire_measure_uses_utf16_bytes_including_nul() {
        assert_eq!(clipboard_utf16_wire_len("A"), Some(4));
        assert_eq!(clipboard_utf16_wire_len("\u{1f4c1}"), Some(6));
        let boundary = "x".repeat(MAX_CLIPBOARD_UTF16_BYTES / 2 - 1);
        assert_eq!(
            clipboard_utf16_wire_len(&boundary),
            Some(MAX_CLIPBOARD_UTF16_BYTES)
        );
        assert_eq!(clipboard_utf16_wire_len(&(boundary + "x")), None);
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
        assert!(
            registry.ids().is_empty(),
            "a refused start must not register"
        );
        assert!(
            !registry.close("tab-1"),
            "closing an unknown session is false, not a panic"
        );
    }

    #[test]
    fn rejected_thread_spawn_frees_session_and_callback_owner_exactly_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static FREES: AtomicUsize = AtomicUsize::new(0);

        unsafe fn fake_run(_session: *mut ffi::zephyr_rdp_session) -> i32 {
            panic!("a rejected thread must never run")
        }

        unsafe fn fake_free(session: *mut ffi::zephyr_rdp_session) {
            FREES.fetch_add(1, Ordering::SeqCst);
            drop(Box::from_raw(session.cast::<u8>()));
        }

        fn reject_spawn(task: impl FnOnce() + Send + 'static) -> std::io::Result<()> {
            drop(task);
            Err(std::io::Error::other("injected thread creation failure"))
        }

        FREES.store(0, Ordering::SeqCst);
        let sink: Arc<dyn FrameSink> = Arc::new(RecordingSink::default());
        let shared = Arc::new(Shared {
            sink,
            session: Mutex::new(None),
            stopping: AtomicBool::new(false),
        });
        let raw = Box::into_raw(Box::new(0_u8)).cast::<ffi::zephyr_rdp_session>();
        *shared.session.lock().unwrap() = Some(raw);
        let ownership = RunOwnership {
            shared: Arc::clone(&shared),
            _user: UserPtr::new(Arc::clone(&shared)),
            run: fake_run,
            free: fake_free,
        };
        assert_eq!(Arc::strong_count(&shared), 3);

        let rejected = reject_spawn(move || ownership.execute());
        assert!(rejected.is_err());
        assert_eq!(FREES.load(Ordering::SeqCst), 1);
        assert!(shared.session.lock().unwrap().is_none());
        assert_eq!(Arc::strong_count(&shared), 1);

        drop(shared);
        assert_eq!(FREES.load(Ordering::SeqCst), 1, "no double free on drop");
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
        sink.frame(FrameRect {
            x: 0,
            y: 0,
            w: 2,
            h: 2,
            pixels: &pixels,
        });
        let snap = sink.snapshot();
        assert_eq!(snap.frames, 1);
        assert_eq!(snap.bytes, 16);
    }
}
