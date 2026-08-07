//! Compile the C shim and link it against whichever FreeRDP the platform has.
//!
//! Version policy: FreeRDP 3 is preferred and 2 is accepted. The shim uses only
//! the accessor API (`freerdp_settings_get/set_*`), which both majors expose, so
//! the same source works either way — this script only has to find the right
//! package names and let the compiler confirm the rest.
//!
//! ── Link order is load-bearing ──
//!
//! `pkg_config::probe()` prints its `cargo:rustc-link-lib` lines immediately.
//! If it runs before `cc::Build::compile()` (which emits
//! `cargo:rustc-link-lib=static=zephyr_rdp_shim`), the final linker command
//! lists the FreeRDP shared objects *before* the archive that needs them.
//!
//! GNU ld defaults to `--as-needed` on Alpine and Debian: a shared library seen
//! before any undefined symbol requires it is dropped outright. The shim's
//! objects are then pulled in with nothing left to satisfy them.
//!
//! Measured on this toolchain with an otherwise identical command line:
//!   libs before archive → 80 undefined references
//!   archive before libs → links cleanly
//!
//! So every probe here runs with `cargo_metadata(false)`, and the collected
//! metadata is printed only after `compile()`. Cargo preserves emission order,
//! which is what makes this deterministic rather than lucky.

use std::env;
use std::path::PathBuf;

/// Package name triples to try, newest first.
const UNIX_CANDIDATES: [[&str; 3]; 2] = [
    ["freerdp3", "freerdp-client3", "winpr3"],
    ["freerdp2", "freerdp-client2", "winpr2"],
];

#[derive(Default)]
struct LinkSpec {
    include_paths: Vec<PathBuf>,
    link_paths: Vec<PathBuf>,
    libs: Vec<String>,
    frameworks: Vec<String>,
    /// Pre-rendered `cargo:` lines (vcpkg hands these over ready-made).
    raw_metadata: Vec<String>,
}

impl LinkSpec {
    /// Print the accumulated link directives. Called *after* cc::Build::compile.
    fn emit(&self) {
        for path in &self.link_paths {
            println!("cargo:rustc-link-search=native={}", path.display());
        }
        for lib in &self.libs {
            println!("cargo:rustc-link-lib={lib}");
        }
        for framework in &self.frameworks {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        for line in &self.raw_metadata {
            println!("{line}");
        }
    }
}

fn probe_unix() -> LinkSpec {
    let mut last_error = String::new();

    for names in UNIX_CANDIDATES {
        let mut spec = LinkSpec::default();
        let mut ok = true;

        for name in names {
            // cargo_metadata(false): collect, do not print. See the module note
            // on link order — printing here is what breaks the build.
            match pkg_config::Config::new().cargo_metadata(false).probe(name) {
                Ok(lib) => {
                    spec.include_paths.extend(lib.include_paths);
                    spec.link_paths.extend(lib.link_paths);
                    spec.libs.extend(lib.libs);
                    spec.frameworks.extend(lib.frameworks);
                }
                Err(error) => {
                    ok = false;
                    last_error = format!("{name}: {error}");
                    break;
                }
            }
        }

        if ok {
            println!("cargo:warning=zephyr-one-rdp linking against {}", names[0]);
            return spec;
        }
    }

    panic!(
        "Neither FreeRDP 3 nor FreeRDP 2 found via pkg-config ({last_error}).\n\
         Alpine:        apk add freerdp-dev\n\
         Debian/Ubuntu: apt-get install libfreerdp-dev libwinpr-dev\n\
         macOS:         brew install freerdp"
    );
}

fn probe_windows() -> LinkSpec {
    // vcpkg's freerdp port carries the import libraries, headers, and the
    // openssl/zlib transitive links, which is why this is not a hand-rolled
    // list of link-lib lines.
    match vcpkg::Config::new()
        .cargo_metadata(false)
        .emit_includes(true)
        .find_package("freerdp")
    {
        Ok(lib) => LinkSpec {
            include_paths: lib.include_paths,
            raw_metadata: lib.cargo_metadata,
            ..Default::default()
        },
        Err(error) => panic!(
            "FreeRDP not found through vcpkg: {error}\n\
             Install with: vcpkg install freerdp:x64-windows-static-md\n\
             and set VCPKG_ROOT so this build script can locate it."
        ),
    }
}

fn main() {
    println!("cargo:rerun-if-changed=csrc/zephyr_rdp.c");
    println!("cargo:rerun-if-changed=csrc/zephyr_rdp.h");
    println!("cargo:rerun-if-changed=build.rs");

    // CARGO_CFG_TARGET_OS, not #[cfg(target_os)]: inside a build script the cfg
    // macro describes the *host*, so a Linux→Windows cross-compile would take
    // the wrong branch.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let spec = if target_os == "windows" {
        probe_windows()
    } else {
        probe_unix()
    };

    let mut build = cc::Build::new();
    build.file("csrc/zephyr_rdp.c").include("csrc").std("c11");
    for path in &spec.include_paths {
        build.include(path);
    }
    // Warnings-as-errors is deliberate: the shim is the layer where a wrong
    // struct field silently corrupts memory, so a FreeRDP release that changes
    // a signature must fail the build rather than emit a warning nobody reads.
    build
        .warnings(true)
        .extra_warnings(true)
        .flag_if_supported("-Werror");
    build.compile("zephyr_rdp_shim");

    // Only now, so the archive precedes the libraries it depends on.
    spec.emit();
}
