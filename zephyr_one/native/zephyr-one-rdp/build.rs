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
    /// Whether a static link was requested (packaged builds).
    statik: bool,
    /// Pre-rendered `cargo:` lines (vcpkg hands these over ready-made).
    raw_metadata: Vec<String>,
}

/// Directories that hold the platform's own libraries.
///
/// Mirrors pkg-config's rule: a hit inside one of these is the system copy, and
/// linking the system libc/libm statically is not what anyone wants even when
/// the FreeRDP stack itself is static.
fn system_roots() -> Vec<PathBuf> {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        vec![PathBuf::from("/Library"), PathBuf::from("/System")]
    } else {
        vec![PathBuf::from(
            env::var("PKG_CONFIG_SYSROOT_DIR")
                .or_else(|_| env::var("SYSROOT"))
                .unwrap_or_else(|_| "/usr".to_string()),
        )]
    }
}

/// Does an actual archive for `name` exist in one of `dirs`, outside the system?
///
/// Deliberately a re-implementation of pkg_config's private `is_static_available`.
/// `Library` only carries bare library names, so calling `.cargo_metadata(false)`
/// (which link order forces, see the module note) throws away the crate's own
/// static/dylib decision. Re-deriving it here is what keeps `cargo:rustc-link-lib`
/// faithful; emitting a bare name instead makes rustc pass `-Bdynamic`, and a
/// static-only vcpkg triplet then fails with one undefined symbol per FFI call.
fn archive_available(name: &str, dirs: &[PathBuf], roots: &[PathBuf]) -> bool {
    let msvc = env::var("TARGET").map(|t| t.contains("msvc")).unwrap_or(false);
    let mut candidates = vec![format!("lib{name}.a")];
    if msvc {
        candidates.push(format!("{name}.lib"));
    }
    dirs.iter().any(|dir| {
        candidates.iter().any(|file| dir.join(file).exists())
            && !roots.iter().any(|root| dir.starts_with(root))
    })
}

/// Is `name` a POSIX-only library that does not exist on this target?
///
/// vcpkg's FreeRDP 3 `.pc` files carry `-ldl -lrt -lpthread -lm` in
/// `Libs.private` regardless of triplet, so a `--static` probe hands them to
/// every target. Measured consequences of passing them through:
///
///   Windows: `LINK : fatal error LNK1181: cannot open input file 'dl.lib'`
///   macOS:   `ld: library 'rt' not found`
///
/// On Windows/MSVC none of the four exist as an import library; their functions
/// live in the CRT. On macOS `dl`/`pthread`/`m` resolve to libSystem stubs, but
/// there is no `librt` at all — clock_gettime and friends are in libSystem too.
/// Linux keeps every one of them.
fn is_absent_posix_lib(name: &str, target_os: &str, msvc: bool) -> bool {
    if msvc || target_os == "windows" {
        matches!(name, "dl" | "rt" | "pthread" | "m")
    } else if target_os == "macos" || target_os == "ios" {
        name == "rt"
    } else {
        false
    }
}

impl LinkSpec {
    /// Print the accumulated link directives. Called *after* cc::Build::compile.
    fn emit(&self) {
        for path in &self.link_paths {
            println!("cargo:rustc-link-search=native={}", path.display());
        }

        let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        let msvc = env::var("TARGET").map(|t| t.contains("msvc")).unwrap_or(false);

        let roots = system_roots();
        let mut static_hits = 0usize;
        for lib in &self.libs {
            if is_absent_posix_lib(lib, &target_os, msvc) {
                println!("cargo:warning=dropping -l{lib} (absent on {target_os})");
                continue;
            }
            if self.statik && archive_available(lib, &self.link_paths, &roots) {
                static_hits += 1;
                println!("cargo:rustc-link-lib=static={lib}");
            } else {
                println!("cargo:rustc-link-lib={lib}");
            }
        }

        /*
         * A packaged build that silently degrades to dynamic linking is the exact
         * failure this guard exists for: it links on the builder, then dies on a
         * user's machine with "libfreerdp.so.3: cannot open shared object file".
         * Failing here, with the directories listed, is worth more than a green
         * build that ships a broken installer.
         */
        if self.statik && static_hits == 0 {
            let mut listing = String::new();
            for dir in &self.link_paths {
                listing.push_str(&format!("\n  {}", dir.display()));
                if let Ok(entries) = std::fs::read_dir(dir) {
                    let mut names: Vec<String> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|n| n.ends_with(".a") || n.ends_with(".lib"))
                        .collect();
                    names.sort();
                    if names.is_empty() {
                        listing.push_str("    (no .a/.lib present)");
                    }
                    for name in names.iter().take(40) {
                        listing.push_str(&format!("\n      {name}"));
                    }
                } else {
                    listing.push_str("    (unreadable)");
                }
            }
            panic!(
                "ZEPHYR_ONE_RDP_STATIC requested a self-contained helper, but no \
                 archive was found for any of: {:?}\nSearched:{}\n\
                 Check that the vcpkg triplet is a static one and that \
                 PKG_CONFIG_PATH points at its lib/pkgconfig.",
                self.libs, listing
            );
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
        spec.statik = statik;
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
