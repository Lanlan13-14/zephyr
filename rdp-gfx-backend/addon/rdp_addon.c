/**
 * RDP N-API Addon — Direct FreeRDP3 bridge for Node.js
 *
 * Replaces the Python ctypes layer (rdp_bridge.py + wire_format.py + server.py)
 * with a native Node.js addon that directly calls librdp_bridge.so.
 *
 * Data flow: Browser ←(WS binary)→ Node.js ←(N-API)→ C/FreeRDP3 ←(TCP 3389)→ Windows
 *
 * Wire format binary protocol is built in C to avoid JS serialization overhead.
 * All output messages are returned as Node.js Buffers ready for WebSocket.send().
 */

#define NAPI_VERSION 8
#include <node_api.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdbool.h>

/* ============================================================================
 * rdp_bridge.h types (duplicated to avoid build dependency on FreeRDP headers)
 * ============================================================================ */

typedef enum {
    RDP_STATE_DISCONNECTED = 0,
    RDP_STATE_CONNECTING,
    RDP_STATE_CONNECTED,
    RDP_STATE_ERROR
} RdpState;

typedef enum {
    RDP_GFX_CODEC_UNCOMPRESSED = 0x0000,
    RDP_GFX_CODEC_CLEARCODEC = 0x0003,
    RDP_GFX_CODEC_PLANAR = 0x0004,
    RDP_GFX_CODEC_AVC420 = 0x0009,
    RDP_GFX_CODEC_ALPHA = 0x000A,
    RDP_GFX_CODEC_AVC444 = 0x000B,
    RDP_GFX_CODEC_AVC444v2 = 0x000E,
    RDP_GFX_CODEC_PROGRESSIVE = 0x000C,
    RDP_GFX_CODEC_PROGRESSIVE_V2 = 0x000D
} RdpGfxCodecId;

typedef enum {
    RDP_GFX_EVENT_NONE = 0,
    RDP_GFX_EVENT_CREATE_SURFACE,
    RDP_GFX_EVENT_DELETE_SURFACE,
    RDP_GFX_EVENT_MAP_SURFACE,
    RDP_GFX_EVENT_START_FRAME,
    RDP_GFX_EVENT_END_FRAME,
    RDP_GFX_EVENT_SOLID_FILL,
    RDP_GFX_EVENT_SURFACE_TO_SURFACE,
    RDP_GFX_EVENT_CACHE_TO_SURFACE,
    RDP_GFX_EVENT_SURFACE_TO_CACHE,
    RDP_GFX_EVENT_WEBP_TILE,
    RDP_GFX_EVENT_VIDEO_FRAME,
    RDP_GFX_EVENT_EVICT_CACHE,
    RDP_GFX_EVENT_RESET_GRAPHICS,
    RDP_GFX_EVENT_CAPS_CONFIRM,
    RDP_GFX_EVENT_INIT_SETTINGS,
    RDP_GFX_EVENT_POINTER_POSITION,
    RDP_GFX_EVENT_POINTER_SYSTEM,
    RDP_GFX_EVENT_POINTER_SET,
} RdpGfxEventType;

/* Must match rdp_bridge.h RdpGfxEvent exactly */
typedef struct {
    int type;
    uint32_t frame_id;
    uint16_t surface_id;
    uint16_t dst_surface_id;
    uint32_t width;
    uint32_t height;
    uint32_t pixel_format;
    int32_t x;
    int32_t y;
    int32_t src_x;
    int32_t src_y;
    uint32_t color;
    uint16_t cache_slot;
    uint8_t* bitmap_data;
    uint32_t bitmap_size;
    int codec_id;
    int video_frame_type;
    uint8_t* nal_data;
    uint32_t nal_size;
    uint8_t* chroma_nal_data;
    uint32_t chroma_nal_size;
    uint32_t gfx_version;
    uint32_t gfx_flags;
    uint32_t init_color_depth;
    uint32_t init_flags_low;
    uint32_t init_flags_high;
    uint16_t pointer_x;
    uint16_t pointer_y;
    uint16_t pointer_hotspot_x;
    uint16_t pointer_hotspot_y;
    uint16_t pointer_width;
    uint16_t pointer_height;
    uint8_t pointer_system_type;
    uint8_t* pointer_data;
    uint32_t pointer_data_size;
} RdpGfxEvent;

/* Shared finalizer for napi_create_external_buffer — just free() the data */
static void buf_free_finalizer(napi_env env, void* data, void* hint) {
    (void)env; (void)hint;
    free(data);
}

/* ============================================================================
 * Wire format magic codes — must match wire-format.js
 * ============================================================================ */

static const char MAGIC_SURF[4] = "SURF";
static const char MAGIC_DELS[4] = "DELS";
static const char MAGIC_MAPS[4] = "MAPS";
static const char MAGIC_STFR[4] = "STFR";
static const char MAGIC_ENFR[4] = "ENFR";
static const char MAGIC_SFIL[4] = "SFIL";
static const char MAGIC_S2SF[4] = "S2SF";
static const char MAGIC_C2SF[4] = "C2SF";
static const char MAGIC_S2CH[4] = "S2CH";
static const char MAGIC_EVCT[4] = "EVCT";
static const char MAGIC_RSGR[4] = "RSGR";
static const char MAGIC_CAPS[4] = "CAPS";
static const char MAGIC_INIT[4] = "INIT";
static const char MAGIC_WEBP[4] = "WEBP";
static const char MAGIC_TILE[4] = "TILE";
static const char MAGIC_CLRC[4] = "CLRC";
static const char MAGIC_H264[4] = "H264";
static const char MAGIC_PPOS[4] = "PPOS";
static const char MAGIC_PSYS[4] = "PSYS";
static const char MAGIC_PSET[4] = "PSET";
static const char MAGIC_OPUS[4] = "OPUS";

/* ============================================================================
 * Library function pointers (loaded via dlopen)
 * ============================================================================ */

static void* g_lib = NULL;

/* Session lifecycle */
static void* (*fn_rdp_create)(const char*, uint16_t, const char*, const char*,
                               const char*, uint32_t, uint32_t, uint32_t) = NULL;
static int   (*fn_rdp_connect)(void*) = NULL;
static int   (*fn_rdp_poll)(void*, int) = NULL;
static void  (*fn_rdp_disconnect)(void*) = NULL;
static void  (*fn_rdp_destroy)(void*) = NULL;
static int   (*fn_rdp_get_state)(void*) = NULL;
static const char* (*fn_rdp_get_error)(void*) = NULL;
static const char* (*fn_rdp_version)(void) = NULL;

/* Input */
static void (*fn_rdp_send_mouse)(void*, uint16_t, int, int) = NULL;
static void (*fn_rdp_send_keyboard)(void*, uint16_t, uint16_t) = NULL;
static void (*fn_rdp_send_unicode)(void*, uint16_t, uint16_t) = NULL;

/* Resize */
static int (*fn_rdp_resize)(void*, uint32_t, uint32_t) = NULL;

/* GFX */
static int (*fn_rdp_gfx_has_events)(void*) = NULL;
static int (*fn_rdp_gfx_get_event)(void*, RdpGfxEvent*) = NULL;
static void (*fn_rdp_gfx_clear_events)(void*) = NULL;
static void (*fn_rdp_free_gfx_event_data)(void*) = NULL;
static int (*fn_rdp_gfx_send_frame_ack)(void*, uint32_t, uint32_t, uint32_t) = NULL;
static bool (*fn_rdp_gfx_is_active)(void*) = NULL;
static int (*fn_rdp_gfx_get_codec)(void*) = NULL;

/* Audio */
static bool (*fn_rdp_has_opus_data)(void*) = NULL;
static int (*fn_rdp_get_opus_format)(void*, int*, int*) = NULL;
static int (*fn_rdp_get_opus_frame)(void*, uint8_t*, int) = NULL;
static void (*fn_rdp_set_audio_context)(void*) = NULL;

/* Clipboard */
static int (*fn_rdp_clipboard_set_text)(void*, const char*) = NULL;
static int (*fn_rdp_clipboard_set_files)(void*, const char*) = NULL;
static void* (*fn_rdp_clipboard_pop_event)(void*) = NULL;
static int (*fn_rdp_clipboard_download_file)(void*, uint32_t, const char*) = NULL;
static void (*fn_rdp_free)(void*) = NULL;

/* Session registry */
static int (*fn_rdp_set_max_sessions)(int) = NULL;

/* ============================================================================
 * Helper: write little-endian integers to buffer
 * ============================================================================ */

static inline void w16(uint8_t* p, uint16_t v) { p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; }
static inline void w32(uint8_t* p, uint32_t v) { p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; p[2] = (v >> 16) & 0xFF; p[3] = (v >> 24) & 0xFF; }
static inline void wi16(uint8_t* p, int16_t v) { w16(p, (uint16_t)v); }

/* ============================================================================
 * Wire format builders — return Node.js Buffer with binary message
 *
 * Each function allocates a buffer, writes header + payload, and returns it
 * as a napi_value (Buffer). The caller sends it directly via WebSocket.
 * ============================================================================ */

static napi_value build_event_message(napi_env env, const RdpGfxEvent* ev)
{
    uint8_t* buf = NULL;
    size_t len = 0;
    napi_value result;

    switch (ev->type) {

    case RDP_GFX_EVENT_CREATE_SURFACE: { /* SURF(4)+sid(2)+w(2)+h(2)+fmt(2) = 12 */
        len = 12;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_SURF, 4);
        w16(buf+4, ev->surface_id);
        w16(buf+6, (uint16_t)ev->width);
        w16(buf+8, (uint16_t)ev->height);
        w16(buf+10, (uint16_t)ev->pixel_format);
        break;
    }

    case RDP_GFX_EVENT_DELETE_SURFACE: { /* DELS(4)+sid(2) = 6 */
        len = 6;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_DELS, 4);
        w16(buf+4, ev->surface_id);
        break;
    }

    case RDP_GFX_EVENT_MAP_SURFACE: { /* MAPS(4)+sid(2)+ox(2)+oy(2) = 10 */
        len = 10;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_MAPS, 4);
        w16(buf+4, ev->surface_id);
        w16(buf+6, (uint16_t)ev->x);
        w16(buf+8, (uint16_t)ev->y);
        break;
    }

    case RDP_GFX_EVENT_START_FRAME: { /* STFR(4)+fid(4) = 8 */
        len = 8;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_STFR, 4);
        w32(buf+4, ev->frame_id);
        break;
    }

    case RDP_GFX_EVENT_END_FRAME: { /* ENFR(4)+fid(4) = 8 */
        len = 8;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_ENFR, 4);
        w32(buf+4, ev->frame_id);
        break;
    }

    case RDP_GFX_EVENT_SOLID_FILL: { /* SFIL(4)+fid(4)+sid(2)+x(2)+y(2)+w(2)+h(2)+color(4) = 22 */
        len = 22;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_SFIL, 4);
        w32(buf+4, ev->frame_id);
        w16(buf+8, ev->surface_id);
        wi16(buf+10, (int16_t)ev->x);
        wi16(buf+12, (int16_t)ev->y);
        w16(buf+14, (uint16_t)ev->width);
        w16(buf+16, (uint16_t)ev->height);
        w32(buf+18, ev->color);
        break;
    }

    case RDP_GFX_EVENT_SURFACE_TO_SURFACE: { /* S2SF(4)+fid(4)+ssid(2)+dsid(2)+sx(2)+sy(2)+sw(2)+sh(2)+dx(2)+dy(2) = 24 */
        len = 24;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_S2SF, 4);
        w32(buf+4, ev->frame_id);
        w16(buf+8, ev->surface_id);
        w16(buf+10, ev->dst_surface_id);
        wi16(buf+12, (int16_t)ev->src_x);
        wi16(buf+14, (int16_t)ev->src_y);
        w16(buf+16, (uint16_t)ev->width);
        w16(buf+18, (uint16_t)ev->height);
        wi16(buf+20, (int16_t)ev->x);
        wi16(buf+22, (int16_t)ev->y);
        break;
    }

    case RDP_GFX_EVENT_SURFACE_TO_CACHE: { /* S2CH(4)+fid(4)+sid(2)+slot(2)+x(2)+y(2)+w(2)+h(2) = 20 */
        len = 20;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_S2CH, 4);
        w32(buf+4, ev->frame_id);
        w16(buf+8, ev->surface_id);
        w16(buf+10, ev->cache_slot);
        wi16(buf+12, (int16_t)ev->x);
        wi16(buf+14, (int16_t)ev->y);
        w16(buf+16, (uint16_t)ev->width);
        w16(buf+18, (uint16_t)ev->height);
        break;
    }

    case RDP_GFX_EVENT_CACHE_TO_SURFACE: { /* C2SF(4)+fid(4)+sid(2)+slot(2)+dx(2)+dy(2) = 16 */
        len = 16;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_C2SF, 4);
        w32(buf+4, ev->frame_id);
        w16(buf+8, ev->surface_id);
        w16(buf+10, ev->cache_slot);
        wi16(buf+12, (int16_t)ev->x);
        wi16(buf+14, (int16_t)ev->y);
        break;
    }

    case RDP_GFX_EVENT_EVICT_CACHE: { /* EVCT(4)+fid(4)+slot(2) = 10 */
        len = 10;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_EVCT, 4);
        w32(buf+4, ev->frame_id);
        w16(buf+8, ev->cache_slot);
        break;
    }

    case RDP_GFX_EVENT_RESET_GRAPHICS: { /* RSGR(4)+w(2)+h(2) = 8 */
        len = 8;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_RSGR, 4);
        w16(buf+4, (uint16_t)ev->width);
        w16(buf+6, (uint16_t)ev->height);
        break;
    }

    case RDP_GFX_EVENT_CAPS_CONFIRM: { /* CAPS(4)+ver(4)+flags(4) = 12 */
        len = 12;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_CAPS, 4);
        w32(buf+4, ev->gfx_version);
        w32(buf+8, ev->gfx_flags);
        break;
    }

    case RDP_GFX_EVENT_INIT_SETTINGS: { /* INIT(4)+cd(4)+fl(4)+fh(4) = 16 */
        len = 16;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_INIT, 4);
        w32(buf+4, ev->init_color_depth);
        w32(buf+8, ev->init_flags_low);
        w32(buf+12, ev->init_flags_high);
        break;
    }

    case RDP_GFX_EVENT_WEBP_TILE: {
        if (!ev->bitmap_data || ev->bitmap_size == 0) return NULL;
        /* codec_id == 0xFFFF → raw BGRA tile (TILE magic)
         * otherwise → WebP tile (WEBP magic) */
        const char* magic = (ev->codec_id == (int)0xFFFF) ? MAGIC_TILE : MAGIC_WEBP;
        /* Header: magic(4)+fid(4)+sid(2)+x(2)+y(2)+w(2)+h(2)+dataSize(4) = 22 */
        len = 22 + ev->bitmap_size;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, magic, 4);
        w32(buf+4, ev->frame_id);
        w16(buf+8, ev->surface_id);
        w16(buf+10, (uint16_t)ev->x);
        w16(buf+12, (uint16_t)ev->y);
        w16(buf+14, (uint16_t)ev->width);
        w16(buf+16, (uint16_t)ev->height);
        w32(buf+18, ev->bitmap_size);
        memcpy(buf+22, ev->bitmap_data, ev->bitmap_size);
        fn_rdp_free_gfx_event_data(ev->bitmap_data);
        break;
    }

    case RDP_GFX_EVENT_VIDEO_FRAME: {
        if (!ev->nal_data || ev->nal_size == 0) return NULL;
        /* ClearCodec uses CLRC magic; everything else uses H264 magic */
        if (ev->codec_id == RDP_GFX_CODEC_CLEARCODEC) {
            /* CLRC(4)+fid(4)+sid(2)+x(2)+y(2)+w(2)+h(2)+dataSize(4)+data = 22+n */
            len = 22 + ev->nal_size;
            buf = (uint8_t*)malloc(len);
            memcpy(buf, MAGIC_CLRC, 4);
            w32(buf+4, ev->frame_id);
            w16(buf+8, ev->surface_id);
            w16(buf+10, (uint16_t)ev->x);
            w16(buf+12, (uint16_t)ev->y);
            w16(buf+14, (uint16_t)ev->width);
            w16(buf+16, (uint16_t)ev->height);
            w32(buf+18, ev->nal_size);
            memcpy(buf+22, ev->nal_data, ev->nal_size);
        } else {
            /* H264(4)+fid(4)+sid(2)+codec(2)+ftype(1)+x(2)+y(2)+w(2)+h(2)+nalSz(4)+chromaSz(4)+data = 29+n+c */
            uint32_t chroma_sz = (ev->chroma_nal_data && ev->chroma_nal_size > 0) ? ev->chroma_nal_size : 0;
            len = 29 + ev->nal_size + chroma_sz;
            buf = (uint8_t*)malloc(len);
            memcpy(buf, MAGIC_H264, 4);
            w32(buf+4, ev->frame_id);
            w16(buf+8, ev->surface_id);
            w16(buf+10, (uint16_t)ev->codec_id);
            buf[12] = (uint8_t)ev->video_frame_type;
            wi16(buf+13, (int16_t)ev->x);
            wi16(buf+15, (int16_t)ev->y);
            w16(buf+17, (uint16_t)ev->width);
            w16(buf+19, (uint16_t)ev->height);
            w32(buf+21, ev->nal_size);
            w32(buf+25, chroma_sz);
            memcpy(buf+29, ev->nal_data, ev->nal_size);
            if (chroma_sz > 0) {
                memcpy(buf+29+ev->nal_size, ev->chroma_nal_data, chroma_sz);
            }
        }
        fn_rdp_free_gfx_event_data(ev->nal_data);
        if (ev->chroma_nal_data) fn_rdp_free_gfx_event_data(ev->chroma_nal_data);
        break;
    }

    case RDP_GFX_EVENT_POINTER_POSITION: { /* PPOS(4)+x(2)+y(2) = 8 */
        len = 8;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_PPOS, 4);
        w16(buf+4, ev->pointer_x);
        w16(buf+6, ev->pointer_y);
        break;
    }

    case RDP_GFX_EVENT_POINTER_SYSTEM: { /* PSYS(4)+type(1) = 5 */
        len = 5;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_PSYS, 4);
        buf[4] = ev->pointer_system_type;
        break;
    }

    case RDP_GFX_EVENT_POINTER_SET: { /* PSET(4)+w(2)+h(2)+hx(2)+hy(2)+dlen(4)+data = 16+n */
        if (!ev->pointer_data || ev->pointer_data_size == 0) return NULL;
        len = 16 + ev->pointer_data_size;
        buf = (uint8_t*)malloc(len);
        memcpy(buf, MAGIC_PSET, 4);
        w16(buf+4, ev->pointer_width);
        w16(buf+6, ev->pointer_height);
        w16(buf+8, ev->pointer_hotspot_x);
        w16(buf+10, ev->pointer_hotspot_y);
        w32(buf+12, ev->pointer_data_size);
        memcpy(buf+16, ev->pointer_data, ev->pointer_data_size);
        fn_rdp_free_gfx_event_data(ev->pointer_data);
        break;
    }

    default:
        return NULL;
    }

    if (!buf) return NULL;

    /* Create Node.js Buffer that owns the malloc'd memory */
    napi_status status = napi_create_external_buffer(env, len, buf,
        buf_free_finalizer, NULL, &result);
    
    if (status != napi_ok) {
        free(buf);
        return NULL;
    }
    return result;
}

/* ============================================================================
 * N-API exported functions
 * ============================================================================ */

#define NAPI_CALL(env, call) do { \
    napi_status _s = (call); \
    if (_s != napi_ok) { \
        const napi_extended_error_info* _err; \
        napi_get_last_error_info((env), &_err); \
        napi_throw_error((env), NULL, _err->error_message); \
        return NULL; \
    } \
} while(0)

/* Get string argument, caller must free() returned pointer */
static char* get_string_arg(napi_env env, napi_value val) {
    size_t len = 0;
    napi_get_value_string_utf8(env, val, NULL, 0, &len);
    char* str = (char*)malloc(len + 1);
    napi_get_value_string_utf8(env, val, str, len + 1, &len);
    return str;
}

static int32_t get_int32(napi_env env, napi_value val) {
    int32_t v = 0;
    napi_get_value_int32(env, val, &v);
    return v;
}

static uint32_t get_uint32(napi_env env, napi_value val) {
    uint32_t v = 0;
    napi_get_value_uint32(env, val, &v);
    return v;
}

/* loadLibrary(path: string): boolean */
static napi_value fn_load_library(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

    char* path = get_string_arg(env, argv[0]);
    if (g_lib) dlclose(g_lib);
    g_lib = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    free(path);

    if (!g_lib) {
        napi_value r;
        napi_get_boolean(env, false, &r);
        return r;
    }

    /* Resolve all function pointers */
    #define LOAD(name) fn_##name = dlsym(g_lib, #name)
    LOAD(rdp_create);
    LOAD(rdp_connect);
    LOAD(rdp_poll);
    LOAD(rdp_disconnect);
    LOAD(rdp_destroy);
    LOAD(rdp_get_state);
    LOAD(rdp_get_error);
    LOAD(rdp_version);
    LOAD(rdp_send_mouse);
    LOAD(rdp_send_keyboard);
    LOAD(rdp_send_unicode);
    LOAD(rdp_resize);
    LOAD(rdp_gfx_has_events);
    LOAD(rdp_gfx_get_event);
    LOAD(rdp_gfx_clear_events);
    LOAD(rdp_free_gfx_event_data);
    LOAD(rdp_gfx_send_frame_ack);
    LOAD(rdp_gfx_is_active);
    LOAD(rdp_gfx_get_codec);
    LOAD(rdp_has_opus_data);
    LOAD(rdp_get_opus_format);
    LOAD(rdp_get_opus_frame);
    LOAD(rdp_set_audio_context);
    LOAD(rdp_clipboard_set_text);
    LOAD(rdp_clipboard_set_files);
    LOAD(rdp_clipboard_pop_event);
    LOAD(rdp_clipboard_download_file);
    LOAD(rdp_free);
    LOAD(rdp_set_max_sessions);
    #undef LOAD

    napi_value r;
    napi_get_boolean(env, true, &r);
    return r;
}

/* version(): string */
static napi_value fn_version(napi_env env, napi_callback_info info) {
    (void)info;
    const char* v = fn_rdp_version ? fn_rdp_version() : "unknown";
    napi_value result;
    napi_create_string_utf8(env, v, strlen(v), &result);
    return result;
}

/* setMaxSessions(limit: number): number */
static napi_value fn_set_max_sessions(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    int r = fn_rdp_set_max_sessions ? fn_rdp_set_max_sessions(get_int32(env, argv[0])) : -1;
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* createSession(host, port, user, pass, domain, w, h, bpp): sessionHandle (external) */
static napi_value fn_create_session(napi_env env, napi_callback_info info) {
    size_t argc = 8;
    napi_value argv[8];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

    char* host = get_string_arg(env, argv[0]);
    uint16_t port = (uint16_t)get_uint32(env, argv[1]);
    char* user = get_string_arg(env, argv[2]);
    char* pass = get_string_arg(env, argv[3]);
    char* domain = get_string_arg(env, argv[4]);
    uint32_t w = get_uint32(env, argv[5]);
    uint32_t h = get_uint32(env, argv[6]);
    uint32_t bpp = get_uint32(env, argv[7]);

    void* session = fn_rdp_create(host, port, user, pass, domain, w, h, bpp);
    free(host); free(user); free(pass); free(domain);

    if (!session) {
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
    }

    napi_value result;
    napi_create_external(env, session, NULL, NULL, &result);
    return result;
}

/* connect(session): number (0=ok) */
static napi_value fn_connect_session(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    int r = fn_rdp_connect(session);
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* poll(session, timeoutMs): number (-1=error, 0=nothing, 1=events) */
static napi_value fn_poll_session(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    int timeout = get_int32(env, argv[1]);
    int r = fn_rdp_poll(session, timeout);
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* getState(session): number */
static napi_value fn_get_state(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    int s = fn_rdp_get_state(session);
    napi_value result;
    napi_create_int32(env, s, &result);
    return result;
}

/* getError(session): string */
static napi_value fn_get_error(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    const char* err = fn_rdp_get_error(session);
    napi_value result;
    napi_create_string_utf8(env, err ? err : "", err ? strlen(err) : 0, &result);
    return result;
}

/* disconnect(session) */
static napi_value fn_disconnect_session(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    fn_rdp_disconnect(session);
    return NULL;
}

/* destroy(session) */
static napi_value fn_destroy_session(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    fn_rdp_destroy(session);
    return NULL;
}

/* sendMouse(session, flags, x, y) */
static napi_value fn_send_mouse(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    fn_rdp_send_mouse(session, (uint16_t)get_uint32(env, argv[1]),
                      get_int32(env, argv[2]), get_int32(env, argv[3]));
    return NULL;
}

/* sendKeyboard(session, flags, scancode) */
static napi_value fn_send_keyboard(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    fn_rdp_send_keyboard(session, (uint16_t)get_uint32(env, argv[1]),
                         (uint16_t)get_uint32(env, argv[2]));
    return NULL;
}

/* sendUnicode(session, flags, code) */
static napi_value fn_send_unicode(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    fn_rdp_send_unicode(session, (uint16_t)get_uint32(env, argv[1]),
                        (uint16_t)get_uint32(env, argv[2]));
    return NULL;
}

/* resize(session, w, h): number */
static napi_value fn_resize_session(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    int r = fn_rdp_resize(session, get_uint32(env, argv[1]), get_uint32(env, argv[2]));
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* sendFrameAck(session, frameId, totalDecoded, queueDepth): number */
static napi_value fn_send_frame_ack(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    int r = fn_rdp_gfx_send_frame_ack(session,
        get_uint32(env, argv[1]), get_uint32(env, argv[2]), get_uint32(env, argv[3]));
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* gfxIsActive(session): boolean */
static napi_value fn_gfx_is_active(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    napi_value result;
    napi_get_boolean(env, fn_rdp_gfx_is_active(session), &result);
    return result;
}

/* gfxGetCodec(session): number */
static napi_value fn_gfx_get_codec(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    napi_value result;
    napi_create_int32(env, fn_rdp_gfx_get_codec(session), &result);
    return result;
}

/**
 * drainGfxEvents(session): Buffer[]
 *
 * Drain all pending GFX events from the C event queue and return them as
 * an array of pre-built binary wire format Buffers. Each Buffer is ready
 * to be sent directly via WebSocket.send() with no further serialization.
 *
 * This is the hot path — called every poll cycle. Building wire format
 * messages in C avoids:
 * - JS object allocation per event
 * - JSON serialization
 * - Per-field Buffer.write calls
 */
static napi_value fn_drain_gfx_events(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);

    napi_value array;
    napi_create_array(env, &array);
    uint32_t idx = 0;

    RdpGfxEvent event;
    while (fn_rdp_gfx_has_events(session) > 0) {
        if (fn_rdp_gfx_get_event(session, &event) != 0) break;

        napi_value msg = build_event_message(env, &event);
        if (msg) {
            napi_set_element(env, array, idx++, msg);
        }

        /* Stop after one complete frame to avoid blocking the event loop */
        if (event.type == RDP_GFX_EVENT_END_FRAME) break;
    }

    return array;
}

/**
 * drainOpusFrames(session): Buffer | null
 *
 * Drain all pending Opus audio frames and return them as a single Buffer
 * containing concatenated OPUS wire messages. Returns null if no audio.
 */
static napi_value fn_drain_opus(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);

    if (!fn_rdp_has_opus_data || !fn_rdp_has_opus_data(session)) {
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
    }

    int sample_rate = 48000, channels = 2;
    if (fn_rdp_get_opus_format) fn_rdp_get_opus_format(session, &sample_rate, &channels);

    /* Collect up to 10 Opus frames into a single buffer */
    uint8_t temp[4096];
    uint8_t* out = (uint8_t*)malloc(128 * 1024);  /* 128KB max batch */
    size_t out_pos = 0;
    int frames = 0;

    while (fn_rdp_has_opus_data(session) && frames < 10 && out_pos + 4108 < 128*1024) {
        int frame_size = fn_rdp_get_opus_frame(session, temp, sizeof(temp));
        if (frame_size <= 0) break;

        /* OPUS(4)+sampleRate(4)+channels(2)+frameSize(2)+data = 12+n */
        size_t msg_len = 12 + (size_t)frame_size;
        memcpy(out + out_pos, MAGIC_OPUS, 4);
        w32(out + out_pos + 4, (uint32_t)sample_rate);
        w16(out + out_pos + 8, (uint16_t)channels);
        w16(out + out_pos + 10, (uint16_t)frame_size);
        memcpy(out + out_pos + 12, temp, (size_t)frame_size);
        out_pos += msg_len;
        frames++;
    }

    if (out_pos == 0) {
        free(out);
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
    }

    napi_value result;
    napi_status status = napi_create_external_buffer(env, out_pos, out,
        buf_free_finalizer, NULL, &result);
    if (status != napi_ok) { free(out); return NULL; }
    return result;
}

/* clipboardSetText(session, text): number */
static napi_value fn_clipboard_set_text(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    char* text = get_string_arg(env, argv[1]);
    int r = fn_rdp_clipboard_set_text(session, text);
    free(text);
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* clipboardSetFiles(session, newlinePaths): number */
static napi_value fn_clipboard_set_files(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    char* paths = get_string_arg(env, argv[1]);
    int r = fn_rdp_clipboard_set_files(session, paths);
    free(paths);
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* clipboardPopEvent(session): string | null */
static napi_value fn_clipboard_pop_event(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    void* ptr = fn_rdp_clipboard_pop_event(session);
    if (!ptr) {
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
    }
    const char* json = (const char*)ptr;
    napi_value result;
    napi_create_string_utf8(env, json, strlen(json), &result);
    fn_rdp_free(ptr);
    return result;
}

/* clipboardDownloadFile(session, index, outputPath): number */
static napi_value fn_clipboard_download_file(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    uint32_t index = get_uint32(env, argv[1]);
    char* path = get_string_arg(env, argv[2]);
    int r = fn_rdp_clipboard_download_file(session, index, path);
    free(path);
    napi_value result;
    napi_create_int32(env, r, &result);
    return result;
}

/* setAudioContext(session) */
static napi_value fn_set_audio_context(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    void* session;
    napi_get_value_external(env, argv[0], &session);
    if (fn_rdp_set_audio_context) fn_rdp_set_audio_context(session);
    return NULL;
}

/* ============================================================================
 * Module initialization
 * ============================================================================ */

#define EXPORT_FN(name, fn) do { \
    napi_value _fn; \
    napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &_fn); \
    napi_set_named_property(env, exports, name, _fn); \
} while(0)

static napi_value Init(napi_env env, napi_value exports) {
    EXPORT_FN("loadLibrary", fn_load_library);
    EXPORT_FN("version", fn_version);
    EXPORT_FN("setMaxSessions", fn_set_max_sessions);
    EXPORT_FN("createSession", fn_create_session);
    EXPORT_FN("connect", fn_connect_session);
    EXPORT_FN("poll", fn_poll_session);
    EXPORT_FN("getState", fn_get_state);
    EXPORT_FN("getError", fn_get_error);
    EXPORT_FN("disconnect", fn_disconnect_session);
    EXPORT_FN("destroy", fn_destroy_session);
    EXPORT_FN("sendMouse", fn_send_mouse);
    EXPORT_FN("sendKeyboard", fn_send_keyboard);
    EXPORT_FN("sendUnicode", fn_send_unicode);
    EXPORT_FN("resize", fn_resize_session);
    EXPORT_FN("sendFrameAck", fn_send_frame_ack);
    EXPORT_FN("gfxIsActive", fn_gfx_is_active);
    EXPORT_FN("gfxGetCodec", fn_gfx_get_codec);
    EXPORT_FN("drainGfxEvents", fn_drain_gfx_events);
    EXPORT_FN("drainOpusFrames", fn_drain_opus);
    EXPORT_FN("clipboardSetText", fn_clipboard_set_text);
    EXPORT_FN("clipboardSetFiles", fn_clipboard_set_files);
    EXPORT_FN("clipboardPopEvent", fn_clipboard_pop_event);
    EXPORT_FN("clipboardDownloadFile", fn_clipboard_download_file);
    EXPORT_FN("setAudioContext", fn_set_audio_context);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
