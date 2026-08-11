//! Raw declarations for `native/freerdp-core/zephyr_rdp.h`.
//!
//! Hand-written rather than bindgen-generated, matching the header's own
//! reasoning: bindgen would add a libclang build dependency on all three desktop
//! platforms to bind twenty flat functions and one POD struct.
//!
//! The risk of hand-writing is drift. `#[repr(C)]` agrees with the C ABI only if
//! the field list and order match exactly, and a mismatch is not a compile error
//! across FFI -- a `*const c_char` gets read where an `i32` was written, so the
//! session either connects with garbage credentials or dereferences an integer as
//! a pointer. That is why the C side exports `zephyr_rdp_config_layout` and why
//! `assert_layout_matches_c` below checks every offset numerically instead of
//! trusting that the two declarations look similar.

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_void};
/// Only referenced by the cfg-gated extern block, so importing it
/// unconditionally would warn on a build without the engine.
#[cfg(zephyr_native_rdp)]
use std::os::raw::c_long;

/// Opaque session handle. Never constructed on the Rust side; only ever a pointer
/// returned by `zephyr_rdp_new`.
#[repr(C)]
pub struct zephyr_rdp_session {
    _private: [u8; 0],
}

/* ---- Event codes --------------------------------------------------------- */

pub const ZEPHYR_RDP_EV_CONNECTED: i32 = 1;
pub const ZEPHYR_RDP_EV_DISCONNECTED: i32 = 2;
pub const ZEPHYR_RDP_EV_ERROR: i32 = 3;
pub const ZEPHYR_RDP_EV_RESIZE: i32 = 4;
pub const ZEPHYR_RDP_EV_CLIPBOARD: i32 = 5;
/// Carries the TLS certificate fingerprint from `VerifyCertificateEx`, and
/// nothing else. Kept distinct from `EV_CHANNEL` because the two were once folded
/// together, which made the host report a channel name (`rdpdr`) in the
/// fingerprint field -- worse than useless in the one situation a fingerprint
/// exists for.
pub const ZEPHYR_RDP_EV_LOG: i32 = 6;
pub const ZEPHYR_RDP_EV_CURSOR: i32 = 7;
/// A virtual channel came up; the text field is the channel name. `rdpdr` here is
/// the wire-level proof that folder redirection negotiated.
pub const ZEPHYR_RDP_EV_CHANNEL: i32 = 8;

/* ---- Audio --------------------------------------------------------------- */

pub const ZEPHYR_RDP_AUDIO_LOCAL: i32 = 0;
pub const ZEPHYR_RDP_AUDIO_REMOTE: i32 = 1;
pub const ZEPHYR_RDP_AUDIO_OFF: i32 = 2;

/* ---- Drive validation ---------------------------------------------------- */

pub const ZEPHYR_RDP_DRIVE_OK: i32 = 0;
pub const ZEPHYR_RDP_DRIVE_NO_NAME: i32 = -1;
pub const ZEPHYR_RDP_DRIVE_NO_PATH: i32 = -2;
pub const ZEPHYR_RDP_DRIVE_NOT_FOUND: i32 = -3;
pub const ZEPHYR_RDP_DRIVE_NOT_DIR: i32 = -4;
pub const ZEPHYR_RDP_DRIVE_BAD_NAME: i32 = -5;

/* ---- Security ------------------------------------------------------------ */

pub const ZEPHYR_RDP_SEC_AUTO: i32 = 0;
pub const ZEPHYR_RDP_SEC_NLA: i32 = 1;
pub const ZEPHYR_RDP_SEC_TLS: i32 = 2;
pub const ZEPHYR_RDP_SEC_RDP: i32 = 3;

/* ---- Layout selectors, used only by the drift assertion ------------------ */

pub const ZEPHYR_RDP_LAYOUT_SIZEOF: i32 = 0;
pub const ZEPHYR_RDP_LAYOUT_HOST: i32 = 1;
pub const ZEPHYR_RDP_LAYOUT_PORT: i32 = 2;
pub const ZEPHYR_RDP_LAYOUT_USERNAME: i32 = 3;
pub const ZEPHYR_RDP_LAYOUT_PASSWORD: i32 = 4;
pub const ZEPHYR_RDP_LAYOUT_DOMAIN: i32 = 5;
pub const ZEPHYR_RDP_LAYOUT_WIDTH: i32 = 6;
pub const ZEPHYR_RDP_LAYOUT_HEIGHT: i32 = 7;
pub const ZEPHYR_RDP_LAYOUT_COLOR_DEPTH: i32 = 8;
pub const ZEPHYR_RDP_LAYOUT_SECURITY: i32 = 9;
pub const ZEPHYR_RDP_LAYOUT_IGNORE_CERTIFICATE: i32 = 10;
pub const ZEPHYR_RDP_LAYOUT_AUDIO_MODE: i32 = 11;
pub const ZEPHYR_RDP_LAYOUT_MICROPHONE: i32 = 12;
pub const ZEPHYR_RDP_LAYOUT_CLIPBOARD: i32 = 13;
pub const ZEPHYR_RDP_LAYOUT_DRIVE_NAME: i32 = 14;
pub const ZEPHYR_RDP_LAYOUT_DRIVE_PATH: i32 = 15;
pub const ZEPHYR_RDP_LAYOUT_DRIVE_READ_ONLY: i32 = 16;
pub const ZEPHYR_RDP_LAYOUT_DYNAMIC_RESOLUTION: i32 = 17;
pub const ZEPHYR_RDP_LAYOUT_GFX: i32 = 18;
pub const ZEPHYR_RDP_LAYOUT_DISABLE_WALLPAPER: i32 = 19;
pub const ZEPHYR_RDP_LAYOUT_DISABLE_THEMES: i32 = 20;
pub const ZEPHYR_RDP_LAYOUT_DISABLE_MENU_ANIMS: i32 = 21;
pub const ZEPHYR_RDP_LAYOUT_DISABLE_FULL_WINDOW_DRAG: i32 = 22;
pub const ZEPHYR_RDP_LAYOUT_ALLOW_FONT_SMOOTHING: i32 = 23;

/* ---- Callbacks ----------------------------------------------------------- */

/// A rectangle of the framebuffer changed.
///
/// `pixels` is tightly packed BGRA (`stride == w * 4`), top-down, and is valid
/// **only for the duration of the call**: the shim packs into a scratch buffer it
/// owns, so a handler must copy or consume synchronously rather than retaining the
/// pointer.
pub type zephyr_rdp_frame_cb = Option<
    unsafe extern "C" fn(
        user: *mut c_void,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        pixels: *const u8,
        len: usize,
    ),
>;

/// Session lifecycle / channel / clipboard notification.
///
/// For clipboard events, `text` borrows exactly `a` bytes of validated UTF-16LE
/// including its final NUL. Other text is NUL-terminated UTF-8 or NULL. For
/// `EV_RESIZE` the two ints are width/height; for `EV_CURSOR` they are x/y.
pub type zephyr_rdp_event_cb =
    Option<unsafe extern "C" fn(user: *mut c_void, code: i32, a: i32, b: i32, text: *const c_char)>;

/* ---- Config -------------------------------------------------------------- */

/// Mirror of the C `zephyr_rdp_config`.
///
/// Field order is load-bearing and asserted by `assert_layout_matches_c`. Do not
/// reorder to group related settings: the C struct is the source of truth.
#[repr(C)]
#[derive(Debug)]
pub struct zephyr_rdp_config {
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

impl Default for zephyr_rdp_config {
    fn default() -> Self {
        Self {
            host: std::ptr::null(),
            port: 0,
            username: std::ptr::null(),
            password: std::ptr::null(),
            domain: std::ptr::null(),
            width: 0,
            height: 0,
            color_depth: 0,
            security: ZEPHYR_RDP_SEC_AUTO,
            ignore_certificate: 0,
            audio_mode: ZEPHYR_RDP_AUDIO_LOCAL,
            microphone: 0,
            clipboard: 0,
            drive_name: std::ptr::null(),
            drive_path: std::ptr::null(),
            drive_read_only: 0,
            dynamic_resolution: 0,
            gfx: 0,
            disable_wallpaper: 0,
            disable_themes: 0,
            disable_menu_anims: 0,
            disable_full_window_drag: 0,
            allow_font_smoothing: 0,
        }
    }
}

#[cfg(zephyr_native_rdp)]
extern "C" {
    pub fn zephyr_rdp_new(
        cfg: *const zephyr_rdp_config,
        frame_cb: zephyr_rdp_frame_cb,
        event_cb: zephyr_rdp_event_cb,
        user: *mut c_void,
    ) -> *mut zephyr_rdp_session;

    pub fn zephyr_rdp_run(session: *mut zephyr_rdp_session) -> i32;
    pub fn zephyr_rdp_stop(session: *mut zephyr_rdp_session);
    pub fn zephyr_rdp_free(session: *mut zephyr_rdp_session);

    pub fn zephyr_rdp_send_mouse(session: *mut zephyr_rdp_session, flags: u16, x: u16, y: u16);
    pub fn zephyr_rdp_send_mouse_ex(session: *mut zephyr_rdp_session, flags: u16, x: u16, y: u16);
    pub fn zephyr_rdp_send_scancode(session: *mut zephyr_rdp_session, flags: u16, code: u16);
    pub fn zephyr_rdp_send_unicode(session: *mut zephyr_rdp_session, flags: u16, code: u16);
    pub fn zephyr_rdp_send_sync(session: *mut zephyr_rdp_session, toggle_flags: u32);
    pub fn zephyr_rdp_request_full_frame(session: *mut zephyr_rdp_session);
    pub fn zephyr_rdp_resize(session: *mut zephyr_rdp_session, width: u32, height: u32);
    pub fn zephyr_rdp_set_clipboard(session: *mut zephyr_rdp_session, utf8: *const c_char);

    pub fn zephyr_rdp_validate_drive(drive_name: *const c_char, drive_path: *const c_char) -> i32;
    pub fn zephyr_rdp_freerdp_major() -> i32;
    pub fn zephyr_rdp_clipboard_available() -> i32;
    pub fn zephyr_rdp_config_layout(selector: i32) -> i32;

    pub fn zephyr_rdp_probe_settings(
        cfg: *const zephyr_rdp_config,
        nla: *mut i32,
        tls: *mut i32,
        rdp_sec: *mut i32,
        audio_playback: *mut i32,
        audio_capture: *mut i32,
        clipboard: *mut i32,
        device_redirection: *mut i32,
        dynamic_res: *mut i32,
        gfx: *mut i32,
    ) -> i32;

    pub fn zephyr_rdp_security_protocol_allowed(
        cfg: *const zephyr_rdp_config,
        selected_protocol: u32,
    ) -> i32;

    pub fn zephyr_rdp_utf_roundtrip(input: *const c_char, out: *mut c_char, out_cap: usize) -> i32;

    #[allow(dead_code)]
    pub fn zephyr_rdp_test_utf8_to_utf16le(
        input: *const c_char,
        out: *mut u16,
        units: usize,
    ) -> c_long;

    #[allow(dead_code)]
    pub fn zephyr_rdp_test_clipboard_payload(data: *const u8, bytes: usize) -> i32;
}

/// Compare every field offset against the C definition.
///
/// Returns `Err` with a human-readable description of the first disagreement.
/// Callable at runtime rather than only in tests so the session layer can refuse
/// to connect on a mismatched build instead of writing garbage into rdpSettings.
#[cfg(zephyr_native_rdp)]
pub fn assert_layout_matches_c() -> Result<(), String> {
    use std::mem::{align_of, offset_of, size_of};

    // SAFETY: pure function of compile-time constants in the shim.
    let c_of = |selector: i32| unsafe { zephyr_rdp_config_layout(selector) };

    let expected_size = c_of(ZEPHYR_RDP_LAYOUT_SIZEOF);
    if expected_size < 0 {
        return Err("zephyr_rdp_config_layout(SIZEOF) failed".into());
    }
    if expected_size as usize != size_of::<zephyr_rdp_config>() {
        return Err(format!(
            "sizeof(zephyr_rdp_config): C says {expected_size}, Rust says {}",
            size_of::<zephyr_rdp_config>()
        ));
    }

    let fields: [(&str, i32, usize); 23] = [
        (
            "host",
            ZEPHYR_RDP_LAYOUT_HOST,
            offset_of!(zephyr_rdp_config, host),
        ),
        (
            "port",
            ZEPHYR_RDP_LAYOUT_PORT,
            offset_of!(zephyr_rdp_config, port),
        ),
        (
            "username",
            ZEPHYR_RDP_LAYOUT_USERNAME,
            offset_of!(zephyr_rdp_config, username),
        ),
        (
            "password",
            ZEPHYR_RDP_LAYOUT_PASSWORD,
            offset_of!(zephyr_rdp_config, password),
        ),
        (
            "domain",
            ZEPHYR_RDP_LAYOUT_DOMAIN,
            offset_of!(zephyr_rdp_config, domain),
        ),
        (
            "width",
            ZEPHYR_RDP_LAYOUT_WIDTH,
            offset_of!(zephyr_rdp_config, width),
        ),
        (
            "height",
            ZEPHYR_RDP_LAYOUT_HEIGHT,
            offset_of!(zephyr_rdp_config, height),
        ),
        (
            "color_depth",
            ZEPHYR_RDP_LAYOUT_COLOR_DEPTH,
            offset_of!(zephyr_rdp_config, color_depth),
        ),
        (
            "security",
            ZEPHYR_RDP_LAYOUT_SECURITY,
            offset_of!(zephyr_rdp_config, security),
        ),
        (
            "ignore_certificate",
            ZEPHYR_RDP_LAYOUT_IGNORE_CERTIFICATE,
            offset_of!(zephyr_rdp_config, ignore_certificate),
        ),
        (
            "audio_mode",
            ZEPHYR_RDP_LAYOUT_AUDIO_MODE,
            offset_of!(zephyr_rdp_config, audio_mode),
        ),
        (
            "microphone",
            ZEPHYR_RDP_LAYOUT_MICROPHONE,
            offset_of!(zephyr_rdp_config, microphone),
        ),
        (
            "clipboard",
            ZEPHYR_RDP_LAYOUT_CLIPBOARD,
            offset_of!(zephyr_rdp_config, clipboard),
        ),
        (
            "drive_name",
            ZEPHYR_RDP_LAYOUT_DRIVE_NAME,
            offset_of!(zephyr_rdp_config, drive_name),
        ),
        (
            "drive_path",
            ZEPHYR_RDP_LAYOUT_DRIVE_PATH,
            offset_of!(zephyr_rdp_config, drive_path),
        ),
        (
            "drive_read_only",
            ZEPHYR_RDP_LAYOUT_DRIVE_READ_ONLY,
            offset_of!(zephyr_rdp_config, drive_read_only),
        ),
        (
            "dynamic_resolution",
            ZEPHYR_RDP_LAYOUT_DYNAMIC_RESOLUTION,
            offset_of!(zephyr_rdp_config, dynamic_resolution),
        ),
        (
            "gfx",
            ZEPHYR_RDP_LAYOUT_GFX,
            offset_of!(zephyr_rdp_config, gfx),
        ),
        (
            "disable_wallpaper",
            ZEPHYR_RDP_LAYOUT_DISABLE_WALLPAPER,
            offset_of!(zephyr_rdp_config, disable_wallpaper),
        ),
        (
            "disable_themes",
            ZEPHYR_RDP_LAYOUT_DISABLE_THEMES,
            offset_of!(zephyr_rdp_config, disable_themes),
        ),
        (
            "disable_menu_anims",
            ZEPHYR_RDP_LAYOUT_DISABLE_MENU_ANIMS,
            offset_of!(zephyr_rdp_config, disable_menu_anims),
        ),
        (
            "disable_full_window_drag",
            ZEPHYR_RDP_LAYOUT_DISABLE_FULL_WINDOW_DRAG,
            offset_of!(zephyr_rdp_config, disable_full_window_drag),
        ),
        (
            "allow_font_smoothing",
            ZEPHYR_RDP_LAYOUT_ALLOW_FONT_SMOOTHING,
            offset_of!(zephyr_rdp_config, allow_font_smoothing),
        ),
    ];

    for (name, selector, rust_offset) in fields {
        let c_offset = c_of(selector);
        if c_offset < 0 {
            return Err(format!("C has no layout entry for {name}"));
        }
        if c_offset as usize != rust_offset {
            return Err(format!(
                "offsetof({name}): C says {c_offset}, Rust says {rust_offset}"
            ));
        }
    }

    /* Alignment is checked separately because a struct can agree on size and on
     * every offset while disagreeing on alignment -- which changes how it is
     * passed by value. Nothing passes this struct by value today; asserting it
     * keeps that from becoming a silent hazard if something starts to. */
    if align_of::<zephyr_rdp_config>() < align_of::<*const c_char>() {
        return Err("zephyr_rdp_config is under-aligned for its pointer fields".into());
    }

    Ok(())
}

#[cfg(not(zephyr_native_rdp))]
pub fn assert_layout_matches_c() -> Result<(), String> {
    // Nothing to compare against: the shim was not compiled into this build.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rust_mirror_agrees_with_the_c_struct() {
        /* This is the assertion the whole module exists for. A silent drift here
         * makes a `*const c_char` be read where an `i32` was written, so the
         * session either connects with garbage credentials or dereferences an
         * integer as a pointer -- neither of which a compiler can catch across
         * FFI. On a build without the engine this is vacuously Ok, which the
         * availability test in the parent module accounts for. */
        if let Err(problem) = assert_layout_matches_c() {
            panic!("zephyr_rdp_config layout drift: {problem}");
        }
    }

    #[test]
    fn event_codes_are_distinct() {
        /* EV_LOG and EV_CHANNEL were once the same code, which made the host
         * present a channel name as a TLS certificate fingerprint. Distinctness
         * is the property that prevents that class of confusion. */
        let codes = [
            ZEPHYR_RDP_EV_CONNECTED,
            ZEPHYR_RDP_EV_DISCONNECTED,
            ZEPHYR_RDP_EV_ERROR,
            ZEPHYR_RDP_EV_RESIZE,
            ZEPHYR_RDP_EV_CLIPBOARD,
            ZEPHYR_RDP_EV_LOG,
            ZEPHYR_RDP_EV_CURSOR,
            ZEPHYR_RDP_EV_CHANNEL,
        ];
        let mut seen = codes.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), codes.len(), "event codes must not collide");
    }

    #[test]
    fn drive_codes_are_negative_and_ok_is_zero() {
        // The C contract is "0 means usable, negative means why not". A positive
        // code would be read as an unknown failure by DriveProblem::from_raw.
        assert_eq!(ZEPHYR_RDP_DRIVE_OK, 0);
        for code in [
            ZEPHYR_RDP_DRIVE_NO_NAME,
            ZEPHYR_RDP_DRIVE_NO_PATH,
            ZEPHYR_RDP_DRIVE_NOT_FOUND,
            ZEPHYR_RDP_DRIVE_NOT_DIR,
            ZEPHYR_RDP_DRIVE_BAD_NAME,
        ] {
            assert!(code < 0, "drive failure codes must be negative, saw {code}");
        }
    }
}
