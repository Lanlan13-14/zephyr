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

use std::path::PathBuf;

/// FreeRDP 3 first, then 2. The shim is written entirely against the accessor
/// API (`freerdp_settings_get/set_*`), which both majors expose, so whichever is
/// installed is the one we link.
const CANDIDATES: [&[&str]; 2] = [
    &["freerdp3", "freerdp-client3", "winpr3"],
    &["freerdp2", "freerdp-client2", "winpr2"],
];

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
    println!("cargo:rerun-if-changed={}", native.join("zephyr_rdp.c").display());
    println!("cargo:rerun-if-changed={}", native.join("zephyr_rdp.h").display());
    println!("cargo:rerun-if-env-changed=ZEPHYR_ONE_SKIP_NATIVE_RDP");

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

    /* Probe with cargo_metadata OFF first. A half-installed major (freerdp3
     * present, winpr3 missing) must not leak its partial link flags into a
     * build that then falls back to freerdp2; only the winning set is
     * re-probed with metadata on, which is what emits the
     * cargo:rustc-link-lib / -link-search lines. */
    let mut errors = Vec::new();
    let found = CANDIDATES.iter().find_map(|pkgs| match probe(pkgs, false) {
        Ok(includes) => Some((pkgs, includes)),
        Err(error) => {
            errors.push(error);
            None
        }
    });
    let Some((pkgs, include_paths)) = found else {
        panic!(
            "FreeRDP development files not found (tried freerdp3, then freerdp2).\n\
             \n\
             Zephyr One's RDP engine is FreeRDP linked in-process; there is no\n\
             WASM fallback in the desktop product. Install the dev package:\n\
             \n\
             \x20 Debian/Ubuntu : sudo apt-get install freerdp3-dev\n\
             \x20 Alpine        : apk add freerdp-dev\n\
             \x20 macOS         : brew install freerdp\n\
             \x20 Windows       : vcpkg install freerdp:x64-windows\n\
             \n\
             pkg-config reported:\n  {}\n\
             \n\
             To build the shell without RDP, set ZEPHYR_ONE_SKIP_NATIVE_RDP=1.\n\
             That build reports native_rdp_unavailable instead of connecting.",
            errors.join("\n  ")
        );
    };
    // The winning set was probed a moment ago; a failure here means pkg-config
    // results changed mid-build, which deserves a loud abort, not a retry.
    for &name in *pkgs {
        pkg_config::Config::new()
            .cargo_metadata(true)
            .probe(name)
            .unwrap_or_else(|error| panic!("FreeRDP package {name} vanished between probes: {error}"));
    }

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

    for path in include_paths {
        build.include(path);
    }

    build.compile("zephyr_rdp");

    // The consumer gates on this, so a skipped build cannot link against
    // symbols that were never compiled.
    println!("cargo:rustc-cfg=zephyr_native_rdp");
}

/// Locate one FreeRDP major through pkg-config.
///
/// Returns the include paths on success so the shim compiles against the same
/// headers the library was built from. On failure the error names the package
/// that was missing, so the panic message blames the right thing rather than
/// the whole set.
fn probe(pkgs: &[&str], cargo_metadata: bool) -> Result<Vec<PathBuf>, String> {
    let mut includes = Vec::new();
    for name in pkgs {
        match pkg_config::Config::new()
            .cargo_metadata(cargo_metadata)
            .probe(name)
        {
            Ok(lib) => includes.extend(lib.include_paths),
            Err(error) => return Err(format!("{name}: {error}")),
        }
    }
    Ok(includes)
}

/// pkg-config is a separate binary from the libraries it describes; a missing
/// tool and a missing library are different problems with different fixes.
fn pkg_config_available() -> bool {
    std::process::Command::new("pkg-config")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}
