/**
 * RDP Bridge Native Library Implementation
 * 
 * Uses FreeRDP3 libfreerdp for direct RDP connection with:
 * - GFX pipeline with H.264/AVC444 support for low-latency video
 * - GDI software rendering as fallback
 * - Dirty rectangle tracking for delta updates
 * - Direct input injection (no X11/xdotool)
 */

#include "rdp_bridge.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <errno.h>
#include <inttypes.h>
#include <dlfcn.h>
#include <time.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <malloc.h>  /* For malloc_trim() */
#ifndef __GLIBC__
static int malloc_trim(size_t pad) { (void)pad; return 0; }
#endif

/* FreeRDP3 headers */
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/addin.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/channels/drdynvc.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/utils/cliprdr_utils.h>
#include <freerdp/client/disp.h>
#include <freerdp/client/rdpsnd.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/client/channels.h>
#include <freerdp/event.h>
#include <freerdp/codec/planar.h>
#include <freerdp/codec/progressive.h>
#include <freerdp/codec/color.h>
#include <freerdp/graphics.h>
#include <opus/opus.h>
#include <winpr/crt.h>
#include <winpr/synch.h>
#include <winpr/thread.h>
#include <winpr/collections.h>
#include <winpr/user.h>
#include <winpr/file.h>
#include <freerdp/codec/region.h>

/* FFmpeg for AVC444 transcoding (4:4:4 → 4:2:0) */
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>

/* libwebp for encoding tiles (ClearCodec, Uncompressed, Planar → WebP) */
#include <webp/encode.h>

#define RDP_BRIDGE_VERSION "3.0.0"
#define MAX_ERROR_LEN 512
#define ZEPHYR_CLIP_FORMAT_FILEGROUP 0xC0FDu
#define ZEPHYR_CLIP_MAX_CHUNK (1024u * 1024u)
#define ZEPHYR_CLIP_EVENT_CAPACITY 256

typedef struct {
    char* path;
    char* name;
    uint64_t size;
} RdpClipboardFile;

typedef struct {
    char* name;
    uint64_t size;
    uint32_t flags;
} RdpRemoteClipboardFile;

/* Debug flags - set to 1 to enable verbose logging for specific subsystems */
#define DEBUG_GFX_FILL 0         /* Log all SolidFill operations */
#define DEBUG_GFX_COPY 0         /* Log all SurfaceToSurface operations */

/* Session registry limits */
#define RDP_MAX_SESSIONS_DEFAULT 100
#define RDP_MAX_SESSIONS_MIN 2
#define RDP_MAX_SESSIONS_MAX 1000

/* Forward declaration of internal FreeRDP cache structures.
 * These are internal (FREERDP_LOCAL) in FreeRDP but we need them for
 * pointer caching since DeactivateClientDecoding=TRUE skips the normal
 * pointer_cache_register_callbacks() call. */
typedef struct _BridgePointerCache {
    UINT32 cacheSize;
    rdpPointer** entries;
    rdpContext* context;
} BridgePointerCache;

typedef struct _BridgeCache {
    void* glyph;               /* rdpGlyphCache* - unused by us */
    void* brush;               /* rdpBrushCache* - unused by us */
    BridgePointerCache* pointer;
    void* bitmap;              /* rdpBitmapCache* - unused by us */
    void* offscreen;           /* rdpOffscreenCache* - unused by us */
    void* palette;             /* rdpPaletteCache* - unused by us */
    void* nine_grid;           /* rdpNineGridCache* - unused by us */
} BridgeCache;

/* Extended client context */
typedef struct {
    rdpClientContext common;        /* Must be first */
    
    /* Our custom fields */
    RdpState state;
    char error_msg[MAX_ERROR_LEN];
    
    /* Frame dimensions (tracked for resize detection) */
    int frame_width;
    int frame_height;
    
    /* Resize pending */
    bool resize_pending;
    uint32_t pending_width;
    uint32_t pending_height;
    
    /* Display control channel */
    DispClientContext* disp;
    
    /* Graphics pipeline channel */
    RdpgfxClientContext* gfx;
    bool gfx_active;                /* GFX pipeline successfully initialized */
    bool gfx_disconnecting;         /* Connection is being torn down - don't call GDI */
    RdpGfxCodecId gfx_codec;        /* Negotiated codec */
    bool gfx_pipeline_needs_init;   /* Deferred GFX pipeline init flag */
    bool gfx_pipeline_ready;        /* GFX pipeline ready for events */
    
    /* GFX surfaces */
    RdpGfxSurface surfaces[RDP_MAX_GFX_SURFACES];
    uint16_t primary_surface_id;
    uint32_t current_frame_id;      /* Current frame ID from start_frame */
    uint32_t last_completed_frame_id; /* Last frame ID that completed (EndFrame called) */
    uint32_t frame_cmd_count;       /* Commands received in current frame */
    bool gfx_frame_in_progress;     /* True between StartFrame and EndFrame */
    uint32_t fallback_frame_id;     /* Synthetic GDI fallback frame counter */
    uint64_t last_fallback_ms;      /* Last fallback capture time */
    pthread_mutex_t gfx_mutex;
    
    /* Audio playback */
    rdpsndDevicePlugin* rdpsnd;
    OpusEncoder* opus_encoder;
    uint8_t* audio_buffer;
    size_t audio_buffer_size;
    size_t audio_buffer_pos;
    size_t audio_read_pos;
    pthread_mutex_t audio_mutex;
    int audio_sample_rate;
    int audio_channels;
    int audio_bits;
    bool audio_initialized;
    
    /* Opus audio buffer (for native audio streaming) */
    uint8_t* opus_buffer;
    size_t opus_buffer_size;
    size_t opus_write_pos;
    size_t opus_read_pos;
    pthread_mutex_t opus_mutex;
    int opus_sample_rate;
    int opus_channels;
    volatile int opus_initialized;
    
    /* AVC444 transcoder (4:4:4 → 4:2:0 for browser compatibility) */
    AVCodecContext* avc_decoder_luma;
    AVCodecContext* avc_decoder_chroma;
    AVCodecContext* avc_encoder;
    struct SwsContext* sws_ctx;
    AVFrame* decoded_frame_luma;
    AVFrame* decoded_frame_chroma;
    AVFrame* combined_frame;       /* Combined YUV444 */
    AVFrame* output_frame;         /* Converted YUV420 */
    AVPacket* encode_pkt;
    bool transcoder_initialized;
    
    /* Planar codec decoder (thread-safe, no GDI dependency)
     * Note: ClearCodec and Progressive are passed through to browser for WASM decoding */
    BITMAP_PLANAR_CONTEXT* planar_decoder;
    
    /* GFX event queue for wire format streaming (Python consumption)
     * Dynamically allocated: starts at RDP_GFX_EVENTS_INITIAL, grows by
     * RDP_GFX_EVENTS_GROW up to RDP_MAX_GFX_EVENTS */
    RdpGfxEvent* gfx_events;
    int gfx_events_capacity;
    int gfx_event_write_idx;
    int gfx_event_read_idx;
    int gfx_event_count;
    pthread_mutex_t gfx_event_mutex;

    /* Native CLIPRDR clipboard bridge (text + FileGroupDescriptorW/FileContents) */
    CliprdrClientContext* cliprdr;
    pthread_mutex_t clip_mutex;
    pthread_cond_t clip_cond;
    char* clip_local_text;
    RdpClipboardFile* clip_local_files;
    uint32_t clip_local_file_count;
    RdpRemoteClipboardFile* clip_remote_files;
    uint32_t clip_remote_file_count;
    uint32_t clip_remote_text_format_id;
    uint32_t clip_remote_file_format_id;
    uint32_t clip_remote_capability_flags;
    uint32_t clip_pending_format_id;
    uint32_t clip_next_stream_id;
    uint32_t clip_pending_stream_id;
    bool clip_pending_done;
    uint16_t clip_pending_flags;
    uint8_t* clip_pending_data;
    uint32_t clip_pending_size;
    char** clip_events;
    int clip_event_capacity;
    int clip_event_write_idx;
    int clip_event_read_idx;
    int clip_event_count;
    pthread_mutex_t clip_event_mutex;
    
} BridgeContext;

/* Forward declarations */
static BOOL bridge_pre_connect(freerdp* instance);
static BOOL bridge_post_connect(freerdp* instance);
static void bridge_post_disconnect(freerdp* instance);
static BOOL bridge_desktop_resize(rdpContext* context);
static void bridge_on_channel_connected(void* ctx, const ChannelConnectedEventArgs* e);
static void bridge_on_channel_disconnected(void* ctx, const ChannelDisconnectedEventArgs* e);

/* CLIPRDR callback forward declarations */
static UINT clip_on_monitor_ready(CliprdrClientContext* context, const CLIPRDR_MONITOR_READY* monitorReady);
static UINT clip_on_server_capabilities(CliprdrClientContext* context, const CLIPRDR_CAPABILITIES* capabilities);
static UINT clip_on_server_format_list(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST* formatList);
static UINT clip_on_server_format_list_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST_RESPONSE* formatListResponse);
static UINT clip_on_server_format_data_request(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_REQUEST* formatDataRequest);
static UINT clip_on_server_format_data_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_RESPONSE* formatDataResponse);
static UINT clip_on_server_file_contents_request(CliprdrClientContext* context, const CLIPRDR_FILE_CONTENTS_REQUEST* fileContentsRequest);
static UINT clip_on_server_file_contents_response(CliprdrClientContext* context, const CLIPRDR_FILE_CONTENTS_RESPONSE* fileContentsResponse);

/* GFX pipeline callback forward declarations */
static UINT gfx_on_caps_confirm(RdpgfxClientContext* context, const RDPGFX_CAPS_CONFIRM_PDU* caps);
static UINT gfx_on_reset_graphics(RdpgfxClientContext* context, const RDPGFX_RESET_GRAPHICS_PDU* reset);
static UINT gfx_on_create_surface(RdpgfxClientContext* context, const RDPGFX_CREATE_SURFACE_PDU* create);
static UINT gfx_on_delete_surface(RdpgfxClientContext* context, const RDPGFX_DELETE_SURFACE_PDU* del);
static UINT gfx_on_map_surface(RdpgfxClientContext* context, const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* map);
static UINT gfx_on_map_surface_scaled(RdpgfxClientContext* context, const RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU* map);
static UINT gfx_on_map_surface_window(RdpgfxClientContext* context, const RDPGFX_MAP_SURFACE_TO_WINDOW_PDU* map);
static UINT gfx_on_map_surface_scaled_window(RdpgfxClientContext* context, const RDPGFX_MAP_SURFACE_TO_SCALED_WINDOW_PDU* map);
static UINT gfx_on_surface_command(RdpgfxClientContext* context, const RDPGFX_SURFACE_COMMAND* cmd);
static UINT gfx_on_start_frame(RdpgfxClientContext* context, const RDPGFX_START_FRAME_PDU* start);
static UINT gfx_on_end_frame(RdpgfxClientContext* context, const RDPGFX_END_FRAME_PDU* end);
static UINT gfx_on_solid_fill(RdpgfxClientContext* context, const RDPGFX_SOLID_FILL_PDU* fill);
static UINT gfx_on_surface_to_surface(RdpgfxClientContext* context, const RDPGFX_SURFACE_TO_SURFACE_PDU* copy);
static UINT gfx_on_surface_to_cache(RdpgfxClientContext* context, const RDPGFX_SURFACE_TO_CACHE_PDU* cache);
static UINT gfx_on_cache_to_surface(RdpgfxClientContext* context, const RDPGFX_CACHE_TO_SURFACE_PDU* cache);
static UINT gfx_on_evict_cache(RdpgfxClientContext* context, const RDPGFX_EVICT_CACHE_ENTRY_PDU* evict);
static UINT gfx_on_delete_encoding_context(RdpgfxClientContext* context, const RDPGFX_DELETE_ENCODING_CONTEXT_PDU* del);
static UINT gfx_on_cache_import_reply(RdpgfxClientContext* context, const RDPGFX_CACHE_IMPORT_REPLY_PDU* reply);
static UINT gfx_on_open(RdpgfxClientContext* context, BOOL* do_caps_advertise, BOOL* do_frame_acks);

/* GFX event queue helpers */
static void gfx_queue_event(BridgeContext* ctx, const RdpGfxEvent* event);
static void gfx_free_event_data(RdpGfxEvent* event);

/* WebP tile encoding helper */
static void queue_webp_tile(BridgeContext* ctx, uint16_t surface_id,
                            int32_t x, int32_t y, uint32_t width, uint32_t height,
                            const uint8_t* bgra_data, int stride);
static void maybe_queue_gdi_fallback_frame(BridgeContext* ctx);

/* Transcoder forward declarations */
static bool init_transcoder(BridgeContext* ctx, int width, int height);
static void cleanup_transcoder(BridgeContext* ctx);
static bool transcode_avc444(BridgeContext* ctx,
                             const uint8_t* luma_data, uint32_t luma_size,
                             const uint8_t* chroma_data, uint32_t chroma_size,
                             uint8_t** out_data, uint32_t* out_size);

/* Deferred GDI pipeline initialization - call from main thread */
static void maybe_init_gfx_pipeline(BridgeContext* bctx);

/* Global audio context structure for plugin communication.
 * This is a regular global (not thread-local) because the rdpsnd plugin
 * runs in a different thread from the main Python thread, and we need
 * both threads to access the same buffer.
 * 
 * MULTI-SESSION NOTE: This global is protected by g_connect_mutex during the
 * connect phase. Each session has its own audio buffer; this global just
 * serves as a handoff mechanism to the plugin during Open callback.
 * 
 * For multi-session support, write_pos and read_pos are POINTERS to the
 * actual positions in the BridgeContext. */
static struct {
    uint8_t* opus_buffer;
    size_t opus_buffer_size;
    size_t* opus_write_pos;         /* POINTER to BridgeContext.opus_write_pos */
    size_t* opus_read_pos;          /* POINTER to BridgeContext.opus_read_pos */
    void* opus_mutex;
    int sample_rate;
    int channels;
    volatile int* initialized;      /* POINTER to BridgeContext.opus_initialized */
} g_audio_ctx;

/* Mutex to protect the connect phase (g_audio_ctx handoff to plugin) */
static pthread_mutex_t g_connect_mutex = PTHREAD_MUTEX_INITIALIZER;

/* ============================================================================
 * Native CLIPRDR helpers (text + FileGroupDescriptorW/FileContents)
 * ============================================================================ */

static void clip_free_local_files(BridgeContext* ctx)
{
    if (!ctx || !ctx->clip_local_files) return;
    for (uint32_t i = 0; i < ctx->clip_local_file_count; i++) {
        free(ctx->clip_local_files[i].path);
        free(ctx->clip_local_files[i].name);
    }
    free(ctx->clip_local_files);
    ctx->clip_local_files = NULL;
    ctx->clip_local_file_count = 0;
}

static void clip_free_remote_files(BridgeContext* ctx)
{
    if (!ctx || !ctx->clip_remote_files) return;
    for (uint32_t i = 0; i < ctx->clip_remote_file_count; i++) free(ctx->clip_remote_files[i].name);
    free(ctx->clip_remote_files);
    ctx->clip_remote_files = NULL;
    ctx->clip_remote_file_count = 0;
}

static char* clip_json_escape(const char* s)
{
    if (!s) return strdup("");
    size_t cap = strlen(s) * 6 + 1;
    char* out = (char*)calloc(1, cap);
    if (!out) return NULL;
    size_t p = 0;
    for (const unsigned char* c = (const unsigned char*)s; *c; c++) {
        if (p + 8 >= cap) {
            cap *= 2;
            char* n = (char*)realloc(out, cap);
            if (!n) { free(out); return NULL; }
            out = n;
        }
        switch (*c) {
            case '\\': out[p++]='\\'; out[p++]='\\'; break;
            case '"': out[p++]='\\'; out[p++]='"'; break;
            case '\n': out[p++]='\\'; out[p++]='n'; break;
            case '\r': out[p++]='\\'; out[p++]='r'; break;
            case '\t': out[p++]='\\'; out[p++]='t'; break;
            default:
                if (*c < 0x20) p += snprintf(out + p, cap - p, "\\u%04x", *c);
                else out[p++] = (char)*c;
        }
    }
    out[p] = '\0';
    return out;
}

static void clip_queue_json(BridgeContext* ctx, char* json)
{
    if (!ctx || !json) return;
    pthread_mutex_lock(&ctx->clip_event_mutex);
    if (!ctx->clip_events || ctx->clip_event_capacity <= 0) {
        pthread_mutex_unlock(&ctx->clip_event_mutex);
        free(json);
        return;
    }
    if (ctx->clip_event_count >= ctx->clip_event_capacity) {
        free(ctx->clip_events[ctx->clip_event_read_idx]);
        ctx->clip_events[ctx->clip_event_read_idx] = NULL;
        ctx->clip_event_read_idx = (ctx->clip_event_read_idx + 1) % ctx->clip_event_capacity;
        ctx->clip_event_count--;
    }
    ctx->clip_events[ctx->clip_event_write_idx] = json;
    ctx->clip_event_write_idx = (ctx->clip_event_write_idx + 1) % ctx->clip_event_capacity;
    ctx->clip_event_count++;
    pthread_mutex_unlock(&ctx->clip_event_mutex);
}

static void clip_queue_text_event(BridgeContext* ctx, const char* text)
{
    char* esc = clip_json_escape(text ? text : "");
    if (!esc) return;
    size_t len = strlen(esc) + 64;
    char* json = (char*)calloc(1, len);
    if (json) snprintf(json, len, "{\"type\":\"clipboard-text\",\"text\":\"%s\"}", esc);
    free(esc);
    clip_queue_json(ctx, json);
}

static void clip_queue_files_event_locked(BridgeContext* ctx)
{
    size_t cap = 128 + (size_t)ctx->clip_remote_file_count * 420;
    char* json = (char*)calloc(1, cap);
    if (!json) return;
    size_t p = snprintf(json, cap, "{\"type\":\"clipboard-files\",\"files\":[");
    for (uint32_t i = 0; i < ctx->clip_remote_file_count; i++) {
        char* esc = clip_json_escape(ctx->clip_remote_files[i].name ? ctx->clip_remote_files[i].name : "file");
        if (!esc) esc = strdup("file");
        size_t need = p + strlen(esc) + 128;
        if (need >= cap) {
            cap = need + 1024;
            char* n = (char*)realloc(json, cap);
            if (!n) { free(esc); free(json); return; }
            json = n;
        }
        p += snprintf(json + p, cap - p, "%s{\"index\":%u,\"name\":\"%s\",\"size\":%" PRIu64 "}",
                      i ? "," : "", i, esc, (uint64_t)ctx->clip_remote_files[i].size);
        free(esc);
    }
    snprintf(json + p, cap - p, "]}");
    clip_queue_json(ctx, json);
}

static uint32_t clip_decode_utf8_char(const unsigned char** pp)
{
    const unsigned char* p = *pp;
    if (*p < 0x80) { *pp = p + 1; return *p; }
    if ((*p & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
        uint32_t cp = ((*p & 0x1F) << 6) | (p[1] & 0x3F); *pp = p + 2; return cp;
    }
    if ((*p & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
        uint32_t cp = ((*p & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F); *pp = p + 3; return cp;
    }
    if ((*p & 0xF8) == 0xF0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80) {
        uint32_t cp = ((*p & 0x07) << 18) | ((p[1] & 0x3F) << 12) | ((p[2] & 0x3F) << 6) | (p[3] & 0x3F); *pp = p + 4; return cp;
    }
    *pp = p + 1;
    return 0xFFFD;
}

static bool clip_utf8_to_utf16le(const char* text, uint8_t** out, uint32_t* out_len)
{
    if (!out || !out_len) return false;
    *out = NULL; *out_len = 0;
    const unsigned char* p = (const unsigned char*)(text ? text : "");
    size_t cap = strlen((const char*)p) * 4 + 4;
    uint8_t* buf = (uint8_t*)calloc(1, cap);
    if (!buf) return false;
    size_t n = 0;
    while (*p) {
        uint32_t cp = clip_decode_utf8_char(&p);
        if (cp > 0x10FFFF) cp = 0xFFFD;
        if (cp <= 0xFFFF) {
            if (n + 2 >= cap) { cap *= 2; uint8_t* nb = (uint8_t*)realloc(buf, cap); if (!nb) { free(buf); return false; } buf = nb; }
            buf[n++] = (uint8_t)(cp & 0xFF); buf[n++] = (uint8_t)((cp >> 8) & 0xFF);
        } else {
            cp -= 0x10000;
            uint16_t hi = 0xD800 | (uint16_t)(cp >> 10);
            uint16_t lo = 0xDC00 | (uint16_t)(cp & 0x3FF);
            if (n + 4 >= cap) { cap *= 2; uint8_t* nb = (uint8_t*)realloc(buf, cap); if (!nb) { free(buf); return false; } buf = nb; }
            buf[n++] = (uint8_t)(hi & 0xFF); buf[n++] = (uint8_t)(hi >> 8);
            buf[n++] = (uint8_t)(lo & 0xFF); buf[n++] = (uint8_t)(lo >> 8);
        }
    }
    buf[n++] = 0; buf[n++] = 0;
    *out = buf; *out_len = (uint32_t)n;
    return true;
}

static char* clip_utf16le_to_utf8(const uint8_t* data, uint32_t len)
{
    if (!data || len < 2) return strdup("");
    size_t cap = (size_t)len * 2 + 1;
    char* out = (char*)calloc(1, cap);
    if (!out) return NULL;
    size_t p = 0;
    for (uint32_t i = 0; i + 1 < len; i += 2) {
        uint32_t w = (uint32_t)data[i] | ((uint32_t)data[i + 1] << 8);
        if (!w) break;
        uint32_t cp = w;
        if (w >= 0xD800 && w <= 0xDBFF && i + 3 < len) {
            uint32_t lo = (uint32_t)data[i + 2] | ((uint32_t)data[i + 3] << 8);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + (((w - 0xD800) << 10) | (lo - 0xDC00));
                i += 2;
            }
        }
        if (p + 5 >= cap) { cap *= 2; char* n = (char*)realloc(out, cap); if (!n) { free(out); return NULL; } out = n; }
        if (cp < 0x80) out[p++] = (char)cp;
        else if (cp < 0x800) { out[p++] = (char)(0xC0 | (cp >> 6)); out[p++] = (char)(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out[p++] = (char)(0xE0 | (cp >> 12)); out[p++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[p++] = (char)(0x80 | (cp & 0x3F)); }
        else { out[p++] = (char)(0xF0 | (cp >> 18)); out[p++] = (char)(0x80 | ((cp >> 12) & 0x3F)); out[p++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[p++] = (char)(0x80 | (cp & 0x3F)); }
    }
    out[p] = '\0';
    return out;
}

static char* clip_wchar_to_utf8(const WCHAR* text, size_t max)
{
    size_t bytes = 0;
    while (bytes / 2 < max && text[bytes / 2]) bytes += 2;
    uint8_t* raw = (uint8_t*)calloc(1, bytes + 2);
    if (!raw) return NULL;
    for (size_t i = 0; i < bytes / 2; i++) { raw[i * 2] = (uint8_t)(text[i] & 0xFF); raw[i * 2 + 1] = (uint8_t)(text[i] >> 8); }
    char* out = clip_utf16le_to_utf8(raw, (uint32_t)(bytes + 2));
    free(raw);
    return out;
}

static void clip_utf8_to_wchar_name(const char* name, WCHAR out[260])
{
    memset(out, 0, sizeof(WCHAR) * 260);
    const unsigned char* p = (const unsigned char*)(name ? name : "file");
    size_t n = 0;
    while (*p && n < 259) {
        uint32_t cp = clip_decode_utf8_char(&p);
        if (cp > 0xFFFF) cp = '_';
        out[n++] = (WCHAR)cp;
    }
}

static UINT clip_send_client_capabilities(BridgeContext* ctx)
{
    if (!ctx || !ctx->cliprdr || !ctx->cliprdr->ClientCapabilities) return CHANNEL_RC_OK;
    CLIPRDR_GENERAL_CAPABILITY_SET general = { CB_CAPSTYPE_GENERAL, CB_CAPSTYPE_GENERAL_LEN, CB_CAPS_VERSION_2,
        CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS | CB_HUGE_FILE_SUPPORT_ENABLED };
    CLIPRDR_CAPABILITIES caps = { { CB_TYPE_NONE, 0, 0 }, 1, (CLIPRDR_CAPABILITY_SET*)&general };
    return ctx->cliprdr->ClientCapabilities(ctx->cliprdr, &caps);
}

static UINT clip_send_client_format_list(BridgeContext* ctx)
{
    if (!ctx || !ctx->cliprdr || !ctx->cliprdr->ClientFormatList) return CHANNEL_RC_OK;
    CLIPRDR_FORMAT formats[2] = { 0 };
    UINT32 n = 0;
    pthread_mutex_lock(&ctx->clip_mutex);
    bool has_text = ctx->clip_local_text && ctx->clip_local_text[0];
    bool has_files = ctx->clip_local_file_count > 0;
    pthread_mutex_unlock(&ctx->clip_mutex);
    if (has_text) formats[n++] = (CLIPRDR_FORMAT){ CF_UNICODETEXT, NULL };
    if (has_files) formats[n++] = (CLIPRDR_FORMAT){ ZEPHYR_CLIP_FORMAT_FILEGROUP, "FileGroupDescriptorW" };
    CLIPRDR_FORMAT_LIST list = { { CB_FORMAT_LIST, 0, 0 }, n, formats };
    return ctx->cliprdr->ClientFormatList(ctx->cliprdr, &list);
}

static UINT clip_send_format_list_response(BridgeContext* ctx, BOOL ok)
{
    if (!ctx || !ctx->cliprdr || !ctx->cliprdr->ClientFormatListResponse) return CHANNEL_RC_OK;
    CLIPRDR_FORMAT_LIST_RESPONSE resp = { { CB_FORMAT_LIST_RESPONSE, (UINT16)(ok ? CB_RESPONSE_OK : CB_RESPONSE_FAIL), 0 } };
    return ctx->cliprdr->ClientFormatListResponse(ctx->cliprdr, &resp);
}

static UINT clip_send_data_response(BridgeContext* ctx, const BYTE* data, UINT32 size, BOOL ok)
{
    if (!ctx || !ctx->cliprdr || !ctx->cliprdr->ClientFormatDataResponse) return CHANNEL_RC_OK;
    CLIPRDR_FORMAT_DATA_RESPONSE resp = { 0 };
    resp.common.msgType = CB_FORMAT_DATA_RESPONSE;
    resp.common.msgFlags = (UINT16)(ok ? CB_RESPONSE_OK : CB_RESPONSE_FAIL);
    resp.common.dataLen = ok ? size : 0;
    resp.requestedFormatData = ok ? data : NULL;
    return ctx->cliprdr->ClientFormatDataResponse(ctx->cliprdr, &resp);
}

static UINT clip_send_file_contents_response(BridgeContext* ctx, const CLIPRDR_FILE_CONTENTS_REQUEST* req, const BYTE* data, UINT32 size, BOOL ok)
{
    if (!ctx || !ctx->cliprdr || !ctx->cliprdr->ClientFileContentsResponse || !req) return CHANNEL_RC_OK;
    CLIPRDR_FILE_CONTENTS_RESPONSE resp = { 0 };
    resp.common.msgType = CB_FILECONTENTS_RESPONSE;
    resp.common.msgFlags = (UINT16)(ok ? CB_RESPONSE_OK : CB_RESPONSE_FAIL);
    resp.streamId = req->streamId;
    resp.cbRequested = ok ? size : 0;
    resp.requestedData = ok ? data : NULL;
    return ctx->cliprdr->ClientFileContentsResponse(ctx->cliprdr, &resp);
}

static BYTE* clip_build_local_file_descriptors(BridgeContext* ctx, UINT32* out_size)
{
    if (!ctx || !out_size) return NULL;
    *out_size = 0;
    pthread_mutex_lock(&ctx->clip_mutex);
    const uint32_t count = ctx->clip_local_file_count;
    if (!count) { pthread_mutex_unlock(&ctx->clip_mutex); return NULL; }
    FILEDESCRIPTORW* desc = (FILEDESCRIPTORW*)calloc(count, sizeof(FILEDESCRIPTORW));
    if (!desc) { pthread_mutex_unlock(&ctx->clip_mutex); return NULL; }
    for (uint32_t i = 0; i < count; i++) {
        desc[i].dwFlags = FD_ATTRIBUTES | FD_FILESIZE;
        desc[i].dwFileAttributes = FILE_ATTRIBUTE_NORMAL;
        desc[i].nFileSizeHigh = (DWORD)(ctx->clip_local_files[i].size >> 32);
        desc[i].nFileSizeLow = (DWORD)(ctx->clip_local_files[i].size & 0xFFFFFFFFu);
        clip_utf8_to_wchar_name(ctx->clip_local_files[i].name, desc[i].cFileName);
    }
    UINT32 flags = ctx->clip_remote_capability_flags;
    pthread_mutex_unlock(&ctx->clip_mutex);
    BYTE* data = NULL;
    UINT32 size = 0;
    if (cliprdr_serialize_file_list_ex(flags, desc, count, &data, &size) != CHANNEL_RC_OK) {
        free(desc);
        return NULL;
    }
    free(desc);
    *out_size = size;
    return data;
}

static const char* clip_basename(const char* path)
{
    if (!path || !*path) return "file";
    const char* a = strrchr(path, '/');
    const char* b = strrchr(path, '\\');
    const char* p = a > b ? a : b;
    return p ? p + 1 : path;
}


/* Mutex for thread-safe logging to stderr */
static pthread_mutex_t g_log_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Thread-safe logging function - writes entire buffer atomically */
static void log_stderr(const char* buffer)
{
    pthread_mutex_lock(&g_log_mutex);
    fputs(buffer, stderr);
    fflush(stderr);
    pthread_mutex_unlock(&g_log_mutex);
}

/* ============================================================================
 * Session Registry for Multi-User Audio Isolation
 * 
 * Maps rdpContext pointers to BridgeContext pointers so the RDPSND plugin
 * can look up the correct audio buffer for each session.
 * ============================================================================ */

typedef struct {
    rdpContext* rdp_ctx;
    BridgeContext* bridge_ctx;
} SessionEntry;

static SessionEntry* g_session_registry = NULL;
static int g_session_count = 0;
static int g_max_sessions = RDP_MAX_SESSIONS_DEFAULT;
static pthread_mutex_t g_registry_mutex = PTHREAD_MUTEX_INITIALIZER;
static volatile int g_registry_initialized = 0;

/* Set maximum allowed sessions (called from Python at startup) */
__attribute__((visibility("default")))
int rdp_set_max_sessions(int limit)
{
    pthread_mutex_lock(&g_registry_mutex);
    
    if (limit < RDP_MAX_SESSIONS_MIN) {
        fprintf(stderr, "[rdp_bridge] Warning: RDP_MAX_SESSIONS=%d is below minimum %d, using %d\n",
                limit, RDP_MAX_SESSIONS_MIN, RDP_MAX_SESSIONS_MIN);
        limit = RDP_MAX_SESSIONS_MIN;
    } else if (limit > RDP_MAX_SESSIONS_MAX) {
        fprintf(stderr, "[rdp_bridge] Warning: RDP_MAX_SESSIONS=%d exceeds maximum %d, using %d\n",
                limit, RDP_MAX_SESSIONS_MAX, RDP_MAX_SESSIONS_MAX);
        limit = RDP_MAX_SESSIONS_MAX;
    }
    
    /* Only allow changing if no sessions are active */
    if (g_session_count > 0) {
        fprintf(stderr, "[rdp_bridge] Warning: Cannot change max sessions while sessions are active\n");
        pthread_mutex_unlock(&g_registry_mutex);
        return -1;
    }
    
    /* Free old registry if it exists */
    if (g_session_registry) {
        free(g_session_registry);
        g_session_registry = NULL;
    }
    
    g_max_sessions = limit;
    g_session_registry = calloc(g_max_sessions, sizeof(SessionEntry));
    if (!g_session_registry) {
        fprintf(stderr, "[rdp_bridge] ERROR: Failed to allocate session registry for %d sessions\n", g_max_sessions);
        pthread_mutex_unlock(&g_registry_mutex);
        return -1;
    }
    
    g_registry_initialized = 1;
    
    pthread_mutex_unlock(&g_registry_mutex);
    return 0;
}

/* Get current max sessions limit */
__attribute__((visibility("default")))
int rdp_get_max_sessions(void)
{
    return g_max_sessions;
}

/* Register a session in the registry */
static int session_registry_add(rdpContext* rdp_ctx, BridgeContext* bridge_ctx)
{
    pthread_mutex_lock(&g_registry_mutex);
    
    /* Initialize registry if not done yet */
    if (!g_registry_initialized) {
        g_session_registry = calloc(g_max_sessions, sizeof(SessionEntry));
        if (!g_session_registry) {
            fprintf(stderr, "[rdp_bridge] ERROR: Failed to allocate session registry\n");
            pthread_mutex_unlock(&g_registry_mutex);
            return -1;
        }
        g_registry_initialized = 1;
    }
    
    /* Check if we're at capacity */
    if (g_session_count >= g_max_sessions) {
        fprintf(stderr, "[rdp_bridge] ERROR: Session limit reached (%d/%d) - cannot create new session\n",
                g_session_count, g_max_sessions);
        pthread_mutex_unlock(&g_registry_mutex);
        return -2; /* Distinct error code for limit reached */
    }
    
    /* Find empty slot */
    for (int i = 0; i < g_max_sessions; i++) {
        if (g_session_registry[i].rdp_ctx == NULL) {
            g_session_registry[i].rdp_ctx = rdp_ctx;
            g_session_registry[i].bridge_ctx = bridge_ctx;
            g_session_count++;
            pthread_mutex_unlock(&g_registry_mutex);
            return 0;
        }
    }
    
    fprintf(stderr, "[rdp_bridge] ERROR: No empty slot found in session registry\n");
    pthread_mutex_unlock(&g_registry_mutex);
    return -1;
}

/* Unregister a session from the registry */
static void session_registry_remove(rdpContext* rdp_ctx)
{
    pthread_mutex_lock(&g_registry_mutex);
    
    if (!g_session_registry) {
        pthread_mutex_unlock(&g_registry_mutex);
        return;
    }
    
    for (int i = 0; i < g_max_sessions; i++) {
        if (g_session_registry[i].rdp_ctx == rdp_ctx) {
            g_session_registry[i].rdp_ctx = NULL;
            g_session_registry[i].bridge_ctx = NULL;
            g_session_count--;
            break;
        }
    }
    
    pthread_mutex_unlock(&g_registry_mutex);
}

/* Look up BridgeContext by rdpContext (exported for plugin use) */
__attribute__((visibility("default")))
void* rdp_lookup_session_by_rdpcontext(void* rdp_ctx)
{
    if (!rdp_ctx) return NULL;
    
    pthread_mutex_lock(&g_registry_mutex);
    
    if (!g_session_registry) {
        pthread_mutex_unlock(&g_registry_mutex);
        return NULL;
    }
    
    for (int i = 0; i < g_max_sessions; i++) {
        if (g_session_registry[i].rdp_ctx == (rdpContext*)rdp_ctx) {
            BridgeContext* ctx = g_session_registry[i].bridge_ctx;
            pthread_mutex_unlock(&g_registry_mutex);
            return ctx;
        }
    }
    
    pthread_mutex_unlock(&g_registry_mutex);
    return NULL;
}

/* Get audio context for a specific session (exported for plugin use)
 * Returns a thread-local struct with POINTERS to the BridgeContext fields */
__attribute__((visibility("default")))
void* rdp_get_session_audio_context(void* session_ptr)
{
    BridgeContext* ctx = (BridgeContext*)session_ptr;
    if (!ctx) return NULL;
    
    /* Return a pointer to a structure matching what the plugin expects
     * Using pointers for mutable fields so plugin writes update BridgeContext */
    static __thread struct {
        uint8_t* opus_buffer;
        size_t opus_buffer_size;
        size_t* opus_write_pos;
        size_t* opus_read_pos;
        void* opus_mutex;
        int sample_rate;
        int channels;
        volatile int* initialized;
    } session_audio_ctx;
    
    session_audio_ctx.opus_buffer = ctx->opus_buffer;
    session_audio_ctx.opus_buffer_size = ctx->opus_buffer_size;
    session_audio_ctx.opus_write_pos = &ctx->opus_write_pos;
    session_audio_ctx.opus_read_pos = &ctx->opus_read_pos;
    session_audio_ctx.opus_mutex = &ctx->opus_mutex;
    session_audio_ctx.sample_rate = ctx->opus_sample_rate;
    session_audio_ctx.channels = ctx->opus_channels;
    session_audio_ctx.initialized = &ctx->opus_initialized;
    
    return &session_audio_ctx;
}

/* ============================================================================
 * GFX/Codec Capability Logging
 * ============================================================================ */

#define LOG_BUFFER_SIZE 4096

#if ENABLE_VERBOSE_SETTINGS_LOG
static void log_settings(rdpSettings* settings, const char* phase)
{
    char buf[LOG_BUFFER_SIZE];
    int pos = 0;
    
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "┌──────────────────────────────────────────────────────────────┐\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ RDP Settings: %-46s │\n", phase);
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* Graphics Pipeline */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Graphics Pipeline                                            │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   SupportGraphicsPipeline: %-6s                            │\n",
            freerdp_settings_get_bool(settings, FreeRDP_SupportGraphicsPipeline) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   ColorDepth:              %-6u                            │\n",
            freerdp_settings_get_uint32(settings, FreeRDP_ColorDepth));
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* H.264/AVC Codecs */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ H.264/AVC Codecs                                             │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   GfxH264:      %-6s    GfxAVC444:     %-6s              │\n",
            freerdp_settings_get_bool(settings, FreeRDP_GfxH264) ? "YES" : "NO",
            freerdp_settings_get_bool(settings, FreeRDP_GfxAVC444) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   GfxAVC444v2:  %-6s                                       │\n",
            freerdp_settings_get_bool(settings, FreeRDP_GfxAVC444v2) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* Progressive/RemoteFX */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Progressive/RemoteFX                                         │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   GfxProgressive:   %-6s  GfxProgressiveV2: %-6s         │\n",
            freerdp_settings_get_bool(settings, FreeRDP_GfxProgressive) ? "YES" : "NO",
            freerdp_settings_get_bool(settings, FreeRDP_GfxProgressiveV2) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   RemoteFxCodec:    %-6s                                   │\n",
            freerdp_settings_get_bool(settings, FreeRDP_RemoteFxCodec) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* Other Codecs */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Other Codecs                                                 │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   NSCodec:    %-6s  JpegCodec:  %-6s  GfxPlanar: %-6s  │\n",
            freerdp_settings_get_bool(settings, FreeRDP_NSCodec) ? "YES" : "NO",
            freerdp_settings_get_bool(settings, FreeRDP_JpegCodec) ? "YES" : "NO",
            freerdp_settings_get_bool(settings, FreeRDP_GfxPlanar) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* GFX Flags */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ GFX Flags                                                    │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   SmallCache: %-6s  ThinClient: %-6s                     │\n",
            freerdp_settings_get_bool(settings, FreeRDP_GfxSmallCache) ? "YES" : "NO",
            freerdp_settings_get_bool(settings, FreeRDP_GfxThinClient) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   SendQoeAck: %-6s  SuspendFrameAck: %-6s                │\n",
            freerdp_settings_get_bool(settings, FreeRDP_GfxSendQoeAck) ? "YES" : "NO",
            freerdp_settings_get_bool(settings, FreeRDP_GfxSuspendFrameAck) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   GfxCapsFilter: 0x%08X                                  │\n",
            freerdp_settings_get_uint32(settings, FreeRDP_GfxCapsFilter));
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* Audio */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Audio                                                        │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   AudioPlayback:      %-6s                                 │\n",
            freerdp_settings_get_bool(settings, FreeRDP_AudioPlayback) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   AudioCapture:       %-6s                                 │\n",
            freerdp_settings_get_bool(settings, FreeRDP_AudioCapture) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   RemoteConsoleAudio: %-6s                                 │\n",
            freerdp_settings_get_bool(settings, FreeRDP_RemoteConsoleAudio) ? "YES" : "NO");
    
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "└──────────────────────────────────────────────────────────────┘\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "\n");
    
    log_stderr(buf);
}
#else
/* Stub when verbose logging is disabled */
static void log_settings(rdpSettings* settings, const char* phase)
{
    (void)settings;
    (void)phase;
}
#endif /* ENABLE_VERBOSE_SETTINGS_LOG */

/**
 * Queue init settings event for frontend (mirrors log_settings)
 * 
 * Packs boolean settings from freerdp_settings_get_bool into bitfields
 * and queues them as RDP_GFX_EVENT_INIT_SETTINGS for the Python bridge.
 * 
 * flagsLow bit mapping:
 *   bit 0:  SupportGraphicsPipeline
 *   bit 1:  GfxH264
 *   bit 2:  GfxAVC444
 *   bit 3:  GfxAVC444v2
 *   bit 4:  GfxProgressive
 *   bit 5:  GfxProgressiveV2
 *   bit 6:  RemoteFxCodec
 *   bit 7:  NSCodec
 *   bit 8:  JpegCodec
 *   bit 9:  GfxPlanar
 *   bit 10: GfxSmallCache
 *   bit 11: GfxThinClient
 *   bit 12: GfxSendQoeAck
 *   bit 13: GfxSuspendFrameAck
 *   bit 14: AudioPlayback
 *   bit 15: AudioCapture
 *   bit 16: RemoteConsoleAudio
 */
static void queue_init_settings(BridgeContext* ctx, rdpSettings* settings)
{
    uint32_t color_depth = freerdp_settings_get_uint32(settings, FreeRDP_ColorDepth);
    uint32_t flags_low = 0;
    
    /* Pack boolean settings into bitfield */
    if (freerdp_settings_get_bool(settings, FreeRDP_SupportGraphicsPipeline)) flags_low |= (1 << 0);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxH264))                  flags_low |= (1 << 1);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxAVC444))                flags_low |= (1 << 2);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxAVC444v2))              flags_low |= (1 << 3);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxProgressive))           flags_low |= (1 << 4);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxProgressiveV2))         flags_low |= (1 << 5);
    if (freerdp_settings_get_bool(settings, FreeRDP_RemoteFxCodec))            flags_low |= (1 << 6);
    if (freerdp_settings_get_bool(settings, FreeRDP_NSCodec))                  flags_low |= (1 << 7);
    if (freerdp_settings_get_bool(settings, FreeRDP_JpegCodec))                flags_low |= (1 << 8);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxPlanar))                flags_low |= (1 << 9);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxSmallCache))            flags_low |= (1 << 10);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxThinClient))            flags_low |= (1 << 11);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxSendQoeAck))            flags_low |= (1 << 12);
    if (freerdp_settings_get_bool(settings, FreeRDP_GfxSuspendFrameAck))       flags_low |= (1 << 13);
    if (freerdp_settings_get_bool(settings, FreeRDP_AudioPlayback))            flags_low |= (1 << 14);
    if (freerdp_settings_get_bool(settings, FreeRDP_AudioCapture))             flags_low |= (1 << 15);
    if (freerdp_settings_get_bool(settings, FreeRDP_RemoteConsoleAudio))       flags_low |= (1 << 16);
    
    /* Queue event for Python bridge */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_INIT_SETTINGS;
    event.init_color_depth = color_depth;
    event.init_flags_low = flags_low;
    event.init_flags_high = 0;  /* Reserved for future use */
    gfx_queue_event(ctx, &event);
    
    fprintf(stderr, "[rdp_bridge] Queued INIT_SETTINGS: colorDepth=%u, flagsLow=0x%08X\n",
            color_depth, flags_low);
}

#if ENABLE_VERBOSE_SETTINGS_LOG
static void log_caps_confirm(UINT32 version, UINT32 flags)
{
    char buf[LOG_BUFFER_SIZE];
    int pos = 0;
    
    /* Decode version */
    const char* version_str = "Unknown";
    bool h264_supported = false;
    switch (version) {
        case RDPGFX_CAPVERSION_8:    version_str = "8.0"; break;
        case RDPGFX_CAPVERSION_81:   version_str = "8.1"; break;
        case RDPGFX_CAPVERSION_10:   version_str = "10.0"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_101:  version_str = "10.1"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_102:  version_str = "10.2"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_103:  version_str = "10.3"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_104:  version_str = "10.4"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_105:  version_str = "10.5"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_106:  version_str = "10.6"; h264_supported = true; break;
        case RDPGFX_CAPVERSION_107:  version_str = "10.7"; h264_supported = true; break;
    }
    
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "┌──────────────────────────────────────────────────────────────┐\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Server CapsConfirm                                           │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   Version: %-8s (0x%08X)                             │\n", version_str, version);
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   Flags:   0x%08X                                        │\n", flags);
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* Flag breakdown - meaningful descriptions for each flag */
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Flag Breakdown                                               │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   Thin Client Mode:   %-8s  (limited graphics if Active) │\n",
            (flags & RDPGFX_CAPS_FLAG_THINCLIENT) ? "Active" : "Inactive");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   Small Cache:        %-8s  (reduced tile cache)         │\n",
            (flags & RDPGFX_CAPS_FLAG_SMALL_CACHE) ? "Active" : "Inactive");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   H.264 AVC420:       %-8s  (4:2:0 chroma subsampling)   │\n",
            (flags & RDPGFX_CAPS_FLAG_AVC420_ENABLED) ? "Enabled" : "Disabled");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   H.264 Blocked:      %-8s  (AVC_DISABLED flag)          │\n",
            (flags & RDPGFX_CAPS_FLAG_AVC_DISABLED) ? "YES!" : "No");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   AVC Thin Client:    %-8s  (reduced H.264 quality)      │\n",
            (flags & RDPGFX_CAPS_FLAG_AVC_THINCLIENT) ? "Active" : "Inactive");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
    
    /* Codec availability - based on negotiated version */
    bool progressive_supported = (version >= RDPGFX_CAPVERSION_81);  /* Progressive requires 8.1+ */
    bool clearcodec_supported = (version >= RDPGFX_CAPVERSION_8);    /* ClearCodec available in all GFX versions */
    
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│ Codec Availability                                           │\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   H.264/AVC:   %-6s   AVC420:      %-6s                  │\n",
            (h264_supported && !(flags & RDPGFX_CAPS_FLAG_AVC_DISABLED)) ? "YES" : "NO",
            (flags & RDPGFX_CAPS_FLAG_AVC420_ENABLED) ? "YES" : "NO");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   Progressive: %-6s   ClearCodec:  %-6s                  │\n",
            progressive_supported ? "YES" : "NO",
            clearcodec_supported ? "YES" : "NO");
    
    /* Warnings */
    if (!h264_supported) {
        pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
        pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   WARNING: GFX version < 10.0 - H.264 NOT available!         │\n");
        pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   Server will use ClearCodec + Progressive only.             │\n");
    }
    if (flags & RDPGFX_CAPS_FLAG_AVC_DISABLED) {
        pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "├──────────────────────────────────────────────────────────────┤\n");
        pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "│   WARNING: AVC_DISABLED flag set - H.264 explicitly off!     │\n");
    }
    
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "└──────────────────────────────────────────────────────────────┘\n");
    pos += snprintf(buf + pos, LOG_BUFFER_SIZE - pos, "\n");
    
    log_stderr(buf);
}
#else
/* Stub when verbose logging is disabled */
static void log_caps_confirm(UINT32 version, UINT32 flags)
{
    (void)version;
    (void)flags;
}
#endif /* ENABLE_VERBOSE_SETTINGS_LOG */

/* ============================================================================
 * Session Lifecycle
 * ============================================================================ */

RdpSession* rdp_create(
    const char* host,
    uint16_t port,
    const char* username,
    const char* password,
    const char* domain,
    uint32_t width,
    uint32_t height,
    uint32_t bpp)
{
    rdpContext* context = NULL;
    freerdp* instance = NULL;
    rdpSettings* settings = NULL;
    RDP_CLIENT_ENTRY_POINTS clientEntryPoints = { 0 };
    
    /* Initialize client entry points */
    clientEntryPoints.Size = sizeof(RDP_CLIENT_ENTRY_POINTS);
    clientEntryPoints.Version = RDP_CLIENT_INTERFACE_VERSION;
    clientEntryPoints.ContextSize = sizeof(BridgeContext);
    
    /* Create FreeRDP context (FreeRDP3 returns rdpContext*, not freerdp*) */
    context = freerdp_client_context_new(&clientEntryPoints);
    if (!context) {
        return NULL;
    }
    
    /* Get the instance from context */
    instance = context->instance;
    
    BridgeContext* ctx = (BridgeContext*)context;
    ctx->state = RDP_STATE_DISCONNECTED;
    pthread_mutex_init(&ctx->audio_mutex, NULL);
    pthread_mutex_init(&ctx->opus_mutex, NULL);
    pthread_mutex_init(&ctx->gfx_mutex, NULL);
    pthread_mutex_init(&ctx->gfx_event_mutex, NULL);
    ctx->audio_initialized = false;
    ctx->audio_buffer = NULL;
    ctx->audio_buffer_size = 0;
    ctx->opus_encoder = NULL;
    
    /* Initialize GFX structures */
    ctx->gfx = NULL;
    ctx->gfx_active = false;
    ctx->gfx_codec = RDP_GFX_CODEC_UNCOMPRESSED;
    ctx->primary_surface_id = 0;
    memset(ctx->surfaces, 0, sizeof(ctx->surfaces));
    
    /* Initialize GFX event queue for wire format streaming (dynamic allocation) */
    ctx->gfx_events_capacity = RDP_GFX_EVENTS_INITIAL;
    ctx->gfx_events = (RdpGfxEvent*)calloc(ctx->gfx_events_capacity, sizeof(RdpGfxEvent));
    ctx->gfx_event_write_idx = 0;
    ctx->gfx_event_read_idx = 0;
    ctx->gfx_event_count = 0;
    
    /* Initialize native CLIPRDR bridge */
    pthread_mutex_init(&ctx->clip_mutex, NULL);
    pthread_cond_init(&ctx->clip_cond, NULL);
    pthread_mutex_init(&ctx->clip_event_mutex, NULL);
    ctx->clip_event_capacity = ZEPHYR_CLIP_EVENT_CAPACITY;
    ctx->clip_events = (char**)calloc(ctx->clip_event_capacity, sizeof(char*));
    ctx->clip_next_stream_id = 1;
    ctx->clip_remote_capability_flags = CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS | CB_HUGE_FILE_SUPPORT_ENABLED;
    ctx->clip_remote_text_format_id = 0;
    ctx->clip_remote_file_format_id = 0;
    ctx->clip_pending_format_id = 0;
    
    /* Initialize planar codec decoder
     * Note: ClearCodec and Progressive are passed through to browser for WASM decoding */
    ctx->planar_decoder = freerdp_bitmap_planar_context_new(0, 64, 64);  /* Will resize as needed */
    
    /* Initialize Opus buffer for native audio streaming.
     * 256KB allows ~4 seconds of Opus audio at 64kbps, which provides
     * enough headroom during graphics-intensive operations (window moves,
     * video playback) when the Python audio streaming loop may be delayed. */
    ctx->opus_buffer_size = 256 * 1024;  /* 256KB for ~4 seconds of Opus at 64kbps */
    ctx->opus_buffer = (uint8_t*)calloc(1, ctx->opus_buffer_size);
    ctx->opus_write_pos = 0;
    ctx->opus_read_pos = 0;
    ctx->opus_sample_rate = 48000;
    ctx->opus_channels = 2;
    ctx->opus_initialized = 0;
    
    /* NOTE: g_audio_ctx is now set in rdp_connect() under g_connect_mutex lock
     * to ensure thread-safe handoff to the plugin during connect */
    
    /* Set callbacks */
    instance->PreConnect = bridge_pre_connect;
    instance->PostConnect = bridge_post_connect;
    instance->PostDisconnect = bridge_post_disconnect;
    
    /* Note: Channel loading happens in bridge_pre_connect() via freerdp_client_load_channels().
     * We do NOT use the LoadChannels callback as the direct call approach works better. */
    
    /* Configure settings */
    settings = context->settings;
    
    /* Connection */
    if (!freerdp_settings_set_string(settings, FreeRDP_ServerHostname, host)) goto fail;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, port)) goto fail;
    
    /* Credentials */
    if (username && *username) {
        if (!freerdp_settings_set_string(settings, FreeRDP_Username, username)) goto fail;
    }
    if (password && *password) {
        if (!freerdp_settings_set_string(settings, FreeRDP_Password, password)) goto fail;
    }
    if (domain && *domain) {
        if (!freerdp_settings_set_string(settings, FreeRDP_Domain, domain)) goto fail;
    }
    
    /* Display settings */
    if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, width)) goto fail;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, height)) goto fail;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, bpp)) goto fail;
    
    /* WIRE-THROUGH MODE: Enable SoftwareGdi but with DeactivateClientDecoding.
     * 
     * SoftwareGdi=TRUE: FreeRDP expects this for proper internal state management.
     * DeactivateClientDecoding=TRUE: Skips actual codec decoding in GDI layer.
     * 
     * The GDI layer still gets initialized (context->gdi exists), but the heavy
     * codec operations are skipped. We handle graphics via GFX callbacks and
     * pass raw frames to the frontend for browser-side decoding. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_SoftwareGdi, TRUE)) goto fail;
    /* Keep FreeRDP's client-side decode state active so RDPEGFX negotiations keep
     * producing SurfaceCommand/StartFrame events. Rendering is still handled by
     * Zephyr's RDPEGFX wire-through callbacks and browser WebCodecs; this only
     * prevents servers from stalling after CreateSurface when decoding is marked
     * deactivated. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_DeactivateClientDecoding, FALSE)) goto fail;
    
    /* Enable Dynamic Virtual Channels (DVCs) - REQUIRED for GFX pipeline.
     * Without this, drdynvc static channel won't load and no DVCs will connect. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_SupportDynamicChannels, TRUE)) goto fail;
    
    /* Enable GFX pipeline with browser-decodable H.264/AVC420 for modern,
     * low-latency graphics.  AVC444 is deliberately disabled on this web path:
     * Windows may send two AVC streams (luma/chroma) that are not a normal
     * browser H.264 picture, and the server-side transcode path was the source
     * of blank/striped frames.  Keep RDPEGFX wire-through, but prefer AVC420 so
     * VideoDecoder receives a standard 4:2:0 Annex-B stream. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxH264, TRUE)) goto fail;
#ifdef ZEPHYR_BROWSER_H264
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444v2, FALSE)) goto fail;
#else
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444v2, TRUE)) goto fail;
#endif
    
    /* Browser path must not negotiate Progressive unless the WASM decoder is
     * actually shipped. The source checkout does not contain progressive_decoder.wasm;
     * if Windows chooses Progressive, the browser receives a valid RDPEGFX session
     * but has no pixels to draw, which appears as a white/black canvas. Keep the
     * RDPEGFX/WebCodecs architecture and prefer browser-decodable AVC420 H.264. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxProgressive, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxProgressiveV2, FALSE)) goto fail;
    
    /* Disable legacy codecs */
    if (!freerdp_settings_set_bool(settings, FreeRDP_RemoteFxCodec, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_NSCodec, FALSE)) goto fail;
    /* GFX options for optimal streaming.
     * GfxSmallCache = TRUE: Tells server to use smaller tile cache, resulting in more
     * direct WireToSurface updates and fewer SurfaceToCache/CacheToSurface operations.
     * This avoids leftover artifacts when windows are de-maximized within the RDP session,
     * as the server won't rely on our client-side cache for desktop background repaints.
     * GfxThinClient = FALSE: Keep full AVC444/H.264 quality (ThinClient would reduce it). */
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxSmallCache, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_GfxThinClient, FALSE)) goto fail;
    
    /* Audio playback - configure rdpsnd with our bridge device plugin.
     * We add rdpsnd to BOTH static and dynamic channel collections with sys:bridge
     * to ensure our bridge plugin is used regardless of which channel Windows prefers.
     * AudioPlayback must be TRUE for the server to send audio data. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_AudioCapture, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RemoteConsoleAudio, FALSE)) goto fail;
    
    /* Log all settings for troubleshooting - and also send to the gfx_queue */
    log_settings(settings, "rdp_create");

    /* Add rdpsnd to STATIC channel collection with sys:bridge */
    {
        ADDIN_ARGV* args = freerdp_addin_argv_new(2, (const char*[]){"rdpsnd", "sys:bridge"});
        if (args) {
            if (!freerdp_static_channel_collection_add(settings, args)) {
                fprintf(stderr, "[rdp_bridge] Warning: Could not add rdpsnd static channel\n");
                freerdp_addin_argv_free(args);
            }
        }
    }
    
    /* Add rdpsnd to DYNAMIC channel collection with sys:bridge */
    {
        ADDIN_ARGV* args = freerdp_addin_argv_new(2, (const char*[]){"rdpsnd", "sys:bridge"});
        if (args) {
            if (!freerdp_dynamic_channel_collection_add(settings, args)) {
                fprintf(stderr, "[rdp_bridge] Warning: Could not add rdpsnd dynamic channel\n");
                freerdp_addin_argv_free(args);
            }
        }
    }
    
    /* Note: rdpgfx and disp channels are automatically added by freerdp_client_load_addins()
     * when SupportGraphicsPipeline=TRUE and SupportDisplayControl=TRUE.
     * We don't need to manually add them here - just ensure the settings are correct above.
     * 
     * Only rdpsnd needs manual addition because we use a custom audio backend (sys:bridge). */
    
    /* Performance optimizations */
    if (!freerdp_settings_set_bool(settings, FreeRDP_FastPathOutput, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_FastPathInput, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_FrameMarkerCommandEnabled, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_SurfaceFrameMarkerEnabled, TRUE)) goto fail;
    
    /* Compression */
    if (!freerdp_settings_set_bool(settings, FreeRDP_CompressionEnabled, TRUE)) goto fail;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_CompressionLevel, 2)) goto fail;
    
    /* Disable features we don't need */
    if (!freerdp_settings_set_bool(settings, FreeRDP_Workarea, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_Fullscreen, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_GrabKeyboard, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_Decorations, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_AllowDesktopComposition, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_DisableWallpaper, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_DisableFullWindowDrag, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_DisableMenuAnims, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_DisableThemes, TRUE)) goto fail;
    
    /* Disable device redirection channels we don't need (prevents RDPDR errors) */
    if (!freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectDrives, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectPrinters, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectSmartCards, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectSerialPorts, FALSE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectParallelPorts, FALSE)) goto fail;
    
    /* Certificate handling - ignore for simplicity */
    if (!freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_AutoAcceptCertificate, TRUE)) goto fail;
    
    /* Clipboard (enabled): full native CLIPRDR text + file streaming. */
    if (!freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, TRUE)) goto fail;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_ClipboardFeatureMask, CLIPRDR_FLAG_DEFAULT_MASK)) goto fail;
    
    /* Dynamic resolution updates */
    if (!freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE)) goto fail;
    if (!freerdp_settings_set_bool(settings, FreeRDP_DynamicResolutionUpdate, TRUE)) goto fail;
    
    /* Register session in the registry for multi-user audio isolation */
    int reg_result = session_registry_add(context, ctx);
    if (reg_result == -2) {
        /* Session limit reached */
        snprintf(ctx->error_msg, MAX_ERROR_LEN, "Session limit reached (%d max)", g_max_sessions);
        ctx->state = RDP_STATE_ERROR;
        goto fail;
    } else if (reg_result != 0) {
        snprintf(ctx->error_msg, MAX_ERROR_LEN, "Failed to register session");
        ctx->state = RDP_STATE_ERROR;
        goto fail;
    }
    
    /* Return context cast as session (context contains instance pointer) */
    return (RdpSession*)context;
    
fail:
    if (context) {
        freerdp_client_context_free(context);
    }
    return NULL;
}

int rdp_connect(RdpSession* session)
{
    rdpContext* context = (rdpContext*)session;
    freerdp* instance = context->instance;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!context) return -1;
    
    ctx->state = RDP_STATE_CONNECTING;
    
    /* Lock to protect g_audio_ctx handoff to the plugin during connect.
     * The plugin's Open callback reads g_audio_ctx, so we must ensure
     * no other session overwrites it during our connect operation. */
    pthread_mutex_lock(&g_connect_mutex);
    
    /* Set up the global audio context to point to THIS session's buffer.
     * The plugin will read this during its Open callback.
     * Use POINTERS for write_pos, read_pos, initialized so the plugin
     * can update the actual values in BridgeContext. */
    g_audio_ctx.opus_buffer = ctx->opus_buffer;
    g_audio_ctx.opus_buffer_size = ctx->opus_buffer_size;
    g_audio_ctx.opus_write_pos = &ctx->opus_write_pos;
    g_audio_ctx.opus_read_pos = &ctx->opus_read_pos;
    g_audio_ctx.opus_mutex = &ctx->opus_mutex;
    g_audio_ctx.sample_rate = ctx->opus_sample_rate;
    g_audio_ctx.channels = ctx->opus_channels;
    g_audio_ctx.initialized = &ctx->opus_initialized;
    
    if (!freerdp_connect(instance)) {
        pthread_mutex_unlock(&g_connect_mutex);
        UINT32 error = freerdp_get_last_error(context);
        snprintf(ctx->error_msg, MAX_ERROR_LEN, 
                 "Connection failed: 0x%08X", error);
        ctx->state = RDP_STATE_ERROR;
        return -1;
    }
    
    /* Set up audio context for the RDPSND bridge plugin AFTER connecting.
     * The plugin is loaded by FreeRDP during freerdp_connect(), so we need
     * to call rdp_set_audio_context after the plugin is available. */
    rdp_set_audio_context(session);
    
    pthread_mutex_unlock(&g_connect_mutex);
    
    ctx->state = RDP_STATE_CONNECTED;
    return 0;
}

RdpState rdp_get_state(RdpSession* session)
{
    if (!session) return RDP_STATE_DISCONNECTED;
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    return ctx->state;
}

const char* rdp_get_error(RdpSession* session)
{
    if (!session) return "Invalid session";
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    return ctx->error_msg;
}

void rdp_disconnect(RdpSession* session)
{
    if (!session) return;
    rdpContext* context = (rdpContext*)session;
    freerdp* instance = context->instance;
    BridgeContext* ctx = (BridgeContext*)context;
    
    fprintf(stderr, "[rdp_bridge] rdp_disconnect called, state=%d\n", ctx->state);
    
    /* Call freerdp_disconnect for CONNECTED, CONNECTING, or ERROR states.
     * ERROR state can occur when server terminates connection - we still need
     * to call freerdp_disconnect to trigger PostDisconnect cleanup callback. */
    if (ctx->state == RDP_STATE_CONNECTED || ctx->state == RDP_STATE_CONNECTING || 
        ctx->state == RDP_STATE_ERROR) {
        fprintf(stderr, "[rdp_bridge] Calling freerdp_disconnect\n");
        freerdp_disconnect(instance);
    } else {
        fprintf(stderr, "[rdp_bridge] Skipping freerdp_disconnect (already disconnected)\n");
    }
    ctx->state = RDP_STATE_DISCONNECTED;
}

void rdp_destroy(RdpSession* session)
{
    if (!session) return;
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    fprintf(stderr, "[rdp_bridge] rdp_destroy: freeing session resources\n");
    
    /* Unregister from session registry BEFORE cleanup */
    session_registry_remove(context);
    
    rdp_disconnect(session);
    
    /* Cleanup transcoder */
    cleanup_transcoder(ctx);

    pthread_mutex_lock(&ctx->clip_mutex);
    free(ctx->clip_local_text);
    ctx->clip_local_text = NULL;
    clip_free_local_files(ctx);
    clip_free_remote_files(ctx);
    free(ctx->clip_pending_data);
    ctx->clip_pending_data = NULL;
    pthread_mutex_unlock(&ctx->clip_mutex);
    if (ctx->clip_events) {
        for (int i = 0; i < ctx->clip_event_capacity; i++) free(ctx->clip_events[i]);
        free(ctx->clip_events);
        ctx->clip_events = NULL;
    }

    pthread_mutex_destroy(&ctx->audio_mutex);
    pthread_mutex_destroy(&ctx->opus_mutex);
    pthread_mutex_destroy(&ctx->gfx_mutex);
    pthread_mutex_destroy(&ctx->gfx_event_mutex);
    pthread_mutex_destroy(&ctx->clip_mutex);
    pthread_mutex_destroy(&ctx->clip_event_mutex);
    pthread_cond_destroy(&ctx->clip_cond);
    
    /* Free audio resources */
    if (ctx->opus_encoder) {
        opus_encoder_destroy(ctx->opus_encoder);
        ctx->opus_encoder = NULL;
    }
    if (ctx->audio_buffer) {
        free(ctx->audio_buffer);
        ctx->audio_buffer = NULL;
    }
    if (ctx->opus_buffer) {
        free(ctx->opus_buffer);
        ctx->opus_buffer = NULL;
    }
    
    /* Free any pending GFX event data (allocated buffers in unread events) */
    if (ctx->gfx_events) {
        while (ctx->gfx_event_count > 0) {
            RdpGfxEvent* event = &ctx->gfx_events[ctx->gfx_event_read_idx];
            gfx_free_event_data(event);
            ctx->gfx_event_read_idx = (ctx->gfx_event_read_idx + 1) % ctx->gfx_events_capacity;
            ctx->gfx_event_count--;
        }
        free(ctx->gfx_events);
        ctx->gfx_events = NULL;
    }
    
    /* Free planar decoder (may already be freed in bridge_post_disconnect, but safe to check) */
    if (ctx->planar_decoder) {
        freerdp_bitmap_planar_context_free(ctx->planar_decoder);
        ctx->planar_decoder = NULL;
    }
    
    /* Ensure GDI resources are freed (may already be freed by bridge_post_disconnect).
     * This is a safety net for server-initiated disconnects where PostDisconnect
     * callback might not be called or might be called with incomplete cleanup. */
    freerdp* instance = context->instance;
    if (instance && context->gdi) {
        fprintf(stderr, "[rdp_bridge] rdp_destroy: forcing gdi_free (gdi was still allocated)\n");
        gdi_free(instance);
    }
    
    fprintf(stderr, "[rdp_bridge] rdp_destroy: calling freerdp_client_context_free\n");
    freerdp_client_context_free(context);
    
    /* Force glibc to return freed memory to the OS */
    malloc_trim(0);
    fprintf(stderr, "[rdp_bridge] rdp_destroy: complete\n");
}

/* ============================================================================
 * Pointer/Cursor Callbacks
 * 
 * FreeRDP sends cursor updates via the graphics subsystem. We convert the
 * cursor bitmap to BGRA32 format and queue it for streaming to the browser.
 * ============================================================================ */

/* Extended pointer structure with pre-converted BGRA data */
typedef struct {
    rdpPointer base;        /* Must be first - inherited from rdpPointer */
    uint8_t* bgra_data;     /* Pre-converted BGRA32 image */
    uint32_t bgra_size;     /* Size of bgra_data */
} BridgePointer;

/* Pointer::New - Convert cursor data to BGRA32 */
static BOOL bridge_pointer_new(rdpContext* context, rdpPointer* pointer)
{
    BridgePointer* bp = (BridgePointer*)pointer;
    
    uint32_t width = pointer->width;
    uint32_t height = pointer->height;
    uint32_t stride = width * 4;  /* BGRA32 = 4 bytes/pixel */
    bp->bgra_size = stride * height;
    bp->bgra_data = (uint8_t*)calloc(1, bp->bgra_size);
    
    if (!bp->bgra_data)
        return FALSE;
    
    /* Convert XOR/AND masks to BGRA32 using FreeRDP codec */
    if (!freerdp_image_copy_from_pointer_data(
            bp->bgra_data, PIXEL_FORMAT_BGRA32, stride,
            0, 0, width, height,
            pointer->xorMaskData, pointer->lengthXorMask,
            pointer->andMaskData, pointer->lengthAndMask,
            pointer->xorBpp, NULL)) {
        free(bp->bgra_data);
        bp->bgra_data = NULL;
        return FALSE;
    }
    
    return TRUE;
}

/* Pointer::Free - Clean up BGRA data */
static void bridge_pointer_free(rdpContext* context, rdpPointer* pointer)
{
    BridgePointer* bp = (BridgePointer*)pointer;
    if (bp && bp->bgra_data) {
        free(bp->bgra_data);
        bp->bgra_data = NULL;
    }
}

/* Pointer::Set - Queue cursor bitmap for frontend */
static BOOL bridge_pointer_set(rdpContext* context, rdpPointer* pointer)
{
    BridgeContext* bctx = (BridgeContext*)context;
    const BridgePointer* bp = (const BridgePointer*)pointer;
    
    if (!bp || !bp->bgra_data) return FALSE;
    
    /* Copy BGRA data for event queue (Python will free) */
    uint8_t* data_copy = (uint8_t*)malloc(bp->bgra_size);
    if (!data_copy) return FALSE;
    memcpy(data_copy, bp->bgra_data, bp->bgra_size);
    
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_POINTER_SET;
    event.pointer_width = pointer->width;
    event.pointer_height = pointer->height;
    event.pointer_hotspot_x = pointer->xPos;
    event.pointer_hotspot_y = pointer->yPos;
    event.pointer_data = data_copy;
    event.pointer_data_size = bp->bgra_size;
    
    gfx_queue_event(bctx, &event);
    return TRUE;
}

/* Pointer::SetNull - Hide cursor */
static BOOL bridge_pointer_set_null(rdpContext* context)
{
    BridgeContext* bctx = (BridgeContext*)context;
    
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_POINTER_SYSTEM;
    event.pointer_system_type = 0;  /* Null/hidden */
    
    gfx_queue_event(bctx, &event);
    return TRUE;
}

/* Pointer::SetDefault - Show default cursor */
static BOOL bridge_pointer_set_default(rdpContext* context)
{
    BridgeContext* bctx = (BridgeContext*)context;
    
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_POINTER_SYSTEM;
    event.pointer_system_type = 1;  /* Default system cursor */
    
    gfx_queue_event(bctx, &event);
    return TRUE;
}

/* Pointer::SetPosition - Update cursor position (optional, server-side cursor) */
static BOOL bridge_pointer_set_position(rdpContext* context, UINT32 x, UINT32 y)
{
    BridgeContext* bctx = (BridgeContext*)context;
    
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_POINTER_POSITION;
    event.pointer_x = (uint16_t)x;
    event.pointer_y = (uint16_t)y;
    
    gfx_queue_event(bctx, &event);
    return TRUE;
}

/* ============================================================================
 * Pointer Update Callbacks (rdpPointerUpdate -> rdpPointer dispatch)
 * 
 * These callbacks receive pointer PDUs from the RDP server and dispatch to
 * our registered rdpPointer callbacks. We need to register these manually
 * because DeactivateClientDecoding=TRUE skips pointer_cache_register_callbacks().
 * ============================================================================ */

/* Allocate a pointer using our registered prototype */
static rdpPointer* Bridge_Pointer_Alloc(rdpContext* context)
{
    rdpGraphics* graphics = context->graphics;
    rdpPointer* pointer = (rdpPointer*)calloc(1, graphics->Pointer_Prototype->size);
    if (pointer) {
        *pointer = *graphics->Pointer_Prototype;
    }
    return pointer;
}

/* Free a pointer and its resources */
static void Bridge_Pointer_Free(rdpContext* context, rdpPointer* pointer)
{
    if (pointer) {
        if (pointer->Free) {
            pointer->Free(context, pointer);
        }
        free(pointer->andMaskData);
        free(pointer->xorMaskData);
        free(pointer);
    }
}

/* Handle POINTER_POSITION_UPDATE PDU */
static BOOL bridge_update_pointer_position(rdpContext* context,
                                           const POINTER_POSITION_UPDATE* pointer_position)
{
    if (!context || !context->graphics || !context->graphics->Pointer_Prototype || !pointer_position)
        return FALSE;

    rdpPointer* pointer = context->graphics->Pointer_Prototype;
    if (pointer->SetPosition) {
        return pointer->SetPosition(context, pointer_position->xPos, pointer_position->yPos);
    }
    return TRUE;
}

/* Handle POINTER_SYSTEM_UPDATE PDU */
static BOOL bridge_update_pointer_system(rdpContext* context,
                                         const POINTER_SYSTEM_UPDATE* pointer_system)
{
    if (!context || !context->graphics || !context->graphics->Pointer_Prototype || !pointer_system)
        return FALSE;

    rdpPointer* pointer = context->graphics->Pointer_Prototype;
    
    switch (pointer_system->type) {
        case SYSPTR_NULL:
            if (pointer->SetNull)
                return pointer->SetNull(context);
            break;
        case SYSPTR_DEFAULT:
            if (pointer->SetDefault)
                return pointer->SetDefault(context);
            break;
        default:
            fprintf(stderr, "[rdp_bridge] Unknown system pointer type: 0x%08X\n", pointer_system->type);
    }
    return TRUE;
}

/* Handle POINTER_COLOR_UPDATE PDU (legacy color cursor) */
static BOOL bridge_update_pointer_color(rdpContext* context,
                                        const POINTER_COLOR_UPDATE* pointer_color)
{
    if (!context || !pointer_color)
        return FALSE;

    BridgeCache* cache = (BridgeCache*)context->cache;
    rdpPointer* pointer = Bridge_Pointer_Alloc(context);
    if (!pointer)
        return FALSE;

    pointer->xorBpp = 24;  /* Color pointer uses 24bpp */
    pointer->xPos = pointer_color->hotSpotX;
    pointer->yPos = pointer_color->hotSpotY;
    pointer->width = pointer_color->width;
    pointer->height = pointer_color->height;

    /* Copy AND mask */
    if (pointer_color->lengthAndMask > 0 && pointer_color->andMaskData) {
        pointer->lengthAndMask = pointer_color->lengthAndMask;
        pointer->andMaskData = (BYTE*)malloc(pointer_color->lengthAndMask);
        if (!pointer->andMaskData) goto fail;
        memcpy(pointer->andMaskData, pointer_color->andMaskData, pointer_color->lengthAndMask);
    }

    /* Copy XOR mask */
    if (pointer_color->lengthXorMask > 0 && pointer_color->xorMaskData) {
        pointer->lengthXorMask = pointer_color->lengthXorMask;
        pointer->xorMaskData = (BYTE*)malloc(pointer_color->lengthXorMask);
        if (!pointer->xorMaskData) goto fail;
        memcpy(pointer->xorMaskData, pointer_color->xorMaskData, pointer_color->lengthXorMask);
    }

    /* Call New to convert to BGRA */
    if (pointer->New && !pointer->New(context, pointer))
        goto fail;

    /* Store in cache */
    if (cache && cache->pointer) {
        BridgePointerCache* pointerCache = cache->pointer;
        if (pointer_color->cacheIndex < pointerCache->cacheSize) {
            Bridge_Pointer_Free(context, pointerCache->entries[pointer_color->cacheIndex]);
            pointerCache->entries[pointer_color->cacheIndex] = pointer;
        }
    }

    /* Set as current cursor */
    if (pointer->Set)
        return pointer->Set(context, pointer);
    return TRUE;

fail:
    Bridge_Pointer_Free(context, pointer);
    return FALSE;
}

/* Handle POINTER_NEW_UPDATE PDU (new cursor with specified bpp) */
static BOOL bridge_update_pointer_new(rdpContext* context,
                                      const POINTER_NEW_UPDATE* pointer_new)
{
    if (!context || !pointer_new)
        return FALSE;

    BridgeCache* cache = (BridgeCache*)context->cache;
    rdpPointer* pointer = Bridge_Pointer_Alloc(context);
    if (!pointer)
        return FALSE;

    pointer->xorBpp = pointer_new->xorBpp;
    pointer->xPos = pointer_new->colorPtrAttr.hotSpotX;
    pointer->yPos = pointer_new->colorPtrAttr.hotSpotY;
    pointer->width = pointer_new->colorPtrAttr.width;
    pointer->height = pointer_new->colorPtrAttr.height;

    /* Copy AND mask */
    if (pointer_new->colorPtrAttr.lengthAndMask > 0 && pointer_new->colorPtrAttr.andMaskData) {
        pointer->lengthAndMask = pointer_new->colorPtrAttr.lengthAndMask;
        pointer->andMaskData = (BYTE*)malloc(pointer_new->colorPtrAttr.lengthAndMask);
        if (!pointer->andMaskData) goto fail;
        memcpy(pointer->andMaskData, pointer_new->colorPtrAttr.andMaskData, pointer_new->colorPtrAttr.lengthAndMask);
    }

    /* Copy XOR mask */
    if (pointer_new->colorPtrAttr.lengthXorMask > 0 && pointer_new->colorPtrAttr.xorMaskData) {
        pointer->lengthXorMask = pointer_new->colorPtrAttr.lengthXorMask;
        pointer->xorMaskData = (BYTE*)malloc(pointer_new->colorPtrAttr.lengthXorMask);
        if (!pointer->xorMaskData) goto fail;
        memcpy(pointer->xorMaskData, pointer_new->colorPtrAttr.xorMaskData, pointer_new->colorPtrAttr.lengthXorMask);
    }

    /* Call New to convert to BGRA */
    if (pointer->New && !pointer->New(context, pointer))
        goto fail;

    /* Store in cache */
    if (cache && cache->pointer) {
        BridgePointerCache* pointerCache = cache->pointer;
        if (pointer_new->colorPtrAttr.cacheIndex < pointerCache->cacheSize) {
            Bridge_Pointer_Free(context, pointerCache->entries[pointer_new->colorPtrAttr.cacheIndex]);
            pointerCache->entries[pointer_new->colorPtrAttr.cacheIndex] = pointer;
        }
    }

    /* Set as current cursor */
    if (pointer->Set)
        return pointer->Set(context, pointer);
    return TRUE;

fail:
    Bridge_Pointer_Free(context, pointer);
    return FALSE;
}

/* Handle POINTER_LARGE_UPDATE PDU (large cursor, > 96x96) */
static BOOL bridge_update_pointer_large(rdpContext* context,
                                        const POINTER_LARGE_UPDATE* pointer_large)
{
    if (!context || !pointer_large)
        return FALSE;

    BridgeCache* cache = (BridgeCache*)context->cache;
    rdpPointer* pointer = Bridge_Pointer_Alloc(context);
    if (!pointer)
        return FALSE;

    pointer->xorBpp = pointer_large->xorBpp;
    pointer->xPos = pointer_large->hotSpotX;
    pointer->yPos = pointer_large->hotSpotY;
    pointer->width = pointer_large->width;
    pointer->height = pointer_large->height;

    /* Copy AND mask */
    if (pointer_large->lengthAndMask > 0 && pointer_large->andMaskData) {
        pointer->lengthAndMask = pointer_large->lengthAndMask;
        pointer->andMaskData = (BYTE*)malloc(pointer_large->lengthAndMask);
        if (!pointer->andMaskData) goto fail;
        memcpy(pointer->andMaskData, pointer_large->andMaskData, pointer_large->lengthAndMask);
    }

    /* Copy XOR mask */
    if (pointer_large->lengthXorMask > 0 && pointer_large->xorMaskData) {
        pointer->lengthXorMask = pointer_large->lengthXorMask;
        pointer->xorMaskData = (BYTE*)malloc(pointer_large->lengthXorMask);
        if (!pointer->xorMaskData) goto fail;
        memcpy(pointer->xorMaskData, pointer_large->xorMaskData, pointer_large->lengthXorMask);
    }

    /* Call New to convert to BGRA */
    if (pointer->New && !pointer->New(context, pointer))
        goto fail;

    /* Store in cache */
    if (cache && cache->pointer) {
        BridgePointerCache* pointerCache = cache->pointer;
        if (pointer_large->cacheIndex < pointerCache->cacheSize) {
            Bridge_Pointer_Free(context, pointerCache->entries[pointer_large->cacheIndex]);
            pointerCache->entries[pointer_large->cacheIndex] = pointer;
        }
    }

    /* Set as current cursor */
    if (pointer->Set)
        return pointer->Set(context, pointer);
    return TRUE;

fail:
    Bridge_Pointer_Free(context, pointer);
    return FALSE;
}

/* Handle POINTER_CACHED_UPDATE PDU (use cached cursor) */
static BOOL bridge_update_pointer_cached(rdpContext* context,
                                         const POINTER_CACHED_UPDATE* pointer_cached)
{
    if (!context || !pointer_cached)
        return FALSE;

    BridgeCache* cache = (BridgeCache*)context->cache;
    if (!cache || !cache->pointer)
        return FALSE;

    BridgePointerCache* pointerCache = cache->pointer;
    if (pointer_cached->cacheIndex >= pointerCache->cacheSize)
        return FALSE;

    rdpPointer* pointer = pointerCache->entries[pointer_cached->cacheIndex];
    if (pointer && pointer->Set) {
        return pointer->Set(context, pointer);
    }

    return FALSE;
}

/* ============================================================================
 * Deferred GDI Pipeline Initialization
 * ============================================================================ */

static void maybe_init_gfx_pipeline(BridgeContext* bctx)
{
    /* Check if deferred initialization is needed */
    pthread_mutex_lock(&bctx->gfx_mutex);
    bool needs_init = bctx->gfx_pipeline_needs_init && !bctx->gfx_pipeline_ready;
    RdpgfxClientContext* gfx = bctx->gfx;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    if (!needs_init || !gfx) {
        return;
    }
    
    /* Check if FreeRDP set up the FrameAcknowledge callback */
    if (!gfx->FrameAcknowledge) {
        fprintf(stderr, "[rdp_bridge] WARNING: FrameAcknowledge callback is NULL - acks won't be sent!\n");
    }
    
    /* Initialize FreeRDP's GFX helper so RDPEGFX frames are decoded into the
     * native GDI framebuffer. Zephyr still serves the browser via /rdp-gfx from
     * this native bridge; this is not the old xfreerdp/Xvfb/ffmpeg pipeline.
     * If direct wire-through events are not produced by a server, the GDI
     * fallback below captures this framebuffer and sends WebP tiles. */
    rdpContext* rctx = (rdpContext*)bctx;
    if (rctx && rctx->gdi) {
        if (!gdi_graphics_pipeline_init(rctx->gdi, gfx)) {
            fprintf(stderr, "[rdp_bridge] WARNING: gdi_graphics_pipeline_init failed; GDI fallback may be unavailable\n");
        } else {
            fprintf(stderr, "[rdp_bridge] gdi_graphics_pipeline_init enabled for native fallback rendering\n");
        }
    }

    pthread_mutex_lock(&bctx->gfx_mutex);
    bctx->gfx_pipeline_needs_init = false;
    bctx->gfx_pipeline_ready = true;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* GFX callbacks are already set in bridge_on_channel_connected */
}

/* ============================================================================
 * Event Processing & Frame Capture
 * ============================================================================ */

int rdp_poll(RdpSession* session, int timeout_ms)
{
    if (!session) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (ctx->state != RDP_STATE_CONNECTED) {
        return -1;
    }
    
    /* WIRE-THROUGH MODE: Check GFX event queue for pending data. */
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    int gfx_pending = ctx->gfx_event_count;
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
    
    if (gfx_pending > 0) {
        return 1;
    }
    
    /* Handle pending resize - use display control channel if available.
     * IMPORTANT: Don't process resize during GFX pipeline init to avoid race conditions. */
    pthread_mutex_lock(&ctx->gfx_mutex);
    bool gfx_initializing = ctx->gfx_pipeline_needs_init && !ctx->gfx_pipeline_ready;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    if (ctx->resize_pending && !gfx_initializing) {
        ctx->resize_pending = false;
        
        uint32_t new_width = ctx->pending_width;
        uint32_t new_height = ctx->pending_height;
        
        /* Skip if dimensions haven't actually changed */
        if (ctx->frame_width == (int)new_width && ctx->frame_height == (int)new_height) {
            /* No-op - dimensions unchanged */
        }
        /* Try to use Display Control channel for dynamic resize */
        else if (ctx->disp && ctx->disp->SendMonitorLayout) {
            DISPLAY_CONTROL_MONITOR_LAYOUT layout = { 0 };
            layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
            layout.Left = 0;
            layout.Top = 0;
            layout.Width = new_width;
            layout.Height = new_height;
            layout.PhysicalWidth = new_width;
            layout.PhysicalHeight = new_height;
            layout.Orientation = ORIENTATION_LANDSCAPE;
            layout.DesktopScaleFactor = 100;
            layout.DeviceScaleFactor = 100;
            
            ctx->disp->SendMonitorLayout(ctx->disp, 1, &layout);
            
            /* WIRE-THROUGH MODE: Server will send ResetGraphics and fresh surfaces.
             * No need to set needs_full_frame - GFX events will flow naturally. */
        }
    }
    
    /* Deferred GDI pipeline initialization (safe from main thread) */
    maybe_init_gfx_pipeline(ctx);
    
    /* Get file descriptors for select/poll */
    HANDLE handles[MAXIMUM_WAIT_OBJECTS] = { 0 };
    DWORD nCount = freerdp_get_event_handles(context, handles, ARRAYSIZE(handles));
    
    if (nCount == 0) {
        snprintf(ctx->error_msg, MAX_ERROR_LEN, "Failed to get event handles");
        return -1;
    }
    
    /* Wait for events */
    DWORD waitStatus = WaitForMultipleObjects(nCount, handles, FALSE, (DWORD)timeout_ms);
    
    if (waitStatus == WAIT_FAILED) {
        return 0; /* No events, not an error */
    }
    
    /* Check if connection is still valid */
    if (!freerdp_check_event_handles(context)) {
        UINT32 error = freerdp_get_last_error(context);
        fprintf(stderr, "[rdp_bridge] freerdp_check_event_handles failed: error=0x%08X\n", error);
        if (error != FREERDP_ERROR_SUCCESS) {
            snprintf(ctx->error_msg, MAX_ERROR_LEN, 
                     "Event handling error: 0x%08X", error);
            ctx->state = RDP_STATE_ERROR;
            
            /* Mark as disconnecting to prevent GDI handler calls from other threads */
            pthread_mutex_lock(&ctx->gfx_mutex);
            ctx->gfx_disconnecting = true;
            pthread_mutex_unlock(&ctx->gfx_mutex);
            
            return -1;
        }
    }
    
    /* WIRE-THROUGH MODE: Check GFX event queue for updates.
     * FreeRDP callbacks have processed PDUs and queued events during check_event_handles. */
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    int has_gfx_events = ctx->gfx_event_count > 0;
    pthread_mutex_unlock(&ctx->gfx_event_mutex);

    /* Always give the native FreeRDP GDI compositor a chance to publish the
     * currently decoded framebuffer. Direct wire-through events may be partial
     * for some RDPEGFX command mixes; the GDI-composited WebP frame is the
     * reliable display path and is rate-limited inside maybe_queue_gdi_fallback_frame(). */
    maybe_queue_gdi_fallback_frame(ctx);
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    has_gfx_events = ctx->gfx_event_count > 0;
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
    
    return has_gfx_events ? 1 : 0;
}

bool rdp_gfx_frame_in_progress(RdpSession* session)
{
    if (!session) return false;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    bool in_progress = ctx->gfx_frame_in_progress;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    return in_progress;
}

uint32_t rdp_gfx_get_last_completed_frame(RdpSession* session)
{
    if (!session) return 0;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    uint32_t frame_id = ctx->last_completed_frame_id;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    return frame_id;
}

/* ============================================================================
 * Input Handling
 * ============================================================================ */

void rdp_send_mouse(RdpSession* session, uint16_t flags, int x, int y)
{
    if (!session) return;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (ctx->state != RDP_STATE_CONNECTED) return;
    
    rdpInput* input = context->input;
    if (input && input->MouseEvent) {
        input->MouseEvent(input, flags, (UINT16)x, (UINT16)y);
    }
}

void rdp_send_keyboard(RdpSession* session, uint16_t flags, uint16_t scancode)
{
    if (!session) return;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (ctx->state != RDP_STATE_CONNECTED) return;
    
    rdpInput* input = context->input;
    if (input && input->KeyboardEvent) {
        input->KeyboardEvent(input, flags, scancode);
    }
}

void rdp_send_unicode(RdpSession* session, uint16_t flags, uint16_t code)
{
    if (!session) return;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (ctx->state != RDP_STATE_CONNECTED) return;
    
    rdpInput* input = context->input;
    if (input && input->UnicodeKeyboardEvent) {
        input->UnicodeKeyboardEvent(input, flags, code);
    }
}

/* ============================================================================
 * Resize
 * ============================================================================ */

int rdp_resize(RdpSession* session, uint32_t width, uint32_t height)
{
    if (!session) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (ctx->state != RDP_STATE_CONNECTED) {
        return -1;
    }
    
    /* Skip redundant resize requests - these can cause race conditions
     * with GFX pipeline initialization during early connection */
    if (ctx->frame_width == (int)width && ctx->frame_height == (int)height) {
        return 0;
    }
    
    /* Queue resize for next poll. In wire-through mode, the server will
     * send ResetGraphics and fresh surfaces after the resize. */
    pthread_mutex_lock(&ctx->gfx_mutex);
    ctx->resize_pending = true;
    ctx->pending_width = width;
    ctx->pending_height = height;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    return 0;
}

/* ============================================================================
 * FreeRDP Callbacks
 * ============================================================================ */

static UINT clip_request_remote_format(BridgeContext* ctx, UINT32 format_id)
{
    if (!ctx || !format_id || !ctx->cliprdr || !ctx->cliprdr->ClientFormatDataRequest) return CHANNEL_RC_OK;
    CLIPRDR_FORMAT_DATA_REQUEST req = { { CB_FORMAT_DATA_REQUEST, 0, 0 }, format_id };
    pthread_mutex_lock(&ctx->clip_mutex);
    ctx->clip_pending_format_id = format_id;
    pthread_mutex_unlock(&ctx->clip_mutex);
    return ctx->cliprdr->ClientFormatDataRequest(ctx->cliprdr, &req);
}

static UINT clip_on_monitor_ready(CliprdrClientContext* context, const CLIPRDR_MONITOR_READY* monitorReady)
{
    (void)monitorReady;
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx) return ERROR_INVALID_PARAMETER;
    UINT rc = clip_send_client_capabilities(ctx);
    if (rc != CHANNEL_RC_OK) return rc;
    return clip_send_client_format_list(ctx);
}

static UINT clip_on_server_capabilities(CliprdrClientContext* context, const CLIPRDR_CAPABILITIES* capabilities)
{
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx || !capabilities) return ERROR_INVALID_PARAMETER;
    UINT32 flags = 0;
    const BYTE* ptr = (const BYTE*)capabilities->capabilitySets;
    for (UINT32 i = 0; i < capabilities->cCapabilitiesSets && ptr; i++) {
        const CLIPRDR_CAPABILITY_SET* cap = (const CLIPRDR_CAPABILITY_SET*)ptr;
        if (cap->capabilitySetType == CB_CAPSTYPE_GENERAL && cap->capabilitySetLength >= CB_CAPSTYPE_GENERAL_LEN) {
            const CLIPRDR_GENERAL_CAPABILITY_SET* gen = (const CLIPRDR_GENERAL_CAPABILITY_SET*)ptr;
            flags = gen->generalFlags;
        }
        ptr += cap->capabilitySetLength;
    }
    pthread_mutex_lock(&ctx->clip_mutex);
    ctx->clip_remote_capability_flags = flags ? flags : (CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS | CB_HUGE_FILE_SUPPORT_ENABLED);
    pthread_mutex_unlock(&ctx->clip_mutex);
    return CHANNEL_RC_OK;
}

static UINT clip_on_server_format_list(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST* formatList)
{
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx || !formatList) return ERROR_INVALID_PARAMETER;
    UINT32 text_id = 0;
    UINT32 file_id = 0;
    for (UINT32 i = 0; i < formatList->numFormats; i++) {
        const CLIPRDR_FORMAT* f = &formatList->formats[i];
        if (!f->formatName && f->formatId == CF_UNICODETEXT) text_id = f->formatId;
        if (f->formatName && strcmp(f->formatName, "FileGroupDescriptorW") == 0) file_id = f->formatId;
    }
    pthread_mutex_lock(&ctx->clip_mutex);
    ctx->clip_remote_text_format_id = text_id;
    ctx->clip_remote_file_format_id = file_id;
    clip_free_remote_files(ctx);
    pthread_mutex_unlock(&ctx->clip_mutex);
    clip_send_format_list_response(ctx, TRUE);
    if (text_id) clip_request_remote_format(ctx, text_id);
    else if (file_id) clip_request_remote_format(ctx, file_id);
    return CHANNEL_RC_OK;
}

static UINT clip_on_server_format_list_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST_RESPONSE* formatListResponse)
{
    (void)context;
    (void)formatListResponse;
    return CHANNEL_RC_OK;
}

static UINT clip_on_server_format_data_request(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_REQUEST* formatDataRequest)
{
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx || !formatDataRequest) return ERROR_INVALID_PARAMETER;
    if (formatDataRequest->requestedFormatId == CF_UNICODETEXT) {
        pthread_mutex_lock(&ctx->clip_mutex);
        const char* text = ctx->clip_local_text ? ctx->clip_local_text : "";
        uint8_t* data = NULL;
        uint32_t size = 0;
        bool ok = clip_utf8_to_utf16le(text, &data, &size);
        pthread_mutex_unlock(&ctx->clip_mutex);
        UINT rc = clip_send_data_response(ctx, data, size, ok ? TRUE : FALSE);
        free(data);
        return rc;
    }
    if (formatDataRequest->requestedFormatId == ZEPHYR_CLIP_FORMAT_FILEGROUP) {
        UINT32 size = 0;
        BYTE* data = clip_build_local_file_descriptors(ctx, &size);
        UINT rc = clip_send_data_response(ctx, data, size, data ? TRUE : FALSE);
        free(data);
        return rc;
    }
    return clip_send_data_response(ctx, NULL, 0, FALSE);
}

static UINT clip_on_server_format_data_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_RESPONSE* formatDataResponse)
{
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx || !formatDataResponse) return ERROR_INVALID_PARAMETER;
    const BOOL ok = (formatDataResponse->common.msgFlags & CB_RESPONSE_OK) && !(formatDataResponse->common.msgFlags & CB_RESPONSE_FAIL);
    if (!ok) return CHANNEL_RC_OK;
    pthread_mutex_lock(&ctx->clip_mutex);
    UINT32 pending = ctx->clip_pending_format_id;
    ctx->clip_pending_format_id = 0;
    UINT32 remote_text = ctx->clip_remote_text_format_id;
    UINT32 remote_file = ctx->clip_remote_file_format_id;
    pthread_mutex_unlock(&ctx->clip_mutex);

    if (pending == remote_text && formatDataResponse->requestedFormatData) {
        char* text = clip_utf16le_to_utf8(formatDataResponse->requestedFormatData, formatDataResponse->common.dataLen);
        if (text) {
            clip_queue_text_event(ctx, text);
            free(text);
        }
        if (remote_file) clip_request_remote_format(ctx, remote_file);
    } else if (pending == remote_file && formatDataResponse->requestedFormatData) {
        FILEDESCRIPTORW* desc = NULL;
        UINT32 count = 0;
        if (cliprdr_parse_file_list(formatDataResponse->requestedFormatData, formatDataResponse->common.dataLen, &desc, &count) == CHANNEL_RC_OK && desc) {
            pthread_mutex_lock(&ctx->clip_mutex);
            clip_free_remote_files(ctx);
            ctx->clip_remote_files = (RdpRemoteClipboardFile*)calloc(count, sizeof(RdpRemoteClipboardFile));
            ctx->clip_remote_file_count = ctx->clip_remote_files ? count : 0;
            for (UINT32 i = 0; i < ctx->clip_remote_file_count; i++) {
                char* name = clip_wchar_to_utf8(desc[i].cFileName, 260);
                ctx->clip_remote_files[i].name = name ? name : strdup("remote-file");
                ctx->clip_remote_files[i].size = (((uint64_t)desc[i].nFileSizeHigh) << 32) | desc[i].nFileSizeLow;
                ctx->clip_remote_files[i].flags = desc[i].dwFlags;
            }
            clip_queue_files_event_locked(ctx);
            pthread_mutex_unlock(&ctx->clip_mutex);
        }
        free(desc);
    }
    return CHANNEL_RC_OK;
}

static UINT clip_on_server_file_contents_request(CliprdrClientContext* context, const CLIPRDR_FILE_CONTENTS_REQUEST* req)
{
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx || !req) return ERROR_INVALID_PARAMETER;
    pthread_mutex_lock(&ctx->clip_mutex);
    if (req->listIndex >= ctx->clip_local_file_count) {
        pthread_mutex_unlock(&ctx->clip_mutex);
        return clip_send_file_contents_response(ctx, req, NULL, 0, FALSE);
    }
    char* path_copy = strdup(ctx->clip_local_files[req->listIndex].path ? ctx->clip_local_files[req->listIndex].path : "");
    uint64_t size = ctx->clip_local_files[req->listIndex].size;
    pthread_mutex_unlock(&ctx->clip_mutex);
    if (!path_copy || !*path_copy) { free(path_copy); return clip_send_file_contents_response(ctx, req, NULL, 0, FALSE); }
    if (req->dwFlags & FILECONTENTS_SIZE) {
        uint8_t buf[8];
        for (int i = 0; i < 8; i++) buf[i] = (uint8_t)((size >> (i * 8)) & 0xFF);
        UINT rc = clip_send_file_contents_response(ctx, req, buf, sizeof(buf), TRUE);
        free(path_copy);
        return rc;
    }
    if (req->dwFlags & FILECONTENTS_RANGE) {
        uint64_t offset = ((uint64_t)req->nPositionHigh << 32) | req->nPositionLow;
        FILE* fp = fopen(path_copy, "rb");
        if (!fp) { free(path_copy); return clip_send_file_contents_response(ctx, req, NULL, 0, FALSE); }
        if (fseeko(fp, (off_t)offset, SEEK_SET) != 0) { free(path_copy); fclose(fp); return clip_send_file_contents_response(ctx, req, NULL, 0, FALSE); }
        uint32_t want = req->cbRequested;
        uint8_t* data = (uint8_t*)malloc(want ? want : 1);
        if (!data) { free(path_copy); fclose(fp); return clip_send_file_contents_response(ctx, req, NULL, 0, FALSE); }
        size_t got = fread(data, 1, want, fp);
        fclose(fp);
        free(path_copy);
        UINT rc = clip_send_file_contents_response(ctx, req, data, (UINT32)got, TRUE);
        free(data);
        return rc;
    }
    free(path_copy);
    return clip_send_file_contents_response(ctx, req, NULL, 0, FALSE);
}

static UINT clip_on_server_file_contents_response(CliprdrClientContext* context, const CLIPRDR_FILE_CONTENTS_RESPONSE* resp)
{
    BridgeContext* ctx = context ? (BridgeContext*)context->custom : NULL;
    if (!ctx || !resp) return ERROR_INVALID_PARAMETER;
    pthread_mutex_lock(&ctx->clip_mutex);
    if (ctx->clip_pending_stream_id == resp->streamId) {
        free(ctx->clip_pending_data);
        ctx->clip_pending_data = NULL;
        ctx->clip_pending_size = 0;
        ctx->clip_pending_flags = resp->common.msgFlags;
        if ((resp->common.msgFlags & CB_RESPONSE_OK) && resp->requestedData && resp->cbRequested) {
            ctx->clip_pending_data = (uint8_t*)malloc(resp->cbRequested);
            if (ctx->clip_pending_data) {
                memcpy(ctx->clip_pending_data, resp->requestedData, resp->cbRequested);
                ctx->clip_pending_size = resp->cbRequested;
            }
        }
        ctx->clip_pending_done = true;
        pthread_cond_broadcast(&ctx->clip_cond);
    }
    pthread_mutex_unlock(&ctx->clip_mutex);
    return CHANNEL_RC_OK;
}

/* ============================================================================
 * FreeRDP Callbacks
 * ============================================================================ */

static BOOL bridge_pre_connect(freerdp* instance)
{
    rdpSettings* settings = instance->context->settings;
    
    /* Ensure we have proper settings */
    if (!freerdp_settings_get_string(settings, FreeRDP_ServerHostname)) {
        fprintf(stderr, "[rdp_bridge] ERROR: No server hostname set\n");
        return FALSE;
    }
    
    /* Load required channels using FreeRDP3 API.
     * This loads rdpgfx, disp, rdpsnd based on settings. */
    if (!freerdp_client_load_channels(instance)) {
        fprintf(stderr, "[rdp_bridge] WARNING: freerdp_client_load_channels failed\n");
        /* Continue anyway - some channels may still work */
    }
    
    return TRUE;
}

static BOOL bridge_post_connect(freerdp* instance)
{
    BridgeContext* ctx = (BridgeContext*)instance->context;
    rdpContext* context = instance->context;
    rdpSettings* settings = context->settings;
    
    /* Check if channels object exists */
    if (!context->channels) {
        fprintf(stderr, "[rdp_bridge] WARNING: Channels object is NULL!\n");
    }
    
    /* WIRE-THROUGH MODE with DeactivateClientDecoding:
     * 
     * We still call gdi_init() for proper FreeRDP internal state, but with
     * DeactivateClientDecoding=TRUE, the heavy codec decoding is skipped.
     * The GDI framebuffer is allocated, but we don't use it for actual decoding -
     * all graphics flow as encoded events to the frontend.
     */
    fprintf(stderr, "[rdp_bridge] PostConnect: gdi=%p before gdi_init\n", (void*)context->gdi);
    if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) {
        fprintf(stderr, "[rdp_bridge] gdi_init failed\n");
        return FALSE;
    }
    
    fprintf(stderr, "[rdp_bridge] PostConnect: GDI initialized (gdi=%p, cache=%p)\n",
            (void*)context->gdi, (void*)context->cache);
    
    /* Register pointer/cursor callbacks for remote cursor support.
     * context->graphics is allocated during freerdp_context_new(), independently of GDI. */
    {
        rdpPointer pointer_proto = { 0 };
        pointer_proto.size = sizeof(BridgePointer);
        pointer_proto.New = bridge_pointer_new;
        pointer_proto.Free = bridge_pointer_free;
        pointer_proto.Set = bridge_pointer_set;
        pointer_proto.SetNull = bridge_pointer_set_null;
        pointer_proto.SetDefault = bridge_pointer_set_default;
        pointer_proto.SetPosition = bridge_pointer_set_position;
        graphics_register_pointer(context->graphics, &pointer_proto);
        fprintf(stderr, "[rdp_bridge] Pointer callbacks registered (no-GDI mode)\n");
    }
    
    /* Register pointer UPDATE callbacks.
     * Since we use DeactivateClientDecoding=TRUE, pointer_cache_register_callbacks()
     * is not called by FreeRDP. We need to register these ourselves to receive
     * pointer PDUs from the RDP server. */
    {
        rdpPointerUpdate* pointer = context->update->pointer;
        if (pointer) {
            pointer->PointerPosition = bridge_update_pointer_position;
            pointer->PointerSystem = bridge_update_pointer_system;
            pointer->PointerColor = bridge_update_pointer_color;
            pointer->PointerNew = bridge_update_pointer_new;
            pointer->PointerLarge = bridge_update_pointer_large;
            pointer->PointerCached = bridge_update_pointer_cached;
            fprintf(stderr, "[rdp_bridge] Pointer UPDATE callbacks registered\n");
        } else {
            fprintf(stderr, "[rdp_bridge] WARNING: pointer update is NULL!\n");
        }
    }
    
    /* Check if server supports GFX */
    {
        rdpSettings* s = context->settings;
        UINT32 negFlags = freerdp_settings_get_uint32(s, FreeRDP_NegotiationFlags);
        
        /* Warn if server doesn't support GFX (DYNVC_GFX_PROTOCOL_SUPPORTED = 0x02) */
        if (!(negFlags & 0x02)) {
            fprintf(stderr, "[rdp_bridge] WARNING: Server does NOT advertise DYNVC_GFX_PROTOCOL support (flag 0x02 not set)\n");
        }
    }
    
    /* Subscribe to channel events to capture GFX DVC when it connects.
     * This must be done in PostConnect - the working version had it here. */
    PubSub_SubscribeChannelConnected(context->pubSub, bridge_on_channel_connected);
    PubSub_SubscribeChannelDisconnected(context->pubSub, bridge_on_channel_disconnected);
    
    /* Set up desktop resize callback (needed for GFX ResetGraphics) */
    context->update->DesktopResize = bridge_desktop_resize;
    
    /* Initialize frame dimensions from settings.
     * These will be updated by ResetGraphics PDU when GFX connects. */
    ctx->frame_width = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
    ctx->frame_height = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);
    
    /* WIRE-THROUGH MODE: No need to set needs_full_frame - GFX events will flow
     * after the GFX DVC connects and sends CreateSurface/StartFrame etc. */
    
    /* Queue init settings for frontend (mirrors log_settings output) */
    queue_init_settings(ctx, settings);
    
    return TRUE;
}

static void bridge_post_disconnect(freerdp* instance)
{
    rdpContext* context = instance->context;
    BridgeContext* ctx = (BridgeContext*)context;
    rdpGdi* gdi = context->gdi;
    
    fprintf(stderr, "[rdp_bridge] PostDisconnect: cleaning up (gdi=%p, cache=%p)\n",
            (void*)gdi, (void*)context->cache);
    
    /* Mark as disconnecting to prevent further GFX operations */
    ctx->gfx_disconnecting = true;
    
    /* Unsubscribe from channel events */
    PubSub_UnsubscribeChannelConnected(context->pubSub, bridge_on_channel_connected);
    PubSub_UnsubscribeChannelDisconnected(context->pubSub, bridge_on_channel_disconnected);
    
    /* Free pending GFX event data before clearing the queue.
     * Each event may have allocated bitmap_data, nal_data, etc. */
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    if (ctx->gfx_events) {
        while (ctx->gfx_event_count > 0) {
            RdpGfxEvent* event = &ctx->gfx_events[ctx->gfx_event_read_idx];
            gfx_free_event_data(event);
            ctx->gfx_event_read_idx = (ctx->gfx_event_read_idx + 1) % ctx->gfx_events_capacity;
            ctx->gfx_event_count--;
        }
    }
    ctx->gfx_event_write_idx = 0;
    ctx->gfx_event_read_idx = 0;
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
    
    /* Clear audio state */
    pthread_mutex_lock(&ctx->audio_mutex);
    ctx->audio_buffer_pos = 0;
    ctx->audio_read_pos = 0;
    ctx->audio_initialized = false;
    pthread_mutex_unlock(&ctx->audio_mutex);
    
    /* Clear Opus state */
    pthread_mutex_lock(&ctx->opus_mutex);
    ctx->opus_write_pos = 0;
    ctx->opus_read_pos = 0;
    ctx->opus_initialized = 0;
    pthread_mutex_unlock(&ctx->opus_mutex);
    
    /* Clear GFX state */
    pthread_mutex_lock(&ctx->gfx_mutex);
    ctx->gfx_active = false;
    ctx->gfx_pipeline_ready = false;
    ctx->gfx_pipeline_needs_init = false;
    ctx->gfx_frame_in_progress = false;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    ctx->disp = NULL;
    ctx->gfx = NULL;
    ctx->rdpsnd = NULL;
    ctx->cliprdr = NULL;
    ctx->state = RDP_STATE_DISCONNECTED;
    
    /* Free AVC444 transcoder (FFmpeg decoder/encoder frames) */
    cleanup_transcoder(ctx);
    
    /* Free codec decoder */
    if (ctx->planar_decoder) {
        freerdp_bitmap_planar_context_free(ctx->planar_decoder);
        ctx->planar_decoder = NULL;
    }
    
    /* Free GDI resources */
    gdi_free(instance);
    
    /* Force glibc to return freed memory to the OS.
     * Without this, glibc keeps freed memory in its arena for reuse,
     * which looks like a memory leak in container stats. */
    malloc_trim(0);
    
    fprintf(stderr, "[rdp_bridge] PostDisconnect: cleanup complete\n");
}

static void bridge_on_channel_connected(void* ctx, const ChannelConnectedEventArgs* e)
{
    rdpContext* context = (rdpContext*)ctx;
    BridgeContext* bctx = (BridgeContext*)context;
    
    if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        CliprdrClientContext* clip = (CliprdrClientContext*)e->pInterface;
        bctx->cliprdr = clip;
        if (clip) {
            clip->custom = bctx;
            clip->MonitorReady = clip_on_monitor_ready;
            clip->ServerCapabilities = clip_on_server_capabilities;
            clip->ServerFormatList = clip_on_server_format_list;
            clip->ServerFormatListResponse = clip_on_server_format_list_response;
            clip->ServerFormatDataRequest = clip_on_server_format_data_request;
            clip->ServerFormatDataResponse = clip_on_server_format_data_response;
            clip->ServerFileContentsRequest = clip_on_server_file_contents_request;
            clip->ServerFileContentsResponse = clip_on_server_file_contents_response;
            fprintf(stderr, "[rdp_bridge] CLIPRDR channel connected\n");
        }
    }
    else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        bctx->disp = (DispClientContext*)e->pInterface;
    }
    else if (strcmp(e->name, RDPSND_CHANNEL_NAME) == 0) {
        /* Audio channel connected - initialize audio buffer */
        pthread_mutex_lock(&bctx->audio_mutex);
        if (!bctx->audio_buffer) {
            /* 1 second buffer at 48kHz stereo 16-bit = 192KB */
            bctx->audio_buffer_size = 48000 * 2 * 2;
            bctx->audio_buffer = (uint8_t*)calloc(1, bctx->audio_buffer_size);
            bctx->audio_buffer_pos = 0;
            bctx->audio_read_pos = 0;
        }
        /* Default format - will be updated when audio format is received */
        bctx->audio_sample_rate = 48000;
        bctx->audio_channels = 2;
        bctx->audio_bits = 16;
        bctx->audio_initialized = true;
        pthread_mutex_unlock(&bctx->audio_mutex);
        
        /* Mark Opus audio as initialized for native streaming */
        pthread_mutex_lock(&bctx->opus_mutex);
        bctx->opus_initialized = 1;
        pthread_mutex_unlock(&bctx->opus_mutex);
    }
    else if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        /* GFX pipeline connected - save context and set deferred init flag.
         * 
         * We do NOT call gdi_graphics_pipeline_init() here because it causes
         * thread-safety issues (GDI reinit in different thread).
         * Instead, we set a flag and initialize from the main poll thread.
         */
        RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
        bctx->gfx = gfx;
        
        if (gfx) {
            /* Store our context for callbacks */
            gfx->custom = bctx;
            
            /* NOTE: Frame ACK control in FreeRDP3 is handled via the OnOpen callback.
             * The OnOpen callback receives a BOOL* do_frame_acks parameter that controls
             * whether FreeRDP automatically sends frame ACKs after EndFrame.
             * 
             * We set gfx->OnOpen = gfx_on_open which sets *do_frame_acks = FALSE,
             * meaning we must manually call gfx->FrameAcknowledge() when the browser
             * sends its FACK message back through the WebSocket.
             * 
             * This provides proper backpressure - if the browser is slow to decode,
             * ACKs will be delayed and the server will throttle its frame rate. */
            
            pthread_mutex_lock(&bctx->gfx_mutex);
            bctx->gfx_active = true;
            bctx->gfx_pipeline_needs_init = true;  /* Deferred init in main thread */
            pthread_mutex_unlock(&bctx->gfx_mutex);
            
            /* Set up ALL GFX callbacks for proper protocol handling.
             * Missing callbacks can cause the server to abort the connection.
             * 
             * PURE GFX MODE: We handle graphics via RDPEGFX callbacks only.
             * H.264/AVC frames are captured and passed to WebSocket clients.
             * Non-H.264 codecs are decoded to the primary buffer.
             */
            gfx->CapsConfirm = gfx_on_caps_confirm;
            gfx->ResetGraphics = gfx_on_reset_graphics;
            gfx->StartFrame = gfx_on_start_frame;
            gfx->EndFrame = gfx_on_end_frame;
            gfx->SurfaceCommand = gfx_on_surface_command;
            gfx->CreateSurface = gfx_on_create_surface;
            gfx->DeleteSurface = gfx_on_delete_surface;
            gfx->MapSurfaceToOutput = gfx_on_map_surface;
            gfx->MapSurfaceToScaledOutput = gfx_on_map_surface_scaled;
            gfx->MapSurfaceToWindow = gfx_on_map_surface_window;
            gfx->MapSurfaceToScaledWindow = gfx_on_map_surface_scaled_window;
            gfx->SolidFill = gfx_on_solid_fill;
            gfx->SurfaceToSurface = gfx_on_surface_to_surface;
            gfx->SurfaceToCache = gfx_on_surface_to_cache;
            gfx->CacheToSurface = gfx_on_cache_to_surface;
            gfx->EvictCacheEntry = gfx_on_evict_cache;
            gfx->DeleteEncodingContext = gfx_on_delete_encoding_context;
            gfx->CacheImportReply = gfx_on_cache_import_reply;
            
            /* OnOpen: disable automatic frame ACKs - browser controls flow */
            gfx->OnOpen = gfx_on_open;
        }
    }
}

static void bridge_on_channel_disconnected(void* ctx, const ChannelDisconnectedEventArgs* e)
{
    rdpContext* context = (rdpContext*)ctx;
    BridgeContext* bctx = (BridgeContext*)context;
    
    if (strcmp(e->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
        bctx->cliprdr = NULL;
        fprintf(stderr, "[rdp_bridge] CLIPRDR channel disconnected\n");
    }
    else if (strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) {
        bctx->disp = NULL;
    }
    else if (strcmp(e->name, RDPSND_CHANNEL_NAME) == 0) {
        pthread_mutex_lock(&bctx->audio_mutex);
        bctx->audio_initialized = false;
        pthread_mutex_unlock(&bctx->audio_mutex);
        
        pthread_mutex_lock(&bctx->opus_mutex);
        bctx->opus_initialized = 0;
        pthread_mutex_unlock(&bctx->opus_mutex);
    }
    else if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        pthread_mutex_lock(&bctx->gfx_mutex);
        /* NOTE: We skip gdi_graphics_pipeline_uninit() because we never called
         * gdi_init() in pure GFX wire-through mode. */
        bctx->gfx = NULL;
        bctx->gfx_active = false;
        pthread_mutex_unlock(&bctx->gfx_mutex);
    }
}

static BOOL bridge_desktop_resize(rdpContext* context)
{
    BridgeContext* ctx = (BridgeContext*)context;
    rdpGdi* gdi = context->gdi;
    
    if (!gdi || !gdi_resize(gdi, gdi->width, gdi->height)) {
        fprintf(stderr, "[rdp_bridge] gdi_resize failed\n");
        return FALSE;
    }
    
    /* Update stored dimensions from GDI */
    ctx->frame_width = gdi->width;
    ctx->frame_height = gdi->height;
    
    fprintf(stderr, "[rdp_bridge] DesktopResize: %dx%d\n", gdi->width, gdi->height);
    
    /* In wire-through mode, the server will send ResetGraphics and fresh
     * surfaces after resize. No dirty rect tracking needed. */
    
    return TRUE;
}

/* ============================================================================
 * AVC444 Transcoder (4:4:4 → 4:2:0 for browser compatibility)
 * 
 * Per MS-RDPEGFX spec, AVC444 uses two H.264 streams:
 * - Stream 0: Luma (Y plane) encoded as YUV420
 * - Stream 1: Chroma (U/V planes) encoded separately at full resolution
 * 
 * Browsers only decode standard YUV420, so we must:
 * 1. Decode both streams
 * 2. Combine into YUV444
 * 3. Convert to YUV420
 * 4. Re-encode to H.264
 * ============================================================================ */

static bool init_transcoder(BridgeContext* ctx, int width, int height)
{
    const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_H264);
    const AVCodec* encoder = avcodec_find_encoder(AV_CODEC_ID_H264);
    
    if (!decoder || !encoder) {
        fprintf(stderr, "[rdp_bridge] H.264 codec not found\n");
        return false;
    }
    
    /* Luma decoder */
    ctx->avc_decoder_luma = avcodec_alloc_context3(decoder);
    if (!ctx->avc_decoder_luma) goto fail;
    
    ctx->avc_decoder_luma->thread_count = 2;  /* Low latency */
    ctx->avc_decoder_luma->flags |= AV_CODEC_FLAG_LOW_DELAY;
    ctx->avc_decoder_luma->flags2 |= AV_CODEC_FLAG2_FAST;
    
    if (avcodec_open2(ctx->avc_decoder_luma, decoder, NULL) < 0) {
        fprintf(stderr, "[rdp_bridge] Failed to open luma decoder\n");
        goto fail;
    }
    
    /* Chroma decoder (separate instance for AVC444) */
    ctx->avc_decoder_chroma = avcodec_alloc_context3(decoder);
    if (!ctx->avc_decoder_chroma) goto fail;
    
    ctx->avc_decoder_chroma->thread_count = 2;
    ctx->avc_decoder_chroma->flags |= AV_CODEC_FLAG_LOW_DELAY;
    ctx->avc_decoder_chroma->flags2 |= AV_CODEC_FLAG2_FAST;
    
    if (avcodec_open2(ctx->avc_decoder_chroma, decoder, NULL) < 0) {
        fprintf(stderr, "[rdp_bridge] Failed to open chroma decoder\n");
        goto fail;
    }
    
    /* H.264 encoder for output (4:2:0) */
    ctx->avc_encoder = avcodec_alloc_context3(encoder);
    if (!ctx->avc_encoder) goto fail;
    
    ctx->avc_encoder->width = width;
    ctx->avc_encoder->height = height;
    ctx->avc_encoder->pix_fmt = AV_PIX_FMT_YUV420P;
    ctx->avc_encoder->time_base = (AVRational){1, 60};
    ctx->avc_encoder->framerate = (AVRational){60, 1};
    ctx->avc_encoder->thread_count = 2;
    ctx->avc_encoder->flags |= AV_CODEC_FLAG_LOW_DELAY;
    ctx->avc_encoder->max_b_frames = 0;  /* No B-frames for low latency */
    ctx->avc_encoder->gop_size = 60;     /* Keyframe every 60 frames */
    
    /* Tune for low latency (zerolatency preset equivalent) */
    AVDictionary* opts = NULL;
    av_dict_set(&opts, "preset", "ultrafast", 0);
    av_dict_set(&opts, "tune", "zerolatency", 0);
    av_dict_set(&opts, "crf", "23", 0);
    
    if (avcodec_open2(ctx->avc_encoder, encoder, &opts) < 0) {
        fprintf(stderr, "[rdp_bridge] Failed to open H.264 encoder\n");
        av_dict_free(&opts);
        goto fail;
    }
    av_dict_free(&opts);
    
    /* Allocate frames */
    ctx->decoded_frame_luma = av_frame_alloc();
    ctx->decoded_frame_chroma = av_frame_alloc();
    ctx->combined_frame = av_frame_alloc();
    ctx->output_frame = av_frame_alloc();
    ctx->encode_pkt = av_packet_alloc();
    
    if (!ctx->decoded_frame_luma || !ctx->decoded_frame_chroma || 
        !ctx->combined_frame || !ctx->output_frame || !ctx->encode_pkt) {
        goto fail;
    }
    
    /* Setup output frame (YUV420P) */
    ctx->output_frame->format = AV_PIX_FMT_YUV420P;
    ctx->output_frame->width = width;
    ctx->output_frame->height = height;
    if (av_frame_get_buffer(ctx->output_frame, 0) < 0) {
        fprintf(stderr, "[rdp_bridge] Failed to allocate output frame buffer\n");
        goto fail;
    }
    
    /* Setup combined frame (YUV444P for intermediate) */
    ctx->combined_frame->format = AV_PIX_FMT_YUV444P;
    ctx->combined_frame->width = width;
    ctx->combined_frame->height = height;
    if (av_frame_get_buffer(ctx->combined_frame, 0) < 0) {
        fprintf(stderr, "[rdp_bridge] Failed to allocate combined frame buffer\n");
        goto fail;
    }
    
    /* Create scaler for YUV444 → YUV420 conversion */
    ctx->sws_ctx = sws_getContext(width, height, AV_PIX_FMT_YUV444P,
                                   width, height, AV_PIX_FMT_YUV420P,
                                   SWS_FAST_BILINEAR, NULL, NULL, NULL);
    if (!ctx->sws_ctx) {
        fprintf(stderr, "[rdp_bridge] Failed to create scaler context\n");
        goto fail;
    }
    
    ctx->transcoder_initialized = true;
    return true;
    
fail:
    /* Cleanup on failure */
    if (ctx->avc_decoder_luma) { avcodec_free_context(&ctx->avc_decoder_luma); }
    if (ctx->avc_decoder_chroma) { avcodec_free_context(&ctx->avc_decoder_chroma); }
    if (ctx->avc_encoder) { avcodec_free_context(&ctx->avc_encoder); }
    if (ctx->decoded_frame_luma) { av_frame_free(&ctx->decoded_frame_luma); }
    if (ctx->decoded_frame_chroma) { av_frame_free(&ctx->decoded_frame_chroma); }
    if (ctx->combined_frame) { av_frame_free(&ctx->combined_frame); }
    if (ctx->output_frame) { av_frame_free(&ctx->output_frame); }
    if (ctx->encode_pkt) { av_packet_free(&ctx->encode_pkt); }
    if (ctx->sws_ctx) { sws_freeContext(ctx->sws_ctx); ctx->sws_ctx = NULL; }
    return false;
}

static void cleanup_transcoder(BridgeContext* ctx)
{
    if (ctx->avc_decoder_luma) { avcodec_free_context(&ctx->avc_decoder_luma); }
    if (ctx->avc_decoder_chroma) { avcodec_free_context(&ctx->avc_decoder_chroma); }
    if (ctx->avc_encoder) { avcodec_free_context(&ctx->avc_encoder); }
    if (ctx->decoded_frame_luma) { av_frame_free(&ctx->decoded_frame_luma); }
    if (ctx->decoded_frame_chroma) { av_frame_free(&ctx->decoded_frame_chroma); }
    if (ctx->combined_frame) { av_frame_free(&ctx->combined_frame); }
    if (ctx->output_frame) { av_frame_free(&ctx->output_frame); }
    if (ctx->encode_pkt) { av_packet_free(&ctx->encode_pkt); }
    if (ctx->sws_ctx) { sws_freeContext(ctx->sws_ctx); ctx->sws_ctx = NULL; }
    ctx->transcoder_initialized = false;
}

/* Transcode AVC444 (luma + chroma streams) to standard 4:2:0 H.264 */
static bool transcode_avc444(BridgeContext* ctx,
                             const uint8_t* luma_data, uint32_t luma_size,
                             const uint8_t* chroma_data, uint32_t chroma_size,
                             uint8_t** out_data, uint32_t* out_size)
{
    if (!ctx->transcoder_initialized) {
        fprintf(stderr, "[rdp_bridge] Transcoder not initialized\n");
        return false;
    }
    
    AVPacket* pkt = av_packet_alloc();
    if (!pkt) return false;
    
    int ret;
    bool got_luma = false;
    bool got_chroma = false;
    
    /* Decode luma stream */
    pkt->data = (uint8_t*)luma_data;
    pkt->size = luma_size;
    
    ret = avcodec_send_packet(ctx->avc_decoder_luma, pkt);
    if (ret < 0 && ret != AVERROR(EAGAIN)) {
        av_packet_free(&pkt);
        return false;
    }
    
    ret = avcodec_receive_frame(ctx->avc_decoder_luma, ctx->decoded_frame_luma);
    if (ret == 0) {
        got_luma = true;
    }
    
    /* Decode chroma stream if present */
    if (chroma_data && chroma_size > 0) {
        pkt->data = (uint8_t*)chroma_data;
        pkt->size = chroma_size;
        
        ret = avcodec_send_packet(ctx->avc_decoder_chroma, pkt);
        if (ret == 0 || ret == AVERROR(EAGAIN)) {
            ret = avcodec_receive_frame(ctx->avc_decoder_chroma, ctx->decoded_frame_chroma);
            if (ret == 0) {
                got_chroma = true;
            }
        }
    }
    
    av_packet_free(&pkt);
    
    if (!got_luma) {
        /* No frame decoded yet (buffering), pass through luma data as-is
         * This happens during initial keyframe build-up */
        *out_data = malloc(luma_size);
        if (*out_data) {
            memcpy(*out_data, luma_data, luma_size);
            *out_size = luma_size;
            return true;
        }
        return false;
    }
    
    /* Combine luma and chroma into YUV444 frame */
    AVFrame* luma = ctx->decoded_frame_luma;
    AVFrame* combined = ctx->combined_frame;
    
    /* Safety check: ensure decoded frame fits in our pre-allocated buffers.
     * If the frame dimensions changed (e.g., after resize), we need to bail out
     * rather than cause a buffer overflow. The transcoder should be reset on resize. */
    if (luma->width > combined->width || luma->height > combined->height) {
        fprintf(stderr, "[rdp_bridge] Transcoder dimension mismatch: decoded=%dx%d, buffer=%dx%d\n",
                luma->width, luma->height, combined->width, combined->height);
        /* Pass through luma data as-is rather than crash */
        *out_data = malloc(luma_size);
        if (*out_data) {
            memcpy(*out_data, luma_data, luma_size);
            *out_size = luma_size;
            return true;
        }
        return false;
    }
    
    /* Copy Y plane from luma frame */
    for (int y = 0; y < luma->height; y++) {
        memcpy(combined->data[0] + y * combined->linesize[0],
               luma->data[0] + y * luma->linesize[0],
               luma->width);
    }
    
    if (got_chroma) {
        /* AVC444: Use decoded chroma for U/V at full resolution */
        AVFrame* chroma = ctx->decoded_frame_chroma;
        
        /* Safety check for chroma dimensions */
        if (chroma->width > combined->width || chroma->height > combined->height) {
            fprintf(stderr, "[rdp_bridge] Chroma dimension mismatch: %dx%d vs %dx%d\n",
                    chroma->width, chroma->height, combined->width, combined->height);
            /* Skip chroma copy, use luma-only fallback below */
            got_chroma = false;
        }
        
        if (got_chroma) {
            /* The chroma stream contains U and V at full resolution */
            for (int y = 0; y < chroma->height; y++) {
                /* Copy U plane */
                memcpy(combined->data[1] + y * combined->linesize[1],
                       chroma->data[1] + y * chroma->linesize[1],
                       chroma->width);
                /* Copy V plane */
                memcpy(combined->data[2] + y * combined->linesize[2],
                       chroma->data[2] + y * chroma->linesize[2],
                       chroma->width);
            }
        }
    }
    
    if (!got_chroma) {
        /* No chroma: upscale 4:2:0 chroma from luma frame to 4:4:4 */
        for (int y = 0; y < luma->height; y++) {
            for (int x = 0; x < luma->width; x++) {
                int src_y = y / 2;
                int src_x = x / 2;
                if (src_y < luma->height / 2 && src_x < luma->width / 2) {
                    combined->data[1][y * combined->linesize[1] + x] =
                        luma->data[1][src_y * luma->linesize[1] + src_x];
                    combined->data[2][y * combined->linesize[2] + x] =
                        luma->data[2][src_y * luma->linesize[2] + src_x];
                }
            }
        }
    }
    
    /* Convert YUV444 → YUV420 */
    av_frame_make_writable(ctx->output_frame);
    sws_scale(ctx->sws_ctx,
              (const uint8_t* const*)combined->data, combined->linesize,
              0, combined->height,
              ctx->output_frame->data, ctx->output_frame->linesize);
    
    ctx->output_frame->pts = luma->pts;
    
    /* Encode to H.264 */
    ret = avcodec_send_frame(ctx->avc_encoder, ctx->output_frame);
    if (ret < 0) {
        fprintf(stderr, "[rdp_bridge] Encode send failed: %d\n", ret);
        return false;
    }
    
    ret = avcodec_receive_packet(ctx->avc_encoder, ctx->encode_pkt);
    if (ret == AVERROR(EAGAIN)) {
        /* Encoder buffering - pass through luma */
        *out_data = malloc(luma_size);
        if (*out_data) {
            memcpy(*out_data, luma_data, luma_size);
            *out_size = luma_size;
            return true;
        }
        return false;
    } else if (ret < 0) {
        fprintf(stderr, "[rdp_bridge] Encode receive failed: %d\n", ret);
        return false;
    }
    
    /* Copy encoded data */
    *out_data = malloc(ctx->encode_pkt->size);
    if (!*out_data) {
        av_packet_unref(ctx->encode_pkt);
        return false;
    }
    memcpy(*out_data, ctx->encode_pkt->data, ctx->encode_pkt->size);
    *out_size = ctx->encode_pkt->size;
    
    av_packet_unref(ctx->encode_pkt);
    return true;
}

/* ============================================================================
 * GFX Pipeline Callbacks (RDPEGFX for H.264/AVC444)
 * ============================================================================ */

static UINT gfx_on_caps_confirm(RdpgfxClientContext* context, const RDPGFX_CAPS_CONFIRM_PDU* caps)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    UINT32 version = caps->capsSet->version;
    UINT32 flags = caps->capsSet->flags;
    
    /* Log the confirmed capabilities */
    log_caps_confirm(version, flags);
    
    /* Queue CAPS_CONFIRM event for frontend */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_CAPS_CONFIRM;
    event.gfx_version = version;
    event.gfx_flags = flags;
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_reset_graphics(RdpgfxClientContext* context, const RDPGFX_RESET_GRAPHICS_PDU* reset)
{
    /* PURE GFX MODE: Handle reset ourselves, no GDI chaining */
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    /* Reset the AVC444 transcoder on resize.
     * The transcoder's encoder/frames are sized for the original resolution.
     * If we resize to a larger resolution, the new decoded frames will overflow
     * the transcoder's internal buffers, causing a crash.
     * Cleaning up here allows re-initialization with new dimensions. */
    if (bctx->transcoder_initialized) {
        cleanup_transcoder(bctx);
    }
    
    /* NOTE: ClearCodec decoder is session-level and should NOT be reset here.
     * Its internal caches (VBar, ShortVBar, Glyph) build up over the session
     * and the server expects the client to retain them. */
    
    /* Clear all our surface tracking - but NOT the bitmap cache!
     * The GFX bitmap cache and ClearCodec internal state are session-level,
     * they persist across surface resets. Only surfaces are reset. */
    pthread_mutex_lock(&bctx->gfx_mutex);
    for (int i = 0; i < RDP_MAX_GFX_SURFACES; i++) {
        bctx->surfaces[i].active = false;
    }
    bctx->primary_surface_id = 0;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* PURE GFX MODE: Server will send fresh content via CreateSurface and tiles.
     * No local surface buffers to manage. */
    
    /* Update frame dimensions.
     * In wire-through mode, the server will send fresh GFX events for the new surface. */
    pthread_mutex_lock(&bctx->gfx_mutex);
    bctx->frame_width = reset->width;
    bctx->frame_height = reset->height;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* Forward reset to frontend so it can clear all its state */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_RESET_GRAPHICS;
    event.width = reset->width;
    event.height = reset->height;
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_create_surface(RdpgfxClientContext* context, const RDPGFX_CREATE_SURFACE_PDU* create)
{
    /* PURE GFX MODE: Track surfaces ourselves, no GDI chaining */
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    /* Log pixel format for debugging */
    const char* format_str = "UNKNOWN";
    switch (create->pixelFormat) {
        case GFX_PIXEL_FORMAT_XRGB_8888: format_str = "XRGB_8888 (0x20)"; break;
        case GFX_PIXEL_FORMAT_ARGB_8888: format_str = "ARGB_8888 (0x21)"; break;
        default: break;
    }
    fprintf(stderr, "[GFX] CreateSurface: id=%u, %ux%u, pixelFormat=%s (0x%02X)\n",
        create->surfaceId, create->width, create->height, format_str, create->pixelFormat);
    
    pthread_mutex_lock(&bctx->gfx_mutex);
    
    /* Find slot for this surface */
    if (create->surfaceId < RDP_MAX_GFX_SURFACES) {
        bctx->surfaces[create->surfaceId].surface_id = create->surfaceId;
        bctx->surfaces[create->surfaceId].width = create->width;
        bctx->surfaces[create->surfaceId].height = create->height;
        bctx->surfaces[create->surfaceId].pixel_format = create->pixelFormat;
        bctx->surfaces[create->surfaceId].active = true;
        bctx->surfaces[create->surfaceId].mapped_to_output = false;
        bctx->surfaces[create->surfaceId].output_x = 0;
        bctx->surfaces[create->surfaceId].output_y = 0;
        
        /* WIRE-THROUGH MODE: No local buffer allocation - all decoding happens in browser.
         * Progressive codec is decoded in browser via WASM. */
    }
    
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* Queue CREATE_SURFACE event for Python wire format streaming */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_CREATE_SURFACE;
    event.surface_id = create->surfaceId;
    event.width = create->width;
    event.height = create->height;
    event.pixel_format = create->pixelFormat;
    gfx_queue_event(bctx, &event);
    
    /* WORKAROUND: Some RDP servers don't send MapSurfaceToOutput.
     * If this is surface 0 and matches the desktop size, auto-map it as primary.
     * This ensures the frontend knows which surface to composite to the output. */
    if (create->surfaceId == 0) {
        pthread_mutex_lock(&bctx->gfx_mutex);
        bctx->surfaces[0].mapped_to_output = true;
        bctx->primary_surface_id = 0;
        pthread_mutex_unlock(&bctx->gfx_mutex);
        
        /* Queue MAP_SURFACE event so frontend sets primarySurfaceId */
        RdpGfxEvent map_event = {0};
        map_event.type = RDP_GFX_EVENT_MAP_SURFACE;
        map_event.surface_id = 0;
        map_event.x = 0;
        map_event.y = 0;
        gfx_queue_event(bctx, &map_event);
    }
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_delete_surface(RdpgfxClientContext* context, const RDPGFX_DELETE_SURFACE_PDU* del)
{
    /* PURE GFX MODE: Track surfaces ourselves, no GDI chaining */
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    /* NOTE: ClearCodec decoder is session-level and should NOT be reset on surface delete. */
    
    pthread_mutex_lock(&bctx->gfx_mutex);
    
    if (del->surfaceId < RDP_MAX_GFX_SURFACES) {
        bctx->surfaces[del->surfaceId].active = false;
        if (bctx->primary_surface_id == del->surfaceId) {
            bctx->primary_surface_id = 0;
        }
        /* WIRE-THROUGH MODE: No local buffers to free */
    }
    
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* Queue DELETE_SURFACE event for Python wire format streaming */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_DELETE_SURFACE;
    event.surface_id = del->surfaceId;
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_map_surface(RdpgfxClientContext* context, const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* map)
{
    /* PURE GFX MODE: Track surface mapping ourselves, no GDI chaining */
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    pthread_mutex_lock(&bctx->gfx_mutex);
    
    if (map->surfaceId < RDP_MAX_GFX_SURFACES && bctx->surfaces[map->surfaceId].active) {
        bctx->surfaces[map->surfaceId].mapped_to_output = true;
        bctx->surfaces[map->surfaceId].output_x = map->outputOriginX;
        bctx->surfaces[map->surfaceId].output_y = map->outputOriginY;
        bctx->primary_surface_id = map->surfaceId;
    }
    
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* Queue MAP_SURFACE event for Python wire format streaming */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_MAP_SURFACE;
    event.surface_id = map->surfaceId;
    event.x = map->outputOriginX;
    event.y = map->outputOriginY;
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

/* Additional GFX callbacks - no-op implementations for protocol compliance */

static UINT gfx_on_map_surface_scaled(RdpgfxClientContext* context, 
                                       const RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU* map)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    pthread_mutex_lock(&bctx->gfx_mutex);
    if (map->surfaceId < RDP_MAX_GFX_SURFACES && bctx->surfaces[map->surfaceId].active) {
        bctx->surfaces[map->surfaceId].mapped_to_output = true;
        bctx->surfaces[map->surfaceId].output_x = map->outputOriginX;
        bctx->surfaces[map->surfaceId].output_y = map->outputOriginY;
        bctx->primary_surface_id = map->surfaceId;
    }
    pthread_mutex_unlock(&bctx->gfx_mutex);
    return CHANNEL_RC_OK;
}

static UINT gfx_on_map_surface_window(RdpgfxClientContext* context,
                                       const RDPGFX_MAP_SURFACE_TO_WINDOW_PDU* map)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_map_surface_scaled_window(RdpgfxClientContext* context,
                                              const RDPGFX_MAP_SURFACE_TO_SCALED_WINDOW_PDU* map)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_solid_fill(RdpgfxClientContext* context, const RDPGFX_SOLID_FILL_PDU* fill)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !fill) return ERROR_INVALID_PARAMETER;
    
    /* Track commands in this frame */
    bctx->frame_cmd_count++;
    
    /* Validate surface */
    if (fill->surfaceId >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[fill->surfaceId].active) {
        return CHANNEL_RC_OK;
    }
    
    /* Build BGRA32 color */
    uint32_t color = fill->fillPixel.B | 
                     (fill->fillPixel.G << 8) | 
                     (fill->fillPixel.R << 16) | 
                     (fill->fillPixel.XA << 24);
    
    /* Queue a GFX event for each rectangle - frontend handles the fill */
    for (UINT16 i = 0; i < fill->fillRectCount; i++) {
        UINT32 left = fill->fillRects[i].left;
        UINT32 top = fill->fillRects[i].top;
        UINT32 right = fill->fillRects[i].right;
        UINT32 bottom = fill->fillRects[i].bottom;
        
        if (left >= right || top >= bottom) continue;
        
        RdpGfxEvent event = {0};
        event.type = RDP_GFX_EVENT_SOLID_FILL;
        event.frame_id = bctx->current_frame_id;
        event.surface_id = fill->surfaceId;
        event.x = left;
        event.y = top;
        event.width = right - left;
        event.height = bottom - top;
        event.color = color;
        
        gfx_queue_event(bctx, &event);
    }
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_surface_to_surface(RdpgfxClientContext* context, 
                                       const RDPGFX_SURFACE_TO_SURFACE_PDU* copy)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !copy) return ERROR_INVALID_PARAMETER;
    
    /* Track commands in this frame */
    bctx->frame_cmd_count++;
    
    /* Validate surfaces */
    if (copy->surfaceIdSrc >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[copy->surfaceIdSrc].active) {
        return CHANNEL_RC_OK;
    }
    if (copy->surfaceIdDest >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[copy->surfaceIdDest].active) {
        return CHANNEL_RC_OK;
    }
    
    /* Source rectangle */
    INT32 srcX = copy->rectSrc.left;
    INT32 srcY = copy->rectSrc.top;
    INT32 width = copy->rectSrc.right - copy->rectSrc.left;
    INT32 height = copy->rectSrc.bottom - copy->rectSrc.top;
    
    if (width <= 0 || height <= 0) return CHANNEL_RC_OK;
    
    /* Queue a GFX event for each destination point - frontend handles the copy */
    for (UINT16 i = 0; i < copy->destPtsCount; i++) {
        RdpGfxEvent event = {0};
        event.type = RDP_GFX_EVENT_SURFACE_TO_SURFACE;
        event.frame_id = bctx->current_frame_id;
        event.surface_id = copy->surfaceIdSrc;
        event.dst_surface_id = copy->surfaceIdDest;
        event.src_x = srcX;
        event.src_y = srcY;
        event.width = width;
        event.height = height;
        event.x = copy->destPts[i].x;
        event.y = copy->destPts[i].y;
        
        gfx_queue_event(bctx, &event);
    }
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_surface_to_cache(RdpgfxClientContext* context,
                                     const RDPGFX_SURFACE_TO_CACHE_PDU* cache)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !cache) return ERROR_INVALID_PARAMETER;
    
    /* Validate surface */
    if (cache->surfaceId >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[cache->surfaceId].active) {
        return CHANNEL_RC_OK;
    }
    
    /* Calculate source rectangle */
    INT32 left = cache->rectSrc.left;
    INT32 top = cache->rectSrc.top;
    UINT32 width = cache->rectSrc.right - cache->rectSrc.left;
    UINT32 height = cache->rectSrc.bottom - cache->rectSrc.top;
    
    if (width == 0 || height == 0) return CHANNEL_RC_OK;
    
    /* Queue GFX event - frontend will extract pixels from its own surface copy
     * and store in its local cache. No backend buffering needed! */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_SURFACE_TO_CACHE;
    event.frame_id = bctx->current_frame_id;
    event.surface_id = cache->surfaceId;
    event.cache_slot = cache->cacheSlot;
    event.x = left;
    event.y = top;
    event.width = width;
    event.height = height;
    event.bitmap_data = NULL;  /* Frontend extracts from its surface */
    event.bitmap_size = 0;
    
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_cache_to_surface(RdpgfxClientContext* context,
                                     const RDPGFX_CACHE_TO_SURFACE_PDU* cache)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !cache) return ERROR_INVALID_PARAMETER;
    
    /* Track commands in this frame */
    bctx->frame_cmd_count++;
    
    /* Validate surface */
    if (cache->surfaceId >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[cache->surfaceId].active) {
        return CHANNEL_RC_OK;
    }
    
    /* Queue a GFX event for each destination point - frontend handles the cache blit */
    for (UINT16 i = 0; i < cache->destPtsCount; i++) {
        RdpGfxEvent event = {0};
        event.type = RDP_GFX_EVENT_CACHE_TO_SURFACE;
        event.frame_id = bctx->current_frame_id;
        event.surface_id = cache->surfaceId;
        event.cache_slot = cache->cacheSlot;
        event.x = cache->destPts[i].x;
        event.y = cache->destPts[i].y;
        event.bitmap_data = NULL;
        event.bitmap_size = 0;
        
        gfx_queue_event(bctx, &event);
    }
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_evict_cache(RdpgfxClientContext* context,
                                const RDPGFX_EVICT_CACHE_ENTRY_PDU* evict)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !evict) return ERROR_INVALID_PARAMETER;
    
    /* Forward cache eviction to frontend so it can delete the cached entry */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_EVICT_CACHE;
    event.frame_id = bctx->current_frame_id;
    event.cache_slot = evict->cacheSlot;
    
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_delete_encoding_context(RdpgfxClientContext* context,
                                            const RDPGFX_DELETE_ENCODING_CONTEXT_PDU* del)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !del) return ERROR_INVALID_PARAMETER;
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_cache_import_reply(RdpgfxClientContext* context,
                                       const RDPGFX_CACHE_IMPORT_REPLY_PDU* reply)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !reply) return ERROR_INVALID_PARAMETER;
    
    return CHANNEL_RC_OK;
}

/* OnOpen callback - controls channel initialization behavior
 * We use this to disable automatic frame ACKs - the browser controls flow! */
static UINT gfx_on_open(RdpgfxClientContext* context, BOOL* do_caps_advertise, BOOL* do_frame_acks)
{
    /* Let FreeRDP handle capability negotiation automatically */
    if (do_caps_advertise) {
        *do_caps_advertise = TRUE;
    }
    
    /* CRITICAL: Disable automatic frame ACKs!
     * The browser must send FACK after it has actually rendered each frame.
     * This enables proper backpressure from browser to RDP server. */
    if (do_frame_acks) {
        *do_frame_acks = FALSE;
    }
    
    return CHANNEL_RC_OK;
}

/* Helper: Detect frame type from H.264 NAL unit */
static RdpH264FrameType detect_h264_frame_type(const uint8_t* data, size_t len)
{
    if (!data || len < 4) return RDP_H264_FRAME_TYPE_P;
    
    /* Look for NAL unit type in Annex-B stream */
    for (size_t i = 0; i + 3 < len; i++) {
        if (data[i] == 0 && data[i+1] == 0 && data[i+2] == 1) {
            uint8_t nal_type = data[i+3] & 0x1F;
            if (nal_type == 5) return RDP_H264_FRAME_TYPE_IDR;  /* IDR picture */
            if (nal_type == 1) return RDP_H264_FRAME_TYPE_P;    /* Non-IDR */
        } else if (data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1) {
            if (i + 4 < len) {
                uint8_t nal_type = data[i+4] & 0x1F;
                if (nal_type == 5) return RDP_H264_FRAME_TYPE_IDR;
                if (nal_type == 1) return RDP_H264_FRAME_TYPE_P;
            }
        }
    }
    return RDP_H264_FRAME_TYPE_P;
}

/* Queue video frame (H.264/Progressive) as a GFX event for strict ordering
 * This ensures video frames are sent in order with other GFX commands */
static bool queue_video_frame_event(BridgeContext* bctx, uint32_t frame_id, uint16_t surface_id,
                                     RdpGfxCodecId codec_id, const RdpRect* rect,
                                     const uint8_t* nal_data, uint32_t nal_size,
                                     const uint8_t* chroma_data, uint32_t chroma_size)
{
    if (!bctx || !nal_data || nal_size == 0) return false;
    
    const uint8_t* output_nal = nal_data;
    uint32_t output_nal_size = nal_size;
    uint8_t* transcoded_data = NULL;
    
    /* For AVC444: transcode to 4:2:0 for browser compatibility */
    if ((codec_id == RDP_GFX_CODEC_AVC444 || codec_id == RDP_GFX_CODEC_AVC444v2) 
        && chroma_data && chroma_size > 0) {
        
        /* Initialize transcoder on first frame */
        if (!bctx->transcoder_initialized) {
            int width = rect->width > 0 ? rect->width : bctx->frame_width;
            int height = rect->height > 0 ? rect->height : bctx->frame_height;
            if (width <= 0 || height <= 0) {
                width = 1920;
                height = 1080;
            }
            if (!init_transcoder(bctx, width, height)) {
                fprintf(stderr, "[rdp_bridge] Transcoder init failed, passing through luma only\n");
            }
        }
        
        /* Transcode AVC444 → AVC420 */
        if (bctx->transcoder_initialized) {
            uint32_t new_size = 0;
            if (transcode_avc444(bctx, nal_data, nal_size, chroma_data, chroma_size,
                                 &transcoded_data, &new_size)) {
                output_nal = transcoded_data;
                output_nal_size = new_size;
                codec_id = RDP_GFX_CODEC_AVC420;  /* Now it's 4:2:0 */
            }
        }
    }
    
    /* Build GFX event with video frame data */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_VIDEO_FRAME;
    event.frame_id = frame_id;
    event.surface_id = surface_id;
    event.x = rect->x;
    event.y = rect->y;
    event.width = rect->width;
    event.height = rect->height;
    event.codec_id = codec_id;
    event.video_frame_type = detect_h264_frame_type(output_nal, output_nal_size);
    
    /* Allocate and copy NAL data - will be freed by Python after consumption */
    event.nal_data = (uint8_t*)malloc(output_nal_size);
    if (!event.nal_data) {
        if (transcoded_data) free(transcoded_data);
        return false;
    }
    memcpy(event.nal_data, output_nal, output_nal_size);
    event.nal_size = output_nal_size;
    
    /* No chroma data after transcoding (merged into 4:2:0) */
    event.chroma_nal_data = NULL;
    event.chroma_nal_size = 0;
    
    /* Queue the event */
    gfx_queue_event(bctx, &event);
    
    /* Track negotiated codec */
    bctx->gfx_codec = codec_id;
    
    if (transcoded_data) free(transcoded_data);
    return true;
}

static UINT gfx_on_surface_command(RdpgfxClientContext* context, const RDPGFX_SURFACE_COMMAND* cmd)
{
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx) return ERROR_INVALID_PARAMETER;
    
    /* Track commands in this frame */
    bctx->frame_cmd_count++;
    
    /* Check if disconnecting - don't process frames during teardown */
    pthread_mutex_lock(&bctx->gfx_mutex);
    bool disconnecting = bctx->gfx_disconnecting;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    if (disconnecting) {
        return CHANNEL_RC_OK;
    }
    
    RdpRect rect = {
        .x = cmd->left,
        .y = cmd->top,
        .width = cmd->right - cmd->left,
        .height = cmd->bottom - cmd->top
    };
    
    switch (cmd->codecId) {
        case RDPGFX_CODECID_AVC420: {
            /* AVC420: Single H.264 stream in YUV 4:2:0 */
            const RDPGFX_AVC420_BITMAP_STREAM* avc420 = cmd->extra;
            if (avc420 && avc420->data && avc420->length > 0) {
                queue_video_frame_event(bctx, bctx->current_frame_id, cmd->surfaceId,
                                RDP_GFX_CODEC_AVC420, &rect,
                                avc420->data, avc420->length, NULL, 0);
            }
            break;
        }
        
        case RDPGFX_CODECID_AVC444:
        case RDPGFX_CODECID_AVC444v2: {
            /* AVC444: Dual H.264 streams (luma + chroma) for YUV 4:4:4 
             * Per MS-RDPEGFX, the RFX_AVC444_BITMAP_STREAM contains:
             * - LC field indicating stream configuration
             * - First AVC420 stream (typically luma)
             * - Second AVC420 stream (typically chroma) */
            const RDPGFX_AVC444_BITMAP_STREAM* avc444 = cmd->extra;
            if (avc444) {
                const uint8_t* luma_data = NULL;
                uint32_t luma_size = 0;
                const uint8_t* chroma_data = NULL;
                uint32_t chroma_size = 0;
                
                /* First stream (usually luma/main) */
                if (avc444->bitstream[0].data && avc444->bitstream[0].length > 0) {
                    luma_data = avc444->bitstream[0].data;
                    luma_size = avc444->bitstream[0].length;
                }
                
                /* Second stream (usually chroma for 4:4:4) */
                if (avc444->bitstream[1].data && avc444->bitstream[1].length > 0) {
                    chroma_data = avc444->bitstream[1].data;
                    chroma_size = avc444->bitstream[1].length;
                }
                
                if (luma_data) {
                    RdpGfxCodecId codec = (cmd->codecId == RDPGFX_CODECID_AVC444v2) 
                                          ? RDP_GFX_CODEC_AVC444v2 : RDP_GFX_CODEC_AVC444;
                    queue_video_frame_event(bctx, bctx->current_frame_id, cmd->surfaceId,
                                    codec, &rect, luma_data, luma_size,
                                    chroma_data, chroma_size);
                }
            }
            break;
        }
        
        /* CLEARCODEC: Wire-through raw data for WASM decoding in browser.
         * No bounds checking needed - browser WASM decoder validates.
         * Surface metadata is only used for event queue. */
        case RDPGFX_CODECID_CLEARCODEC: {
            if (!cmd->data || cmd->length == 0) {
                break;
            }
            
            bctx->gfx_codec = RDP_GFX_CODEC_CLEARCODEC;
            
            /* Queue raw ClearCodec data for browser WASM decoding */
            queue_video_frame_event(bctx, bctx->current_frame_id, cmd->surfaceId,
                             RDP_GFX_CODEC_CLEARCODEC, &rect,
                             cmd->data, cmd->length, NULL, 0);
            break;
        }
        
        /* UNCOMPRESSED: Raw BGRA pixels - convert to RGBA and encode to WebP tile */
        case RDPGFX_CODECID_UNCOMPRESSED: {
            if (!cmd->data) {
                break;
            }
            
            UINT32 surfId = cmd->surfaceId;
            UINT32 surfX = cmd->left;
            UINT32 surfY = cmd->top;
            UINT32 nWidth = cmd->right - cmd->left;
            UINT32 nHeight = cmd->bottom - cmd->top;
            
            /* Get surface info */
            if (surfId >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[surfId].active) {
                break;
            }
            
            UINT32 surfW = bctx->surfaces[surfId].width;
            UINT32 surfH = bctx->surfaces[surfId].height;
            
            /* Bounds check */
            if (surfX + nWidth > surfW || surfY + nHeight > surfH ||
                nWidth == 0 || nHeight == 0) {
                break;
            }
            
            /* Allocate buffer for RGBA conversion */
            size_t rgba_size = (size_t)nWidth * nHeight * 4;
            uint8_t* rgba_buf = (uint8_t*)malloc(rgba_size);
            if (!rgba_buf) {
                break;
            }
            
            /* Convert BGRX → RGBA
             * cmd->data is BGRX32 (not BGRA32) - the X byte is unused padding.
             * Per MS-RDPEGFX, UNCOMPRESSED uses the surface pixel format which
             * is typically GFX_PIXEL_FORMAT_XRGB_8888 (no alpha channel).
             * We set alpha to 0xFF (fully opaque) for WebP encoding. */
            const uint8_t* src = cmd->data;
            uint8_t* dst = rgba_buf;
            size_t pixel_count = (size_t)nWidth * nHeight;
            for (size_t i = 0; i < pixel_count; i++) {
                dst[0] = src[2];  /* R (from offset 2 in BGRX) */
                dst[1] = src[1];  /* G (from offset 1 in BGRX) */
                dst[2] = src[0];  /* B (from offset 0 in BGRX) */
                dst[3] = 0xFF;    /* A = opaque (X byte is padding, not alpha) */
                src += 4;
                dst += 4;
            }
            
            queue_webp_tile(bctx, surfId, surfX, surfY, nWidth, nHeight,
                           rgba_buf, nWidth * 4);
            free(rgba_buf);
            break;
        }
        
        /* Progressive codec - pass raw wire data to browser for WASM decoding */
        case RDPGFX_CODECID_CAPROGRESSIVE:
        case RDPGFX_CODECID_CAPROGRESSIVE_V2: {
            /* Track that progressive codec is being used */
            RdpGfxCodecId prog_codec = (cmd->codecId == RDPGFX_CODECID_CAPROGRESSIVE_V2) 
                ? RDP_GFX_CODEC_PROGRESSIVE_V2 : RDP_GFX_CODEC_PROGRESSIVE;
            bctx->gfx_codec = prog_codec;
            
            /* Queue raw progressive data as GFX event for strict ordering */
            queue_video_frame_event(bctx, bctx->current_frame_id, cmd->surfaceId,
                             prog_codec, &rect,
                             cmd->data, cmd->length, NULL, 0);
            break;
        }
        
        /* Planar codec - decode to RGBA and encode to WebP tile */
        case RDPGFX_CODECID_PLANAR: {
            if (!bctx->planar_decoder) {
                break;
            }
            
            UINT32 surfId = cmd->surfaceId;
            UINT32 surfX = cmd->left;
            UINT32 surfY = cmd->top;
            UINT32 nWidth = cmd->right - cmd->left;
            UINT32 nHeight = cmd->bottom - cmd->top;
            
            /* Get surface info */
            if (surfId >= RDP_MAX_GFX_SURFACES || !bctx->surfaces[surfId].active) {
                break;
            }
            
            UINT32 surfW = bctx->surfaces[surfId].width;
            UINT32 surfH = bctx->surfaces[surfId].height;
            
            /* Bounds check */
            if (surfX + nWidth > surfW || surfY + nHeight > surfH ||
                nWidth == 0 || nHeight == 0) {
                break;
            }
            
            /* Allocate temporary buffer for decoded pixels */
            size_t buf_size = (size_t)nWidth * nHeight * 4;
            uint8_t* temp_buf = (uint8_t*)calloc(1, buf_size);  /* Zero-init = transparent (0,0,0,0) */
            if (!temp_buf) {
                break;
            }
            
            /* Decode Planar directly to RGBA */
            if (freerdp_bitmap_decompress_planar(bctx->planar_decoder,
                    cmd->data, cmd->length,
                    nWidth, nHeight,
                    temp_buf, PIXEL_FORMAT_RGBA32,
                    nWidth * 4,  /* stride */
                    0, 0,        /* decode at origin of temp buffer */
                    nWidth, nHeight, FALSE)) {
                
                /* Encode to WebP and queue */
                queue_webp_tile(bctx, surfId, surfX, surfY, nWidth, nHeight,
                               temp_buf, nWidth * 4);
            } else {
                static int planar_err = 0;
                if (planar_err < 5) {
                    fprintf(stderr, "[rdp_bridge] Planar decode failed\n");
                    planar_err++;
                }
            }
            
            free(temp_buf);
            break;
        }
        
        /* Alpha codec and other unknown codecs */
        case RDPGFX_CODECID_ALPHA:
        default: {
            static int other_codec = 0;
            if (other_codec < 10) {
                fprintf(stderr, "[rdp_bridge] Unsupported codec 0x%04X at (%d,%d)-(%d,%d)\n",
                        cmd->codecId, cmd->left, cmd->top, cmd->right, cmd->bottom);
                other_codec++;
            }
            break;
        }
    }
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_start_frame(RdpgfxClientContext* context, const RDPGFX_START_FRAME_PDU* start)
{
    /* PURE GFX MODE: Just track frame ID, no GDI chaining needed */
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !start) return ERROR_INVALID_PARAMETER;
    
    /* Mark frame as in progress - Python should not send frames while this is true */
    pthread_mutex_lock(&bctx->gfx_mutex);
    bctx->gfx_frame_in_progress = true;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    bctx->current_frame_id = start->frameId;
    bctx->frame_cmd_count = 0;  /* Reset command count for this frame */
    
    /* Queue START_FRAME event for Python wire format streaming */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_START_FRAME;
    event.frame_id = start->frameId;
    gfx_queue_event(bctx, &event);
    
    return CHANNEL_RC_OK;
}

static UINT gfx_on_end_frame(RdpgfxClientContext* context, const RDPGFX_END_FRAME_PDU* end)
{
    /* WIRE-THROUGH MODE: We do NOT send FrameAcknowledge here!
     * 
     * With gfx->sendFrameAcks = FALSE (set in channel connect), FreeRDP will NOT
     * auto-send the ACK. Instead, the browser sends a FACK message after it has
     * decoded and composited the frame, which Python forwards to rdp_gfx_send_frame_ack().
     * 
     * This ensures proper backpressure - the server won't flood us with frames
     * faster than the browser can decode them.
     */
    BridgeContext* bctx = (BridgeContext*)context->custom;
    if (!bctx || !end) return ERROR_INVALID_PARAMETER;
    
    pthread_mutex_lock(&bctx->gfx_mutex);
    /* Frame is now complete - Python can safely read buffer and send frames */
    bctx->gfx_frame_in_progress = false;
    /* Update last_completed_frame_id so Python knows a frame finished */
    bctx->last_completed_frame_id = end->frameId;
    pthread_mutex_unlock(&bctx->gfx_mutex);
    
    /* Queue END_FRAME event for Python wire format streaming */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_END_FRAME;
    event.frame_id = end->frameId;
    gfx_queue_event(bctx, &event);
    
    /* Wire-through mode: All GFX events are streamed to the frontend.
     * H.264 frames are decoded by browser VideoDecoder.
     * Other codecs (SolidFill, CopyRect, WebP tiles) are handled via GFX events. */
    
    return CHANNEL_RC_OK;
}

/* ============================================================================
 * GFX/H.264 API Implementation
 * ============================================================================ */

bool rdp_gfx_is_active(RdpSession* session)
{
    if (!session) return false;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    bool active = ctx->gfx_active && ctx->gfx != NULL;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    return active;
}

RdpGfxCodecId rdp_gfx_get_codec(RdpSession* session)
{
    if (!session) return RDP_GFX_CODEC_UNCOMPRESSED;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    RdpGfxCodecId codec = ctx->gfx_codec;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    return codec;
}

int rdp_gfx_get_surface(RdpSession* session, uint16_t surface_id, RdpGfxSurface* surface)
{
    if (!session || !surface) return -1;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    
    for (int i = 0; i < RDP_MAX_GFX_SURFACES; i++) {
        if (ctx->surfaces[i].active && ctx->surfaces[i].surface_id == surface_id) {
            *surface = ctx->surfaces[i];
            pthread_mutex_unlock(&ctx->gfx_mutex);
            return 0;
        }
    }
    
    pthread_mutex_unlock(&ctx->gfx_mutex);
    return -1;
}

uint16_t rdp_gfx_get_primary_surface(RdpSession* session)
{
    if (!session) return 0;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    uint16_t id = ctx->primary_surface_id;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    return id;
}

/**
 * Send a frame acknowledgment to the RDP server.
 * 
 * This is called when the browser sends a FACK message after successfully
 * decoding and presenting a frame. In FreeRDP3, we must call FrameAcknowledge() 
 * manually to inform the server we've processed the frame.
 * 
 * The frame ACK tells the server that we've processed the frame and are ready
 * for more. This provides backpressure - if the browser is slow to decode,
 * ACKs will be delayed and the server will throttle its frame rate.
 * 
 * Per MS-RDPEGFX 2.2.3.3 RDPGFX_FRAME_ACKNOWLEDGE_PDU:
 * - queueDepth: Number of unprocessed frames in client queue
 *   - 0x00000000 (QUEUE_DEPTH_UNAVAILABLE): Queue depth not available
 *   - 0xFFFFFFFF (SUSPEND_FRAME_ACKNOWLEDGEMENT): Suspend frame sending
 *   - Other values: Actual queue depth (server uses for rate control)
 * - totalFramesDecoded: Running count of frames decoded by client
 * 
 * @param session              RDP session handle
 * @param frame_id             Frame ID to acknowledge (from EndFrame PDU / FACK message)
 * @param total_frames_decoded Running count of frames decoded by browser
 * @param queue_depth          Number of unprocessed frames in browser decode queue
 * @return                     0 on success, -1 on error
 */
int rdp_gfx_send_frame_ack(RdpSession* session, uint32_t frame_id, uint32_t total_frames_decoded, uint32_t queue_depth)
{
    if (!session) return -1;
    
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_mutex);
    RdpgfxClientContext* gfx = ctx->gfx;
    bool active = ctx->gfx_active;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    if (!active || !gfx) {
        fprintf(stderr, "[GFX] Cannot send frame ACK: GFX not active\n");
        return -1;
    }
    
    /* Check if FrameAcknowledge callback is available */
    if (!gfx->FrameAcknowledge) {
        fprintf(stderr, "[GFX] ERROR: FrameAcknowledge callback is NULL!\n");
        return -1;
    }
    
    /* Build the frame acknowledge PDU per MS-RDPEGFX 2.2.3.3 */
    RDPGFX_FRAME_ACKNOWLEDGE_PDU ack = {0};
    ack.frameId = frame_id;
    ack.totalFramesDecoded = total_frames_decoded;
    
    /* Use actual browser queue depth for adaptive server-side rate control */
    ack.queueDepth = queue_depth;
    
    /* Update our tracking */
    pthread_mutex_lock(&ctx->gfx_mutex);
    ctx->last_completed_frame_id = frame_id;
    pthread_mutex_unlock(&ctx->gfx_mutex);
    
    /* Send the ACK to the server */
    UINT status = gfx->FrameAcknowledge(gfx, &ack);
    
    if (status != CHANNEL_RC_OK) {
        fprintf(stderr, "[GFX] FrameAcknowledge failed for frame %u: status=%u\n", 
                frame_id, status);
        return -1;
    }
    
    return 0;
}

/* =========================================================================
 * GDI fallback frame capture
 * ========================================================================= */

static uint64_t monotonic_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)ts.tv_nsec / 1000000ULL;
}

static void maybe_queue_gdi_fallback_frame(BridgeContext* ctx)
{
    if (!ctx) return;
    rdpContext* rctx = (rdpContext*)ctx;
    rdpGdi* gdi = rctx ? rctx->gdi : NULL;
    if (!gdi || !gdi->primary_buffer || gdi->width <= 0 || gdi->height <= 0) return;

    pthread_mutex_lock(&ctx->gfx_mutex);
    const uint16_t surface_id = ctx->primary_surface_id;
    const bool surface_ok = surface_id < RDP_MAX_GFX_SURFACES && ctx->surfaces[surface_id].active;
    const uint32_t surface_w = surface_ok ? ctx->surfaces[surface_id].width : (uint32_t)gdi->width;
    const uint32_t surface_h = surface_ok ? ctx->surfaces[surface_id].height : (uint32_t)gdi->height;
    const uint32_t real_frames = ctx->last_completed_frame_id;
    const uint64_t last_ms = ctx->last_fallback_ms;
    const bool mapped_to_output = surface_ok && ctx->surfaces[surface_id].mapped_to_output;
    pthread_mutex_unlock(&ctx->gfx_mutex);

    /* Always publish the native FreeRDP GDI-composited framebuffer at a modest
     * cadence. This is the documented FreeRDP client rendering path:
     * rdpgfx callbacks are decoded by gdi_graphics_pipeline_init() into the
     * primary GDI surface, then Zephyr transports that surface over /rdp-gfx.
     * The older condition `real_frames > 0` was wrong: servers may send valid
     * RDPEGFX frames using commands/codecs our partial browser wire-through
     * implementation does not fully render, which left the frontend black while
     * ACKs kept flowing. */
    (void)real_frames;
    (void)mapped_to_output;
    uint64_t now = monotonic_ms();
    if (last_ms && now - last_ms < 100) return;

    uint32_t w = (uint32_t)gdi->width;
    uint32_t h = (uint32_t)gdi->height;
    if (surface_w > 0 && w > surface_w) w = surface_w;
    if (surface_h > 0 && h > surface_h) h = surface_h;
    if (w == 0 || h == 0) return;

    const uint32_t src_stride = gdi->stride ? gdi->stride : gdi->bitmap_stride;
    if (src_stride < w * 4) return;
    uint8_t* rgba = (uint8_t*)malloc((size_t)w * h * 4);
    if (!rgba) return;

    const uint8_t* src = gdi->primary_buffer;
    for (uint32_t y = 0; y < h; y++) {
        const uint8_t* row = src + (size_t)y * src_stride;
        uint8_t* out = rgba + (size_t)y * w * 4;
        for (uint32_t x = 0; x < w; x++) {
            const uint8_t b = row[x * 4 + 0];
            const uint8_t g = row[x * 4 + 1];
            const uint8_t r = row[x * 4 + 2];
            const uint8_t a = row[x * 4 + 3] ? row[x * 4 + 3] : 0xFF;
            out[x * 4 + 0] = r;
            out[x * 4 + 1] = g;
            out[x * 4 + 2] = b;
            out[x * 4 + 3] = a;
        }
    }

    pthread_mutex_lock(&ctx->gfx_mutex);
    const uint32_t frame_id = ++ctx->fallback_frame_id;
    ctx->last_fallback_ms = now;
    pthread_mutex_unlock(&ctx->gfx_mutex);

    const uint16_t target_surface_id = surface_ok ? surface_id : 0;
    if (!surface_ok || !mapped_to_output) {
        if (!surface_ok) {
            pthread_mutex_lock(&ctx->gfx_mutex);
            ctx->primary_surface_id = target_surface_id;
            ctx->surfaces[target_surface_id].surface_id = target_surface_id;
            ctx->surfaces[target_surface_id].width = w;
            ctx->surfaces[target_surface_id].height = h;
            ctx->surfaces[target_surface_id].pixel_format = GFX_PIXEL_FORMAT_ARGB_8888;
            ctx->surfaces[target_surface_id].active = true;
            ctx->surfaces[target_surface_id].mapped_to_output = true;
            pthread_mutex_unlock(&ctx->gfx_mutex);
            RdpGfxEvent create = {0};
            create.type = RDP_GFX_EVENT_CREATE_SURFACE;
            create.surface_id = target_surface_id;
            create.width = w;
            create.height = h;
            create.pixel_format = GFX_PIXEL_FORMAT_ARGB_8888;
            gfx_queue_event(ctx, &create);
        } else {
            pthread_mutex_lock(&ctx->gfx_mutex);
            ctx->surfaces[target_surface_id].mapped_to_output = true;
            ctx->surfaces[target_surface_id].output_x = 0;
            ctx->surfaces[target_surface_id].output_y = 0;
            ctx->primary_surface_id = target_surface_id;
            pthread_mutex_unlock(&ctx->gfx_mutex);
        }
        RdpGfxEvent map = {0};
        map.type = RDP_GFX_EVENT_MAP_SURFACE;
        map.surface_id = target_surface_id;
        map.x = 0;
        map.y = 0;
        gfx_queue_event(ctx, &map);
    }

    RdpGfxEvent start = {0};
    start.type = RDP_GFX_EVENT_START_FRAME;
    start.frame_id = frame_id;
    gfx_queue_event(ctx, &start);
    queue_webp_tile(ctx, target_surface_id, 0, 0, w, h, rgba, (int)(w * 4));
    RdpGfxEvent end = {0};
    end.type = RDP_GFX_EVENT_END_FRAME;
    end.frame_id = frame_id;
    gfx_queue_event(ctx, &end);

    free(rgba);
    static int logged = 0;
    if (logged < 3) {
        fprintf(stderr, "[GFX] queued GDI fallback frame %u (%ux%u) because RDPEGFX produced no frame events\n", frame_id, w, h);
        logged++;
    }
}

/* ============================================================================
 * WebP Tile Encoding Helper
 * ============================================================================ */

/**
 * Encode RGBA pixels to WebP and queue as WEBP_TILE event.
 * 
 * @param ctx Bridge context
 * @param surface_id Target surface
 * @param x, y Destination coordinates on surface
 * @param width, height Tile dimensions
 * @param rgba_data RGBA32 pixel data (width * height * 4 bytes)
 * @param stride Bytes per row in rgba_data
 * 
 * This function:
 * 1. Encodes RGBA to WebP (lossless)
 * 2. Queues a WEBP_TILE event with the compressed data
 * 3. The event's bitmap_data is allocated here and freed by Python after reading
 * 
 * NOTE: Callers must convert to RGBA before calling this function.
 * PLANAR codec uses PIXEL_FORMAT_RGBA32 in freerdp_bitmap_decompress_planar.
 * UNCOMPRESSED codec converts BGRA→RGBA before calling.
 */
static void queue_webp_tile(BridgeContext* ctx, uint16_t surface_id,
                            int32_t x, int32_t y, uint32_t width, uint32_t height,
                            const uint8_t* rgba_data, int stride)
{
    if (!ctx || !rgba_data || width == 0 || height == 0) return;
    
    uint8_t* webp_out = NULL;
    size_t webp_size = 0;

    /* We always use lossless WebP to preserve exact pixels for cache operations.
     * Lossy WebP would cause cache mismatches because:
     *  - SurfaceToCache captures lossy-decoded pixels
     *  - CacheToSurface would blit degraded pixels
     *  - Each cache reuse further degrades quality */
    /* Use advanced API with exact=1 to preserve RGB values in transparent areas */
    {
        WebPConfig config;
        WebPPicture pic;
        WebPMemoryWriter writer;
        
        if (!WebPConfigPreset(&config, WEBP_PRESET_DEFAULT, 100.0f)) {
            fprintf(stderr, "[GFX] WebP config init failed\n");
            return;
        }
        
        /* CRITICAL: Set lossless mode with exact=1 */
        config.lossless = 1;
        config.exact = 1;  /* Preserve RGB values even where alpha=0 */
        config.method = 0; /* Fast encoding (0=fastest, 6=slowest) */
        
        if (!WebPValidateConfig(&config)) {
            fprintf(stderr, "[GFX] WebP config validation failed\n");
            return;
        }
        
        if (!WebPPictureInit(&pic)) {
            fprintf(stderr, "[GFX] WebP picture init failed\n");
            return;
        }
        
        pic.width = width;
        pic.height = height;
        pic.use_argb = 1;  /* Use ARGB mode for lossless */
        
        /* Import RGBA data directly */
        if (!WebPPictureImportRGBA(&pic, rgba_data, stride)) {
            fprintf(stderr, "[GFX] WebP RGBA import failed\n");
            WebPPictureFree(&pic);
            return;
        }
        
        /* Set up memory writer */
        WebPMemoryWriterInit(&writer);
        pic.writer = WebPMemoryWrite;
        pic.custom_ptr = &writer;
        
        /* Encode */
        int ok = WebPEncode(&config, &pic);
        WebPPictureFree(&pic);
        
        if (!ok) {
            fprintf(stderr, "[GFX] WebP encoding failed for %ux%u tile (error %d)\n", 
                    width, height, pic.error_code);
            WebPMemoryWriterClear(&writer);
            return;
        }
        
        webp_out = writer.mem;
        webp_size = writer.size;
    }
    
    if (webp_size == 0 || !webp_out) {
        fprintf(stderr, "[GFX] WebP encoding failed for %ux%u tile\n", width, height);
        return;
    }
    
    /* Allocate persistent buffer for event (Python will free after reading) */
    uint8_t* event_data = (uint8_t*)malloc(webp_size);
    if (!event_data) {
        WebPFree(webp_out);
        return;
    }
    memcpy(event_data, webp_out, webp_size);
    WebPFree(webp_out);
    
    /* Queue the event */
    RdpGfxEvent event = {0};
    event.type = RDP_GFX_EVENT_WEBP_TILE;
    event.frame_id = ctx->current_frame_id;
    event.surface_id = surface_id;
    event.x = x;
    event.y = y;
    event.width = width;
    event.height = height;
    event.bitmap_data = event_data;
    event.bitmap_size = (uint32_t)webp_size;
    
    gfx_queue_event(ctx, &event);
}

/* ============================================================================
 * GFX Event Queue API (for wire format streaming)
 * ============================================================================ */

/* Event type names for logging */
static const char* gfx_event_type_name(int type) {
    switch (type) {
        case RDP_GFX_EVENT_NONE: return "NONE";
        case RDP_GFX_EVENT_CREATE_SURFACE: return "CREATE_SURFACE";
        case RDP_GFX_EVENT_DELETE_SURFACE: return "DELETE_SURFACE";
        case RDP_GFX_EVENT_MAP_SURFACE: return "MAP_SURFACE";
        case RDP_GFX_EVENT_START_FRAME: return "START_FRAME";
        case RDP_GFX_EVENT_END_FRAME: return "END_FRAME";
        case RDP_GFX_EVENT_SOLID_FILL: return "SOLID_FILL";
        case RDP_GFX_EVENT_SURFACE_TO_SURFACE: return "SURFACE_TO_SURFACE";
        case RDP_GFX_EVENT_CACHE_TO_SURFACE: return "CACHE_TO_SURFACE";
        case RDP_GFX_EVENT_SURFACE_TO_CACHE: return "SURFACE_TO_CACHE";
        case RDP_GFX_EVENT_WEBP_TILE: return "WEBP_TILE";
        case RDP_GFX_EVENT_VIDEO_FRAME: return "VIDEO_FRAME";
        case RDP_GFX_EVENT_EVICT_CACHE: return "EVICT_CACHE";
        case RDP_GFX_EVENT_RESET_GRAPHICS: return "RESET_GRAPHICS";
        default: return "UNKNOWN";
    }
}

/* Internal helper: queue a GFX event (caller must NOT hold gfx_event_mutex) */
static void gfx_queue_event(BridgeContext* ctx, const RdpGfxEvent* event)
{
    if (!ctx || !event || !ctx->gfx_events) return;
    
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    
    /* Check if queue needs to grow */
    if (ctx->gfx_event_count >= ctx->gfx_events_capacity) {
        if (ctx->gfx_events_capacity < RDP_MAX_GFX_EVENTS) {
            /* Grow queue by RDP_GFX_EVENTS_GROW slots */
            int new_capacity = ctx->gfx_events_capacity + RDP_GFX_EVENTS_GROW;
            if (new_capacity > RDP_MAX_GFX_EVENTS) {
                new_capacity = RDP_MAX_GFX_EVENTS;
            }
            
            /* Allocate new buffer */
            RdpGfxEvent* new_queue = (RdpGfxEvent*)calloc(new_capacity, sizeof(RdpGfxEvent));
            if (new_queue) {
                /* Copy existing events in order (linearize the ring buffer) */
                int i;
                for (i = 0; i < ctx->gfx_event_count; i++) {
                    int src_idx = (ctx->gfx_event_read_idx + i) % ctx->gfx_events_capacity;
                    new_queue[i] = ctx->gfx_events[src_idx];
                }
                
                free(ctx->gfx_events);
                ctx->gfx_events = new_queue;
                ctx->gfx_events_capacity = new_capacity;
                ctx->gfx_event_read_idx = 0;
                ctx->gfx_event_write_idx = ctx->gfx_event_count;
                
                fprintf(stderr, "[GFX] Queue grown to %d slots (%d KB)\n",
                        new_capacity, (int)(new_capacity * sizeof(RdpGfxEvent) / 1024));
            } else {
                /* Allocation failed - drop oldest event */
                RdpGfxEvent* dropped = &ctx->gfx_events[ctx->gfx_event_read_idx];
                fprintf(stderr, "[GFX] WARNING: Queue grow failed! Dropping event type=%d (%s) frame=%u\n",
                        dropped->type, gfx_event_type_name(dropped->type), dropped->frame_id);
                ctx->gfx_event_read_idx = (ctx->gfx_event_read_idx + 1) % ctx->gfx_events_capacity;
                ctx->gfx_event_count--;
            }
        } else {
            /* At max capacity - drop oldest event */
            RdpGfxEvent* dropped = &ctx->gfx_events[ctx->gfx_event_read_idx];
            fprintf(stderr, "[GFX] WARNING: Queue at max (%d)! Dropping event type=%d (%s) frame=%u\n",
                    RDP_MAX_GFX_EVENTS, dropped->type, gfx_event_type_name(dropped->type), dropped->frame_id);
            ctx->gfx_event_read_idx = (ctx->gfx_event_read_idx + 1) % ctx->gfx_events_capacity;
            ctx->gfx_event_count--;
        }
    }
    
    ctx->gfx_events[ctx->gfx_event_write_idx] = *event;
    ctx->gfx_event_write_idx = (ctx->gfx_event_write_idx + 1) % ctx->gfx_events_capacity;
    ctx->gfx_event_count++;
    
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
}

int rdp_gfx_has_events(RdpSession* session)
{
    if (!session) return 0;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    int count = ctx->gfx_event_count;
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
    
    return count;
}

int rdp_gfx_get_event(RdpSession* session, RdpGfxEvent* event)
{
    if (!session || !event) return -1;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    
    if (ctx->gfx_event_count == 0) {
        pthread_mutex_unlock(&ctx->gfx_event_mutex);
        return -1;
    }
    
    *event = ctx->gfx_events[ctx->gfx_event_read_idx];
    ctx->gfx_event_read_idx = (ctx->gfx_event_read_idx + 1) % ctx->gfx_events_capacity;
    ctx->gfx_event_count--;
    
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
    return 0;
}

void rdp_gfx_clear_events(RdpSession* session)
{
    if (!session) return;
    BridgeContext* ctx = (BridgeContext*)session;
    
    pthread_mutex_lock(&ctx->gfx_event_mutex);
    
    /* Free any allocated data in pending events before clearing */
    while (ctx->gfx_event_count > 0) {
        RdpGfxEvent* event = &ctx->gfx_events[ctx->gfx_event_read_idx];
        gfx_free_event_data(event);
        ctx->gfx_event_read_idx = (ctx->gfx_event_read_idx + 1) % ctx->gfx_events_capacity;
        ctx->gfx_event_count--;
    }
    
    ctx->gfx_event_write_idx = 0;
    ctx->gfx_event_read_idx = 0;
    ctx->gfx_event_count = 0;
    pthread_mutex_unlock(&ctx->gfx_event_mutex);
}

/* Helper to free all dynamically allocated data in a GFX event */
static void gfx_free_event_data(RdpGfxEvent* event)
{
    if (!event) return;
    
    if (event->bitmap_data) {
        free(event->bitmap_data);
        event->bitmap_data = NULL;
    }
    if (event->nal_data) {
        free(event->nal_data);
        event->nal_data = NULL;
    }
    if (event->chroma_nal_data) {
        free(event->chroma_nal_data);
        event->chroma_nal_data = NULL;
    }
    if (event->pointer_data) {
        free(event->pointer_data);
        event->pointer_data = NULL;
    }
}

void rdp_free_gfx_event_data(void* data)
{
    if (data) {
        free(data);
    }
}

int rdp_clipboard_set_text(RdpSession* session, const char* utf8_text)
{
    if (!session) return -1;
    BridgeContext* ctx = (BridgeContext*)session;
    pthread_mutex_lock(&ctx->clip_mutex);
    free(ctx->clip_local_text);
    ctx->clip_local_text = strdup(utf8_text ? utf8_text : "");
    clip_free_local_files(ctx);
    pthread_mutex_unlock(&ctx->clip_mutex);
    return (int)clip_send_client_format_list(ctx);
}

int rdp_clipboard_set_files(RdpSession* session, const char* newline_paths)
{
    if (!session || !newline_paths) return -1;
    BridgeContext* ctx = (BridgeContext*)session;
    char* copy = strdup(newline_paths);
    if (!copy) return -1;
    RdpClipboardFile* files = NULL;
    uint32_t count = 0;
    char* save = NULL;
    for (char* line = strtok_r(copy, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        if (!*line) continue;
        struct stat st;
        if (stat(line, &st) != 0 || !S_ISREG(st.st_mode)) continue;
        RdpClipboardFile* nf = (RdpClipboardFile*)realloc(files, sizeof(RdpClipboardFile) * (count + 1));
        if (!nf) continue;
        files = nf;
        files[count].path = strdup(line);
        files[count].name = strdup(clip_basename(line));
        files[count].size = (uint64_t)st.st_size;
        if (files[count].path && files[count].name) count++;
        else { free(files[count].path); free(files[count].name); }
    }
    free(copy);
    pthread_mutex_lock(&ctx->clip_mutex);
    free(ctx->clip_local_text);
    ctx->clip_local_text = NULL;
    clip_free_local_files(ctx);
    ctx->clip_local_files = files;
    ctx->clip_local_file_count = count;
    pthread_mutex_unlock(&ctx->clip_mutex);
    return count ? (int)clip_send_client_format_list(ctx) : -1;
}

char* rdp_clipboard_pop_event(RdpSession* session)
{
    if (!session) return NULL;
    BridgeContext* ctx = (BridgeContext*)session;
    pthread_mutex_lock(&ctx->clip_event_mutex);
    if (!ctx->clip_events || ctx->clip_event_count <= 0) {
        pthread_mutex_unlock(&ctx->clip_event_mutex);
        return NULL;
    }
    char* out = ctx->clip_events[ctx->clip_event_read_idx];
    ctx->clip_events[ctx->clip_event_read_idx] = NULL;
    ctx->clip_event_read_idx = (ctx->clip_event_read_idx + 1) % ctx->clip_event_capacity;
    ctx->clip_event_count--;
    pthread_mutex_unlock(&ctx->clip_event_mutex);
    return out;
}

static int clip_request_remote_file_chunk(BridgeContext* ctx, uint32_t index, uint64_t offset, uint32_t size, uint8_t** out, uint32_t* out_size)
{
    if (!ctx || !ctx->cliprdr || !ctx->cliprdr->ClientFileContentsRequest || !out || !out_size) return -1;
    *out = NULL;
    *out_size = 0;
    pthread_mutex_lock(&ctx->clip_mutex);
    uint32_t stream = ctx->clip_next_stream_id++;
    if (!ctx->clip_next_stream_id) ctx->clip_next_stream_id = 1;
    free(ctx->clip_pending_data);
    ctx->clip_pending_data = NULL;
    ctx->clip_pending_size = 0;
    ctx->clip_pending_flags = 0;
    ctx->clip_pending_stream_id = stream;
    ctx->clip_pending_done = false;
    pthread_mutex_unlock(&ctx->clip_mutex);

    CLIPRDR_FILE_CONTENTS_REQUEST req = { 0 };
    req.common.msgType = CB_FILECONTENTS_REQUEST;
    req.streamId = stream;
    req.listIndex = index;
    req.dwFlags = FILECONTENTS_RANGE;
    req.nPositionLow = (UINT32)(offset & 0xFFFFFFFFu);
    req.nPositionHigh = (UINT32)(offset >> 32);
    req.cbRequested = size;
    UINT rc = ctx->cliprdr->ClientFileContentsRequest(ctx->cliprdr, &req);
    if (rc != CHANNEL_RC_OK) return -1;

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec += 30;
    pthread_mutex_lock(&ctx->clip_mutex);
    while (!ctx->clip_pending_done && ctx->clip_pending_stream_id == stream) {
        if (pthread_cond_timedwait(&ctx->clip_cond, &ctx->clip_mutex, &ts) != 0) break;
    }
    if (!ctx->clip_pending_done || !(ctx->clip_pending_flags & CB_RESPONSE_OK)) {
        pthread_mutex_unlock(&ctx->clip_mutex);
        return -1;
    }
    if (ctx->clip_pending_size) {
        *out = ctx->clip_pending_data;
        *out_size = ctx->clip_pending_size;
        ctx->clip_pending_data = NULL;
        ctx->clip_pending_size = 0;
    }
    pthread_mutex_unlock(&ctx->clip_mutex);
    return 0;
}

int rdp_clipboard_download_file(RdpSession* session, uint32_t index, const char* output_path)
{
    if (!session || !output_path) return -1;
    BridgeContext* ctx = (BridgeContext*)session;
    pthread_mutex_lock(&ctx->clip_mutex);
    if (index >= ctx->clip_remote_file_count) { pthread_mutex_unlock(&ctx->clip_mutex); return -1; }
    uint64_t total = ctx->clip_remote_files[index].size;
    pthread_mutex_unlock(&ctx->clip_mutex);
    FILE* fp = fopen(output_path, "wb");
    if (!fp) return -1;
    uint64_t offset = 0;
    while (offset < total) {
        uint32_t want = (uint32_t)((total - offset) > ZEPHYR_CLIP_MAX_CHUNK ? ZEPHYR_CLIP_MAX_CHUNK : (total - offset));
        uint8_t* data = NULL;
        uint32_t got = 0;
        if (clip_request_remote_file_chunk(ctx, index, offset, want, &data, &got) != 0) { fclose(fp); return -1; }
        if (got && fwrite(data, 1, got, fp) != got) { free(data); fclose(fp); return -1; }
        free(data);
        if (got == 0) break;
        offset += got;
    }
    fclose(fp);
    return 0;
}

void rdp_free(void* ptr)
{
    free(ptr);
}

/* ============================================================================
 * Audio API
 * ============================================================================ */

bool rdp_has_audio_data(RdpSession* session)
{
    if (!session) return false;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!ctx->audio_initialized || !ctx->audio_buffer) {
        return false;
    }
    
    pthread_mutex_lock(&ctx->audio_mutex);
    bool has_data = ctx->audio_buffer_pos > ctx->audio_read_pos;
    pthread_mutex_unlock(&ctx->audio_mutex);
    
    return has_data;
}

int rdp_get_audio_format(RdpSession* session, int* sample_rate, int* channels, int* bits)
{
    if (!session) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!ctx->audio_initialized) {
        return -1;
    }
    
    pthread_mutex_lock(&ctx->audio_mutex);
    if (sample_rate) *sample_rate = ctx->audio_sample_rate;
    if (channels) *channels = ctx->audio_channels;
    if (bits) *bits = ctx->audio_bits;
    pthread_mutex_unlock(&ctx->audio_mutex);
    
    return 0;
}

int rdp_get_audio_data(RdpSession* session, uint8_t* buffer, int max_size)
{
    if (!session || !buffer || max_size <= 0) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!ctx->audio_initialized || !ctx->audio_buffer) {
        return 0;
    }
    
    pthread_mutex_lock(&ctx->audio_mutex);
    
    size_t available = ctx->audio_buffer_pos - ctx->audio_read_pos;
    if (available == 0) {
        pthread_mutex_unlock(&ctx->audio_mutex);
        return 0;
    }
    
    size_t to_copy = (available < (size_t)max_size) ? available : (size_t)max_size;
    memcpy(buffer, ctx->audio_buffer + ctx->audio_read_pos, to_copy);
    ctx->audio_read_pos += to_copy;
    
    /* Reset buffer positions if fully consumed */
    if (ctx->audio_read_pos >= ctx->audio_buffer_pos) {
        ctx->audio_buffer_pos = 0;
        ctx->audio_read_pos = 0;
    }
    
    pthread_mutex_unlock(&ctx->audio_mutex);
    
    return (int)to_copy;
}

void rdp_write_audio_data(RdpSession* session, const uint8_t* data, size_t size,
                          int sample_rate, int channels, int bits)
{
    if (!session || !data || size == 0) return;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    pthread_mutex_lock(&ctx->audio_mutex);
    
    /* Update format info */
    ctx->audio_sample_rate = sample_rate;
    ctx->audio_channels = channels;
    ctx->audio_bits = bits;
    
    /* Check if we need to resize buffer or if buffer is full */
    if (ctx->audio_buffer_pos + size > ctx->audio_buffer_size) {
        /* Buffer overflow - reset and accept data loss */
        ctx->audio_buffer_pos = 0;
        ctx->audio_read_pos = 0;
    }
    
    if (ctx->audio_buffer && ctx->audio_buffer_pos + size <= ctx->audio_buffer_size) {
        memcpy(ctx->audio_buffer + ctx->audio_buffer_pos, data, size);
        ctx->audio_buffer_pos += size;
    }
    
    pthread_mutex_unlock(&ctx->audio_mutex);
}

/* ============================================================================
 * Opus Audio API (for native audio streaming without PulseAudio)
 * ============================================================================ */

void rdp_set_audio_context(RdpSession* session)
{
    if (!session) return;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    /* Point to our BridgeContext's Opus buffer using POINTERS for mutable state */
    g_audio_ctx.opus_buffer = ctx->opus_buffer;
    g_audio_ctx.opus_buffer_size = ctx->opus_buffer_size;
    g_audio_ctx.opus_write_pos = &ctx->opus_write_pos;
    g_audio_ctx.opus_read_pos = &ctx->opus_read_pos;
    g_audio_ctx.opus_mutex = &ctx->opus_mutex;
    g_audio_ctx.sample_rate = ctx->opus_sample_rate;
    g_audio_ctx.channels = ctx->opus_channels;
    g_audio_ctx.initialized = &ctx->opus_initialized;
    
    /* Try to find and call the plugin's context setter using dlsym.
     * The plugin is loaded dynamically by FreeRDP during connect,
     * so we use RTLD_DEFAULT to search all loaded libraries. */
    typedef void (*set_context_fn)(void*);
    set_context_fn set_ctx = (set_context_fn)dlsym(RTLD_DEFAULT, "rdpsnd_bridge_set_context");
    if (set_ctx) {
        set_ctx(&g_audio_ctx);
    }
}

/* Exported function for the plugin to get the current audio context.
 * The plugin can call this via dlsym(RTLD_DEFAULT, "rdp_get_current_audio_context")
 * Note: This is a legacy interface. For multi-session, use rdp_lookup_session_by_rdpcontext */
__attribute__((visibility("default")))
void* rdp_get_current_audio_context(void)
{
    return &g_audio_ctx;
}

/* Get audio buffer debug statistics for diagnostics */
int rdp_get_audio_stats(RdpSession* session, int* initialized, size_t* write_pos, 
                        size_t* read_pos, size_t* buffer_size)
{
    if (!session) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (initialized) *initialized = ctx->opus_initialized;
    if (buffer_size) *buffer_size = ctx->opus_buffer_size;
    
    if (!ctx->opus_buffer) {
        if (write_pos) *write_pos = 0;
        if (read_pos) *read_pos = 0;
        return -2;  /* Buffer not allocated */
    }
    
    pthread_mutex_lock(&ctx->opus_mutex);
    if (write_pos) *write_pos = ctx->opus_write_pos;
    if (read_pos) *read_pos = ctx->opus_read_pos;
    pthread_mutex_unlock(&ctx->opus_mutex);
    
    return 0;
}

bool rdp_has_opus_data(RdpSession* session)
{
    if (!session) return false;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!ctx->opus_initialized || !ctx->opus_buffer) {
        return false;
    }
    
    pthread_mutex_lock(&ctx->opus_mutex);
    bool has_data = ctx->opus_write_pos > ctx->opus_read_pos;
    pthread_mutex_unlock(&ctx->opus_mutex);
    
    return has_data;
}

int rdp_get_opus_format(RdpSession* session, int* sample_rate, int* channels)
{
    if (!session) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!ctx->opus_initialized) {
        return -1;
    }
    
    pthread_mutex_lock(&ctx->opus_mutex);
    if (sample_rate) *sample_rate = ctx->opus_sample_rate;
    if (channels) *channels = ctx->opus_channels;
    pthread_mutex_unlock(&ctx->opus_mutex);
    
    return 0;
}

int rdp_get_opus_frame(RdpSession* session, uint8_t* buffer, int max_size)
{
    if (!session || !buffer || max_size <= 0) return -1;
    
    rdpContext* context = (rdpContext*)session;
    BridgeContext* ctx = (BridgeContext*)context;
    
    if (!ctx->opus_initialized || !ctx->opus_buffer) {
        return 0;
    }
    
    pthread_mutex_lock(&ctx->opus_mutex);
    
    /* Check if we have any data */
    if (ctx->opus_write_pos <= ctx->opus_read_pos) {
        pthread_mutex_unlock(&ctx->opus_mutex);
        return 0;
    }
    
    /* Read frame header (2 bytes: little-endian size) */
    size_t read_pos = ctx->opus_read_pos % ctx->opus_buffer_size;
    uint16_t frame_size = ctx->opus_buffer[read_pos];
    read_pos = (read_pos + 1) % ctx->opus_buffer_size;
    frame_size |= (uint16_t)ctx->opus_buffer[read_pos] << 8;
    read_pos = (read_pos + 1) % ctx->opus_buffer_size;
    
    if (frame_size == 0 || frame_size > 4000) {
        /* Invalid frame - reset buffer */
        ctx->opus_write_pos = 0;
        ctx->opus_read_pos = 0;
        pthread_mutex_unlock(&ctx->opus_mutex);
        return 0;
    }
    
    if (frame_size > max_size) {
        /* Buffer too small - skip this frame */
        ctx->opus_read_pos += 2 + frame_size;
        pthread_mutex_unlock(&ctx->opus_mutex);
        return -2;  /* Buffer too small error */
    }
    
    /* Read Opus frame data (handle wrap-around) */
    size_t first_chunk = ctx->opus_buffer_size - read_pos;
    if (first_chunk >= frame_size) {
        memcpy(buffer, ctx->opus_buffer + read_pos, frame_size);
    } else {
        memcpy(buffer, ctx->opus_buffer + read_pos, first_chunk);
        memcpy(buffer + first_chunk, ctx->opus_buffer, frame_size - first_chunk);
    }
    
    ctx->opus_read_pos += 2 + frame_size;
    
    /* Reset positions if buffer is empty */
    if (ctx->opus_read_pos >= ctx->opus_write_pos) {
        ctx->opus_write_pos = 0;
        ctx->opus_read_pos = 0;
    }
    
    pthread_mutex_unlock(&ctx->opus_mutex);
    
    return frame_size;
}

/* ============================================================================
 * Version
 * ============================================================================ */

const char* rdp_version(void)
{
    return RDP_BRIDGE_VERSION;
}


