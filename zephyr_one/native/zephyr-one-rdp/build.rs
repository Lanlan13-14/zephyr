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

fn probe_pkg_config(statik: bool) -> LinkSpec {
    let mut last_error = String::new();

    for names in UNIX_CANDIDATES {
        let mut spec = LinkSpec::default();
        let mut ok = true;

        for name in names {
            /*
             * cargo_metadata(false): collect, do not print. See the module note
             * on link order — printing here is what breaks the build.
             *
             * Windows/macOS point PKG_CONFIG_PATH at a vcpkg STATIC triplet.
             * statik(true) is essential: it includes Libs.private from the .pc
             * files (OpenSSL, zlib, cJSON, system frameworks). vcpkg-rs's
             * find_package("freerdp") is not sufficient here: the port contains
             * three actual libraries (freerdp3, freerdp-client3, winpr3), and
             * probing only the package name neither finds all three nor carries
             * their private transitive dependencies.
             */
            match pkg_config::Config::new()
                .cargo_metadata(false)
                .statik(statik)
                .probe(name)
            {
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
         Linux: install freerdp3-dev (or freerdp2-dev).\n\
         Windows/macOS: run the checked-in vcpkg manifest with a static triplet\n\
         and point PKG_CONFIG_PATH at <installed>/<triplet>/lib/pkgconfig."
    );
}

/* Windows/macOS are also probed through pkg-config. Their workflow points
 * PKG_CONFIG_PATH at vcpkg's static triplet, so the .pc files remain the single
 * source of truth for all FreeRDP and transitive link libraries. */

fn main() {
    println!("cargo:rerun-if-changed=csrc/zephyr_rdp.c");
    println!("cargo:rerun-if-changed=csrc/zephyr_rdp.h");
    println!("cargo:rerun-if-changed=build.rs");

    // CARGO_CFG_TARGET_OS, not #[cfg(target_os)]: inside a build script the cfg
    // macro describes the *host*, so a Linux→Windows cross-compile would take
    // the wrong branch.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    /*
     * Packaged builds set ZEPHYR_ONE_RDP_STATIC=1 and point PKG_CONFIG_PATH at a
     * vcpkg static triplet on all three desktop platforms. This makes the
     * helper self-contained: installing One must never require Homebrew or the
     * distro's exact FreeRDP SONAME. Local Linux development may omit the flag
     * and link the distro shared libraries for a much faster edit/build loop.
     */
    let force_static = env::var_os("ZEPHYR_ONE_RDP_STATIC").is_some();
    let spec = probe_pkg_config(
        force_static || matches!(target_os.as_str(), "windows" | "macos"),
    );

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
        .flag_if_supported("-Werror")
        /* FreeRDP 3 marks compatibility members in its public structs as
         * deprecated, so merely parsing client.h can warn. Keep the warning
         * visible while preventing a third-party declaration from defeating
         * our own warnings-as-errors policy. */
        .flag_if_supported("-Wno-error=deprecated-declarations");
    if target_os != "windows" {
        build.define("_POSIX_C_SOURCE", Some("200809L"));
    }
    build.compile("zephyr_rdp_shim");

    // Only now, so the archive precedes the libraries it depends on.
    spec.emit();
}
