//! FreeRDP, linked in-process.
//!
//! This is the Rust half of `native/freerdp-core/zephyr_rdp.{c,h}`. The C side
//! owns every rdpSettings / rdpContext touch, because those are ALIGN64 structs
//! whose layout depends on the compiler and on FreeRDP build options; Rust only
//! ever sees the flat `zephyr_rdp_*` ABI declared below.
//!
//! ## Why this file exists at all
//!
//! The C shim has been in the tree, tested, and compiled by CI for a while, but
//! nothing consumed it: `NATIVE_ENGINE_DECISIONS.md` records that One shipped the
//! same Go/WASM RDP client as the browser, so "native RDP" was groundwork rather
//! than product. This module is the consumer that makes the claim true.
//!
//! ## What is deliberately *not* here
//!
//! No frame pump into the WebView. The development spec is explicit that the RDP
//! native core emits protocol and dirty rectangles while the *platform* layer
//! owns the surface, and that high-frequency frames must not cross the Node core
//! or be repainted in a Web canvas. An earlier revision (b0e5a9c) did exactly
//! that through a sidecar and was removed for it. So `FrameSink` below is a
//! Rust-side trait: whoever owns a real OS surface implements it, and no path in
//! this file forwards pixels to JavaScript.
//!
//! ## Availability
//!
//! Everything that talks to FreeRDP is behind `cfg(zephyr_native_rdp)`, which
//! `build.rs` sets only after it has actually located and compiled against
//! FreeRDP. With `ZEPHYR_ONE_SKIP_NATIVE_RDP=1` the cfg is absent and the public
//! functions return `Error::Unavailable` ? an honest "this build has no engine"
//! rather than a silent fallback that would let One claim native RDP while
//! running the browser pipeline.

use std::fmt;

pub mod ffi;
mod session;

pub use session::{
    FrameRect, FrameSink, RecordedState, RecordingSink, SessionEvent, SessionHandle,
    SessionRegistry,
};

/// A connection request, in Rust terms.
///
/// Mirrors `zephyr_rdp_config` but owns its strings. Translation to the C struct
/// happens in one place (`ffi::with_config`) so no caller has to reason about
/// pointer lifetimes; the C side copies everything it needs during
/// `zephyr_rdp_new`, and the borrowed `CString`s outlive that call.
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u32,
    pub username: String,
    pub password: String,
    pub domain: String,

    pub width: u32,
    pub height: u32,
    pub color_depth: u32,

    pub security: Security,
    pub ignore_certificate: bool,

    pub audio: AudioMode,
    pub microphone: bool,
    pub clipboard: bool,

    /// Folder mapping. Both must be set for a drive to be attached; validate with
    /// [`validate_drive`] first so a stale path reports itself instead of failing
    /// the whole connect.
    pub drive_name: String,
    pub drive_path: String,
    pub drive_read_only: bool,

    pub dynamic_resolution: bool,
    pub gfx: bool,

    pub disable_wallpaper: bool,
    pub disable_themes: bool,
    pub disable_menu_anims: bool,
    pub disable_full_window_drag: bool,
    pub allow_font_smoothing: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 3389,
            username: String::new(),
            password: String::new(),
            domain: String::new(),
            width: 1920,
            height: 1080,
            /* 32bpp because the shim packs BGRA and the GDI path is
             * PIXEL_FORMAT_BGRA32; asking for less would make the pack step
             * lossy for no bandwidth win on a local link. */
            color_depth: 32,
            security: Security::Auto,
            ignore_certificate: false,
            audio: AudioMode::Local,
            microphone: false,
            clipboard: true,
            drive_name: String::new(),
            drive_path: String::new(),
            drive_read_only: false,
            dynamic_resolution: true,
            gfx: true,
            disable_wallpaper: false,
            disable_themes: false,
            disable_menu_anims: false,
            disable_full_window_drag: false,
            allow_font_smoothing: true,
        }
    }
}

/// Security negotiation, matching `ZEPHYR_RDP_SEC_*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    Auto,
    Nla,
    Tls,
    Rdp,
}

impl Security {
    pub fn as_raw(self) -> i32 {
        match self {
            Security::Auto => ffi::ZEPHYR_RDP_SEC_AUTO,
            Security::Nla => ffi::ZEPHYR_RDP_SEC_NLA,
            Security::Tls => ffi::ZEPHYR_RDP_SEC_TLS,
            Security::Rdp => ffi::ZEPHYR_RDP_SEC_RDP,
        }
    }

    /// Parse the wire spelling the product UI already uses for this setting.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => Some(Security::Auto),
            "nla" => Some(Security::Nla),
            "tls" => Some(Security::Tls),
            "rdp" => Some(Security::Rdp),
            _ => None,
        }
    }
}

/// Where session audio plays, matching `ZEPHYR_RDP_AUDIO_*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioMode {
    /// Play on this device through rdpsnd.
    Local,
    /// Leave the sound on the remote machine.
    Remote,
    /// No audio channel at all.
    Off,
}

impl AudioMode {
    pub fn as_raw(self) -> i32 {
        match self {
            AudioMode::Local => ffi::ZEPHYR_RDP_AUDIO_LOCAL,
            AudioMode::Remote => ffi::ZEPHYR_RDP_AUDIO_REMOTE,
            AudioMode::Off => ffi::ZEPHYR_RDP_AUDIO_OFF,
        }
    }

    /// The product UI stores `local` / `remote` / `off` for this.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "local" | "" => Some(AudioMode::Local),
            "remote" => Some(AudioMode::Remote),
            "off" | "none" | "disabled" => Some(AudioMode::Off),
            _ => None,
        }
    }
}

/// Why a folder mapping cannot be used.
///
/// Distinct variants rather than one "bad folder" error because the UI reaction
/// differs per case: a missing path means the user never picked a folder, while a
/// missing name is recoverable by defaulting to the folder's basename. The C side
/// separates them for the same reason, and collapsing them here would throw the
/// distinction away again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveProblem {
    NameEmpty,
    PathEmpty,
    NotFound,
    NotDirectory,
    /// Name contains `/`, `\` or `:`, or is not valid UTF-8. Those separators are
    /// interpreted rather than displayed by the remote Explorer, so the name is
    /// refused instead of being silently rewritten.
    NameUnusable,
}

impl DriveProblem {
    /// Stable code for the product UI, matching the reveal/error style already in
    /// use elsewhere in the core.
    pub fn code(self) -> &'static str {
        match self {
            DriveProblem::NameEmpty => "drive_name_empty",
            DriveProblem::PathEmpty => "drive_path_empty",
            DriveProblem::NotFound => "drive_not_found",
            DriveProblem::NotDirectory => "drive_not_directory",
            DriveProblem::NameUnusable => "drive_name_unusable",
        }
    }

    fn from_raw(raw: i32) -> Option<Self> {
        match raw {
            ffi::ZEPHYR_RDP_DRIVE_OK => None,
            ffi::ZEPHYR_RDP_DRIVE_NO_NAME => Some(DriveProblem::NameEmpty),
            ffi::ZEPHYR_RDP_DRIVE_NO_PATH => Some(DriveProblem::PathEmpty),
            ffi::ZEPHYR_RDP_DRIVE_NOT_FOUND => Some(DriveProblem::NotFound),
            ffi::ZEPHYR_RDP_DRIVE_NOT_DIR => Some(DriveProblem::NotDirectory),
            ffi::ZEPHYR_RDP_DRIVE_BAD_NAME => Some(DriveProblem::NameUnusable),
            // An unknown negative code still means "unusable"; reporting it as OK
            // would attach a drive the C side refused to validate.
            _ => Some(DriveProblem::NotFound),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// This build has no RDP engine: FreeRDP was absent at build time and
    /// `ZEPHYR_ONE_SKIP_NATIVE_RDP=1` was set.
    Unavailable,
    /// A string crossing the ABI contained an interior NUL, so it cannot be a C
    /// string. Rejected rather than truncated: a silently shortened hostname
    /// would connect somewhere the user did not ask for.
    InteriorNul(&'static str),
    /// `zephyr_rdp_new` returned NULL (allocation or settings assembly failed).
    SessionCreate,
    /// The folder mapping is unusable.
    Drive(DriveProblem),
    /// The RDP loop exited non-zero; carries FreeRDP's own code where it has one.
    Run(i32),
    /// No session with that id is registered.
    NoSuchSession,
    /// The Rust mirror of `zephyr_rdp_config` disagrees with the C struct.
    ///
    /// Its own variant rather than folded into a generic failure because the
    /// consequence is specific and severe: writing a Rust layout into a
    /// differently-shaped C struct makes a `*const c_char` be read where an
    /// `i32` was written. Connecting anyway would send garbage credentials or
    /// dereference an integer as a pointer.
    AbiMismatch(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Unavailable => write!(
                f,
                "this build has no native RDP engine (built with ZEPHYR_ONE_SKIP_NATIVE_RDP=1)"
            ),
            Error::InteriorNul(field) => write!(f, "field {field} contains an interior NUL byte"),
            Error::SessionCreate => write!(f, "FreeRDP session could not be created"),
            Error::Drive(problem) => write!(f, "folder mapping unusable: {}", problem.code()),
            Error::Run(code) => write!(f, "RDP session ended with code {code}"),
            Error::NoSuchSession => write!(f, "no such RDP session"),
            Error::AbiMismatch(detail) => {
                write!(f, "FreeRDP shim ABI mismatch, refusing to connect: {detail}")
            }
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    /// Stable code for the product UI. The core's other error shapes are
    /// `{ error, code }`, so these slot into the same handling.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Unavailable => "native_rdp_unavailable",
            Error::InteriorNul(_) => "invalid_field",
            Error::SessionCreate => "rdp_session_create_failed",
            Error::Drive(problem) => problem.code(),
            Error::Run(_) => "rdp_session_failed",
            Error::NoSuchSession => "rdp_session_not_found",
            Error::AbiMismatch(_) => "rdp_abi_mismatch",
        }
    }
}

/// Whether this build can actually open an RDP session.
///
/// Reported to the UI so it can say so up front rather than offering a connect
/// button that always fails.
pub fn is_available() -> bool {
    cfg!(zephyr_native_rdp)
}

/// FreeRDP major version this binary is linked against, or `None` when the
/// engine was not built.
pub fn freerdp_major() -> Option<i32> {
    #[cfg(zephyr_native_rdp)]
    {
        // SAFETY: no arguments, no state; returns a compile-time constant from
        // the shim's translation unit.
        Some(unsafe { ffi::zephyr_rdp_freerdp_major() })
    }
    #[cfg(not(zephyr_native_rdp))]
    {
        None
    }
}

/// Check a folder mapping before a session uses it.
///
/// Worth doing separately rather than letting connect fail: FreeRDP's
/// `freerdp_client_add_device_channel` stats the path and returns FALSE when the
/// directory is absent, which fails the *entire* settings assembly. A folder that
/// was valid when the user picked it but has since been deleted or unmounted
/// would otherwise surface as a generic connect failure with no hint that the
/// folder caused it.
pub fn validate_drive(name: &str, path: &str) -> Result<(), Error> {
    #[cfg(zephyr_native_rdp)]
    {
        use std::ffi::CString;
        let c_name = CString::new(name).map_err(|_| Error::InteriorNul("driveName"))?;
        let c_path = CString::new(path).map_err(|_| Error::InteriorNul("drivePath"))?;
        // SAFETY: both pointers are valid NUL-terminated strings that outlive the
        // call, and the C function performs only filesystem inspection.
        let raw = unsafe { ffi::zephyr_rdp_validate_drive(c_name.as_ptr(), c_path.as_ptr()) };
        match DriveProblem::from_raw(raw) {
            None => Ok(()),
            Some(problem) => Err(Error::Drive(problem)),
        }
    }
    #[cfg(not(zephyr_native_rdp))]
    {
        let _ = (name, path);
        Err(Error::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn security_and_audio_parse_the_spellings_the_ui_stores() {
        // These strings come from the saved connection record, so a rename on
        // either side must fail here rather than silently downgrade security.
        assert_eq!(Security::parse("nla"), Some(Security::Nla));
        assert_eq!(Security::parse(" TLS "), Some(Security::Tls));
        assert_eq!(Security::parse(""), Some(Security::Auto));
        assert_eq!(Security::parse("plaintext"), None);

        assert_eq!(AudioMode::parse("remote"), Some(AudioMode::Remote));
        assert_eq!(AudioMode::parse("off"), Some(AudioMode::Off));
        assert_eq!(AudioMode::parse(""), Some(AudioMode::Local));
        assert_eq!(AudioMode::parse("speaker"), None);
    }

    #[test]
    fn raw_values_match_the_c_constants() {
        assert_eq!(Security::Auto.as_raw(), ffi::ZEPHYR_RDP_SEC_AUTO);
        assert_eq!(Security::Nla.as_raw(), ffi::ZEPHYR_RDP_SEC_NLA);
        assert_eq!(Security::Tls.as_raw(), ffi::ZEPHYR_RDP_SEC_TLS);
        assert_eq!(Security::Rdp.as_raw(), ffi::ZEPHYR_RDP_SEC_RDP);

        assert_eq!(AudioMode::Local.as_raw(), ffi::ZEPHYR_RDP_AUDIO_LOCAL);
        assert_eq!(AudioMode::Remote.as_raw(), ffi::ZEPHYR_RDP_AUDIO_REMOTE);
        assert_eq!(AudioMode::Off.as_raw(), ffi::ZEPHYR_RDP_AUDIO_OFF);
    }

    #[test]
    fn every_drive_code_maps_to_a_distinct_reason() {
        /* The point of these codes is that the UI can say *why*. If two mapped
         * to the same string the user would be told "bad folder" for a problem
         * that has a specific fix. */
        let codes = [
            DriveProblem::NameEmpty.code(),
            DriveProblem::PathEmpty.code(),
            DriveProblem::NotFound.code(),
            DriveProblem::NotDirectory.code(),
            DriveProblem::NameUnusable.code(),
        ];
        let mut unique = codes.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), codes.len(), "drive codes must be distinct");
    }

    #[test]
    fn ok_is_the_only_raw_value_that_means_success() {
        assert_eq!(DriveProblem::from_raw(ffi::ZEPHYR_RDP_DRIVE_OK), None);
        // An unrecognised code must not be read as success: that would attach a
        // drive the C side declined to validate.
        assert!(DriveProblem::from_raw(-99).is_some());
        assert!(DriveProblem::from_raw(7).is_some());
    }

    #[test]
    fn defaults_are_the_ones_the_pack_step_needs() {
        let cfg = Config::default();
        // The shim packs BGRA and GDI is PIXEL_FORMAT_BGRA32; anything less
        // makes the pack lossy for no gain on a local link.
        assert_eq!(cfg.color_depth, 32);
        assert_eq!(cfg.port, 3389);
        assert!(cfg.clipboard, "clipboard is on by default in the product UI");
    }

    #[test]
    fn unavailable_is_reported_rather_than_faked() {
        /* The failure mode this guards against is a build with no engine that
         * still answers as if it had one. `is_available` and the cfg must agree,
         * so a test run on a machine without FreeRDP still checks the contract. */
        if is_available() {
            assert!(freerdp_major().is_some(), "an available engine must report its major");
        } else {
            assert_eq!(freerdp_major(), None);
            assert_eq!(validate_drive("share", "/tmp"), Err(Error::Unavailable));
            assert_eq!(Error::Unavailable.code(), "native_rdp_unavailable");
        }
    }
}
