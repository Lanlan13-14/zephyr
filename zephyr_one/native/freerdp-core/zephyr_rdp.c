/*
 * zephyr_rdp.c — implementation of the narrow C ABI over libfreerdp.
 *
 * Threading contract:
 *   zephyr_rdp_run() owns the FreeRDP instance for its whole lifetime. Every
 *   other exported function is callable from another thread and does nothing
 *   but append to a mutex-protected queue plus SetEvent() a wake handle. That
 *   keeps FreeRDP's non-reentrant send path single-threaded by construction
 *   rather than by hoping callers cooperate.
 *
 * Version portability:
 *   Only the accessor API (freerdp_settings_set_*) is used for settings, so
 *   this compiles unchanged against FreeRDP 2.11 (Alpine, used for development
 *   and the automated tests) and FreeRDP 3.x (vcpkg/Homebrew, used for shipped
 *   builds). The two places where the C API genuinely diverges are isolated
 *   behind FREERDP_VERSION_MAJOR checks and marked below.
 */

#include "zephyr_rdp.h"

#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/event.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/settings.h>
#include <freerdp/version.h>
#include <winpr/crt.h>
#include <winpr/interlocked.h>
#include <winpr/synch.h>
#include <winpr/user.h>

#include <stdlib.h>
#include <string.h>

/* Folder-mapping validation needs a directory test. WinPR's GetFileAttributesA
 * is not usable here (ANSI on real Windows mangles non-ASCII folder names), so
 * each platform uses its own native wide/UTF-8 API directly. */
#ifdef _WIN32
#include <winpr/file.h>
#include <io.h>      /* _dup / _dup2 / _fileno for the stdout isolation below */
#include <stdio.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>  /* dup / dup2 / close */
#include <fcntl.h>   /* open, O_WRONLY */
#endif

/* ── FreeRDP 2/3 source compatibility ──────────────────────────────────────
 *
 * FreeRDP 3 nested every clipboard PDU's wire header under `.common` and every
 * redirected device's base fields under `.device`; FreeRDP 2 exposed the same
 * fields flat. Keep protocol code readable and version-neutral through these
 * accessors instead of maintaining two divergent implementations.
 */
#if FREERDP_VERSION_MAJOR >= 3
#define CLIP_FLAGS(v) ((v).common.msgFlags)
#define CLIP_FLAGS_P(v) ((v)->common.msgFlags)
#define CLIP_LEN(v) ((v).common.dataLen)
#define CLIP_LEN_P(v) ((v)->common.dataLen)
#define DRIVE_NAME(v) ((v)->device.Name)
#define DRIVE_TYPE(v) ((v)->device.Type)
#else
#define CLIP_FLAGS(v) ((v).msgFlags)
#define CLIP_FLAGS_P(v) ((v)->msgFlags)
#define CLIP_LEN(v) ((v).dataLen)
#define CLIP_LEN_P(v) ((v)->dataLen)
#define DRIVE_NAME(v) ((v)->Name)
#define DRIVE_TYPE(v) ((v)->Type)
#endif

#if FREERDP_VERSION_MAJOR >= 3
#define Z_EVENT_CONST const
#else
#define Z_EVENT_CONST
#endif

/* This marker is added by the pinned FreeRDP patch. Without it the upstream
 * cliprdr callback runs only after the generic channel code has allocated the
 * server-controlled `totalLength`, so enabling the channel would leave an OOM
 * path even if the response callback below rejected the payload. */
#if defined(FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT) && \
    FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT == 1
#define ZEPHYR_RDP_SAFE_CLIPRDR 1
#else
#define ZEPHYR_RDP_SAFE_CLIPRDR 0
#endif

/* ── input queue ──────────────────────────────────────────────────────────── */

#define ZQ_MOUSE     1
#define ZQ_MOUSE_EX  2
#define ZQ_SCANCODE  3
#define ZQ_UNICODE   4
#define ZQ_SYNC      5
#define ZQ_RESIZE    6
#define ZQ_CLIPBOARD 7
#define ZQ_FULLFRAME 8

/* MS-RDPBCGR 2.2.1.1.1 negotiation protocol values. The core negotiation
 * header that defines these is private to FreeRDP, so keep the small wire
 * constants here rather than reaching into an unshipped internal header. */
#define ZEPHYR_PROTOCOL_RDP       0x00000000u
#define ZEPHYR_PROTOCOL_SSL       0x00000001u
#define ZEPHYR_PROTOCOL_HYBRID    0x00000002u
#define ZEPHYR_PROTOCOL_HYBRID_EX 0x00000008u

#ifdef ZEPHYR_RDP_TESTING
#define ZEPHYR_RDP_TEST_FAIL_HOST        1
#define ZEPHYR_RDP_TEST_FAIL_USERNAME    2
#define ZEPHYR_RDP_TEST_FAIL_PASSWORD    3
#define ZEPHYR_RDP_TEST_FAIL_DOMAIN      4
#define ZEPHYR_RDP_TEST_FAIL_DRIVE_NAME  5
#define ZEPHYR_RDP_TEST_FAIL_DRIVE_PATH  6
#define ZEPHYR_RDP_TEST_FAIL_LOCK        7
#define ZEPHYR_RDP_TEST_FAIL_WAKE        8
#define ZEPHYR_RDP_TEST_FAIL_CONTEXT     9
#define ZEPHYR_RDP_TEST_FAIL_CONFIG     10
#define ZEPHYR_RDP_TEST_FAIL_READY      11

int32_t zephyr_rdp_test_new_failure_cleanup(const zephyr_rdp_config* cfg,
                                            int32_t failpoint);
int32_t zephyr_rdp_test_password_wipe_cleanup(const zephyr_rdp_config* cfg,
                                              int32_t failpoint);

static int32_t zrdp_test_failpoint;
static BOOL zrdp_test_failpoint_hit;
static int32_t zrdp_test_live_sessions;
static int32_t zrdp_test_live_strings;
static int32_t zrdp_test_live_locks;
static int32_t zrdp_test_live_wakes;
static int32_t zrdp_test_live_contexts;
static int32_t zrdp_test_password_wipe_failures;
static int32_t zrdp_test_owned_password_wipes;
static int32_t zrdp_test_settings_password_wipes;
static BOOL zrdp_test_wiping_owned_password;

static BOOL zrdp_test_fail_now(int32_t failpoint) {
    if (zrdp_test_failpoint != failpoint) return FALSE;
    zrdp_test_failpoint_hit = TRUE;
    return TRUE;
}

static void zrdp_test_record_password_wipe(const char* bytes, size_t len,
                                           BOOL settings_copy) {
    for (size_t i = 0; i < len; i++) {
        if (bytes[i] != '\0') {
            zrdp_test_password_wipe_failures++;
            break;
        }
    }
    if (settings_copy)
        zrdp_test_settings_password_wipes++;
    else
        zrdp_test_owned_password_wipes++;
}

#define ZRDP_TEST_FAIL_NOW(v) zrdp_test_fail_now(v)
#define ZRDP_TEST_TRACK_ACQUIRE(v) ((v)++)
#define ZRDP_TEST_TRACK_RELEASE(v) ((v)--)
#else
#define ZRDP_TEST_FAIL_NOW(v) FALSE
#define ZRDP_TEST_TRACK_ACQUIRE(v) ((void)0)
#define ZRDP_TEST_TRACK_RELEASE(v) ((void)0)
#endif

/* Bounded so a stalled server cannot turn UI input into unbounded memory
 * growth. On overflow the *oldest* entry is dropped: newer input is always
 * more relevant than a stale mouse position, and dropping the newest would
 * make a release event vanish while its press survived (stuck buttons). */
#define ZQ_CAPACITY 4096

typedef struct {
    int      kind;
    uint16_t a, b, c;
    uint32_t d;
    char*    text; /* owned, ZQ_CLIPBOARD only */
} zq_item;

struct zephyr_rdp_session {
    freerdp*    instance;
    rdpContext* context;

    zephyr_rdp_frame_cb frame_cb;
    zephyr_rdp_event_cb event_cb;
    void*               user;

    /* Owned copies of every config string: the caller's pointers are only
     * guaranteed valid for the duration of zephyr_rdp_new(). */
    zephyr_rdp_config cfg;
    char* own_host;
    char* own_user;
    char* own_pass;
    char* own_domain;
    char* own_drive_name;
    char* own_drive_path;

    CRITICAL_SECTION lock;
    BOOL             lock_initialized;
    HANDLE           wake;
    zq_item          queue[ZQ_CAPACITY];
    int              q_head;
    int              q_count;
    uint64_t         q_dropped;

    volatile LONG stopping;
    BOOL          connected;

    /* Channel contexts captured from ChannelConnected. */
    CliprdrClientContext* cliprdr;
    DispClientContext*    disp;
    BOOL                  cliprdr_ready;

    /* Latest local clipboard text, held until the server requests a format. */
    char* clip_pending;

    /* Scratch buffer for packed frame rows, grown on demand. */
    uint8_t* pack;
    size_t   pack_cap;
};

static BOOL security_mode_supported(const zephyr_rdp_config* cfg) {
    return cfg && (cfg->security == ZEPHYR_RDP_SEC_AUTO ||
                   cfg->security == ZEPHYR_RDP_SEC_NLA);
}

static BOOL security_protocol_allowed(const zephyr_rdp_config* cfg,
                                      UINT32 selected_protocol) {
    if (!security_mode_supported(cfg)) return FALSE;
    return selected_protocol == ZEPHYR_PROTOCOL_HYBRID ||
           selected_protocol == ZEPHYR_PROTOCOL_HYBRID_EX;
}

static BOOL session_is_stopping(zephyr_rdp_session* s) {
    if (!s) return TRUE;
    return InterlockedCompareExchange(&s->stopping, 0, 0) != 0;
}

static void session_request_stop(zephyr_rdp_session* s) {
    if (!s) return;
    const LONG previous = InterlockedExchange(&s->stopping, 1);
    (void)previous;
}

/* FreeRDP allocates the context; this is how the callbacks find us back. */
typedef struct {
    rdpClientContext      common;
    zephyr_rdp_session*   owner;
} zephyr_client_context;

static zephyr_rdp_session* owner_of(rdpContext* context) {
    if (!context) return NULL;
    return ((zephyr_client_context*)context)->owner;
}

static char* dup_or_null(const char* s) {
    if (!s || !*s) return NULL;
    size_t n = strlen(s);
    char* out = (char*)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

static BOOL copy_config_string(const char* source, char** destination) {
    if (!destination) return FALSE;
    *destination = dup_or_null(source);
    if (source && *source && !*destination) return FALSE;
#ifdef ZEPHYR_RDP_TESTING
    if (*destination) ZRDP_TEST_TRACK_ACQUIRE(zrdp_test_live_strings);
#endif
    return TRUE;
}

static void free_config_string(char** value) {
    if (!value || !*value) return;
    const size_t len = strlen(*value);
    (void)SecureZeroMemory(*value, len);
#ifdef ZEPHYR_RDP_TESTING
    if (zrdp_test_wiping_owned_password)
        zrdp_test_record_password_wipe(*value, len, FALSE);
    ZRDP_TEST_TRACK_RELEASE(zrdp_test_live_strings);
#endif
    free(*value);
    *value = NULL;
}

static void emit_event(zephyr_rdp_session* s, int32_t code, int32_t a, int32_t b,
                       const char* text) {
    if (s && s->event_cb) s->event_cb(s->user, code, a, b, text);
}

/* ── UTF-8 ↔ UTF-16LE ──────────────────────────────────────────────────────
 *
 * Hand-rolled rather than using WinPR's ConvertToUnicode/ConvertFromUnicode:
 * those exist in WinPR 2 but were *removed* in WinPR 3, so calling them would
 * break the FreeRDP 3 builds this file is meant to support. Doing it here also
 * makes the conversion directly unit-testable without a live session.
 *
 * Both directions are strict: malformed input is rejected rather than being
 * silently replaced, so a bad clipboard payload cannot inject truncated text.
 */

/* Returns bytes written to `out` (excluding terminator), or -1 on bad input.
 * `out` receives UTF-16LE code units; pass NULL to measure. */
static long utf8_to_utf16le(const char* in, uint16_t* out, size_t out_units) {
    size_t i = 0;
    long   n = 0;
    const unsigned char* p = (const unsigned char*)in;

#define PUT(u)                                        \
    do {                                              \
        if (out) {                                    \
            if ((size_t)n >= out_units) return -1;    \
            out[n] = (uint16_t)(u);                   \
        }                                             \
        n++;                                          \
    } while (0)

    while (p[i]) {
        uint32_t cp;
        unsigned char c = p[i];
        if (c < 0x80) {
            cp = c;
            i += 1;
        } else if ((c & 0xE0) == 0xC0) {
            if ((p[i + 1] & 0xC0) != 0x80) return -1;
            cp = ((uint32_t)(c & 0x1F) << 6) | (uint32_t)(p[i + 1] & 0x3F);
            if (cp < 0x80) return -1; /* overlong */
            i += 2;
        } else if ((c & 0xF0) == 0xE0) {
            if ((p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80) return -1;
            cp = ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)(p[i + 1] & 0x3F) << 6) |
                 (uint32_t)(p[i + 2] & 0x3F);
            if (cp < 0x800) return -1;
            if (cp >= 0xD800 && cp <= 0xDFFF) return -1; /* lone surrogate */
            i += 3;
        } else if ((c & 0xF8) == 0xF0) {
            if ((p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80 ||
                (p[i + 3] & 0xC0) != 0x80)
                return -1;
            cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(p[i + 1] & 0x3F) << 12) |
                 ((uint32_t)(p[i + 2] & 0x3F) << 6) | (uint32_t)(p[i + 3] & 0x3F);
            if (cp < 0x10000 || cp > 0x10FFFF) return -1;
            i += 4;
        } else {
            return -1;
        }

        if (cp < 0x10000) {
            PUT(cp);
        } else {
            cp -= 0x10000;
            PUT(0xD800 + (cp >> 10));
            PUT(0xDC00 + (cp & 0x3FF));
        }
    }
    PUT(0); /* NUL terminator, counted */
#undef PUT
    return n;
}

static char* dup_clipboard_or_null(const char* utf8) {
    if (!utf8 || !*utf8) return NULL;
    long units = utf8_to_utf16le(utf8, NULL, 0);
    if (units <= 0 ||
        (size_t)units >
            (size_t)ZEPHYR_RDP_MAX_CLIPBOARD_UTF16_BYTES / sizeof(uint16_t))
        return NULL;
    return dup_or_null(utf8);
}

/* `units` counts available UTF-16 code units; conversion stops at a NUL unit.
 * Returns bytes written excluding the NUL, or -1 on bad input. */
static long utf16le_to_utf8(const uint16_t* in, size_t units, char* out,
                            size_t out_cap) {
    long n = 0;

#define PUTB(byte)                                    \
    do {                                              \
        if (out) {                                    \
            if ((size_t)n >= out_cap) return -1;      \
            out[n] = (char)(byte);                    \
        }                                             \
        n++;                                          \
    } while (0)

    for (size_t i = 0; i < units; i++) {
        uint32_t u = in[i];
        if (u == 0) break;
        if (u >= 0xD800 && u <= 0xDBFF) {
            if (i + 1 >= units) return -1;
            uint32_t lo = in[i + 1];
            if (lo < 0xDC00 || lo > 0xDFFF) return -1;
            u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
            i++;
        } else if (u >= 0xDC00 && u <= 0xDFFF) {
            return -1; /* unpaired low surrogate */
        }

        if (u < 0x80) {
            PUTB(u);
        } else if (u < 0x800) {
            PUTB(0xC0 | (u >> 6));
            PUTB(0x80 | (u & 0x3F));
        } else if (u < 0x10000) {
            PUTB(0xE0 | (u >> 12));
            PUTB(0x80 | ((u >> 6) & 0x3F));
            PUTB(0x80 | (u & 0x3F));
        } else {
            PUTB(0xF0 | (u >> 18));
            PUTB(0x80 | ((u >> 12) & 0x3F));
            PUTB(0x80 | ((u >> 6) & 0x3F));
            PUTB(0x80 | (u & 0x3F));
        }
    }
    if (out) {
        if ((size_t)n >= out_cap) return -1;
        out[n] = '\0';
    }
#undef PUTB
    return n;
}

static uint16_t read_utf16le_unit(const uint8_t* bytes) {
    return (uint16_t)((uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8));
}

/* Validate a complete CF_UNICODETEXT payload without allocating. Length is
 * checked before touching `data`, including for SIZE_MAX supplied by tests, so
 * no multiply/add can wrap into an apparently small allocation. */
static BOOL validate_clipboard_payload(const uint8_t* data, size_t bytes) {
    if (bytes < sizeof(uint16_t) ||
        bytes > (size_t)ZEPHYR_RDP_MAX_CLIPBOARD_UTF16_BYTES ||
        (bytes % sizeof(uint16_t)) != 0 || !data)
        return FALSE;

    if (read_utf16le_unit(data + bytes - sizeof(uint16_t)) != 0) return FALSE;

    const size_t text_bytes = bytes - sizeof(uint16_t);
    for (size_t offset = 0; offset < text_bytes; offset += sizeof(uint16_t)) {
        uint16_t unit = read_utf16le_unit(data + offset);
        if (unit == 0) return FALSE; /* embedded NUL / ignored trailing data */
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (text_bytes - offset < 2u * sizeof(uint16_t)) return FALSE;
            uint16_t low = read_utf16le_unit(data + offset + sizeof(uint16_t));
            if (low < 0xDC00 || low > 0xDFFF) return FALSE;
            offset += sizeof(uint16_t);
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            return FALSE;
        }
    }
    return TRUE;
}

/* Exposed for the test suite: proves the converters round-trip real payloads
 * (CJK, emoji, surrogate pairs) instead of assuming they do. */
int32_t zephyr_rdp_utf_roundtrip(const char* in, char* out, size_t out_cap) {
    long units = utf8_to_utf16le(in, NULL, 0);
    if (units < 0) return -1;
    uint16_t* mid = (uint16_t*)calloc((size_t)units, sizeof(uint16_t));
    if (!mid) return -1;
    long w = utf8_to_utf16le(in, mid, (size_t)units);
    if (w < 0) {
        free(mid);
        return -1;
    }
    long r = utf16le_to_utf8(mid, (size_t)w, out, out_cap);
    free(mid);
    return r < 0 ? -1 : (int32_t)r;
}

/* ── frame emission ───────────────────────────────────────────────────────── */

/*
 * Pack one damage rect out of the GDI primary buffer and hand it up.
 *
 * The GDI buffer is BGRA with an arbitrary stride; the host wants tightly
 * packed RGBA (what a browser ImageData expects). Doing both the stride
 * compaction and the channel swap here means the host never needs to know the
 * GDI layout, and the WebView never spends CPU on a per-pixel swizzle.
 *
 * The R/B swap is asserted against a real session by the pixel-truth test
 * rather than trusted from the PIXEL_FORMAT_* naming.
 */
static void emit_rect(zephyr_rdp_session* s, rdpGdi* gdi, int32_t x, int32_t y,
                      int32_t w, int32_t h) {
    if (!s || !s->frame_cb || !gdi || !gdi->primary_buffer) return;
    if (w <= 0 || h <= 0) return;

    /* Clamp: a server may invalidate outside the current surface across a
     * resize, and trusting it would read past the buffer. */
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x >= gdi->width || y >= gdi->height) return;
    if (x + w > gdi->width) w = gdi->width - x;
    if (y + h > gdi->height) h = gdi->height - y;
    if (w <= 0 || h <= 0) return;

    size_t need = (size_t)w * (size_t)h * 4u;
    if (need > s->pack_cap) {
        uint8_t* grown = (uint8_t*)realloc(s->pack, need);
        if (!grown) return;
        s->pack = grown;
        s->pack_cap = need;
    }

    for (int32_t row = 0; row < h; row++) {
        const uint8_t* src =
            gdi->primary_buffer + (size_t)(y + row) * gdi->stride + (size_t)x * 4u;
        uint8_t* dst = s->pack + (size_t)row * (size_t)w * 4u;
        for (int32_t col = 0; col < w; col++) {
            dst[0] = src[2]; /* R ← B */
            dst[1] = src[1]; /* G */
            dst[2] = src[0]; /* B ← R */
            dst[3] = 0xFF;   /* opaque: RDP has no meaningful alpha */
            src += 4;
            dst += 4;
        }
    }
    s->frame_cb(s->user, x, y, w, h, s->pack, need);
}

static BOOL zephyr_begin_paint(rdpContext* context) {
    rdpGdi* gdi = context ? context->gdi : NULL;
    if (!gdi || !gdi->primary || !gdi->primary->hdc || !gdi->primary->hdc->hwnd)
        return FALSE;
    gdi->primary->hdc->hwnd->invalid->null = TRUE;
    gdi->primary->hdc->hwnd->ninvalid = 0;
    return TRUE;
}

static BOOL zephyr_end_paint(rdpContext* context) {
    zephyr_rdp_session* s = owner_of(context);
    rdpGdi* gdi = context ? context->gdi : NULL;
    if (!s || !gdi || !gdi->primary || !gdi->primary->hdc || !gdi->primary->hdc->hwnd)
        return FALSE;

    HGDI_WND hwnd = gdi->primary->hdc->hwnd;
    INT32 ninvalid = hwnd->ninvalid;
    if (ninvalid < 1) return TRUE;

    /* Ship each sub-rect rather than their bounding box: a cursor blink in one
     * corner plus a taskbar clock tick in the other would otherwise repaint the
     * whole screen. */
    for (INT32 i = 0; i < ninvalid; i++) {
        const GDI_RGN* rgn = &hwnd->cinvalid[i];
        emit_rect(s, gdi, rgn->x, rgn->y, rgn->w, rgn->h);
    }

    hwnd->invalid->null = TRUE;
    hwnd->ninvalid = 0;
    return TRUE;
}

static BOOL zephyr_desktop_resize(rdpContext* context) {
    zephyr_rdp_session* s = owner_of(context);
    if (!s || !context->settings) return FALSE;
    UINT32 w = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    if (!gdi_resize(context->gdi, w, h)) return FALSE;
    emit_event(s, ZEPHYR_RDP_EV_RESIZE, (int32_t)w, (int32_t)h, NULL);
    /* The resized surface starts undefined, so force a full repaint instead of
     * leaving the host showing a stretched copy of the old frame. */
    emit_rect(s, context->gdi, 0, 0, (int32_t)w, (int32_t)h);
    return TRUE;
}

/* ── clipboard ────────────────────────────────────────────────────────────── */

static UINT clip_send_format_list(zephyr_rdp_session* s) {
    if (!s->cliprdr || !s->cliprdr->ClientFormatList) return CHANNEL_RC_OK;
    CLIPRDR_FORMAT formats[1];
    CLIPRDR_FORMAT_LIST list;
    memset(formats, 0, sizeof(formats));
    memset(&list, 0, sizeof(list));
    formats[0].formatId = CF_UNICODETEXT;
    formats[0].formatName = NULL;
    CLIP_FLAGS(list) = 0;
    list.numFormats = 1;
    list.formats = formats;
    return s->cliprdr->ClientFormatList(s->cliprdr, &list);
}

static UINT on_monitor_ready(CliprdrClientContext* ctx,
                            const CLIPRDR_MONITOR_READY* ready) {
    (void)ready;
    zephyr_rdp_session* s = (zephyr_rdp_session*)ctx->custom;
    if (!s) return CHANNEL_RC_OK;
    s->cliprdr_ready = TRUE;
    /* Advertise only if we already hold text; otherwise stay silent so the
     * remote clipboard is not clobbered with an empty payload on connect. */
    if (s->clip_pending) return clip_send_format_list(s);
    return CHANNEL_RC_OK;
}

static UINT on_server_capabilities(CliprdrClientContext* ctx,
                                   const CLIPRDR_CAPABILITIES* caps) {
    (void)ctx;
    (void)caps;
    return CHANNEL_RC_OK;
}

/* Server announced formats. Ask for Unicode text if it is on offer. */
static UINT on_server_format_list(CliprdrClientContext* ctx,
                                  const CLIPRDR_FORMAT_LIST* list) {
    zephyr_rdp_session* s = (zephyr_rdp_session*)ctx->custom;
    UINT rc = CHANNEL_RC_OK;

    if (ctx->ClientFormatListResponse) {
        CLIPRDR_FORMAT_LIST_RESPONSE resp;
        memset(&resp, 0, sizeof(resp));
        CLIP_FLAGS(resp) = CB_RESPONSE_OK;
        rc = ctx->ClientFormatListResponse(ctx, &resp);
        if (rc != CHANNEL_RC_OK) return rc;
    }
    if (!s || !ctx->ClientFormatDataRequest) return rc;

    for (UINT32 i = 0; i < list->numFormats; i++) {
        if (list->formats[i].formatId != CF_UNICODETEXT) continue;
        CLIPRDR_FORMAT_DATA_REQUEST req;
        memset(&req, 0, sizeof(req));
        req.requestedFormatId = CF_UNICODETEXT;
        return ctx->ClientFormatDataRequest(ctx, &req);
    }
    return rc;
}

/* Server delivered the text we asked for. */
static UINT on_server_format_data_response(
    CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_RESPONSE* resp) {
    zephyr_rdp_session* s = (zephyr_rdp_session*)ctx->custom;
    if (!s || !resp || (CLIP_FLAGS_P(resp) & CB_RESPONSE_FAIL)) return CHANNEL_RC_OK;
    const size_t bytes = (size_t)CLIP_LEN_P(resp);
    if (!validate_clipboard_payload(resp->requestedFormatData, bytes))
        return CHANNEL_RC_OK;

    /* `bytes` is at most 4 MiB, hence representable by the callback's int32.
     * The FreeRDP buffer stays alive for this synchronous callback. Rust makes
     * the sole owned copy after independently checking the same boundary. */
    emit_event(s, ZEPHYR_RDP_EV_CLIPBOARD, (int32_t)bytes, 0,
               (const char*)resp->requestedFormatData);
    return CHANNEL_RC_OK;
}

/* Server wants the text we advertised. */
static UINT on_server_format_data_request(
    CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_REQUEST* req) {
    zephyr_rdp_session* s = (zephyr_rdp_session*)ctx->custom;
    if (!ctx->ClientFormatDataResponse) return CHANNEL_RC_OK;

    CLIPRDR_FORMAT_DATA_RESPONSE resp;
    memset(&resp, 0, sizeof(resp));

    if (!s || !s->clip_pending || !req || req->requestedFormatId != CF_UNICODETEXT) {
        CLIP_FLAGS(resp) = CB_RESPONSE_FAIL;
        return ctx->ClientFormatDataResponse(ctx, &resp);
    }

    long units = utf8_to_utf16le(s->clip_pending, NULL, 0);
    if (units <= 0 ||
        (size_t)units >
            (size_t)ZEPHYR_RDP_MAX_CLIPBOARD_UTF16_BYTES / sizeof(uint16_t)) {
        CLIP_FLAGS(resp) = CB_RESPONSE_FAIL;
        return ctx->ClientFormatDataResponse(ctx, &resp);
    }
    const size_t wide_units = (size_t)units;
    if (wide_units > SIZE_MAX / sizeof(uint16_t)) {
        CLIP_FLAGS(resp) = CB_RESPONSE_FAIL;
        return ctx->ClientFormatDataResponse(ctx, &resp);
    }
    uint16_t* wide = (uint16_t*)calloc(wide_units, sizeof(uint16_t));
    if (!wide) {
        CLIP_FLAGS(resp) = CB_RESPONSE_FAIL;
        return ctx->ClientFormatDataResponse(ctx, &resp);
    }
    long w = utf8_to_utf16le(s->clip_pending, wide, wide_units);
    if (w < 0) {
        free(wide);
        CLIP_FLAGS(resp) = CB_RESPONSE_FAIL;
        return ctx->ClientFormatDataResponse(ctx, &resp);
    }
    CLIP_FLAGS(resp) = CB_RESPONSE_OK;
    CLIP_LEN(resp) = (UINT32)((size_t)w * sizeof(uint16_t));
    resp.requestedFormatData = (const BYTE*)wide;
    UINT rc = ctx->ClientFormatDataResponse(ctx, &resp);
    free(wide);
    return rc;
}

static void bind_cliprdr(zephyr_rdp_session* s, CliprdrClientContext* ctx) {
    s->cliprdr = ctx;
    ctx->custom = s;
    ctx->MonitorReady = on_monitor_ready;
    ctx->ServerCapabilities = on_server_capabilities;
    ctx->ServerFormatList = on_server_format_list;
    ctx->ServerFormatDataRequest = on_server_format_data_request;
    ctx->ServerFormatDataResponse = on_server_format_data_response;
}

/* ── channel wiring ──────────────────────────────────────────────────────── */

static void on_channel_connected(void* context, Z_EVENT_CONST ChannelConnectedEventArgs* e) {
    rdpContext* ctx = (rdpContext*)context;
    zephyr_rdp_session* s = owner_of(ctx);
    if (!s || !e || !e->name) return;

    if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        bind_cliprdr(s, (CliprdrClientContext*)e->pInterface);
    } else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        s->disp = (DispClientContext*)e->pInterface;
    } else {
        /* The common client's fallback is what wires RDPGFX into the GDI
         * pipeline (gdi_graphics_pipeline_init on rdpgfx). Without it the
         * channel negotiates up, the server sends every frame as GFX PDUs,
         * and the GDI primary buffer never receives a single pixel: connect
         * succeeds, EndPaint sees ninvalid == 0 forever, and the host times
         * out waiting for the first frame. Every official client (SDL, X11,
         * iOS) ends its handler with this exact fallback for the channels it
         * does not claim itself. */
        freerdp_client_OnChannelConnectedEventHandler(context, e);
    }
    /* rdpdr/drive needs no client-side context: the drive addin services IRPs
     * against the mapped path on its own thread once the channel is up. */
    emit_event(s, ZEPHYR_RDP_EV_CHANNEL, 0, 0, e->name);
}

static void on_channel_disconnected(void* context, Z_EVENT_CONST ChannelDisconnectedEventArgs* e) {
    rdpContext* ctx = (rdpContext*)context;
    zephyr_rdp_session* s = owner_of(ctx);
    if (!s || !e || !e->name) return;
    if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        s->cliprdr = NULL;
        s->cliprdr_ready = FALSE;
    } else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        s->disp = NULL;
    } else {
        /* Symmetric with the connect path: the common fallback uninitializes
         * the GFX pipeline (gdi_graphics_pipeline_uninit) so a reconnect does
         * not double-register the surface-update callbacks. */
        freerdp_client_OnChannelDisconnectedEventHandler(context, e);
    }
}

/* ── instance callbacks ──────────────────────────────────────────────────── */

/*
 * The helper is a non-interactive child process: credentials are already in
 * rdpSettings, so a console prompt can never succeed. FreeRDP 3 invokes
 * AuthenticateEx even for an intentionally empty username/password (for
 * example an /sec:rdp shadow session); without a callback its common-client
 * fallback calls freerdp_passphrase_read(), sees non-interactive stdin, and
 * aborts with ERRCONNECT_CONNECT_CANCELLED. Returning TRUE while leaving the
 * supplied strings untouched means "use exactly the configured credentials",
 * including a deliberately empty credential set.
 */
#if FREERDP_VERSION_MAJOR >= 3
static BOOL zephyr_authenticate(freerdp* instance, char** username, char** password,
                                char** domain, rdp_auth_reason reason) {
    (void)instance; (void)username; (void)password; (void)domain; (void)reason;
    return TRUE;
}
#else
static BOOL zephyr_authenticate(freerdp* instance, char** username, char** password,
                                char** domain) {
    (void)instance; (void)username; (void)password; (void)domain;
    return TRUE;
}
#endif

static BOOL zephyr_pre_connect(freerdp* instance) {
    rdpContext* context = instance->context;
    zephyr_rdp_session* s = owner_of(context);
    if (!s) return FALSE;

    /* This is what turns RedirectDrives / AudioPlayback / RedirectClipboard
     * from inert settings into loaded channel addins. Without it the drive
     * would be "configured" and still never appear in the session. */
    if (!freerdp_client_load_addins(context->channels, context->settings))
        return FALSE;

    PubSub_SubscribeChannelConnected(context->pubSub, on_channel_connected);
    PubSub_SubscribeChannelDisconnected(context->pubSub, on_channel_disconnected);
    return TRUE;
}

static BOOL zephyr_post_connect(freerdp* instance) {
    rdpContext* context = instance->context;
    zephyr_rdp_session* s = owner_of(context);
    if (!s) return FALSE;

    /* FreeRDP already rejects protocols disabled in rdpSettings. Recheck the
     * negotiated wire value before initializing graphics so a future library
     * regression, or a server response that selects protocol 0, still fails
     * closed at Zephyr's own trust boundary. */
    UINT32 selected_protocol =
        freerdp_settings_get_uint32(context->settings, FreeRDP_SelectedProtocol);
    if (!security_protocol_allowed(&s->cfg, selected_protocol)) {
        emit_event(s, ZEPHYR_RDP_EV_ERROR, (int32_t)selected_protocol, 0,
                   "insecure RDP security negotiation rejected");
        return FALSE;
    }

    /* BGRA32 is the format every shipped FreeRDP client uses, so it is the
     * best-tested path through the GDI/codec layers. emit_rect() converts to
     * RGBA for the WebView. */
    if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) return FALSE;

    context->update->BeginPaint = zephyr_begin_paint;
    context->update->EndPaint = zephyr_end_paint;
    context->update->DesktopResize = zephyr_desktop_resize;

    s->connected = TRUE;
    UINT32 w = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    UINT32 h = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    emit_event(s, ZEPHYR_RDP_EV_CONNECTED, (int32_t)w, (int32_t)h, NULL);
    return TRUE;
}

static void zephyr_post_disconnect(freerdp* instance) {
    rdpContext* context = instance->context;
    zephyr_rdp_session* s = owner_of(context);
    if (s) s->connected = FALSE;
    gdi_free(instance);
}

/*
 * Certificate trust. Returning 2 means "accept and remember"; 1 means "accept
 * for this session only". The decision is made by the caller through
 * ignore_certificate rather than by prompting: there is no UI thread here, and
 * silently defaulting to accept would remove the only MITM check.
 */
static DWORD zephyr_verify_certificate_ex(freerdp* instance, const char* host,
                                          UINT16 port, const char* common_name,
                                          const char* subject, const char* issuer,
                                          const char* fingerprint, DWORD flags) {
    (void)host;
    (void)port;
    (void)common_name;
    (void)subject;
    (void)issuer;
    (void)flags;
    zephyr_rdp_session* s = owner_of(instance->context);
    if (!s) return 0;
    emit_event(s, ZEPHYR_RDP_EV_LOG, 0, 0, fingerprint);
    return s->cfg.ignore_certificate ? 1 : 0;
}

static DWORD zephyr_verify_changed_certificate_ex(
    freerdp* instance, const char* host, UINT16 port, const char* common_name,
    const char* subject, const char* issuer, const char* fingerprint,
    const char* old_subject, const char* old_issuer, const char* old_fingerprint,
    DWORD flags) {
    (void)host; (void)port; (void)common_name; (void)subject; (void)issuer;
    (void)fingerprint; (void)old_subject; (void)old_issuer; (void)old_fingerprint;
    (void)flags;
    zephyr_rdp_session* s = owner_of(instance->context);
    if (!s) return 0;
    /* A *changed* certificate is the MITM signal, so it is only accepted when
     * the caller explicitly opted out of verification. */
    return s->cfg.ignore_certificate ? 1 : 0;
}

static BOOL zephyr_client_new(freerdp* instance, rdpContext* context) {
    (void)context;
#if FREERDP_VERSION_MAJOR >= 3
    instance->AuthenticateEx = zephyr_authenticate;
#else
    instance->Authenticate = zephyr_authenticate;
#endif
    instance->PreConnect = zephyr_pre_connect;
    instance->PostConnect = zephyr_post_connect;
    instance->PostDisconnect = zephyr_post_disconnect;
    instance->VerifyCertificateEx = zephyr_verify_certificate_ex;
    instance->VerifyChangedCertificateEx = zephyr_verify_changed_certificate_ex;
    return TRUE;
}

static void zephyr_client_free(freerdp* instance, rdpContext* context) {
    (void)instance;
    (void)context;
}

static int zephyr_client_start(rdpContext* context) {
    (void)context;
    return 0;
}

static int zephyr_client_stop(rdpContext* context) {
    (void)context;
    return 0;
}

static void fill_entry_points(RDP_CLIENT_ENTRY_POINTS* ep) {
    memset(ep, 0, sizeof(*ep));
    ep->Size = sizeof(*ep);
    ep->Version = RDP_CLIENT_INTERFACE_VERSION;
    ep->ContextSize = sizeof(zephyr_client_context);
    ep->ClientNew = zephyr_client_new;
    ep->ClientFree = zephyr_client_free;
    ep->ClientStart = zephyr_client_start;
    ep->ClientStop = zephyr_client_stop;
    ep->settings = NULL;
}


/* ── settings assembly ────────────────────────────────────────────────────
 *
 * Split out of zephyr_rdp_new so zephyr_rdp_probe_* can exercise *this exact
 * function* rather than a reimplementation. A probe that duplicated the logic
 * could agree with itself while disagreeing with production.
 */
static BOOL apply_config(rdpSettings* settings, const zephyr_rdp_config* cfg) {
    if (!settings || !cfg) return FALSE;

    /* AUTO is an ABI/UI compatibility spelling for the same NLA-only policy.
     * TLS-only, Standard RDP Security, and unknown values are rejected before
     * credentials are copied into the FreeRDP settings object. */
    if (!security_mode_supported(cfg)) return FALSE;

    if (!freerdp_settings_set_string(settings, FreeRDP_ServerHostname,
                                     cfg->host ? cfg->host : ""))
        return FALSE;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_ServerPort,
                                     cfg->port ? cfg->port : 3389))
        return FALSE;
    if (cfg->username && *cfg->username &&
        !freerdp_settings_set_string(settings, FreeRDP_Username, cfg->username))
        return FALSE;
    if (cfg->password && *cfg->password &&
        !freerdp_settings_set_string(settings, FreeRDP_Password, cfg->password))
        return FALSE;
    if (cfg->domain && *cfg->domain &&
        !freerdp_settings_set_string(settings, FreeRDP_Domain, cfg->domain))
        return FALSE;

    UINT32 w = cfg->width ? cfg->width : 1920;
    UINT32 h = cfg->height ? cfg->height : 1080;
    /* RDP encodes desktop dimensions as UINT16 and Windows rejects odd widths
     * on some codec paths, so clamp and round here rather than letting the
     * server drop the connect request. */
    if (w < 200) w = 200;
    if (h < 200) h = 200;
    if (w > 8192) w = 8192;
    if (h > 8192) h = 8192;
    w &= ~1u;
    h &= ~1u;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, w)) return FALSE;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, h)) return FALSE;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth,
                                     cfg->color_depth ? cfg->color_depth : 32))
        return FALSE;

    /* Software GDI: the framebuffer must live in a buffer this process can read
     * and forward. A hardware/X11 path would draw into a window we do not have. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE)) return FALSE;

    /* NLA is the sole offered authentication protocol regardless of whether
     * the password is empty. TlsSecurity means TLS *without* CredSSP in
     * FreeRDP, so it must stay disabled even though NLA itself uses TLS as its
     * transport. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, TRUE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_UseRdpSecurityLayer, FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_NegotiateSecurityLayer, TRUE))
        return FALSE;

    if (cfg->ignore_certificate) {
        if (!freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE))
            return FALSE;
    }

    /* ── audio ──
     * LOCAL  → rdpsnd with an OS backend (winmm / CoreAudio / ALSA-PulseAudio).
     *          FreeRDP plays it directly; no browser audio path is involved,
     *          which is why dropping the WASM pipeline is not a regression.
     * REMOTE → no rdpsnd channel; the server keeps the sound locally to itself.
     * OFF    → same as REMOTE from the wire's point of view, but recorded
     *          separately so the UI's three-way choice round-trips. */
    BOOL playback = (cfg->audio_mode == ZEPHYR_RDP_AUDIO_LOCAL);
    if (!freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, playback))
        return FALSE;
    if (!freerdp_settings_set_bool(settings, FreeRDP_AudioCapture,
                                   cfg->microphone ? TRUE : FALSE))
        return FALSE;

    const BOOL clipboard =
        (cfg->clipboard && ZEPHYR_RDP_SAFE_CLIPRDR) ? TRUE : FALSE;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, clipboard))
        return FALSE;
    if (clipboard &&
        !freerdp_settings_set_uint32(
            settings, FreeRDP_ClipboardFeatureMask,
            CLIPRDR_FLAG_LOCAL_TO_REMOTE | CLIPRDR_FLAG_REMOTE_TO_LOCAL))
        return FALSE;

    /* ── folder mapping (RDPDR drive redirection) ──
     *
     * freerdp_client_add_device_channel is the same entry point xfreerdp's
     * `/drive:name,path` uses, so the resulting device is byte-identical to a
     * mapping made by the reference client. Doing it through the documented
     * helper rather than hand-building an RDPDR_DRIVE also means FreeRDP owns
     * the allocation lifetime.
     *
     * Read-only is *not* an RDPDR concept: MS-RDPEFS has no read-only flag, and
     * FreeRDP's drive addin honours the filesystem. Enforcing it here would be
     * a lie, so the caller is told to enforce it on the directory itself. */
    if (cfg->drive_name && *cfg->drive_name && cfg->drive_path && *cfg->drive_path) {
        if (!freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, TRUE))
            return FALSE;
        if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectDrives, TRUE))
            return FALSE;
#if FREERDP_VERSION_MAJOR >= 3
        const char* params[3] = { "drive", cfg->drive_name, cfg->drive_path };
#else
        char* params[3] = {
            (char*)"drive", (char*)cfg->drive_name, (char*)cfg->drive_path
        };
#endif
        if (!freerdp_client_add_device_channel(settings, 3, params)) return FALSE;
    }

    /* ── display ──
     * The disp dynamic channel is what lets the remote desktop follow a resized
     * tab. DynamicResolutionUpdate additionally requires dynamic channels. */
    if (cfg->dynamic_resolution) {
        if (!freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE) ||
            !freerdp_settings_set_bool(settings, FreeRDP_DynamicResolutionUpdate, TRUE) ||
            !freerdp_settings_set_bool(settings, FreeRDP_SupportDynamicChannels, TRUE))
            return FALSE;
    }

    /* ── graphics pipeline ──
     * RDPGFX (with H.264) is a large win on real links, but it is also the
     * codec surface that produced the mosaic/black-block defects in the WASM
     * client. Here decoding is FreeRDP's own, so it is enabled when asked and
     * left off otherwise; the caller decides. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline,
                                   cfg->gfx ? TRUE : FALSE))
        return FALSE;
    if (!cfg->gfx) {
        if (!freerdp_settings_set_bool(settings, FreeRDP_GfxH264, FALSE) ||
            !freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, FALSE))
            return FALSE;
    }

    /* ── codecs ──
     *
     * RemoteFX and NSCodec are deliberately *off* unless the caller asked for
     * the graphics pipeline, matching xfreerdp, where both are opt-in (`/rfx`,
     * `/nsc`). They were briefly forced on here with the rationale that they
     * were "the fallback when the server declines RDPGFX". That rationale was
     * wrong twice over: the real fallback is plain bitmap updates, and forcing
     * them advertises surface-command capabilities this client then has to
     * satisfy.
     *
     * Measured consequence of forcing them, against freerdp-shadow-cli: the
     * server rejected the capability set and the session entered an endless
     * "Deactivate All PDU" loop — freerdp_connect() never returned, so the
     * session hung with no error. The reference client, with the same server and
     * codecs left at their defaults, reached an active session. Turning these
     * off is therefore load-bearing, not a preference.
     *
     * When gfx is requested, RDPGFX carries the codecs on the dynamic channel
     * and these legacy capability flags stay out of the picture.
     */
    if (!freerdp_settings_set_bool(settings, FreeRDP_RemoteFxCodec, FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_NSCodec, FALSE))
        return FALSE;

    if (!freerdp_settings_set_bool(settings, FreeRDP_FastPathInput, TRUE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_FastPathOutput, TRUE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_BitmapCacheEnabled, TRUE))
        return FALSE;

    if (!freerdp_settings_set_bool(settings, FreeRDP_DisableWallpaper,
                                   cfg->disable_wallpaper ? TRUE : FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_DisableThemes,
                                   cfg->disable_themes ? TRUE : FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_DisableMenuAnims,
                                   cfg->disable_menu_anims ? TRUE : FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_DisableFullWindowDrag,
                                   cfg->disable_full_window_drag ? TRUE : FALSE) ||
        !freerdp_settings_set_bool(settings, FreeRDP_AllowFontSmoothing,
                                   cfg->allow_font_smoothing ? TRUE : FALSE))
        return FALSE;

    return TRUE;
}

/* ── folder-mapping validation ─────────────────────────────────────────────
 *
 * This exists because of a behaviour that is easy to miss and expensive to
 * debug: freerdp_client_add_device_channel() *stats the path* and returns
 * FALSE when the directory does not exist. So a mapping pointing at a deleted
 * folder, an unmounted external drive, or a disconnected network share does not
 * degrade to "session without a drive" — it makes the whole session fail to
 * build, with no indication that the folder was the reason.
 *
 * Reproduced directly: the identical config succeeded with drive_path="/tmp"
 * and failed with "/tmp/zephyr-rdp-share" purely because the latter did not
 * exist; creating the directory made it pass with no recompile.
 *
 * Windows deliberately uses GetFileAttributesW with our own UTF-8→UTF-16
 * conversion rather than GetFileAttributesA: the A variant takes *ANSI*, which
 * mangles exactly the non-ASCII folder names this feature is for (选择文件夹).
 */
int32_t zephyr_rdp_validate_drive(const char* drive_name, const char* drive_path) {
    if (!drive_name || !*drive_name) return ZEPHYR_RDP_DRIVE_NO_NAME;
    if (!drive_path || !*drive_path) return ZEPHYR_RDP_DRIVE_NO_PATH;

#ifdef _WIN32
    long units = utf8_to_utf16le(drive_path, NULL, 0);
    if (units < 0) return ZEPHYR_RDP_DRIVE_BAD_NAME;
    uint16_t* wide = (uint16_t*)calloc((size_t)units, sizeof(uint16_t));
    if (!wide) return ZEPHYR_RDP_DRIVE_NOT_FOUND;
    if (utf8_to_utf16le(drive_path, wide, (size_t)units) < 0) {
        free(wide);
        return ZEPHYR_RDP_DRIVE_BAD_NAME;
    }
    DWORD attrs = GetFileAttributesW((LPCWSTR)wide);
    free(wide);
    if (attrs == INVALID_FILE_ATTRIBUTES) return ZEPHYR_RDP_DRIVE_NOT_FOUND;
    if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) return ZEPHYR_RDP_DRIVE_NOT_DIR;
#else
    struct stat st;
    if (stat(drive_path, &st) != 0) return ZEPHYR_RDP_DRIVE_NOT_FOUND;
    if (!S_ISDIR(st.st_mode)) return ZEPHYR_RDP_DRIVE_NOT_DIR;
#endif

    /* The share name travels to the remote Explorer, where a path separator
     * would be interpreted rather than displayed. Reject instead of silently
     * rewriting, so the caller can report which name was refused. */
    for (const char* p = drive_name; *p; p++) {
        if (*p == '/' || *p == '\\' || *p == ':') return ZEPHYR_RDP_DRIVE_BAD_NAME;
    }
    if (utf8_to_utf16le(drive_name, NULL, 0) < 0) return ZEPHYR_RDP_DRIVE_BAD_NAME;

    return ZEPHYR_RDP_DRIVE_OK;
}

/* ── construction ─────────────────────────────────────────────────────────── */

static void clear_freerdp_password(zephyr_rdp_session* s) {
    if (!s || !s->context || !s->context->settings) return;

    const char* password = freerdp_settings_get_string(
        s->context->settings, FreeRDP_Password);
    if (!password) return;

    const size_t len = strlen(password);
    (void)SecureZeroMemory((void*)password, len);
#ifdef ZEPHYR_RDP_TESTING
    zrdp_test_record_password_wipe(password, len, TRUE);
#endif
    /* Release FreeRDP's owned copy now. Its generated teardown currently uses
     * ordinary memset, which does not provide the same optimization-resistant
     * guarantee as SecureZeroMemory. */
    (void)freerdp_settings_set_string(s->context->settings, FreeRDP_Password,
                                      NULL);
}

static void destroy_session(zephyr_rdp_session* s) {
    if (!s) return;

    if (s->context) {
        clear_freerdp_password(s);
        freerdp_client_context_free(s->context);
        s->context = NULL;
        s->instance = NULL;
#ifdef ZEPHYR_RDP_TESTING
        ZRDP_TEST_TRACK_RELEASE(zrdp_test_live_contexts);
#endif
    }
    if (s->wake) {
        CloseHandle(s->wake);
        s->wake = NULL;
#ifdef ZEPHYR_RDP_TESTING
        ZRDP_TEST_TRACK_RELEASE(zrdp_test_live_wakes);
#endif
    }

    /* No producer may race free (the public contract requires run to have
     * returned), so the remaining owned queue payloads can be drained before
     * deleting the lock. */
    while (s->q_count > 0) {
        free(s->queue[s->q_head].text);
        s->queue[s->q_head].text = NULL;
        s->q_head = (s->q_head + 1) % ZQ_CAPACITY;
        s->q_count--;
    }
    if (s->lock_initialized) {
        DeleteCriticalSection(&s->lock);
        s->lock_initialized = FALSE;
#ifdef ZEPHYR_RDP_TESTING
        ZRDP_TEST_TRACK_RELEASE(zrdp_test_live_locks);
#endif
    }

    free(s->clip_pending);
    free(s->pack);
    free_config_string(&s->own_host);
    free_config_string(&s->own_user);
#ifdef ZEPHYR_RDP_TESTING
    zrdp_test_wiping_owned_password = TRUE;
#endif
    free_config_string(&s->own_pass);
#ifdef ZEPHYR_RDP_TESTING
    zrdp_test_wiping_owned_password = FALSE;
#endif
    free_config_string(&s->own_domain);
    free_config_string(&s->own_drive_name);
    free_config_string(&s->own_drive_path);
#ifdef ZEPHYR_RDP_TESTING
    ZRDP_TEST_TRACK_RELEASE(zrdp_test_live_sessions);
#endif
    free(s);
}

zephyr_rdp_session* zephyr_rdp_new(const zephyr_rdp_config* cfg,
                                   zephyr_rdp_frame_cb frame_cb,
                                   zephyr_rdp_event_cb event_cb, void* user) {
    /* Refuse legacy/invalid modes before allocating or copying credentials. */
    if (!cfg || !security_mode_supported(cfg)) return NULL;

    zephyr_rdp_session* s = (zephyr_rdp_session*)calloc(1, sizeof(*s));
    if (!s) return NULL;
#ifdef ZEPHYR_RDP_TESTING
    ZRDP_TEST_TRACK_ACQUIRE(zrdp_test_live_sessions);
#endif
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_HOST)) goto fail;

    s->frame_cb = frame_cb;
    s->event_cb = event_cb;
    s->user = user;
    s->cfg = *cfg;

    /* Own every string. The caller's pointers may be freed the moment this
     * returns, but FreeRDP reads drive_name/drive_path during PreConnect. */
    if (!copy_config_string(cfg->host, &s->own_host)) goto fail;
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_USERNAME)) goto fail;
    if (!copy_config_string(cfg->username, &s->own_user)) goto fail;
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_PASSWORD)) goto fail;
    if (!copy_config_string(cfg->password, &s->own_pass)) goto fail;
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_DOMAIN)) goto fail;
    if (!copy_config_string(cfg->domain, &s->own_domain)) goto fail;
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_DRIVE_NAME)) goto fail;
    if (!copy_config_string(cfg->drive_name, &s->own_drive_name)) goto fail;
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_DRIVE_PATH)) goto fail;
    if (!copy_config_string(cfg->drive_path, &s->own_drive_path)) goto fail;
    s->cfg.host = s->own_host;
    s->cfg.username = s->own_user;
    s->cfg.password = s->own_pass;
    s->cfg.domain = s->own_domain;
    s->cfg.drive_name = s->own_drive_name;
    s->cfg.drive_path = s->own_drive_path;

    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_LOCK) ||
        !InitializeCriticalSectionAndSpinCount(&s->lock, 4000))
        goto fail;
    s->lock_initialized = TRUE;
#ifdef ZEPHYR_RDP_TESTING
    ZRDP_TEST_TRACK_ACQUIRE(zrdp_test_live_locks);
#endif
    /* Manual-reset, drained explicitly by the loop.
     *
     * An auto-reset event would be the natural choice, but WinPR on POSIX logs
     * "auto-reset events not yet implemented" and silently degrades to
     * manual-reset behaviour (verified against WinPR 2.11.7 on musl/aarch64).
     * A handle that stays signalled makes WaitForMultipleObjects return
     * immediately forever, turning the session loop into a busy spin.
     *
     * Asking for manual-reset and calling ResetEvent ourselves is not a
     * workaround for one platform: it is the same behaviour on real Windows, so
     * there is one code path rather than two. */
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_WAKE)) goto fail;
    s->wake = CreateEvent(NULL, TRUE, FALSE, NULL);
    if (!s->wake) goto fail;
#ifdef ZEPHYR_RDP_TESTING
    ZRDP_TEST_TRACK_ACQUIRE(zrdp_test_live_wakes);
#endif

    RDP_CLIENT_ENTRY_POINTS ep;
    fill_entry_points(&ep);
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_CONTEXT)) goto fail;
    rdpContext* context = freerdp_client_context_new(&ep);
    if (!context) goto fail;

    /* Set before freerdp_connect so every callback can find the session. The
     * ClientNew callback already ran inside context_new, but it only installs
     * function pointers and never dereferences owner. */
    ((zephyr_client_context*)context)->owner = s;
    s->context = context;
    s->instance = context->instance;
#ifdef ZEPHYR_RDP_TESTING
    ZRDP_TEST_TRACK_ACQUIRE(zrdp_test_live_contexts);
#endif

    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_CONFIG)) goto fail;
    if (!apply_config(context->settings, &s->cfg)) goto fail;
    if (ZRDP_TEST_FAIL_NOW(ZEPHYR_RDP_TEST_FAIL_READY)) goto fail;

    return s;

fail:
    destroy_session(s);
    return NULL;
}

/* ── input queue ──────────────────────────────────────────────────────────── */

static void enqueue(zephyr_rdp_session* s, int kind, uint16_t a, uint16_t b,
                    uint16_t c, uint32_t d, char* text) {
    if (!s) {
        free(text);
        return;
    }
    EnterCriticalSection(&s->lock);
    if (s->q_count == ZQ_CAPACITY) {
        /* Drop oldest; free its payload so overflow cannot leak. */
        zq_item* victim = &s->queue[s->q_head];
        free(victim->text);
        s->q_head = (s->q_head + 1) % ZQ_CAPACITY;
        s->q_count--;
        s->q_dropped++;
    }
    int slot = (s->q_head + s->q_count) % ZQ_CAPACITY;
    s->queue[slot].kind = kind;
    s->queue[slot].a = a;
    s->queue[slot].b = b;
    s->queue[slot].c = c;
    s->queue[slot].d = d;
    s->queue[slot].text = text;
    s->q_count++;
    LeaveCriticalSection(&s->lock);
    SetEvent(s->wake);
}

void zephyr_rdp_send_mouse(zephyr_rdp_session* s, uint16_t flags, uint16_t x,
                           uint16_t y) {
    enqueue(s, ZQ_MOUSE, flags, x, y, 0, NULL);
}
void zephyr_rdp_send_mouse_ex(zephyr_rdp_session* s, uint16_t flags, uint16_t x,
                              uint16_t y) {
    enqueue(s, ZQ_MOUSE_EX, flags, x, y, 0, NULL);
}
void zephyr_rdp_send_scancode(zephyr_rdp_session* s, uint16_t flags, uint16_t code) {
    enqueue(s, ZQ_SCANCODE, flags, code, 0, 0, NULL);
}
void zephyr_rdp_send_unicode(zephyr_rdp_session* s, uint16_t flags, uint16_t code) {
    enqueue(s, ZQ_UNICODE, flags, code, 0, 0, NULL);
}
void zephyr_rdp_send_sync(zephyr_rdp_session* s, uint32_t toggle_flags) {
    enqueue(s, ZQ_SYNC, 0, 0, 0, toggle_flags, NULL);
}
void zephyr_rdp_request_full_frame(zephyr_rdp_session* s) {
    enqueue(s, ZQ_FULLFRAME, 0, 0, 0, 0, NULL);
}
void zephyr_rdp_resize(zephyr_rdp_session* s, uint32_t width, uint32_t height) {
    enqueue(s, ZQ_RESIZE, (uint16_t)width, (uint16_t)height, 0, 0, NULL);
}
void zephyr_rdp_set_clipboard(zephyr_rdp_session* s, const char* utf8) {
    enqueue(s, ZQ_CLIPBOARD, 0, 0, 0, 0, dup_clipboard_or_null(utf8));
}

/* ── loop-thread side effects for queued non-input items ─────────────────────
 *
 * These three are the landing points for ZQ_FULLFRAME / ZQ_RESIZE /
 * ZQ_CLIPBOARD. They live here, below the queue accessors and above
 * drain_input, because they must only ever run on the loop thread: two of them
 * touch FreeRDP channel contexts, which are not reentrant.
 */

/* Repaint everything currently in the framebuffer.
 *
 * Used when a tab is re-attached: the WebView canvas was thrown away, but the
 * server has no reason to resend a screen that did not change, so without this
 * the user stares at an empty canvas until something moves on the remote side. */
static void emit_full_frame(zephyr_rdp_session* s) {
    if (!s || !s->context) return;
    rdpGdi* gdi = s->context->gdi;
    if (!gdi || !gdi->primary_buffer) return;
    emit_rect(s, gdi, 0, 0, gdi->width, gdi->height);
}

/* Live resize through the disp dynamic channel (MS-RDPEDISP).
 *
 * No-op when the server never brought the channel up, which is the honest
 * outcome: without disp, the desktop size was fixed at connect time and the
 * only way to change it is to reconnect. Silently doing nothing here is
 * therefore correct, and the host learns the real size from EV_RESIZE, which
 * only fires when the server actually resizes. */
static void send_monitor_layout(zephyr_rdp_session* s, uint32_t width,
                                uint32_t height) {
    if (!s || !s->disp || !s->disp->SendMonitorLayout) return;

    /* MS-RDPEDISP constrains monitor dimensions and requires an even width.
     * Sending an out-of-range layout makes the server reject the PDU outright,
     * so clamping here is what keeps a small tab from killing the resize. */
    if (width < DISPLAY_CONTROL_MIN_MONITOR_WIDTH) width = DISPLAY_CONTROL_MIN_MONITOR_WIDTH;
    if (height < DISPLAY_CONTROL_MIN_MONITOR_HEIGHT) height = DISPLAY_CONTROL_MIN_MONITOR_HEIGHT;
    if (width > DISPLAY_CONTROL_MAX_MONITOR_WIDTH) width = DISPLAY_CONTROL_MAX_MONITOR_WIDTH;
    if (height > DISPLAY_CONTROL_MAX_MONITOR_HEIGHT) height = DISPLAY_CONTROL_MAX_MONITOR_HEIGHT;
    width &= ~1u;

    DISPLAY_CONTROL_MONITOR_LAYOUT layout;
    memset(&layout, 0, sizeof(layout));
    layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Left = 0;
    layout.Top = 0;
    layout.Width = width;
    layout.Height = height;
    /* Physical size 0 means "unspecified", which is what a browser canvas
     * genuinely is — inventing millimetres would make the remote DPI wrong. */
    layout.PhysicalWidth = 0;
    layout.PhysicalHeight = 0;
    layout.Orientation = ORIENTATION_LANDSCAPE;
    layout.DesktopScaleFactor = 100;
    layout.DeviceScaleFactor = 100;
    s->disp->SendMonitorLayout(s->disp, 1, &layout);
}

/* Take local clipboard text and offer it to the remote session.
 *
 * The text is only *advertised* here; the payload is handed over later, when
 * the server answers with a FormatDataRequest (that is the cliprdr handshake,
 * not an optimisation). `clip_pending` therefore has to outlive this call,
 * hence the copy — `text` belongs to the queue item and is freed by
 * drain_input as soon as this returns. */
static void set_local_clipboard(zephyr_rdp_session* s, const char* text) {
    if (!s) return;
    char* copy = dup_clipboard_or_null(text);
    free(s->clip_pending);
    s->clip_pending = copy;
    if (!copy) return;
    if (s->cliprdr_ready) clip_send_format_list(s);
}

/* Runs on the loop thread only. */
static void drain_input(zephyr_rdp_session* s) {
    for (;;) {
        zq_item item;
        EnterCriticalSection(&s->lock);
        if (s->q_count == 0) {
            LeaveCriticalSection(&s->lock);
            return;
        }
        item = s->queue[s->q_head];
        s->queue[s->q_head].text = NULL; /* ownership moves to `item` */
        s->q_head = (s->q_head + 1) % ZQ_CAPACITY;
        s->q_count--;
        LeaveCriticalSection(&s->lock);

        rdpInput* input = s->context ? s->context->input : NULL;
        switch (item.kind) {
            case ZQ_MOUSE:
                if (input) freerdp_input_send_mouse_event(input, item.a, item.b, item.c);
                break;
            case ZQ_MOUSE_EX:
                if (input)
                    freerdp_input_send_extended_mouse_event(input, item.a, item.b, item.c);
                break;
            case ZQ_SCANCODE:
                if (input) freerdp_input_send_keyboard_event(input, item.a, item.b);
                break;
            case ZQ_UNICODE:
                if (input) freerdp_input_send_unicode_keyboard_event(input, item.a, item.b);
                break;
            case ZQ_SYNC:
                if (input) freerdp_input_send_synchronize_event(input, item.d);
                break;
            case ZQ_FULLFRAME:
                emit_full_frame(s);
                break;
            case ZQ_RESIZE:
                send_monitor_layout(s, item.a, item.b);
                break;
            case ZQ_CLIPBOARD:
                set_local_clipboard(s, item.text);
                break;
            default:
                break;
        }
        free(item.text);
    }
}

/* ── run loop ─────────────────────────────────────────────────────────────── */

int32_t zephyr_rdp_run(zephyr_rdp_session* s) {
    if (!s || !s->instance) return -1;

    if (!freerdp_connect(s->instance)) {
        UINT32 code = freerdp_get_last_error(s->context);
        const char* text = freerdp_get_last_error_string(code);
        emit_event(s, ZEPHYR_RDP_EV_ERROR, (int32_t)code, 0, text);
        return code ? (int32_t)code : -1;
    }

    int32_t rc = 0;
    while (!session_is_stopping(s)) {
        HANDLE handles[64];
        /* Slot 0 is the input wake event so queued input is serviced in the
         * same iteration it arrives, instead of waiting out a poll interval. */
        handles[0] = s->wake;
        DWORD count = freerdp_get_event_handles(s->context, &handles[1], 63);
        if (count == 0) {
            emit_event(s, ZEPHYR_RDP_EV_ERROR, 0, 0, "freerdp_get_event_handles failed");
            rc = -1;
            break;
        }

        /* The 100 ms cap is a liveness floor, not the input path: it bounds how
         * long a stop request can sit unnoticed if no handle ever signals. */
        DWORD status = WaitForMultipleObjects(count + 1, handles, FALSE, 100);
        if (status == WAIT_FAILED) {
            emit_event(s, ZEPHYR_RDP_EV_ERROR, 0, 0, "WaitForMultipleObjects failed");
            rc = -1;
            break;
        }

        if (session_is_stopping(s)) break;

        /* Reset *before* draining, not after. If an enqueue lands between the
         * drain and the reset, resetting afterwards would erase its SetEvent
         * and that input would sit in the queue until the 100 ms timeout fires.
         * Resetting first means a racing enqueue leaves the handle signalled and
         * the next wait returns immediately. */
        ResetEvent(s->wake);
        drain_input(s);

        if (!freerdp_check_event_handles(s->context)) {
            if (freerdp_get_last_error(s->context) == FREERDP_ERROR_SUCCESS) {
                /* Clean server-side disconnect. */
                break;
            }
            UINT32 code = freerdp_get_last_error(s->context);
            emit_event(s, ZEPHYR_RDP_EV_ERROR, (int32_t)code, 0,
                       freerdp_get_last_error_string(code));
            rc = (int32_t)code;
            break;
        }

#if FREERDP_VERSION_MAJOR >= 3
        if (freerdp_shall_disconnect_context(s->context)) break;
#else
        if (freerdp_shall_disconnect(s->instance)) break;
#endif
    }

    freerdp_disconnect(s->instance);
    emit_event(s, ZEPHYR_RDP_EV_DISCONNECTED, rc, 0, NULL);
    return rc;
}

void zephyr_rdp_stop(zephyr_rdp_session* s) {
    if (!s) return;
    session_request_stop(s);
    /* Breaks a connect that is still in TLS/NLA negotiation, where the loop has
     * not started and SetEvent alone would not be observed. */
    if (s->instance) {
#if FREERDP_VERSION_MAJOR >= 3
        freerdp_abort_connect_context(s->context);
#else
        freerdp_abort_connect(s->instance);
#endif
    }
    if (s->wake) SetEvent(s->wake);
}

void zephyr_rdp_free(zephyr_rdp_session* s) {
    destroy_session(s);
}

/* ── introspection ───────────────────────────────────────────────────────── */

int32_t zephyr_rdp_freerdp_major(void) { return FREERDP_VERSION_MAJOR; }

int32_t zephyr_rdp_clipboard_available(void) {
    return ZEPHYR_RDP_SAFE_CLIPRDR;
}

intptr_t zephyr_rdp_isolate_stdout(void) {
#ifdef _WIN32
    /* _dup returns a CRT descriptor; the caller needs the OS HANDLE, because
     * that is what Rust's FromRawHandle takes. */
    int saved = _dup(1);
    if (saved < 0) return -1;
    if (_dup2(2, 1) < 0) {
        _close(saved);
        return -1;
    }
    intptr_t handle = _get_osfhandle(saved);
    if (handle == -1) {
        _close(saved);
        return -1;
    }
    /* Deliberately not _close(saved): that would close the OS handle just
     * returned. The CRT slot leaks for the process lifetime, which is the
     * correct trade for not handing back a dangling handle. */
    return handle;
#else
    int saved = dup(1);
    if (saved < 0) return -1;
    if (dup2(2, 1) < 0) {
        close(saved);
        return -1;
    }
    /* Keep the protocol channel out of any child process: a helper spawned by
     * a FreeRDP addin must not be able to write frames. */
    int flags = fcntl(saved, F_GETFD);
    if (flags != -1) fcntl(saved, F_SETFD, flags | FD_CLOEXEC);
    return (intptr_t)saved;
#endif
}

int32_t zephyr_rdp_config_layout(int32_t selector) {
#define OFF(field) ((int32_t)offsetof(zephyr_rdp_config, field))
    switch (selector) {
        case ZEPHYR_RDP_LAYOUT_SIZEOF: return (int32_t)sizeof(zephyr_rdp_config);
        case ZEPHYR_RDP_LAYOUT_HOST: return OFF(host);
        case ZEPHYR_RDP_LAYOUT_PORT: return OFF(port);
        case ZEPHYR_RDP_LAYOUT_USERNAME: return OFF(username);
        case ZEPHYR_RDP_LAYOUT_PASSWORD: return OFF(password);
        case ZEPHYR_RDP_LAYOUT_DOMAIN: return OFF(domain);
        case ZEPHYR_RDP_LAYOUT_WIDTH: return OFF(width);
        case ZEPHYR_RDP_LAYOUT_HEIGHT: return OFF(height);
        case ZEPHYR_RDP_LAYOUT_COLOR_DEPTH: return OFF(color_depth);
        case ZEPHYR_RDP_LAYOUT_SECURITY: return OFF(security);
        case ZEPHYR_RDP_LAYOUT_IGNORE_CERTIFICATE: return OFF(ignore_certificate);
        case ZEPHYR_RDP_LAYOUT_AUDIO_MODE: return OFF(audio_mode);
        case ZEPHYR_RDP_LAYOUT_MICROPHONE: return OFF(microphone);
        case ZEPHYR_RDP_LAYOUT_CLIPBOARD: return OFF(clipboard);
        case ZEPHYR_RDP_LAYOUT_DRIVE_NAME: return OFF(drive_name);
        case ZEPHYR_RDP_LAYOUT_DRIVE_PATH: return OFF(drive_path);
        case ZEPHYR_RDP_LAYOUT_DRIVE_READ_ONLY: return OFF(drive_read_only);
        case ZEPHYR_RDP_LAYOUT_DYNAMIC_RESOLUTION: return OFF(dynamic_resolution);
        case ZEPHYR_RDP_LAYOUT_GFX: return OFF(gfx);
        case ZEPHYR_RDP_LAYOUT_DISABLE_WALLPAPER: return OFF(disable_wallpaper);
        case ZEPHYR_RDP_LAYOUT_DISABLE_THEMES: return OFF(disable_themes);
        case ZEPHYR_RDP_LAYOUT_DISABLE_MENU_ANIMS: return OFF(disable_menu_anims);
        case ZEPHYR_RDP_LAYOUT_DISABLE_FULL_WINDOW_DRAG:
            return OFF(disable_full_window_drag);
        case ZEPHYR_RDP_LAYOUT_ALLOW_FONT_SMOOTHING: return OFF(allow_font_smoothing);
        default: return -1;
    }
#undef OFF
}

/* Build a throwaway context so the probe exercises the real apply_config
 * against a real rdpSettings, not a mock. */
static rdpContext* probe_context(const zephyr_rdp_config* cfg) {
    RDP_CLIENT_ENTRY_POINTS ep;
    fill_entry_points(&ep);
    rdpContext* context = freerdp_client_context_new(&ep);
    if (!context) return NULL;
    ((zephyr_client_context*)context)->owner = NULL;
    if (!apply_config(context->settings, cfg)) {
        freerdp_client_context_free(context);
        return NULL;
    }
    return context;
}

int32_t zephyr_rdp_probe_drive(const zephyr_rdp_config* cfg, char* name_out,
                               size_t name_cap, char* path_out, size_t path_cap,
                               int32_t* type_out) {
    if (!cfg) return -1;
    rdpContext* context = probe_context(cfg);
    if (!context) return -1;

    rdpSettings* settings = context->settings;
    UINT32 count = freerdp_settings_get_uint32(settings, FreeRDP_DeviceCount);
    int32_t result = (int32_t)count;

    if (name_out && name_cap) name_out[0] = '\0';
    if (path_out && path_cap) path_out[0] = '\0';
    if (type_out) *type_out = 0;

    RDPDR_DEVICE* device =
        freerdp_device_collection_find_type(settings, RDPDR_DTYP_FILESYSTEM);
    if (device) {
        RDPDR_DRIVE* drive = (RDPDR_DRIVE*)device;
        if (type_out) *type_out = (int32_t)device->Type;
        if (name_out && name_cap && DRIVE_NAME(drive)) {
            strncpy(name_out, DRIVE_NAME(drive), name_cap - 1);
            name_out[name_cap - 1] = '\0';
        }
        if (path_out && path_cap && drive->Path) {
            strncpy(path_out, drive->Path, path_cap - 1);
            path_out[path_cap - 1] = '\0';
        }
    }

    freerdp_client_context_free(context);
    return result;
}

int32_t zephyr_rdp_probe_settings(const zephyr_rdp_config* cfg, int32_t* nla,
                                  int32_t* tls, int32_t* rdp_sec,
                                  int32_t* audio_playback, int32_t* audio_capture,
                                  int32_t* clipboard, int32_t* device_redirection,
                                  int32_t* dynamic_res, int32_t* gfx) {
    if (!cfg) return -1;
    rdpContext* context = probe_context(cfg);
    if (!context) return -1;
    rdpSettings* st = context->settings;

#define GET(out, id) \
    do { if (out) *out = freerdp_settings_get_bool(st, id) ? 1 : 0; } while (0)
    GET(nla, FreeRDP_NlaSecurity);
    GET(tls, FreeRDP_TlsSecurity);
    GET(rdp_sec, FreeRDP_RdpSecurity);
    GET(audio_playback, FreeRDP_AudioPlayback);
    GET(audio_capture, FreeRDP_AudioCapture);
    GET(clipboard, FreeRDP_RedirectClipboard);
    GET(device_redirection, FreeRDP_DeviceRedirection);
    GET(dynamic_res, FreeRDP_DynamicResolutionUpdate);
    GET(gfx, FreeRDP_SupportGraphicsPipeline);
#undef GET

    freerdp_client_context_free(context);
    return 0;
}

int32_t zephyr_rdp_security_protocol_allowed(const zephyr_rdp_config* cfg,
                                             uint32_t selected_protocol) {
    return security_protocol_allowed(cfg, (UINT32)selected_protocol) ? 1 : 0;
}

/* ── exported for the UTF conversion unit tests ──────────────────────────── */

long zephyr_rdp_test_utf8_to_utf16le(const char* in, uint16_t* out, size_t units) {
    return utf8_to_utf16le(in, out, units);
}

long zephyr_rdp_test_utf16le_to_utf8(const uint16_t* in, size_t units, char* out,
                                     size_t cap) {
    return utf16le_to_utf8(in, units, out, cap);
}

int32_t zephyr_rdp_test_clipboard_payload(const uint8_t* data, size_t bytes) {
    return validate_clipboard_payload(data, bytes) ? 1 : 0;
}

#ifdef ZEPHYR_RDP_TESTING
int32_t zephyr_rdp_test_new_failure_cleanup(const zephyr_rdp_config* cfg,
                                            int32_t failpoint) {
    if (!cfg || failpoint < ZEPHYR_RDP_TEST_FAIL_HOST ||
        failpoint > ZEPHYR_RDP_TEST_FAIL_READY)
        return 0;

    const int32_t sessions_before = zrdp_test_live_sessions;
    const int32_t strings_before = zrdp_test_live_strings;
    const int32_t locks_before = zrdp_test_live_locks;
    const int32_t wakes_before = zrdp_test_live_wakes;
    const int32_t contexts_before = zrdp_test_live_contexts;

    zrdp_test_failpoint_hit = FALSE;
    zrdp_test_failpoint = failpoint;
    zephyr_rdp_session* s = zephyr_rdp_new(cfg, NULL, NULL, NULL);
    zrdp_test_failpoint = 0;
    if (s) {
        zephyr_rdp_free(s);
        return 0;
    }

    return zrdp_test_failpoint_hit &&
           zrdp_test_live_sessions == sessions_before &&
           zrdp_test_live_strings == strings_before &&
           zrdp_test_live_locks == locks_before &&
           zrdp_test_live_wakes == wakes_before &&
           zrdp_test_live_contexts == contexts_before;
}

int32_t zephyr_rdp_test_password_wipe_cleanup(const zephyr_rdp_config* cfg,
                                              int32_t failpoint) {
    if (!cfg || !cfg->password || !*cfg->password || failpoint < 0 ||
        failpoint > ZEPHYR_RDP_TEST_FAIL_READY)
        return 0;

    zrdp_test_password_wipe_failures = 0;
    zrdp_test_owned_password_wipes = 0;
    zrdp_test_settings_password_wipes = 0;
    zrdp_test_failpoint_hit = FALSE;
    zrdp_test_failpoint = failpoint;

    zephyr_rdp_session* s = zephyr_rdp_new(cfg, NULL, NULL, NULL);
    zrdp_test_failpoint = 0;
    if (failpoint == 0) {
        if (!s) return 0;
        zephyr_rdp_free(s);
    } else {
        if (s) {
            zephyr_rdp_free(s);
            return 0;
        }
        if (!zrdp_test_failpoint_hit) return 0;
    }

    if (zrdp_test_password_wipe_failures != 0) return -1;

    int32_t mask = 0;
    if (zrdp_test_owned_password_wipes > 0) mask |= 1;
    if (zrdp_test_settings_password_wipes > 0) mask |= 2;
    return mask;
}
#endif
