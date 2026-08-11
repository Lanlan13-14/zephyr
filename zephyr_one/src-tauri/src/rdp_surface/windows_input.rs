//! Win32 input and clipboard bridge for the native FreeRDP surface.
//!
//! Window messages are consumed on the surface's UI thread and forwarded to
//! [`SessionHandle`], whose C shim queues them onto the FreeRDP loop thread.
//! Clipboard APIs also stay on the UI thread: a remote clipboard callback only
//! stages text and posts a private window message. No input or clipboard payload
//! crosses Tauri, JavaScript, a WebView, or the WASM RDP implementation.

use std::collections::HashSet;
use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};

use crate::rdp::SessionHandle;

use super::{PixelSize, SurfaceError, SurfaceResult};

const WM_APP: u32 = 0x8000;
const WM_ZEPHYR_REMOTE_CLIPBOARD: u32 = WM_APP + 0x5b;
const WM_ZEPHYR_INPUT_SYNC: u32 = WM_APP + 0x5c;
const WM_ZEPHYR_INPUT_RESET: u32 = WM_APP + 0x5d;

const WM_SETFOCUS: u32 = 0x0007;
const WM_KILLFOCUS: u32 = 0x0008;
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;
const WM_UNICHAR: u32 = 0x0109;
const WM_IME_COMPOSITION: u32 = 0x010f;
const WM_IME_CHAR: u32 = 0x0286;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MBUTTONUP: u32 = 0x0208;
const WM_MOUSEWHEEL: u32 = 0x020a;
const WM_XBUTTONDOWN: u32 = 0x020b;
const WM_XBUTTONUP: u32 = 0x020c;
const WM_MOUSEHWHEEL: u32 = 0x020e;
const WM_CAPTURECHANGED: u32 = 0x0215;
const WM_CLIPBOARDUPDATE: u32 = 0x031d;

const UNICODE_NOCHAR: usize = 0xffff;
const GCS_RESULTSTR: isize = 0x0800;

const KBD_FLAGS_EXTENDED: u16 = 0x0100;
const KBD_FLAGS_RELEASE: u16 = 0x8000;

const PTR_FLAGS_WHEEL_NEGATIVE: u16 = 0x0100;
const PTR_FLAGS_WHEEL: u16 = 0x0200;
const PTR_FLAGS_HWHEEL: u16 = 0x0400;
const PTR_FLAGS_MOVE: u16 = 0x0800;
const PTR_FLAGS_BUTTON1: u16 = 0x1000;
const PTR_FLAGS_BUTTON2: u16 = 0x2000;
const PTR_FLAGS_BUTTON3: u16 = 0x4000;
const PTR_FLAGS_DOWN: u16 = 0x8000;
const PTR_XFLAGS_BUTTON1: u16 = 0x0001;
const PTR_XFLAGS_BUTTON2: u16 = 0x0002;

const KBD_SYNC_SCROLL_LOCK: u32 = 0x0001;
const KBD_SYNC_NUM_LOCK: u32 = 0x0002;
const KBD_SYNC_CAPS_LOCK: u32 = 0x0004;
const KBD_SYNC_KANA_LOCK: u32 = 0x0008;
const VK_CAPITAL: i32 = 0x14;
const VK_KANA: i32 = 0x15;
const VK_NUMLOCK: i32 = 0x90;
const VK_SCROLL: i32 = 0x91;

const CF_UNICODETEXT: u32 = 13;
const GMEM_MOVEABLE: u32 = 0x0002;
const MAX_CLIPBOARD_UTF16_BYTES: usize = 4 * 1024 * 1024;
/* Text units exclude the required final NUL, matching the cliprdr wire cap. */
const MAX_CLIPBOARD_UTF16_UNITS: usize = MAX_CLIPBOARD_UTF16_BYTES / size_of::<u16>() - 1;
const CLIPBOARD_OPEN_ATTEMPTS: usize = 5;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct RemotePoint {
    x: u16,
    y: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerPacketKind {
    Primary,
    Extended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PointerPacket {
    kind: PointerPacketKind,
    flags: u16,
    point: RemotePoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PhysicalKey {
    code: u16,
    extended: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyPacket {
    key: PhysicalKey,
    flags: u16,
    release: bool,
}

trait InputTarget: Send + Sync {
    fn mouse(&self, packet: PointerPacket);
    fn scancode(&self, flags: u16, code: u16);
    fn unicode(&self, flags: u16, code: u16);
    fn sync(&self, flags: u32);
    fn clipboard(&self, text: &str);
}

struct SessionInputTarget(SessionHandle);

impl InputTarget for SessionInputTarget {
    fn mouse(&self, packet: PointerPacket) {
        match packet.kind {
            PointerPacketKind::Primary => {
                self.0
                    .send_mouse(packet.flags, packet.point.x, packet.point.y)
            }
            PointerPacketKind::Extended => {
                self.0
                    .send_mouse_ex(packet.flags, packet.point.x, packet.point.y)
            }
        }
    }

    fn scancode(&self, flags: u16, code: u16) {
        self.0.send_scancode(flags, code);
    }

    fn unicode(&self, flags: u16, code: u16) {
        self.0.send_unicode(flags, code);
    }

    fn sync(&self, flags: u32) {
        self.0.send_sync(flags);
    }

    fn clipboard(&self, text: &str) {
        // Interior NUL and teardown races are intentionally silent here. The
        // event is best-effort clipboard state, not a reason to expose content
        // through an error or log path.
        let _ = self.0.set_clipboard(text);
    }
}

#[derive(Clone, Copy)]
struct WindowBinding {
    hwnd: isize,
    token: usize,
}

struct BridgeState {
    target: Option<Arc<dyn InputTarget>>,
    window: Option<WindowBinding>,
    remote_size: PixelSize,
    pending_remote_clipboard: Option<String>,
    suppress_clipboard_sequence: Option<u32>,
}

/// Thread-safe boundary between a native Win32 surface and one FreeRDP session.
///
/// The surface exists before its session is connected, so the target is bound
/// later with [`WindowsInputBridge::bind_session`]. Detaching a window clears
/// both the target and staged clipboard text, making destruction a callback
/// fence even if the operating system reuses the old HWND value.
pub struct WindowsInputBridge {
    state: Mutex<BridgeState>,
}

impl WindowsInputBridge {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BridgeState {
                target: None,
                window: None,
                remote_size: PixelSize::new(1, 1),
                pending_remote_clipboard: None,
                suppress_clipboard_sequence: None,
            }),
        }
    }

    /// Bind after `SessionRegistry::start` returns its live handle.
    pub fn bind_session(&self, session: SessionHandle) {
        self.bind_target(Arc::new(SessionInputTarget(session)));
    }

    fn bind_target(&self, target: Arc<dyn InputTarget>) {
        let window = {
            let mut state = self.state.lock();
            state.target = Some(target);
            state.window
        };
        if let Some(window) = window {
            let _ = post_private_message(window, WM_ZEPHYR_INPUT_SYNC);
        }
    }

    /// Stop forwarding immediately. The UI-thread reset message only clears its
    /// pressed-key bookkeeping; it cannot retain or invoke the old target.
    pub fn unbind_session(&self) {
        let window = {
            let mut state = self.state.lock();
            state.target = None;
            state.pending_remote_clipboard = None;
            state.suppress_clipboard_sequence = None;
            state.window
        };
        if let Some(window) = window {
            let _ = post_private_message(window, WM_ZEPHYR_INPUT_RESET);
        }
    }

    pub fn set_remote_size(&self, size: PixelSize) {
        if size.width != 0 && size.height != 0 {
            self.state.lock().remote_size = size;
        }
    }

    fn attach_window(&self, hwnd: HWND, token: usize, remote_size: PixelSize) {
        let mut state = self.state.lock();
        state.window = Some(WindowBinding {
            hwnd: hwnd.0 as isize,
            token,
        });
        state.remote_size = remote_size;
        state.pending_remote_clipboard = None;
        state.suppress_clipboard_sequence = None;
    }

    fn detach_window(&self, hwnd: HWND, token: usize) {
        let mut state = self.state.lock();
        if state
            .window
            .is_some_and(|window| window.hwnd == hwnd.0 as isize && window.token == token)
        {
            state.window = None;
            state.target = None;
            state.pending_remote_clipboard = None;
            state.suppress_clipboard_sequence = None;
        }
    }

    /// Stage remote text for the surface UI thread. No clipboard API runs on
    /// the FreeRDP callback thread.
    pub fn apply_remote_clipboard(&self, text: &str) -> SurfaceResult {
        validate_clipboard_text(text)?;
        let window = {
            let mut state = self.state.lock();
            let window = state.window.ok_or(SurfaceError::Detached)?;
            state.pending_remote_clipboard = Some(text.to_owned());
            window
        };

        if !post_private_message(window, WM_ZEPHYR_REMOTE_CLIPBOARD) {
            let mut state = self.state.lock();
            if state
                .window
                .is_some_and(|current| current.hwnd == window.hwnd && current.token == window.token)
            {
                state.pending_remote_clipboard = None;
            }
            return Err(SurfaceError::Platform(
                "failed to queue remote clipboard update".to_owned(),
            ));
        }
        Ok(())
    }

    fn window_and_size(&self) -> (Option<WindowBinding>, PixelSize) {
        let state = self.state.lock();
        (state.window, state.remote_size)
    }

    fn send_mouse(&self, packet: PointerPacket) {
        if let Some(target) = self.state.lock().target.clone() {
            target.mouse(packet);
        }
    }

    fn send_key(&self, packet: KeyPacket) {
        if let Some(target) = self.state.lock().target.clone() {
            target.scancode(packet.flags, packet.key.code);
        }
    }

    fn send_unicode_units(&self, units: &[u16]) {
        let target = self.state.lock().target.clone();
        let Some(target) = target else {
            return;
        };
        for &unit in units {
            target.unicode(0, unit);
            target.unicode(KBD_FLAGS_RELEASE, unit);
        }
    }

    fn send_sync(&self, flags: u32) {
        if let Some(target) = self.state.lock().target.clone() {
            target.sync(flags);
        }
    }

    fn send_local_clipboard(&self, text: &str) {
        if let Some(target) = self.state.lock().target.clone() {
            target.clipboard(text);
        }
    }

    fn take_remote_clipboard(&self, hwnd: HWND, token: usize) -> Option<String> {
        let mut state = self.state.lock();
        if state
            .window
            .is_some_and(|window| window.hwnd == hwnd.0 as isize && window.token == token)
        {
            state.pending_remote_clipboard.take()
        } else {
            None
        }
    }

    fn mark_remote_sequence(&self, hwnd: HWND, token: usize, sequence: u32) {
        let mut state = self.state.lock();
        if state
            .window
            .is_some_and(|window| window.hwnd == hwnd.0 as isize && window.token == token)
        {
            state.suppress_clipboard_sequence = Some(sequence);
        }
    }

    fn consume_remote_sequence(&self, sequence: u32) -> bool {
        let mut state = self.state.lock();
        if state.suppress_clipboard_sequence == Some(sequence) {
            state.suppress_clipboard_sequence = None;
            true
        } else {
            // Any newer clipboard owner makes the old suppression token stale.
            if state
                .suppress_clipboard_sequence
                .is_some_and(|expected| expected != sequence)
            {
                state.suppress_clipboard_sequence = None;
            }
            false
        }
    }
}

impl Default for WindowsInputBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// UI-thread state for one HWND. Only small key/button sets are retained; no
/// clipboard text lives here.
pub struct WindowsWindowInput {
    bridge: Arc<WindowsInputBridge>,
    state: Mutex<WindowInputState>,
    attached: AtomicBool,
    token: usize,
}

impl WindowsWindowInput {
    pub fn new(bridge: Arc<WindowsInputBridge>, token: usize) -> Self {
        Self {
            bridge,
            state: Mutex::new(WindowInputState::default()),
            attached: AtomicBool::new(false),
            token,
        }
    }

    pub fn attach(&self, hwnd: HWND, remote_size: PixelSize) -> SurfaceResult {
        if unsafe { win32::AddClipboardFormatListener(hwnd.0) } == 0 {
            return Err(SurfaceError::Platform(
                "AddClipboardFormatListener failed".to_owned(),
            ));
        }
        self.bridge.attach_window(hwnd, self.token, remote_size);
        self.attached.store(true, Ordering::Release);
        Ok(())
    }

    /// Release all pressed remote inputs before clearing the session target.
    /// Called from `WM_DESTROY`, and idempotent for create-failure teardown.
    pub fn shutdown(&self, hwnd: HWND) {
        if !self.attached.swap(false, Ordering::AcqRel) {
            self.bridge.detach_window(hwnd, self.token);
            return;
        }
        self.release_all(hwnd);
        unsafe {
            let _ = win32::RemoveClipboardFormatListener(hwnd.0);
        }
        self.bridge.detach_window(hwnd, self.token);
    }

    /// Return `Some` when the message belongs to the native RDP input plane.
    pub unsafe fn handle_message(
        &self,
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> Option<LRESULT> {
        match message {
            WM_MOUSEMOVE => {
                if let Some(point) = self.map_message_point(hwnd, lparam, false) {
                    self.state.lock().last_point = point;
                    self.bridge.send_mouse(PointerPacket {
                        kind: PointerPacketKind::Primary,
                        flags: PTR_FLAGS_MOVE,
                        point,
                    });
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN => {
                let point = self.map_message_point(hwnd, lparam, false)?;
                let button = pointer_button(message, wparam)?;
                let _ = win32::SetFocus(hwnd.0);
                let _ = win32::SetCapture(hwnd.0);
                let packet = self.state.lock().button(button, true, point);
                self.bridge.send_mouse(packet);
                Some(LRESULT((message == WM_XBUTTONDOWN) as isize))
            }
            WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP => {
                let point = self.map_message_point(hwnd, lparam, false)?;
                let button = pointer_button(message, wparam)?;
                let (packet, buttons_empty) = {
                    let mut state = self.state.lock();
                    let packet = state.button(button, false, point);
                    (packet, state.pressed_buttons == 0)
                };
                self.bridge.send_mouse(packet);
                if buttons_empty {
                    let _ = win32::ReleaseCapture();
                }
                Some(LRESULT((message == WM_XBUTTONUP) as isize))
            }
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                let point = self.map_message_point(hwnd, lparam, true)?;
                let delta = high_i16(wparam.0);
                if let Some(packet) = wheel_packet(message == WM_MOUSEHWHEEL, delta, point) {
                    self.state.lock().last_point = point;
                    self.bridge.send_mouse(packet);
                }
                Some(LRESULT(0))
            }
            WM_CAPTURECHANGED => {
                self.release_pointer_buttons();
                Some(LRESULT(0))
            }
            WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP => {
                if let Some(packet) = key_packet(message, lparam) {
                    self.state.lock().record_key(packet);
                    self.bridge.send_key(packet);
                }
                Some(LRESULT(0))
            }
            WM_SETFOCUS | WM_ZEPHYR_INPUT_SYNC => {
                self.bridge.send_sync(lock_key_flags());
                Some(LRESULT(0))
            }
            WM_KILLFOCUS => {
                self.release_all(hwnd);
                Some(LRESULT(0))
            }
            WM_ZEPHYR_INPUT_RESET => {
                self.state.lock().clear();
                let _ = win32::ReleaseCapture();
                Some(LRESULT(0))
            }
            WM_UNICHAR => {
                if wparam.0 == UNICODE_NOCHAR {
                    return Some(LRESULT(1));
                }
                if let Some(character) = char::from_u32(wparam.0 as u32) {
                    let mut units = [0u16; 2];
                    self.bridge
                        .send_unicode_units(character.encode_utf16(&mut units));
                }
                Some(LRESULT(0))
            }
            WM_IME_COMPOSITION if lparam.0 & GCS_RESULTSTR != 0 => {
                if let Some(units) = committed_ime_text(hwnd) {
                    self.bridge.send_unicode_units(&units);
                }
                // Handling the result prevents DefWindowProc from generating a
                // second WM_IME_CHAR copy of the committed text.
                Some(LRESULT(0))
            }
            WM_IME_CHAR => {
                if let Ok(unit) = u16::try_from(wparam.0) {
                    self.bridge.send_unicode_units(&[unit]);
                }
                Some(LRESULT(0))
            }
            WM_ZEPHYR_REMOTE_CLIPBOARD if wparam.0 == self.token => {
                if let Some(text) = self.bridge.take_remote_clipboard(hwnd, self.token) {
                    if let Some(sequence) = write_system_clipboard(hwnd, &text) {
                        self.bridge.mark_remote_sequence(hwnd, self.token, sequence);
                    }
                }
                Some(LRESULT(0))
            }
            WM_CLIPBOARDUPDATE => {
                let sequence = win32::GetClipboardSequenceNumber();
                if !self.bridge.consume_remote_sequence(sequence) {
                    if let Some(text) = read_system_clipboard(hwnd) {
                        self.bridge.send_local_clipboard(&text);
                    }
                }
                Some(LRESULT(0))
            }
            _ => None,
        }
    }

    unsafe fn map_message_point(
        &self,
        hwnd: HWND,
        lparam: LPARAM,
        screen_coordinates: bool,
    ) -> Option<RemotePoint> {
        let mut point = WinPoint {
            x: low_i16(lparam.0 as usize) as i32,
            y: high_i16(lparam.0 as usize) as i32,
        };
        if screen_coordinates && win32::ScreenToClient(hwnd.0, &mut point) == 0 {
            return None;
        }
        let mut client = WinRect::default();
        if win32::GetClientRect(hwnd.0, &mut client) == 0 {
            return None;
        }
        let (_, remote_size) = self.bridge.window_and_size();
        map_client_point(
            point.x,
            point.y,
            client.right.saturating_sub(client.left),
            client.bottom.saturating_sub(client.top),
            remote_size,
        )
    }

    fn release_pointer_buttons(&self) {
        let packets = self.state.lock().release_buttons();
        for packet in packets {
            self.bridge.send_mouse(packet);
        }
    }

    fn release_all(&self, _hwnd: HWND) {
        let (pointer, keys) = self.state.lock().release_all();
        for packet in pointer {
            self.bridge.send_mouse(packet);
        }
        for packet in keys {
            self.bridge.send_key(packet);
        }
        unsafe {
            let _ = win32::ReleaseCapture();
        }
    }
}

#[derive(Default)]
struct WindowInputState {
    pressed_buttons: u8,
    pressed_keys: HashSet<PhysicalKey>,
    last_point: RemotePoint,
}

impl WindowInputState {
    fn button(&mut self, button: PointerButton, down: bool, point: RemotePoint) -> PointerPacket {
        self.last_point = point;
        if down {
            self.pressed_buttons |= button.bit();
        } else {
            self.pressed_buttons &= !button.bit();
        }
        PointerPacket {
            kind: button.kind(),
            flags: button.flag() | if down { PTR_FLAGS_DOWN } else { 0 },
            point,
        }
    }

    fn record_key(&mut self, packet: KeyPacket) {
        if packet.release {
            self.pressed_keys.remove(&packet.key);
        } else {
            self.pressed_keys.insert(packet.key);
        }
    }

    fn release_buttons(&mut self) -> Vec<PointerPacket> {
        let mut packets = Vec::new();
        for button in PointerButton::ALL {
            if self.pressed_buttons & button.bit() != 0 {
                packets.push(self.button(button, false, self.last_point));
            }
        }
        packets
    }

    fn release_all(&mut self) -> (Vec<PointerPacket>, Vec<KeyPacket>) {
        let pointer = self.release_buttons();
        let keys = self
            .pressed_keys
            .drain()
            .map(|key| KeyPacket {
                key,
                flags: extended_flag(key) | KBD_FLAGS_RELEASE,
                release: true,
            })
            .collect();
        (pointer, keys)
    }

    fn clear(&mut self) {
        self.pressed_buttons = 0;
        self.pressed_keys.clear();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl PointerButton {
    const ALL: [Self; 5] = [Self::Left, Self::Right, Self::Middle, Self::X1, Self::X2];

    const fn bit(self) -> u8 {
        1 << self as u8
    }

    const fn kind(self) -> PointerPacketKind {
        match self {
            Self::X1 | Self::X2 => PointerPacketKind::Extended,
            _ => PointerPacketKind::Primary,
        }
    }

    const fn flag(self) -> u16 {
        match self {
            Self::Left => PTR_FLAGS_BUTTON1,
            Self::Right => PTR_FLAGS_BUTTON2,
            Self::Middle => PTR_FLAGS_BUTTON3,
            Self::X1 => PTR_XFLAGS_BUTTON1,
            Self::X2 => PTR_XFLAGS_BUTTON2,
        }
    }
}

fn pointer_button(message: u32, wparam: WPARAM) -> Option<PointerButton> {
    match message {
        WM_LBUTTONDOWN | WM_LBUTTONUP => Some(PointerButton::Left),
        WM_RBUTTONDOWN | WM_RBUTTONUP => Some(PointerButton::Right),
        WM_MBUTTONDOWN | WM_MBUTTONUP => Some(PointerButton::Middle),
        WM_XBUTTONDOWN | WM_XBUTTONUP => match (wparam.0 >> 16) & 0xffff {
            1 => Some(PointerButton::X1),
            2 => Some(PointerButton::X2),
            _ => None,
        },
        _ => None,
    }
}

fn map_client_point(
    x: i32,
    y: i32,
    client_width: i32,
    client_height: i32,
    remote: PixelSize,
) -> Option<RemotePoint> {
    if client_width <= 0 || client_height <= 0 || remote.width == 0 || remote.height == 0 {
        return None;
    }
    Some(RemotePoint {
        x: map_axis(x, client_width, remote.width),
        y: map_axis(y, client_height, remote.height),
    })
}

fn map_axis(value: i32, client_extent: i32, remote_extent: u32) -> u16 {
    let client_max = (client_extent - 1).max(0) as u64;
    let remote_max = remote_extent.saturating_sub(1).min(u16::MAX as u32) as u64;
    if client_max == 0 || remote_max == 0 {
        return 0;
    }
    let value = value.clamp(0, client_extent - 1) as u64;
    ((value * remote_max + client_max / 2) / client_max) as u16
}

fn key_packet(message: u32, lparam: LPARAM) -> Option<KeyPacket> {
    let bits = lparam.0 as usize;
    let code = ((bits >> 16) & 0xff) as u16;
    if code == 0 {
        return None;
    }
    let key = PhysicalKey {
        code,
        extended: bits & (1 << 24) != 0,
    };
    let release = matches!(message, WM_KEYUP | WM_SYSKEYUP);
    Some(KeyPacket {
        key,
        flags: extended_flag(key) | if release { KBD_FLAGS_RELEASE } else { 0 },
        release,
    })
}

const fn extended_flag(key: PhysicalKey) -> u16 {
    if key.extended {
        KBD_FLAGS_EXTENDED
    } else {
        0
    }
}

fn wheel_packet(horizontal: bool, delta: i16, point: RemotePoint) -> Option<PointerPacket> {
    if delta == 0 {
        return None;
    }
    let magnitude = delta.unsigned_abs().min(0xff);
    Some(PointerPacket {
        kind: PointerPacketKind::Primary,
        flags: if horizontal {
            PTR_FLAGS_HWHEEL
        } else {
            PTR_FLAGS_WHEEL
        } | if delta < 0 {
            PTR_FLAGS_WHEEL_NEGATIVE
        } else {
            0
        } | magnitude,
        point,
    })
}

fn lock_key_flags() -> u32 {
    let enabled = |key| unsafe { win32::GetKeyState(key) & 1 != 0 };
    (if enabled(VK_SCROLL) {
        KBD_SYNC_SCROLL_LOCK
    } else {
        0
    }) | (if enabled(VK_NUMLOCK) {
        KBD_SYNC_NUM_LOCK
    } else {
        0
    }) | (if enabled(VK_CAPITAL) {
        KBD_SYNC_CAPS_LOCK
    } else {
        0
    }) | (if enabled(VK_KANA) {
        KBD_SYNC_KANA_LOCK
    } else {
        0
    })
}

fn validate_clipboard_text(text: &str) -> SurfaceResult {
    if text.contains('\0') {
        return Err(SurfaceError::Platform(
            "clipboard text contains an interior NUL".to_owned(),
        ));
    }
    if text
        .encode_utf16()
        .take(MAX_CLIPBOARD_UTF16_UNITS + 1)
        .count()
        > MAX_CLIPBOARD_UTF16_UNITS
    {
        return Err(SurfaceError::Platform(
            "clipboard text exceeds the native clipboard limit".to_owned(),
        ));
    }
    Ok(())
}

fn post_private_message(window: WindowBinding, message: u32) -> bool {
    unsafe { win32::PostMessageW(window.hwnd as *mut c_void, message, window.token, 0) != 0 }
}

unsafe fn committed_ime_text(hwnd: HWND) -> Option<Vec<u16>> {
    let input_context = win32::ImmGetContext(hwnd.0);
    if input_context.is_null() {
        return None;
    }
    struct InputContextGuard {
        hwnd: *mut c_void,
        context: *mut c_void,
    }
    impl Drop for InputContextGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = win32::ImmReleaseContext(self.hwnd, self.context);
            }
        }
    }
    let _guard = InputContextGuard {
        hwnd: hwnd.0,
        context: input_context,
    };
    let bytes =
        win32::ImmGetCompositionStringW(input_context, GCS_RESULTSTR as u32, ptr::null_mut(), 0);
    if bytes <= 0 || bytes as usize % 2 != 0 {
        return None;
    }
    let units = bytes as usize / 2;
    if units > MAX_CLIPBOARD_UTF16_UNITS {
        return None;
    }
    let mut text = vec![0u16; units];
    let copied = win32::ImmGetCompositionStringW(
        input_context,
        GCS_RESULTSTR as u32,
        text.as_mut_ptr().cast(),
        bytes as u32,
    );
    (copied == bytes).then_some(text)
}

fn write_system_clipboard(hwnd: HWND, text: &str) -> Option<u32> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > MAX_CLIPBOARD_UTF16_UNITS {
        return None;
    }
    units.push(0);
    let bytes = units.len().checked_mul(size_of::<u16>())?;
    let allocation = unsafe { win32::GlobalAlloc(GMEM_MOVEABLE, bytes) };
    if allocation.is_null() {
        return None;
    }
    let memory = unsafe { win32::GlobalLock(allocation) };
    if memory.is_null() {
        unsafe {
            let _ = win32::GlobalFree(allocation);
        }
        return None;
    }
    unsafe {
        ptr::copy_nonoverlapping(units.as_ptr().cast::<u8>(), memory.cast::<u8>(), bytes);
        let _ = win32::GlobalUnlock(allocation);
    }

    let Some(_clipboard) = open_clipboard(hwnd) else {
        unsafe {
            let _ = win32::GlobalFree(allocation);
        }
        return None;
    };
    if unsafe { win32::EmptyClipboard() } == 0
        || unsafe { win32::SetClipboardData(CF_UNICODETEXT, allocation) }.is_null()
    {
        unsafe {
            let _ = win32::GlobalFree(allocation);
        }
        return None;
    }
    // SetClipboardData transferred allocation ownership to the system.
    Some(unsafe { win32::GetClipboardSequenceNumber() })
}

fn read_system_clipboard(hwnd: HWND) -> Option<String> {
    if unsafe { win32::IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
        return None;
    }
    let _clipboard = open_clipboard(hwnd)?;
    let allocation = unsafe { win32::GetClipboardData(CF_UNICODETEXT) };
    if allocation.is_null() {
        return None;
    }
    let byte_len = unsafe { win32::GlobalSize(allocation) };
    if byte_len < size_of::<u16>()
        || byte_len % size_of::<u16>() != 0
        || byte_len > MAX_CLIPBOARD_UTF16_BYTES
    {
        return None;
    }
    let memory = unsafe { win32::GlobalLock(allocation) };
    if memory.is_null() {
        return None;
    }
    struct GlobalUnlockGuard(*mut c_void);
    impl Drop for GlobalUnlockGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = win32::GlobalUnlock(self.0);
            }
        }
    }
    let _unlock = GlobalUnlockGuard(allocation);
    let units =
        unsafe { std::slice::from_raw_parts(memory.cast::<u16>(), byte_len / size_of::<u16>()) };
    let end = units.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&units[..end]).ok()
}

struct ClipboardGuard;

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = win32::CloseClipboard();
        }
    }
}

fn open_clipboard(hwnd: HWND) -> Option<ClipboardGuard> {
    for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
        if unsafe { win32::OpenClipboard(hwnd.0) } != 0 {
            return Some(ClipboardGuard);
        }
        if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
            thread::sleep(Duration::from_millis(1));
        }
    }
    None
}

const fn low_i16(value: usize) -> i16 {
    (value & 0xffff) as u16 as i16
}

const fn high_i16(value: usize) -> i16 {
    ((value >> 16) & 0xffff) as u16 as i16
}

use std::mem::size_of;

#[repr(C)]
#[derive(Default)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Default)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[allow(non_snake_case)]
mod win32 {
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        pub fn AddClipboardFormatListener(hwnd: *mut c_void) -> i32;
        pub fn RemoveClipboardFormatListener(hwnd: *mut c_void) -> i32;
        pub fn OpenClipboard(hwnd: *mut c_void) -> i32;
        pub fn CloseClipboard() -> i32;
        pub fn EmptyClipboard() -> i32;
        pub fn GetClipboardData(format: u32) -> *mut c_void;
        pub fn SetClipboardData(format: u32, memory: *mut c_void) -> *mut c_void;
        pub fn IsClipboardFormatAvailable(format: u32) -> i32;
        pub fn GetClipboardSequenceNumber() -> u32;
        pub fn PostMessageW(hwnd: *mut c_void, message: u32, wparam: usize, lparam: isize) -> i32;
        pub fn GetClientRect(hwnd: *mut c_void, rect: *mut super::WinRect) -> i32;
        pub fn ScreenToClient(hwnd: *mut c_void, point: *mut super::WinPoint) -> i32;
        pub fn SetFocus(hwnd: *mut c_void) -> *mut c_void;
        pub fn SetCapture(hwnd: *mut c_void) -> *mut c_void;
        pub fn ReleaseCapture() -> i32;
        pub fn GetKeyState(virtual_key: i32) -> i16;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        pub fn GlobalFree(memory: *mut c_void) -> *mut c_void;
        pub fn GlobalLock(memory: *mut c_void) -> *mut c_void;
        pub fn GlobalUnlock(memory: *mut c_void) -> i32;
        pub fn GlobalSize(memory: *mut c_void) -> usize;
    }

    #[link(name = "imm32")]
    extern "system" {
        pub fn ImmGetContext(hwnd: *mut c_void) -> *mut c_void;
        pub fn ImmReleaseContext(hwnd: *mut c_void, context: *mut c_void) -> i32;
        pub fn ImmGetCompositionStringW(
            context: *mut c_void,
            index: u32,
            buffer: *mut c_void,
            bytes: u32,
        ) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingTarget {
        mouse: Mutex<Vec<PointerPacket>>,
        keys: Mutex<Vec<(u16, u16)>>,
        unicode: Mutex<Vec<(u16, u16)>>,
        sync: Mutex<Vec<u32>>,
        clipboard: Mutex<Vec<String>>,
    }

    impl InputTarget for RecordingTarget {
        fn mouse(&self, packet: PointerPacket) {
            self.mouse.lock().push(packet);
        }

        fn scancode(&self, flags: u16, code: u16) {
            self.keys.lock().push((flags, code));
        }

        fn unicode(&self, flags: u16, code: u16) {
            self.unicode.lock().push((flags, code));
        }

        fn sync(&self, flags: u32) {
            self.sync.lock().push(flags);
        }

        fn clipboard(&self, text: &str) {
            self.clipboard.lock().push(text.to_owned());
        }
    }

    #[test]
    fn client_coordinates_map_to_remote_pixels_across_dpi_scaled_sizes() {
        let cases = [
            ((0, 0, 1280, 720), PixelSize::new(1920, 1080), (0, 0)),
            (
                (1279, 719, 1280, 720),
                PixelSize::new(1920, 1080),
                (1919, 1079),
            ),
            (
                (640, 360, 1280, 720),
                PixelSize::new(1920, 1080),
                (960, 540),
            ),
            ((-50, 900, 1280, 720), PixelSize::new(1920, 1080), (0, 1079)),
            ((0, 0, 1, 1), PixelSize::new(3840, 2160), (0, 0)),
        ];
        for ((x, y, width, height), remote, expected) in cases {
            let mapped = map_client_point(x, y, width, height, remote).unwrap();
            assert_eq!((mapped.x, mapped.y), expected);
        }
        assert_eq!(map_client_point(0, 0, 0, 100, PixelSize::new(10, 10)), None);
    }

    #[test]
    fn remote_coordinates_are_clamped_to_the_rdp_u16_wire_range() {
        let mapped = map_client_point(99, 99, 100, 100, PixelSize::new(100_000, 80_000)).unwrap();
        assert_eq!(
            mapped,
            RemotePoint {
                x: u16::MAX,
                y: u16::MAX
            }
        );
    }

    #[test]
    fn key_message_table_preserves_extended_and_release_flags() {
        let cases = [
            (WM_KEYDOWN, 0x001e_0001isize, 0x1e, 0),
            (WM_KEYUP, 0xc01e_0001u32 as isize, 0x1e, KBD_FLAGS_RELEASE),
            (WM_SYSKEYDOWN, 0x0138_0001isize, 0x38, KBD_FLAGS_EXTENDED),
            (
                WM_SYSKEYUP,
                0xc138_0001u32 as isize,
                0x38,
                KBD_FLAGS_EXTENDED | KBD_FLAGS_RELEASE,
            ),
        ];
        for (message, lparam, code, flags) in cases {
            let packet = key_packet(message, LPARAM(lparam)).unwrap();
            assert_eq!(packet.key.code, code);
            assert_eq!(packet.flags, flags);
        }
        assert_eq!(key_packet(WM_KEYDOWN, LPARAM(0)), None);
    }

    #[test]
    fn wheel_table_encodes_axis_direction_and_bounded_magnitude() {
        let point = RemotePoint { x: 7, y: 9 };
        assert_eq!(
            wheel_packet(false, 120, point).unwrap().flags,
            PTR_FLAGS_WHEEL | 120
        );
        assert_eq!(
            wheel_packet(false, -120, point).unwrap().flags,
            PTR_FLAGS_WHEEL | PTR_FLAGS_WHEEL_NEGATIVE | 120
        );
        assert_eq!(
            wheel_packet(true, 300, point).unwrap().flags,
            PTR_FLAGS_HWHEEL | 0xff
        );
        assert_eq!(wheel_packet(false, 0, point), None);
    }

    #[test]
    fn focus_loss_releases_every_pressed_key_and_pointer_button() {
        let point = RemotePoint { x: 10, y: 12 };
        let mut state = WindowInputState::default();
        state.button(PointerButton::Left, true, point);
        state.button(PointerButton::X2, true, point);
        state.record_key(KeyPacket {
            key: PhysicalKey {
                code: 0x1d,
                extended: false,
            },
            flags: 0,
            release: false,
        });
        state.record_key(KeyPacket {
            key: PhysicalKey {
                code: 0x38,
                extended: true,
            },
            flags: KBD_FLAGS_EXTENDED,
            release: false,
        });

        let (pointer, keys) = state.release_all();
        assert_eq!(pointer.len(), 2);
        assert!(pointer
            .iter()
            .all(|packet| packet.flags & PTR_FLAGS_DOWN == 0));
        assert_eq!(keys.len(), 2);
        assert!(keys
            .iter()
            .all(|packet| packet.flags & KBD_FLAGS_RELEASE != 0));
        assert_eq!(state.pressed_buttons, 0);
        assert!(state.pressed_keys.is_empty());
    }

    #[test]
    fn unicode_text_uses_down_up_pairs_for_each_utf16_unit() {
        let bridge = WindowsInputBridge::new();
        let target = Arc::new(RecordingTarget::default());
        bridge.bind_target(target.clone());
        let units: Vec<u16> = "A\u{1f642}".encode_utf16().collect();
        bridge.send_unicode_units(&units);
        assert_eq!(
            *target.unicode.lock(),
            units
                .iter()
                .flat_map(|unit| [(0, *unit), (KBD_FLAGS_RELEASE, *unit)])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn unbind_is_an_immediate_callback_fence() {
        let bridge = WindowsInputBridge::new();
        let target = Arc::new(RecordingTarget::default());
        bridge.bind_target(target.clone());
        bridge.send_mouse(PointerPacket {
            kind: PointerPacketKind::Primary,
            flags: PTR_FLAGS_MOVE,
            point: RemotePoint { x: 1, y: 2 },
        });
        bridge.unbind_session();
        bridge.send_mouse(PointerPacket {
            kind: PointerPacketKind::Primary,
            flags: PTR_FLAGS_MOVE,
            point: RemotePoint { x: 3, y: 4 },
        });
        bridge.send_local_clipboard("must not be delivered");
        assert_eq!(target.mouse.lock().len(), 1);
        assert!(target.clipboard.lock().is_empty());
    }

    #[test]
    fn clipboard_validation_is_bounded_and_rejects_interior_nul() {
        assert!(validate_clipboard_text("hello").is_ok());
        assert!(validate_clipboard_text("secret\0suffix").is_err());
        let too_large = "x".repeat(MAX_CLIPBOARD_UTF16_UNITS + 1);
        assert!(validate_clipboard_text(&too_large).is_err());
    }

    #[test]
    fn remote_sequence_suppression_is_one_shot_and_stale_safe() {
        let bridge = WindowsInputBridge::new();
        bridge.state.lock().suppress_clipboard_sequence = Some(41);
        assert!(bridge.consume_remote_sequence(41));
        assert!(!bridge.consume_remote_sequence(41));
        bridge.state.lock().suppress_clipboard_sequence = Some(42);
        assert!(!bridge.consume_remote_sequence(43));
        assert_eq!(bridge.state.lock().suppress_clipboard_sequence, None);
    }
}
