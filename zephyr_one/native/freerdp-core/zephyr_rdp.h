/*
 * zephyr_rdp.h — narrow, stable C ABI over libfreerdp for Zephyr One.
 *
 * Why a C shim instead of binding FreeRDP directly from Rust:
 *   rdpSettings has several hundred fields and rdpContext/freerdp are
 *   ALIGN64-annotated structs whose layout is compiler-dependent. Hand-writing
 *   those in Rust means hard-coding offsets that silently corrupt memory when
 *   FreeRDP is rebuilt with different options. bindgen would fix that but adds
 *   a libclang build dependency on all three desktop platforms.
 *
 *   Instead every struct touch happens in C, where the headers guarantee
 *   correct offsets, and Rust only sees the flat `zephyr_rdp_*` ABI below.
 *
 * Source compatibility: this file uses only the accessor API
 * (freerdp_settings_get/set_*), which exists in FreeRDP 2.4+ and is the *only*
 * supported way to touch settings in FreeRDP 3. One source therefore compiles
 * against Alpine's FreeRDP 2.11 (development/CI) and vcpkg/Homebrew FreeRDP 3
 * (shipping builds) without an #ifdef per field.
 */
#ifndef ZEPHYR_RDP_H
#define ZEPHYR_RDP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct zephyr_rdp_session zephyr_rdp_session;

/* ── Event codes pushed to the host through zephyr_rdp_event_cb ───────────── */
#define ZEPHYR_RDP_EV_CONNECTED     1
#define ZEPHYR_RDP_EV_DISCONNECTED  2
#define ZEPHYR_RDP_EV_ERROR         3
#define ZEPHYR_RDP_EV_RESIZE        4
#define ZEPHYR_RDP_EV_CLIPBOARD     5  /* utf8 text from the remote clipboard */
/*
 * EV_LOG carries the TLS certificate fingerprint from VerifyCertificateEx, and
 * nothing else. It is deliberately narrow: the fingerprint is the only record of
 * which certificate a session actually trusted, so it must not share a code with
 * anything routine. An operator checking for a MITM has to be able to read the
 * fingerprint field and get a fingerprint.
 */
#define ZEPHYR_RDP_EV_LOG           6
#define ZEPHYR_RDP_EV_CURSOR        7  /* pointer position moved by the server */
/*
 * A virtual channel came up; `text` is the channel name (rdpdr, rdpsnd,
 * cliprdr, …). Separate from EV_LOG because these two were originally folded
 * together, which made the host report `{"type":"certificate",
 * "fingerprint":"rdpdr"}` — a channel name presented as a certificate
 * fingerprint. That is worse than useless in the one situation the fingerprint
 * exists for.
 *
 * It is also the wire-level proof that folder mapping negotiated: `rdpdr` here
 * means the server accepted the redirection channel.
 */
#define ZEPHYR_RDP_EV_CHANNEL       8

/* ── Audio modes ─────────────────────────────────────────────────────────── */
#define ZEPHYR_RDP_AUDIO_LOCAL   0 /* play on this device (rdpsnd, OS backend) */
#define ZEPHYR_RDP_AUDIO_REMOTE  1 /* leave the sound on the remote machine    */
#define ZEPHYR_RDP_AUDIO_OFF     2 /* no audio channel at all                  */

/* ── Folder-mapping validation ────────────────────────────────────────────
 *
 * These exist because freerdp_client_add_device_channel() *stats the path* and
 * returns FALSE when the directory is absent. Without a pre-check, a folder
 * that was valid when the user picked it but has since been deleted or
 * unmounted (external disk, network share) makes the whole session fail with no
 * indication that the folder was the cause.
 *
 * Verified against FreeRDP 2.11.7: the identical config succeeded with
 * drive_path="/tmp" and failed with a non-existent path, with no other change.
 */
/*
 * Name and path emptiness are reported separately on purpose: the UI reaction
 * differs. A missing path means the user never picked a folder ("请选择文件夹");
 * a missing name is recoverable by defaulting to the folder's basename, so
 * collapsing both into one code would throw away the information needed to
 * choose between them.
 */
#define ZEPHYR_RDP_DRIVE_OK         0
#define ZEPHYR_RDP_DRIVE_NO_NAME  (-1) /* share name empty                     */
#define ZEPHYR_RDP_DRIVE_NO_PATH  (-2) /* folder path empty                    */
#define ZEPHYR_RDP_DRIVE_NOT_FOUND (-3) /* path does not exist / unreadable    */
#define ZEPHYR_RDP_DRIVE_NOT_DIR  (-4) /* exists but is not a directory        */
/* Share name carries `/`, `\` or `:`, or is not valid UTF-8. Those separators
 * are interpreted rather than displayed by the remote Explorer, so the name is
 * refused instead of being silently rewritten. */
#define ZEPHYR_RDP_DRIVE_BAD_NAME (-5)

/* ── Security negotiation ────────────────────────────────────────────────── */
#define ZEPHYR_RDP_SEC_AUTO  0
#define ZEPHYR_RDP_SEC_NLA   1
#define ZEPHYR_RDP_SEC_TLS   2
#define ZEPHYR_RDP_SEC_RDP   3

/*
 * Frame callback: a rectangle of the framebuffer changed.
 *
 * `pixels` is tightly packed BGRA (`stride == w * 4`), top-down, and is only
 * valid for the duration of the call — the host must copy or write it out
 * synchronously. Packing happens in C so the host never has to know the GDI
 * stride or reason about the primary buffer's lifetime.
 */
typedef void (*zephyr_rdp_frame_cb)(void* user, int32_t x, int32_t y, int32_t w,
                                    int32_t h, const uint8_t* pixels, size_t len);

/* Event callback. `text` is NUL-terminated UTF-8 and may be NULL. For
 * ZEPHYR_RDP_EV_RESIZE, a/b carry the new width/height. For EV_CURSOR they
 * carry x/y. */
typedef void (*zephyr_rdp_event_cb)(void* user, int32_t code, int32_t a,
                                    int32_t b, const char* text);

typedef struct zephyr_rdp_config {
    const char* host;
    uint32_t    port;
    const char* username;
    const char* password;
    const char* domain;

    uint32_t width;
    uint32_t height;
    uint32_t color_depth;

    int32_t security;          /* ZEPHYR_RDP_SEC_*                            */
    int32_t ignore_certificate; /* 1 = accept unknown/self-signed certs        */

    int32_t audio_mode;   /* ZEPHYR_RDP_AUDIO_*                               */
    int32_t microphone;   /* 1 = redirect local mic to the remote session      */
    int32_t clipboard;    /* 1 = enable cliprdr text bridging                  */

    /* Folder mapping (RDPDR drive redirection). Both must be non-empty for the
     * drive to be attached; `drive_name` is what shows up in the remote
     * Explorer, `drive_path` is the local directory being shared. */
    const char* drive_name;
    const char* drive_path;
    int32_t     drive_read_only;

    int32_t dynamic_resolution; /* 1 = advertise disp channel for live resize  */
    int32_t gfx;                /* 1 = allow RDPGFX pipeline (H264 etc.)       */

    /* Perf knobs mapped to FreeRDP's connection-type presets. */
    int32_t disable_wallpaper;
    int32_t disable_themes;
    int32_t disable_menu_anims;
    int32_t disable_full_window_drag;
    int32_t allow_font_smoothing;
} zephyr_rdp_config;

/*
 * Create a session. Does not connect and does not spawn a thread: the caller
 * owns threading, so Rust keeps one OS thread per session and there is no
 * hidden C-side thread to reason about at shutdown.
 *
 * Returns NULL on allocation/settings failure.
 */
zephyr_rdp_session* zephyr_rdp_new(const zephyr_rdp_config* cfg,
                                   zephyr_rdp_frame_cb frame_cb,
                                   zephyr_rdp_event_cb event_cb, void* user);

/*
 * Connect and run the RDP event loop until disconnect or zephyr_rdp_stop().
 * Blocks the calling thread. Emits EV_CONNECTED on success and
 * EV_DISCONNECTED/EV_ERROR on exit. Returns 0 on clean disconnect, non-zero
 * on failure (the FreeRDP error code where one is available).
 */
int32_t zephyr_rdp_run(zephyr_rdp_session* s);

/* Ask the loop to exit. Safe to call from any thread, including while
 * zephyr_rdp_run is blocked in a wait. */
void zephyr_rdp_stop(zephyr_rdp_session* s);

/* Free the session. Must not be called while zephyr_rdp_run is executing. */
void zephyr_rdp_free(zephyr_rdp_session* s);

/* ── Input. All are safe to call from a thread other than the loop: they
 *    enqueue onto an internal mutex-protected queue and wake the loop through
 *    a WinPR event handle, so FreeRDP's non-reentrant send path is only ever
 *    touched by the loop thread itself. ───────────────────────────────────── */
void zephyr_rdp_send_mouse(zephyr_rdp_session* s, uint16_t flags, uint16_t x, uint16_t y);
void zephyr_rdp_send_mouse_ex(zephyr_rdp_session* s, uint16_t flags, uint16_t x, uint16_t y);
void zephyr_rdp_send_scancode(zephyr_rdp_session* s, uint16_t flags, uint16_t code);
void zephyr_rdp_send_unicode(zephyr_rdp_session* s, uint16_t flags, uint16_t code);
void zephyr_rdp_send_sync(zephyr_rdp_session* s, uint32_t toggle_flags);
/* Request a full repaint of the current framebuffer (used on tab re-attach). */
void zephyr_rdp_request_full_frame(zephyr_rdp_session* s);
/* Live resize through the disp channel; no-op when dynamic_resolution is off. */
void zephyr_rdp_resize(zephyr_rdp_session* s, uint32_t width, uint32_t height);
/* Push local clipboard text to the remote session. */
void zephyr_rdp_set_clipboard(zephyr_rdp_session* s, const char* utf8);

/*
 * Check a folder mapping before it is used, returning a specific
 * ZEPHYR_RDP_DRIVE_* code so the host can tell the user *why* the mapping is
 * unusable instead of surfacing a generic connect failure.
 *
 * Callable without a session. Pure filesystem inspection; no RDP state.
 */
int32_t zephyr_rdp_validate_drive(const char* drive_name, const char* drive_path);

/* ── Introspection, used by the test suite ───────────────────────────────── */

/* FreeRDP major version this shim was compiled against. */
int32_t zephyr_rdp_freerdp_major(void);

/*
 * Move the process's stdout out of the way and hand back a private handle to
 * the original.
 *
 * Why this is required, not defensive:
 *   The host uses stdout as a length-prefixed binary channel. FreeRDP's WLog
 *   console appender writes to *stdout*, and its default level is INFO, so a
 *   stock build interleaves lines like
 *       [INFO][com.freerdp.gdi] - Local framebuffer format PIXEL_FORMAT_BGRA32
 *   into the frame stream. The reader then interprets those ASCII bytes as a
 *   frame length and desynchronises permanently — observed as exactly one frame
 *   parsed (the `hello` sent before FreeRDP starts logging) and then nothing.
 *
 *   WinPR exposes no public way to point the console appender at stderr, and
 *   fixing only WLog would still leave any other library that printf()s to
 *   stdout able to corrupt the channel. Redirecting the descriptor fixes the
 *   whole class: after this call, fd 1 *is* stderr, so stray output becomes
 *   diagnostics instead of corruption.
 *
 * Must be called before anything writes to stdout, i.e. first thing in main.
 *
 * Returns, on success, a handle to the original stdout that the caller owns:
 *   POSIX   — the duplicated file descriptor
 *   Windows — the CRT descriptor's OS HANDLE, cast to intptr_t, which is what
 *             std::os::windows::io::FromRawHandle consumes
 * Returns -1 on failure, in which case stdout is left untouched.
 */
intptr_t zephyr_rdp_isolate_stdout(void);

/*
 * Report sizeof/offsetof for zephyr_rdp_config so the Rust mirror of this
 * struct can be asserted against the C definition at test time.
 *
 * This is not decoration. Rust's #[repr(C)] agrees with the C ABI only if the
 * field list and order match exactly; if they drift, a `const char*` gets read
 * where an `int32_t` was written and the session silently connects with garbage
 * credentials — or dereferences an integer as a pointer. A compiler cannot catch
 * that across an FFI boundary, so it is asserted numerically instead.
 *
 * Selector: 0 = sizeof, then one per field in declaration order (see
 * ZEPHYR_RDP_LAYOUT_* below). Returns -1 for an unknown selector.
 */
int32_t zephyr_rdp_config_layout(int32_t selector);

#define ZEPHYR_RDP_LAYOUT_SIZEOF                   0
#define ZEPHYR_RDP_LAYOUT_HOST                     1
#define ZEPHYR_RDP_LAYOUT_PORT                     2
#define ZEPHYR_RDP_LAYOUT_USERNAME                 3
#define ZEPHYR_RDP_LAYOUT_PASSWORD                 4
#define ZEPHYR_RDP_LAYOUT_DOMAIN                   5
#define ZEPHYR_RDP_LAYOUT_WIDTH                    6
#define ZEPHYR_RDP_LAYOUT_HEIGHT                   7
#define ZEPHYR_RDP_LAYOUT_COLOR_DEPTH              8
#define ZEPHYR_RDP_LAYOUT_SECURITY                 9
#define ZEPHYR_RDP_LAYOUT_IGNORE_CERTIFICATE      10
#define ZEPHYR_RDP_LAYOUT_AUDIO_MODE              11
#define ZEPHYR_RDP_LAYOUT_MICROPHONE              12
#define ZEPHYR_RDP_LAYOUT_CLIPBOARD               13
#define ZEPHYR_RDP_LAYOUT_DRIVE_NAME              14
#define ZEPHYR_RDP_LAYOUT_DRIVE_PATH              15
#define ZEPHYR_RDP_LAYOUT_DRIVE_READ_ONLY         16
#define ZEPHYR_RDP_LAYOUT_DYNAMIC_RESOLUTION      17
#define ZEPHYR_RDP_LAYOUT_GFX                     18
#define ZEPHYR_RDP_LAYOUT_DISABLE_WALLPAPER       19
#define ZEPHYR_RDP_LAYOUT_DISABLE_THEMES          20
#define ZEPHYR_RDP_LAYOUT_DISABLE_MENU_ANIMS      21
#define ZEPHYR_RDP_LAYOUT_DISABLE_FULL_WINDOW_DRAG 22
#define ZEPHYR_RDP_LAYOUT_ALLOW_FONT_SMOOTHING    23
#define ZEPHYR_RDP_LAYOUT_COUNT                   24

/*
 * Build a settings object exactly as zephyr_rdp_new would, then report what
 * the RDPDR device collection actually contains. This is how the drive-mapping
 * wiring is verified without needing a live RDP server: a server can only prove
 * the channel works, it cannot prove the *settings* were assembled correctly.
 *
 * Writes the resolved drive name/path into the caller's buffers and returns the
 * device count, or -1 on failure.
 */
int32_t zephyr_rdp_probe_drive(const zephyr_rdp_config* cfg, char* name_out,
                               size_t name_cap, char* path_out, size_t path_cap,
                               int32_t* type_out);

/*
 * Report the negotiated security/redirection flags a config resolves to, so
 * tests can assert that e.g. audio_mode=OFF really clears AudioPlayback rather
 * than merely not setting it. Values are written into the out params.
 */
int32_t zephyr_rdp_probe_settings(const zephyr_rdp_config* cfg, int32_t* nla,
                                  int32_t* tls, int32_t* rdp_sec,
                                  int32_t* audio_playback, int32_t* audio_capture,
                                  int32_t* clipboard, int32_t* device_redirection,
                                  int32_t* dynamic_res, int32_t* gfx);

/*
 * UTF-8 ↔ UTF-16LE, exported for the conversion tests.
 *
 * The clipboard bridge depends on these being correct for CJK and for
 * astral-plane input (emoji, which RDP carries as surrogate pairs). WinPR's own
 * converters could not be used — ConvertToUnicode/ConvertFromUnicode exist in
 * WinPR 2 but were removed in WinPR 3 — so they are hand-written here and must
 * be tested directly rather than only through a live session.
 *
 * Both return the number of units/bytes written excluding the terminator, or
 * -1 on malformed input (overlong encodings, lone surrogates, truncated
 * sequences). Pass out=NULL to measure.
 */
long zephyr_rdp_test_utf8_to_utf16le(const char* in, uint16_t* out, size_t units);
long zephyr_rdp_test_utf16le_to_utf8(const uint16_t* in, size_t units, char* out,
                                     size_t cap);
/* Round-trips UTF-8 → UTF-16LE → UTF-8 in one call. Returns bytes written or
 * -1. Byte equality with the input is the property the tests assert. */
int32_t zephyr_rdp_utf_roundtrip(const char* in, char* out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* ZEPHYR_RDP_H */
