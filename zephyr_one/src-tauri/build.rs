//! Build script for Zephyr One.
//!
//! Two jobs: the Tauri codegen, and compiling the FreeRDP C shim that
//! `src/rdp` binds.
//!
//! Why the shim is compiled here rather than vendored as a prebuilt library:
//!   `native/freerdp-core/zephyr_rdp.c` touches rdpSettings and rdpContext,
//!   which are ALIGN64-annotated structs whose layout depends on the compiler
//!   and on FreeRDP's build options. Compiling it in-tree against the same
//!   headers the local FreeRDP was built with is what keeps those offsets
//!   correct; a prebuilt .a would silently disagree after a FreeRDP upgrade.
//!
//! Why this is not optional:
//!   An earlier revision (b0e5a9c) compiled this shim while *no* Rust code
//!   consumed it, so Tauri required FreeRDP for zero functionality, and the
//!   build was rightly reverted. This time the compile and the consumer land
//!   together: `src/rdp` is the caller, and `rdp_native_*` commands expose it.
//!   So a missing FreeRDP is a hard error with install instructions rather than
//!   a silent fallback to the browser WASM engine ? a fallback would mean One
//!   claims native RDP while shipping the same Go/WASM pipeline as the browser,
//!   which is the exact dishonesty NATIVE_ENGINE_DECISIONS.md ADR-004 forbids.

use std::fs;
use std::path::{Path, PathBuf};

/// Zephyr One ships exactly the FreeRDP 3 ABI. These names are also a packaging
/// contract: accepting an older ABI here could produce an installer whose
/// runtime libraries do not match the headers used to compile the C shim.
const FREERDP3_PACKAGES: [&str; 3] = ["freerdp3", "freerdp-client3", "winpr3"];
const MIN_FREERDP3_VERSION: &str = "3.0.0";
const PATCHED_FREERDP_STAMP: &str = "3.30.0+cliprdr-reassembly-limit-v1";
const PATCHED_FREERDP_DEFINE: &str = "#define FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1";

fn main() {
    tauri_build::build();

    // src/rdp gates on this cfg in ~40 places; declaring it keeps every use
    // warning-free (unexpected_cfgs, Rust >= 1.80) in BOTH build modes --
    // without this line the skip path below would compile with a warning per
    // use site.
    println!("cargo::rustc-check-cfg=cfg(zephyr_native_rdp)");

    // Re-run when the shim or its header changes, not on every touch of src/.
    let native = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must have a parent")
        .join("native/freerdp-core");
    println!(
        "cargo:rerun-if-changed={}",
        native.join("zephyr_rdp.c").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        native.join("zephyr_rdp.h").display()
    );
    println!("cargo:rerun-if-env-changed=ZEPHYR_ONE_SKIP_NATIVE_RDP");
    println!("cargo:rerun-if-env-changed=ZEPHYR_ONE_REQUIRE_PATCHED_FREERDP");
    println!("cargo:rerun-if-env-changed=ZEPHYR_ONE_RDP_STATIC");

    /* Escape hatch for environments that genuinely cannot provide FreeRDP ?
     * a docs build, or a contributor checking that the rest of the shell
     * compiles. It is deliberately an explicit opt-out rather than an automatic
     * fallback: `cfg(zephyr_native_rdp)` disappears, every rdp_native_* command
     * reports `native_rdp_unavailable`, and nothing pretends RDP works. */
    if std::env::var("ZEPHYR_ONE_SKIP_NATIVE_RDP").as_deref() == Ok("1") {
        println!(
            "cargo:warning=ZEPHYR_ONE_SKIP_NATIVE_RDP=1: building without the native RDP engine. \
             RDP sessions will report native_rdp_unavailable."
        );
        return;
    }

    /* pkg-config is the only discovery mechanism, so check the tool before
     * the libraries: without it every probe fails and "FreeRDP not found"
     * would be a lie about why. Say what is actually missing. */
    if !pkg_config_available() {
        panic!(
            "pkg-config not found on PATH.\n\
             \n\
             Zephyr One locates FreeRDP through pkg-config; install the tool\n\
             first, then the FreeRDP dev package:\n\
             \n\
             \x20 Debian/Ubuntu : sudo apt-get install pkg-config freerdp3-dev\n\
             \x20 Alpine        : apk add pkgconf freerdp-dev\n\
             \x20 macOS         : brew install pkgconf freerdp\n\
             \x20 Windows       : vcpkg install pkgconf:x64-windows freerdp:x64-windows\n\
             \n\
             To build the shell without RDP, set ZEPHYR_ONE_SKIP_NATIVE_RDP=1."
        );
    }

    /* Probe with cargo_metadata OFF first. A half-installed FreeRDP 3 set must
     * not leak partial link flags into the build. Only the complete, versioned
     * set is re-probed with metadata on, which emits the cargo link directives. */
    let include_paths = probe(&FREERDP3_PACKAGES, false).unwrap_or_else(|error| {
        panic!(
            "FreeRDP 3 development files were not found or are too old.\n\
             \n\
             Zephyr One's RDP engine is FreeRDP linked in-process; there is no\n\
             WASM or FreeRDP 2 fallback in the desktop product. Install FreeRDP\n\
             3.0.0 or newer with all three pkg-config modules:\n\
             \n\
             \x20 Debian/Ubuntu : sudo apt-get install freerdp3-dev\n\
             \x20 Alpine        : apk add freerdp-dev\n\
             \x20 macOS         : brew install freerdp\n\
             \x20 Windows       : vcpkg install freerdp:x64-windows\n\
             \n\
             Required modules: freerdp3, freerdp-client3, winpr3\n\
             pkg-config reported:\n  {}\n\
             \n\
             To build the shell without RDP, set ZEPHYR_ONE_SKIP_NATIVE_RDP=1.\n\
             That build reports native_rdp_unavailable instead of connecting.",
            error
        );
    });
    enforce_patched_freerdp(&include_paths);
    // The complete set was probed a moment ago; a failure here means pkg-config
    // results changed mid-build, which deserves a loud abort, not a retry.
    probe(&FREERDP3_PACKAGES, true)
        .unwrap_or_else(|error| panic!("FreeRDP 3 package set changed between probes: {error}"));

    let mut build = cc::Build::new();
    build
        .file(native.join("zephyr_rdp.c"))
        .include(&native)
        .std("c11")
        /* Same warning set the C test script uses. -Wmissing-prototypes is not
         * decoration: it is what caught exported helpers with no header
         * declaration, which would have been unbindable from Rust. */
        .warnings(true)
        .flag_if_supported("-Wmissing-prototypes")
        .flag_if_supported("-Wstrict-prototypes")
        .flag_if_supported("-Wno-deprecated-declarations")
        .flag_if_supported("-D_POSIX_C_SOURCE=200809L");

    // FreeRDP 3.30's public Windows header unconditionally marks consumers
    // `dllimport`, including when CMake produced static archives. Its own
    // static objects use this export macro, which makes declarations normal
    // external references for the final link rather than `__imp_*` imports.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        build.define("FREERDP_EXPORTS", None);
    }

    for path in include_paths {
        build.include(path);
    }

    build.compile("zephyr_rdp");

    // The consumer gates on this, so a skipped build cannot link against
    // symbols that were never compiled.
    println!("cargo:rustc-cfg=zephyr_native_rdp");
}

/// Locate the complete FreeRDP 3 ABI through pkg-config.
///
/// Returns the include paths on success so the shim compiles against the same
/// headers the library was built from. On failure the error names the package
/// that was missing, so the panic message blames the right thing rather than
/// the whole set.
fn probe(pkgs: &[&str], cargo_metadata: bool) -> Result<Vec<PathBuf>, String> {
    let mut includes = Vec::new();
    for name in pkgs {
        match pkg_config(cargo_metadata).probe(name) {
            Ok(lib) => {
                let forbidden = lib
                    .libs
                    .iter()
                    .filter(|linked| is_freerdp2_link_name(linked))
                    .cloned()
                    .collect::<Vec<_>>();
                if !forbidden.is_empty() {
                    return Err(format!(
                        "{name}: pkg-config resolved forbidden FreeRDP 2 libraries: {}",
                        forbidden.join(", ")
                    ));
                }
                includes.extend(lib.include_paths);
            }
            Err(error) => return Err(format!("{name}: {error}")),
        }
    }
    Ok(includes)
}

fn pkg_config(cargo_metadata: bool) -> pkg_config::Config {
    let mut config = pkg_config::Config::new();
    config
        .cargo_metadata(cargo_metadata)
        .atleast_version(MIN_FREERDP3_VERSION);
    if std::env::var("ZEPHYR_ONE_RDP_STATIC").as_deref() == Ok("1") {
        config.statik(true);
    }
    config
}

fn enforce_patched_freerdp(include_paths: &[PathBuf]) {
    let required = std::env::var("PROFILE").as_deref() == Ok("release")
        || std::env::var("ZEPHYR_ONE_REQUIRE_PATCHED_FREERDP").as_deref() == Ok("1");

    match find_patched_freerdp(include_paths) {
        Ok((header, stamp)) => {
            println!("cargo:rerun-if-changed={}", header.display());
            println!("cargo:rerun-if-changed={}", stamp.display());
        }
        Err(error) if required => panic!(
            "release/native CI requires Zephyr's pinned, patched FreeRDP 3.30.0 build: {error}.\n\
             Run native/freerdp-core/scripts/build-freerdp.sh and then\n\
             scripts/resolve-rdp-pkgconfig.py before invoking Cargo."
        ),
        Err(error) => println!(
            "cargo:warning=unpatched FreeRDP 3 accepted for a non-release local build ({error}); \
             clipboard redirection remains unavailable"
        ),
    }
}

fn find_patched_freerdp(include_paths: &[PathBuf]) -> Result<(PathBuf, PathBuf), String> {
    let mut inspected = Vec::new();
    for include in include_paths {
        for relative in [
            Path::new("freerdp/client/channels.h"),
            Path::new("freerdp3/freerdp/client/channels.h"),
        ] {
            let header = include.join(relative);
            if !header.is_file() {
                continue;
            }
            inspected.push(header.display().to_string());
            let source = fs::read_to_string(&header)
                .map_err(|error| format!("could not read {}: {error}", header.display()))?;
            if !source
                .lines()
                .any(|line| line.trim() == PATCHED_FREERDP_DEFINE)
            {
                continue;
            }

            for root in include.ancestors().take(4) {
                let stamp = root.join(".zephyr-freerdp-tag");
                if !stamp.is_file() {
                    continue;
                }
                let value = fs::read_to_string(&stamp)
                    .map_err(|error| format!("could not read {}: {error}", stamp.display()))?;
                if value.trim() == PATCHED_FREERDP_STAMP {
                    return Ok((header, stamp));
                }
                return Err(format!(
                    "{} contains {:?}, expected {:?}",
                    stamp.display(),
                    value.trim(),
                    PATCHED_FREERDP_STAMP
                ));
            }
            return Err(format!(
                "{} has the patch macro but no .zephyr-freerdp-tag stamp",
                header.display()
            ));
        }
    }
    Err(format!(
        "patch marker not found in FreeRDP include paths ({})",
        if inspected.is_empty() {
            include_paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            inspected.join(", ")
        }
    ))
}

fn is_freerdp2_link_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("freerdp2")
        || name.starts_with("freerdp-client2")
        || name.starts_with("winpr2")
        || name.starts_with("libfreerdp2")
        || name.starts_with("libfreerdp-client2")
        || name.starts_with("libwinpr2")
}

/// pkg-config is a separate binary from the libraries it describes; a missing
/// tool and a missing library are different problems with different fixes.
fn pkg_config_available() -> bool {
    // The pkg_config crate discovers the tool as $PKG_CONFIG, then pkg-config,
    // then pkgconf; the availability check must agree with the probe that
    // follows or a vcpkg pkgconf:x64-windows install (which ships pkgconf.exe,
    // not pkg-config.exe) is reported missing and the build aborts wrongly.
    let candidates: Vec<std::ffi::OsString> = match std::env::var_os("PKG_CONFIG") {
        Some(value) if !value.is_empty() => vec![value],
        _ => vec![
            std::ffi::OsString::from("pkg-config"),
            std::ffi::OsString::from("pkgconf"),
        ],
    };
    candidates.into_iter().any(|tool| {
        std::process::Command::new(tool)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}
