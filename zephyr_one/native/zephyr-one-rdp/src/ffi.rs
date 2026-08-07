//! Raw bindings to the `zephyr_rdp_*` C shim.
//!
//! The only hand-maintained risk here is `Config`: it mirrors
//! `zephyr_rdp_config` field for field, and a mismatch would not fail to
//! compile — it would make C read a pointer where Rust wrote an int, which
//! corrupts memory or leaks credentials into the wrong field.
//!
//! `layout_matches_c()` closes that hole by asking the C side for
//! `sizeof`/`offsetof` of every field and comparing against Rust's own
//! `offset_of!`. It runs as a unit test *and* as a runtime assertion in `main`,
//! so a FreeRDP rebuild with different alignment fails loudly instead of
//! silently misbehaving.

use std::ffi::c_void;
use std::os::raw::c_char;

pub const EV_CONNECTED: i32 = 1;
pub const EV_DISCONNECTED: i32 = 2;
pub const EV_ERROR: i32 = 3;
pub const EV_RESIZE: i32 = 4;
pub const EV_CLIPBOARD: i32 = 5;
/// TLS certificate fingerprint, and only that. See the header comment.
pub const EV_LOG: i32 = 6;
pub const EV_CURSOR: i32 = 7;
/// A virtual channel came up; the text is its name. `rdpdr` is the wire-level
/// confirmation that folder mapping was accepted by the server.
pub const EV_CHANNEL: i32 = 8;

pub const AUDIO_LOCAL: i32 = 0;
pub const AUDIO_REMOTE: i32 = 1;
pub const AUDIO_OFF: i32 = 2;

pub const SEC_AUTO: i32 = 0;
pub const SEC_NLA: i32 = 1;
pub const SEC_TLS: i32 = 2;
pub const SEC_RDP: i32 = 3;

pub const DRIVE_OK: i32 = 0;
pub const DRIVE_NO_NAME: i32 = -1;
pub const DRIVE_NO_PATH: i32 = -2;
pub const DRIVE_NOT_FOUND: i32 = -3;
pub const DRIVE_NOT_DIR: i32 = -4;
pub const DRIVE_BAD_NAME: i32 = -5;

/// Human-readable, user-facing reason a folder mapping was refused.
///
/// Returned to the UI verbatim. The point of distinct codes is that
/// "you have not picked a folder yet" and "the folder you picked is gone" need
/// different actions from the user, and a single generic failure string would
/// force them to guess.
pub fn drive_error_message(code: i32, path: &str, name: &str) -> String {
    match code {
        DRIVE_NO_NAME => "未填写映射设备名称".to_string(),
        DRIVE_NO_PATH => "未选择映射文件夹".to_string(),
        DRIVE_NOT_FOUND => format!("映射文件夹不存在或无法访问：{path}"),
        DRIVE_NOT_DIR => format!("映射目标不是文件夹：{path}"),
        DRIVE_BAD_NAME => {
            format!("设备名称不能包含 / \\ : 等路径字符，也必须是合法 UTF-8：{name}")
        }
        _ => format!("映射文件夹校验失败（代码 {code}）"),
    }
}

#[repr(C)]
#[derive(Debug)]
pub struct Config {
    pub host: *const c_char,
    pub port: u32,
    pub username: *const c_char,
    pub password: *const c_char,
    pub domain: *const c_char,

    pub width: u32,
    pub height: u32,
    pub color_depth: u32,

    pub security: i32,
    pub ignore_certificate: i32,

    pub audio_mode: i32,
    pub microphone: i32,
    pub clipboard: i32,

    pub drive_name: *const c_char,
    pub drive_path: *const c_char,
    pub drive_read_only: i32,

    pub dynamic_resolution: i32,
    pub gfx: i32,

    pub disable_wallpaper: i32,
    pub disable_themes: i32,
    pub disable_menu_anims: i32,
    pub disable_full_window_drag: i32,
    pub allow_font_smoothing: i32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: std::ptr::null(),
            port: 3389,
            username: std::ptr::null(),
            password: std::ptr::null(),
            domain: std::ptr::null(),
            width: 1920,
            height: 1080,
            color_depth: 32,
            security: SEC_AUTO,
            ignore_certificate: 0,
            audio_mode: AUDIO_LOCAL,
            microphone: 0,
            clipboard: 1,
            drive_name: std::ptr::null(),
            drive_path: std::ptr::null(),
            drive_read_only: 0,
            dynamic_resolution: 1,
            gfx: 0,
            disable_wallpaper: 0,
            disable_themes: 0,
            disable_menu_anims: 0,
            disable_full_window_drag: 0,
            allow_font_smoothing: 1,
        }
    }
}

#[repr(C)]
pub struct Session {
    _opaque: [u8; 0],
}

pub type FrameCb = unsafe extern "C" fn(
    user: *mut c_void,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    pixels: *const u8,
    len: usize,
);

pub type EventCb =
    unsafe extern "C" fn(user: *mut c_void, code: i32, a: i32, b: i32, text: *const c_char);

extern "C" {
    pub fn zephyr_rdp_new(
        cfg: *const Config,
        frame_cb: FrameCb,
        event_cb: EventCb,
        user: *mut c_void,
    ) -> *mut Session;
    pub fn zephyr_rdp_run(s: *mut Session) -> i32;
    pub fn zephyr_rdp_stop(s: *mut Session);
    pub fn zephyr_rdp_free(s: *mut Session);

    pub fn zephyr_rdp_send_mouse(s: *mut Session, flags: u16, x: u16, y: u16);
    pub fn zephyr_rdp_send_mouse_ex(s: *mut Session, flags: u16, x: u16, y: u16);
    pub fn zephyr_rdp_send_scancode(s: *mut Session, flags: u16, code: u16);
    pub fn zephyr_rdp_send_unicode(s: *mut Session, flags: u16, code: u16);
    pub fn zephyr_rdp_send_sync(s: *mut Session, toggle_flags: u32);
    pub fn zephyr_rdp_request_full_frame(s: *mut Session);
    pub fn zephyr_rdp_resize(s: *mut Session, width: u32, height: u32);
    pub fn zephyr_rdp_set_clipboard(s: *mut Session, utf8: *const c_char);

    pub fn zephyr_rdp_freerdp_major() -> i32;
    pub fn zephyr_rdp_validate_drive(name: *const c_char, path: *const c_char) -> i32;
    /* Both sides are int32_t, spelled i32 here rather than c_int/c_long.
     *
     * This was originally bound as `c_long`, which is i64 on LP64 (Linux,
     * macOS) and i32 on LLP64 (Windows). Against a C function returning
     * int32_t, the LP64 reading left the upper 32 bits undefined — so the
     * negative sentinel came back as 0x00000000FFFFFFFF (4294967295) while
     * every real offset, being a small positive number, zero-extended to the
     * correct value. The layout test therefore passed and only the
     * unknown-selector assertion caught it. Fixed-width types on both sides
     * remove the platform dependency entirely. */
    pub fn zephyr_rdp_config_layout(selector: i32) -> i32;

    /* Move the real stdout to a private descriptor and point fd 1 at stderr.
     *
     * This exists because FreeRDP's WLog console appender writes to *stdout*,
     * which is this process's binary protocol channel. At WLOG_LEVEL=INFO (the
     * FreeRDP default) a line such as
     *     [INFO][com.freerdp.gdi] - Local framebuffer format ...
     * lands in the middle of a length-prefixed frame; the bridge then reads the
     * ASCII as a u32 length, sees it out of range, and tears the session down.
     * Measured: at INFO the stream desynchronised 83 bytes in, after exactly one
     * frame. At WARN it survived only because no INFO line happened to be
     * emitted — i.e. the default configuration was the broken one.
     *
     * Returns the caller-owned original stdout (POSIX fd / Windows HANDLE as
     * intptr_t), or -1 on failure. `intptr_t` maps to `isize`. */
    pub fn zephyr_rdp_isolate_stdout() -> isize;
}

/// C-side selector ids, mirroring `ZEPHYR_RDP_LAYOUT_*`.
mod layout {
    pub const SIZEOF: i32 = 0;
    pub const HOST: i32 = 1;
    pub const PORT: i32 = 2;
    pub const USERNAME: i32 = 3;
    pub const PASSWORD: i32 = 4;
    pub const DOMAIN: i32 = 5;
    pub const WIDTH: i32 = 6;
    pub const HEIGHT: i32 = 7;
    pub const COLOR_DEPTH: i32 = 8;
    pub const SECURITY: i32 = 9;
    pub const IGNORE_CERTIFICATE: i32 = 10;
    pub const AUDIO_MODE: i32 = 11;
    pub const MICROPHONE: i32 = 12;
    pub const CLIPBOARD: i32 = 13;
    pub const DRIVE_NAME: i32 = 14;
    pub const DRIVE_PATH: i32 = 15;
    pub const DRIVE_READ_ONLY: i32 = 16;
    pub const DYNAMIC_RESOLUTION: i32 = 17;
    pub const GFX: i32 = 18;
    pub const DISABLE_WALLPAPER: i32 = 19;
    pub const DISABLE_THEMES: i32 = 20;
    pub const DISABLE_MENU_ANIMS: i32 = 21;
    pub const DISABLE_FULL_WINDOW_DRAG: i32 = 22;
    pub const ALLOW_FONT_SMOOTHING: i32 = 23;
}

/// Compare every field offset and the total size against the C compiler's own
/// view. Returns the list of disagreements; empty means the mirror is exact.
pub fn layout_mismatches() -> Vec<String> {
    use std::mem::{offset_of, size_of};

    let pairs: [(i32, usize, &str); 24] = [
        (layout::SIZEOF, size_of::<Config>(), "sizeof"),
        (layout::HOST, offset_of!(Config, host), "host"),
        (layout::PORT, offset_of!(Config, port), "port"),
        (layout::USERNAME, offset_of!(Config, username), "username"),
        (layout::PASSWORD, offset_of!(Config, password), "password"),
        (layout::DOMAIN, offset_of!(Config, domain), "domain"),
        (layout::WIDTH, offset_of!(Config, width), "width"),
        (layout::HEIGHT, offset_of!(Config, height), "height"),
        (
            layout::COLOR_DEPTH,
            offset_of!(Config, color_depth),
            "color_depth",
        ),
        (layout::SECURITY, offset_of!(Config, security), "security"),
        (
            layout::IGNORE_CERTIFICATE,
            offset_of!(Config, ignore_certificate),
            "ignore_certificate",
        ),
        (
            layout::AUDIO_MODE,
            offset_of!(Config, audio_mode),
            "audio_mode",
        ),
        (
            layout::MICROPHONE,
            offset_of!(Config, microphone),
            "microphone",
        ),
        (
            layout::CLIPBOARD,
            offset_of!(Config, clipboard),
            "clipboard",
        ),
        (
            layout::DRIVE_NAME,
            offset_of!(Config, drive_name),
            "drive_name",
        ),
        (
            layout::DRIVE_PATH,
            offset_of!(Config, drive_path),
            "drive_path",
        ),
        (
            layout::DRIVE_READ_ONLY,
            offset_of!(Config, drive_read_only),
            "drive_read_only",
        ),
        (
            layout::DYNAMIC_RESOLUTION,
            offset_of!(Config, dynamic_resolution),
            "dynamic_resolution",
        ),
        (layout::GFX, offset_of!(Config, gfx), "gfx"),
        (
            layout::DISABLE_WALLPAPER,
            offset_of!(Config, disable_wallpaper),
            "disable_wallpaper",
        ),
        (
            layout::DISABLE_THEMES,
            offset_of!(Config, disable_themes),
            "disable_themes",
        ),
        (
            layout::DISABLE_MENU_ANIMS,
            offset_of!(Config, disable_menu_anims),
            "disable_menu_anims",
        ),
        (
            layout::DISABLE_FULL_WINDOW_DRAG,
            offset_of!(Config, disable_full_window_drag),
            "disable_full_window_drag",
        ),
        (
            layout::ALLOW_FONT_SMOOTHING,
            offset_of!(Config, allow_font_smoothing),
            "allow_font_smoothing",
        ),
    ];

    let mut bad = Vec::new();
    for (selector, rust_value, name) in pairs {
        let c_value = unsafe { zephyr_rdp_config_layout(selector) };
        if c_value < 0 {
            bad.push(format!("{name}: C returned {c_value} (unknown selector)"));
        } else if c_value as usize != rust_value {
            bad.push(format!("{name}: C={c_value} Rust={rust_value}"));
        }
    }
    bad
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole reason the C side exports `zephyr_rdp_config_layout`. Without
    /// this, a reordered or differently-padded struct would compile fine and
    /// then hand FreeRDP a password pointer where it expected a port.
    #[test]
    fn config_layout_matches_c() {
        let bad = layout_mismatches();
        assert!(bad.is_empty(), "Config layout disagrees with C: {bad:?}");
    }

    /// Guards against the selector table drifting out of sync: if C gains a
    /// field and a selector, this fails until the Rust table covers it.
    #[test]
    fn every_c_selector_is_covered() {
        let count = unsafe { zephyr_rdp_config_layout(-1) };
        assert_eq!(count, -1, "unknown selector must report -1");
        // ZEPHYR_RDP_LAYOUT_COUNT is 24; selectors 0..23 must all resolve.
        for selector in 0..24 {
            let value = unsafe { zephyr_rdp_config_layout(selector) };
            assert!(value >= 0, "selector {selector} unexpectedly unknown");
        }
        // One past the end must be rejected, proving COUNT is honoured rather
        // than the switch falling through to a default that returns 0.
        assert_eq!(unsafe { zephyr_rdp_config_layout(24) }, -1);
    }

    #[test]
    fn links_against_a_supported_freerdp_major() {
        let major = unsafe { zephyr_rdp_freerdp_major() };
        assert!(
            major == 2 || major == 3,
            "unexpected FreeRDP major {major}; the shim is written for 2 and 3"
        );
    }

    #[test]
    fn drive_messages_name_the_actual_problem() {
        // Each code must produce a distinct, actionable sentence: a single
        // generic string would make the UI unable to tell the user what to fix.
        let missing = drive_error_message(DRIVE_NOT_FOUND, "/gone", "Share");
        assert!(missing.contains("/gone"));
        let no_path = drive_error_message(DRIVE_NO_PATH, "", "");
        assert!(no_path.contains("未选择"));
        let bad_name = drive_error_message(DRIVE_BAD_NAME, "", "a/b");
        assert!(bad_name.contains("a/b"));
        assert_ne!(missing, no_path);
        assert_ne!(no_path, bad_name);
    }
}
