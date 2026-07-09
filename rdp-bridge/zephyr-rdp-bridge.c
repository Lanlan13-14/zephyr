/*
 * zephyr-rdp-bridge.c — FreeRDP native bridge, stdio transport
 *
 * Node spawns this process with stdio pipes.
 * stdout = frames to browser  (binary: type(4LE) len(4LE) payload)
 * stdin  = input from browser (same format)
 * stderr = log messages
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <unistd.h>
#include <pthread.h>
#include <signal.h>
#include <errno.h>
#include <getopt.h>

#include <winpr/wlog.h>
#include <winpr/synch.h>
#include <winpr/thread.h>

#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/settings.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/codec/color.h>
#include <freerdp/codec/interleaved.h>
#include <freerdp/input.h>
#include <freerdp/pointer.h>
#include <freerdp/event.h>
#include <freerdp/channels/channels.h>
#include <freerdp/client/cmdline.h>

/* ─── Wire protocol ──────────────────────────────────────────── */
#define MSG_BITMAP_BGRA    1
#define MSG_H264_FRAME     2
#define MSG_DESKTOP_SIZE   3
#define MSG_CONNECTED      4
#define MSG_DISCONNECTED   5
#define MSG_ERROR          6
#define MSG_FRAME_START    8
#define MSG_FRAME_END      9
#define MSG_CAPABILITIES   10

#define MSG_MOUSE_EVENT    100
#define MSG_KEYBOARD_EVENT 101
#define MSG_UNICODE_EVENT  102
#define MSG_RESIZE         103
#define MSG_DISCONNECT     104
#define MSG_FRAME_ACK      105

/* ─── Custom context ─────────────────────────────────────────── */
typedef struct {
    rdpContext ctx;          /* MUST be first */
    RdpgfxClientContext* gfx;
    pcRdpgfxSurfaceCommand origSurfaceCmd;
    pcRdpgfxStartFrame     origStartFrame;
    pcRdpgfxEndFrame       origEndFrame;
    BITMAP_INTERLEAVED_CONTEXT* rle;
    bool connected;
    HANDLE client_thread;
} ZCtx;

/* ─── Global state ───────────────────────────────────────────── */
typedef struct {
    freerdp*    instance;
    rdpContext* context;
    rdpSettings* settings;
    rdpGdi*     gdi;

    char host[256];
    int  port;
    char username[256];
    char password[256];
    char domain[64];
    int  width, height, depth;

    /* stdout output buffer (thread-safe) */
    pthread_mutex_t out_lock;
    uint8_t* out_buf;
    size_t   out_len, out_cap;
    int      proto_fd;  /* original stdout pipe; logs may redirect stdout to stderr */

    bool shall_disconnect;
} G;

static G g;
static volatile sig_atomic_t g_exit = 0;
static int g_paint_count = 0;

/* ─── Logging (to stderr so stdout stays clean) ──────────────── */
static void blog(const char* lvl, const char* fmt, ...) {
    va_list ap;
    fprintf(stderr, "[bridge:%s] ", lvl);
    va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
    fputc('\n', stderr); fflush(stderr);
}
#define LOGI(fmt,...) blog("I",fmt,##__VA_ARGS__)
#define LOGW(fmt,...) blog("W",fmt,##__VA_ARGS__)
#define LOGE(fmt,...) blog("E",fmt,##__VA_ARGS__)
/* ─── stdout output (binary framing) ────────────────────────── */

static void out_flush(void) {
    if (g.out_len == 0) return;
    /* Write all buffered bytes to stdout atomically */
    size_t written = 0;
    while (written < g.out_len) {
        ssize_t n = write(g.proto_fd >= 0 ? g.proto_fd : STDOUT_FILENO, g.out_buf + written, g.out_len - written);
        if (n <= 0) break;
        written += n;
    }
    g.out_len = 0;
}

static void out_queue(uint32_t type, const void* payload, size_t plen) {
    pthread_mutex_lock(&g.out_lock);
    size_t needed = 8 + plen;
    if (g.out_len + needed > g.out_cap) {
        size_t nc = g.out_cap ? g.out_cap : 65536;
        while (nc < g.out_len + needed) nc *= 2;
        uint8_t* nb = realloc(g.out_buf, nc);
        if (!nb) { pthread_mutex_unlock(&g.out_lock); return; }
        g.out_buf = nb; g.out_cap = nc;
    }
    uint8_t* d = g.out_buf + g.out_len;
    d[0]=type; d[1]=type>>8; d[2]=type>>16; d[3]=type>>24;
    uint32_t l = (uint32_t)plen;
    d[4]=l; d[5]=l>>8; d[6]=l>>16; d[7]=l>>24;
    if (payload && plen) memcpy(d+8, payload, plen);
    g.out_len += needed;
    out_flush();
    pthread_mutex_unlock(&g.out_lock);
}

static void send_bitmap(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                        const uint8_t* px) {
    size_t total = 8 + (size_t)w * h * 4;
    uint8_t* buf = malloc(total);
    if (!buf) return;
    memcpy(buf,   &x, 2); memcpy(buf+2, &y, 2);
    memcpy(buf+4, &w, 2); memcpy(buf+6, &h, 2);
    memcpy(buf+8, px, (size_t)w * h * 4);
    out_queue(MSG_BITMAP_BGRA, buf, total);
    free(buf);
}
/* ─── GFX SurfaceCommand interceptor ────────────────────────── */

static UINT my_SurfaceCmd(RdpgfxClientContext* ctx,
                           const RDPGFX_SURFACE_COMMAND* cmd) {
    ZCtx* zc = (ZCtx*)ctx->custom;
    if (!cmd || !cmd->data || cmd->length == 0)
        return zc->origSurfaceCmd ? zc->origSurfaceCmd(ctx, cmd) : CHANNEL_RC_OK;

    if (cmd->codecId == RDPGFX_CODECID_AVC420 ||
        cmd->codecId == RDPGFX_CODECID_AVC444 ||
        cmd->codecId == RDPGFX_CODECID_AVC444v2) {
        /* H264 passthrough: forward raw bitstream to browser */
        size_t hdr = 16, total = hdr + cmd->length;
        uint8_t* buf = malloc(total);
        if (buf) {
            uint16_t sid=cmd->surfaceId, cid=cmd->codecId;
            uint16_t l=cmd->left, t=cmd->top, r=cmd->right, b=cmd->bottom;
            uint32_t fmt=cmd->format;
            memcpy(buf,    &sid, 2); memcpy(buf+2,  &cid, 2);
            memcpy(buf+4,  &l,   2); memcpy(buf+6,  &t,   2);
            memcpy(buf+8,  &r,   2); memcpy(buf+10, &b,   2);
            memcpy(buf+12, &fmt, 4);
            memcpy(buf+16, cmd->data, cmd->length);
            out_queue(MSG_H264_FRAME, buf, total);
            free(buf);
        }
        return CHANNEL_RC_OK;
    }

    /* Non-H264: decode via FreeRDP, extract from surface */
    UINT rc = zc->origSurfaceCmd ? zc->origSurfaceCmd(ctx, cmd) : CHANNEL_RC_OK;
    if (rc == CHANNEL_RC_OK && ctx->GetSurfaceData) {
        gdiGfxSurface* s = (gdiGfxSurface*)ctx->GetSurfaceData(ctx, (UINT16)cmd->surfaceId);
        if (s && s->data) {
            UINT32 w = cmd->right - cmd->left, h = cmd->bottom - cmd->top;
            if (w && h && w < 8192 && h < 8192) {
                uint8_t* px = malloc((size_t)w*h*4);
                if (px) {
                    for (UINT32 row = 0; row < h; row++)
                        memcpy(px + row*w*4,
                            s->data + (cmd->top+row)*s->scanline + cmd->left*4,
                            w*4);
                    send_bitmap(cmd->left, cmd->top, w, h, px);
                    free(px);
                }
            }
        }
    }
    return rc;
}

static UINT my_StartFrame(RdpgfxClientContext* ctx,
                           const RDPGFX_START_FRAME_PDU* f) {
    ZCtx* zc = (ZCtx*)ctx->custom;
    if (f) {
        uint8_t p[12];
        uint32_t id=f->frameId; uint64_t ts=f->timestamp;
        memcpy(p, &id, 4); memcpy(p+4, &ts, 8);
        out_queue(MSG_FRAME_START, p, 12);
    }
    return zc->origStartFrame ? zc->origStartFrame(ctx, f) : CHANNEL_RC_OK;
}

static UINT my_EndFrame(RdpgfxClientContext* ctx,
                         const RDPGFX_END_FRAME_PDU* f) {
    ZCtx* zc = (ZCtx*)ctx->custom;
    if (f) {
        uint32_t id = f->frameId;
        out_queue(MSG_FRAME_END, &id, 4);
    }
    return zc->origEndFrame ? zc->origEndFrame(ctx, f) : CHANNEL_RC_OK;
}
/* ─── BeginPaint / EndPaint (bitmap frame extraction) ───────── */

static BOOL my_BeginPaint(rdpContext* context) {
    (void)context; return TRUE;
}

static BOOL my_EndPaint(rdpContext* context) {
    rdpGdi* gdi = context->gdi;
    if (!gdi || !gdi->primary || !gdi->primary_buffer) return TRUE;
    if (!gdi->primary->hdc || !gdi->primary->hdc->hwnd) return TRUE;

    HGDI_WND hwnd = gdi->primary->hdc->hwnd;
    if (!hwnd->invalid || hwnd->ninvalid < 1) return TRUE;

    for (INT32 i = 0; i < hwnd->ninvalid; i++) {
        HGDI_RGN inv = &hwnd->cinvalid[i];
        INT32 x = inv->x, y = inv->y, w = inv->w, h = inv->h;
        if (w <= 0 || h <= 0 || w > 7680 || h > 4320) continue;
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > gdi->width)  w = gdi->width  - x;
        if (y + h > gdi->height) h = gdi->height - y;
        if (w <= 0 || h <= 0) continue;

        UINT32 stride = gdi->stride ? gdi->stride : (UINT32)gdi->width * 4;
        uint8_t* px = malloc((size_t)w * h * 4);
        if (px) {
            for (INT32 row = 0; row < h; row++)
                memcpy(px + row*w*4,
                    gdi->primary_buffer + (y+row)*stride + x*4,
                    (size_t)w * 4);
            send_bitmap((uint16_t)x, (uint16_t)y, (uint16_t)w, (uint16_t)h, px);
            free(px);
        }
    }
    hwnd->invalid->null = TRUE;
    hwnd->ninvalid = 0;

    g_paint_count++;
    if (g_paint_count <= 3) LOGI("EndPaint #%d", g_paint_count);
    return TRUE;
}

static BOOL my_DesktopResize(rdpContext* context) {
    uint16_t w = (uint16_t)freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    uint16_t h = (uint16_t)freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    uint8_t p[4]; memcpy(p, &w, 2); memcpy(p+2, &h, 2);
    out_queue(MSG_DESKTOP_SIZE, p, 4);
    LOGI("desktop resize: %ux%u", w, h);
    return TRUE;
}
/* ─── PostConnect / PostDisconnect ──────────────────────────── */

/* ─── ChannelConnected event (hooks RDPGFX when it connects) ──── */
static void on_channel_connected(void* ctx, ChannelConnectedEventArgs* e) {
    rdpContext* context = (rdpContext*)ctx;
    ZCtx* zc = (ZCtx*)context;
    
    if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0) {
        RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
        zc->gfx = gfx;
        gfx->custom = zc;
        zc->origSurfaceCmd  = gfx->SurfaceCommand;
        zc->origStartFrame  = gfx->StartFrame;
        zc->origEndFrame    = gfx->EndFrame;
        gfx->SurfaceCommand = my_SurfaceCmd;
        gfx->StartFrame     = my_StartFrame;
        gfx->EndFrame       = my_EndFrame;
        if (g.gdi) gdi_graphics_pipeline_init(g.gdi, gfx);
        LOGI("RDPGFX connected & hooked for H264 passthrough");
    }
}

static BOOL my_PostConnect(freerdp* instance) {
    LOGI("PostConnect");
    ZCtx* zc = (ZCtx*)instance->context;
    g.gdi = instance->context->gdi;
    if (!g.gdi) { LOGE("GDI not initialized"); return FALSE; }

    /* Re-hook BeginPaint/EndPaint after GDI init (gdi_init may overwrite) */
    instance->update->BeginPaint = my_BeginPaint;
    instance->update->EndPaint   = my_EndPaint;
    instance->update->DesktopResize = my_DesktopResize;

    zc->rle = bitmap_interleaved_context_new(FALSE);
    zc->connected = true;
    out_queue(MSG_CONNECTED, NULL, 0);

    uint16_t w = (uint16_t)freerdp_settings_get_uint32(instance->settings, FreeRDP_DesktopWidth);
    uint16_t h = (uint16_t)freerdp_settings_get_uint32(instance->settings, FreeRDP_DesktopHeight);
    uint8_t sz[4]; memcpy(sz, &w, 2); memcpy(sz+2, &h, 2);
    out_queue(MSG_DESKTOP_SIZE, sz, 4);

    uint32_t caps = 0x01;
    out_queue(MSG_CAPABILITIES, &caps, 4);
    LOGI("connected, desktop %ux%u", w, h);
    return TRUE;
}

static void my_PostDisconnect(freerdp* instance) {
    LOGI("PostDisconnect");
    ZCtx* zc = (ZCtx*)instance->context;
    zc->connected = false;
    uint32_t r = 0;
    out_queue(MSG_DISCONNECTED, &r, 4);
    if (zc->rle) { bitmap_interleaved_context_free(zc->rle); zc->rle = NULL; }
}
/* ─── stdin input reader ─────────────────────────────────────── */

static void process_input(uint32_t type, const uint8_t* data, size_t len) {
    freerdp* inst = g.instance;
    if (!inst || !inst->input) return;
    ZCtx* zc = (ZCtx*)inst->context;
    if (!zc->connected) return;

    switch (type) {
        case MSG_MOUSE_EVENT:
            if (len >= 6) {
                uint16_t f,x,y;
                memcpy(&f,data,2); memcpy(&x,data+2,2); memcpy(&y,data+4,2);
                freerdp_input_send_mouse_event(inst->input, f, x, y);
            }
            break;
        case MSG_KEYBOARD_EVENT:
            if (len >= 4) {
                uint16_t f,c; memcpy(&f,data,2); memcpy(&c,data+2,2);
                freerdp_input_send_keyboard_event(inst->input, f, c);
            }
            break;
        case MSG_UNICODE_EVENT:
            if (len >= 4) {
                uint16_t f,c; memcpy(&f,data,2); memcpy(&c,data+2,2);
                freerdp_input_send_unicode_keyboard_event(inst->input, f, c);
            }
            break;
        case MSG_DISCONNECT:
            g.shall_disconnect = true;
            freerdp_disconnect(inst);
            break;
        case MSG_FRAME_ACK:
            if (len >= 4) {
                ZCtx* zc2 = (ZCtx*)inst->context;
                if (zc2->gfx && zc2->gfx->FrameAcknowledge) {
                    uint32_t fid; memcpy(&fid, data, 4);
                    RDPGFX_FRAME_ACKNOWLEDGE_PDU ack = {0};
                    ack.queueDepth = QUEUE_DEPTH_UNAVAILABLE;
                    ack.frameId = fid;
                    ack.totalFramesDecoded = fid;
                    zc2->gfx->FrameAcknowledge(zc2->gfx, &ack);
                }
            }
            break;
    }
}

/* stdin reader thread: reads framed messages and dispatches */
static void* stdin_reader(void* arg) {
    (void)arg;
    uint8_t hdr[8];
    while (!g_exit) {
        /* Read 8-byte header */
        size_t got = 0;
        while (got < 8) {
            ssize_t n = read(STDIN_FILENO, hdr + got, 8 - got);
            if (n <= 0) { g_exit = 1; return NULL; }
            got += n;
        }
        uint32_t type = hdr[0]|(hdr[1]<<8)|(hdr[2]<<16)|(hdr[3]<<24);
        uint32_t plen = hdr[4]|(hdr[5]<<8)|(hdr[6]<<16)|(hdr[7]<<24);
        if (plen > 64*1024*1024) { LOGE("input: oversized payload %u", plen); g_exit=1; return NULL; }

        uint8_t* payload = NULL;
        if (plen > 0) {
            payload = malloc(plen);
            if (!payload) { g_exit=1; return NULL; }
            size_t pg = 0;
            while (pg < plen) {
                ssize_t n = read(STDIN_FILENO, payload + pg, plen - pg);
                if (n <= 0) { free(payload); g_exit=1; return NULL; }
                pg += n;
            }
        }
        process_input(type, payload, plen);
        free(payload);
    }
    return NULL;
}
/* ─── FreeRDP client thread ──────────────────────────────────── */

static void* client_thread(void* arg) {
    rdpContext* ctx = (rdpContext*)arg;
    freerdp* inst   = ctx->instance;

    LOGI("client thread: connecting to %s:%d as %s", g.host, g.port, g.username);
    if (!freerdp_connect(inst)) {
        uint32_t err = freerdp_get_last_error(ctx);
        char buf[128];
        snprintf(buf, sizeof(buf), "freerdp_connect failed: 0x%08x", err);
        LOGE("%s", buf);
        out_queue(MSG_ERROR, buf, strlen(buf));
        return NULL;
    }
    LOGI("freerdp_connect OK");

    while (!g_exit && !g.shall_disconnect) {
        HANDLE ev[64];
        DWORD n = freerdp_get_event_handles(ctx, ev, 64);
        if (!n) break;
        DWORD r = WaitForMultipleObjects(n, ev, FALSE, 100);
        if (r == WAIT_FAILED) break;
        if (!freerdp_check_event_handles(ctx)) {
            if (!freerdp_shall_disconnect(inst)) LOGE("check_event_handles failed");
            break;
        }
    }

    LOGI("client thread: disconnecting");
    freerdp_disconnect(inst);
    return NULL;
}

static int my_ClientStart(rdpContext* ctx) {
    ZCtx* zc = (ZCtx*)ctx;
    HANDLE t = CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE)client_thread, ctx, 0, NULL);
    if (!t) return -1;
    zc->client_thread = t;
    return 0;
}

static int my_ClientStop(rdpContext* ctx) {
    ZCtx* zc = (ZCtx*)ctx;
    g.shall_disconnect = true;
    if (zc->client_thread) {
        WaitForSingleObject(zc->client_thread, 5000);
        CloseHandle(zc->client_thread);
        zc->client_thread = NULL;
    }
    return 0;
}

static BOOL my_ClientNew(freerdp* inst, rdpContext* ctx) { (void)inst; (void)ctx; return TRUE; }
static void my_ClientFree(freerdp* inst, rdpContext* ctx) { (void)inst; (void)ctx; }

static int RdpEntry(RDP_CLIENT_ENTRY_POINTS* ep) {
    ep->Version    = RDP_CLIENT_INTERFACE_VERSION;
    ep->Size       = sizeof(RDP_CLIENT_ENTRY_POINTS);
    ep->ContextSize = sizeof(ZCtx);
    ep->ClientNew  = my_ClientNew;
    ep->ClientFree = my_ClientFree;
    ep->ClientStart = my_ClientStart;
    ep->ClientStop  = my_ClientStop;
    return 0;
}
/* ─── main ───────────────────────────────────────────────────── */

static void sigh(int s) { (void)s; g_exit = 1; }

int main(int argc, char* argv[]) {
    memset(&g, 0, sizeof(g));
    pthread_mutex_init(&g.out_lock, NULL);
    g.width = 1920; g.height = 1080; g.depth = 32;

    static struct option lo[] = {
        {"host",1,0,'H'}, {"port",1,0,'P'}, {"user",1,0,'u'},
        {"password",1,0,'p'}, {"domain",1,0,'d'},
        {"width",1,0,'w'}, {"height",1,0,'h'}, {"depth",1,0,'b'},
        {0,0,0,0}
    };
    int c, oi;
    while ((c = getopt_long(argc, argv, "H:P:u:p:d:w:h:b:", lo, &oi)) != -1) {
        switch (c) {
            case 'H': strncpy(g.host,     optarg, 255); break;
            case 'P': g.port = atoi(optarg);            break;
            case 'u': strncpy(g.username, optarg, 255); break;
            case 'p': strncpy(g.password, optarg, 255); break;
            case 'd': strncpy(g.domain,   optarg,  63); break;
            case 'w': g.width  = atoi(optarg);          break;
            case 'h': g.height = atoi(optarg);          break;
            case 'b': g.depth  = atoi(optarg);          break;
        }
    }
    if (!g.host[0] || !g.username[0] || !g.password[0]) {
        fprintf(stderr, "Usage: %s --host <ip> --user <u> --password <p> [--port 3389] ...\n", argv[0]);
        return 1;
    }
    if (!g.port) g.port = 3389;
    signal(SIGINT, sigh); signal(SIGTERM, sigh);

    /* Keep original stdout as binary protocol pipe, then redirect normal stdout
     * to stderr so FreeRDP/winpr logs cannot corrupt the protocol stream. */
    g.proto_fd = dup(STDOUT_FILENO);
    if (g.proto_fd < 0) { perror("dup stdout"); return 1; }
    dup2(STDERR_FILENO, STDOUT_FILENO);

    /* silence FreeRDP logs */
    wLog* log = WLog_Get("");
    if (log) WLog_SetLogLevel(log, WLOG_WARN);

    LOGI("starting: %s:%d as %s, %dx%d", g.host, g.port, g.username, g.width, g.height);

    /* Create client context */
    RDP_CLIENT_ENTRY_POINTS ep;
    memset(&ep, 0, sizeof(ep));
    RdpEntry(&ep);
    g.context = freerdp_client_context_new(&ep);
    if (!g.context) { LOGE("freerdp_client_context_new failed"); return 1; }
    g.instance = g.context->instance;
    g.settings = g.context->settings;

    /* Settings */
    rdpSettings* s = g.settings;
    freerdp_settings_set_string(s, FreeRDP_ServerHostname, g.host);
    freerdp_settings_set_uint32(s, FreeRDP_ServerPort,     g.port);
    freerdp_settings_set_string(s, FreeRDP_Username,       g.username);
    freerdp_settings_set_string(s, FreeRDP_Password,       g.password);
    if (g.domain[0])
        freerdp_settings_set_string(s, FreeRDP_Domain, g.domain);
    freerdp_settings_set_uint32(s, FreeRDP_DesktopWidth,   g.width);
    freerdp_settings_set_uint32(s, FreeRDP_DesktopHeight,  g.height);
    freerdp_settings_set_uint32(s, FreeRDP_ColorDepth,     g.depth);

    freerdp_settings_set_bool(s, FreeRDP_SupportGraphicsPipeline, TRUE);
    freerdp_settings_set_bool(s, FreeRDP_GfxH264,    TRUE);
    freerdp_settings_set_bool(s, FreeRDP_GfxAVC444,  TRUE);
    freerdp_settings_set_bool(s, FreeRDP_GfxAVC444v2,TRUE);
    freerdp_settings_set_bool(s, FreeRDP_RemoteFxCodec, TRUE);
    freerdp_settings_set_bool(s, FreeRDP_NSCodec,    FALSE);
    freerdp_settings_set_bool(s, FreeRDP_JpegCodec,  FALSE);
    freerdp_settings_set_bool(s, FreeRDP_FrameMarkerCommandEnabled, TRUE);
    freerdp_settings_set_bool(s, FreeRDP_BitmapCacheV3Enabled,      TRUE);
    freerdp_settings_set_bool(s, FreeRDP_SoftwareGdi,    TRUE);
    freerdp_settings_set_bool(s, FreeRDP_IgnoreCertificate, TRUE);
    freerdp_settings_set_bool(s, FreeRDP_RedirectClipboard, FALSE);
    freerdp_settings_set_bool(s, FreeRDP_NlaSecurity,   TRUE);
    freerdp_settings_set_bool(s, FreeRDP_TlsSecurity,   TRUE);

    /* Callbacks */
    freerdp* inst = g.instance;
    inst->PostConnect    = my_PostConnect;
    inst->PostDisconnect = my_PostDisconnect;

    /* Subscribe to ChannelConnected event (for RDPGFX hook) */
    PubSub_SubscribeChannelConnected(inst->context->pubSub,
        (pChannelConnectedEventHandler)on_channel_connected);

    /* Init GDI before connect (installs update handlers) */
    if (!gdi_init(inst, PIXEL_FORMAT_BGRX32)) {
        LOGE("gdi_init failed"); return 1;
    }
    g.gdi = inst->context->gdi;
    inst->update->BeginPaint    = my_BeginPaint;
    inst->update->EndPaint      = my_EndPaint;
    inst->update->DesktopResize = my_DesktopResize;

    /* Load channel addins */
    freerdp_client_load_addins(inst->context->channels, inst->settings);

    /* Start stdin reader thread */
    pthread_t stdin_t;
    pthread_create(&stdin_t, NULL, stdin_reader, NULL);

    /* Start FreeRDP client (spawns client_thread) */
    if (freerdp_client_start(g.context) != 0) {
        LOGE("freerdp_client_start failed"); return 1;
    }

    /* Wait */
    while (!g_exit && !g.shall_disconnect)
        usleep(100000);

    freerdp_client_stop(g.context);
    g_exit = 1;
    pthread_join(stdin_t, NULL);
    freerdp_client_context_free(g.context);
    pthread_mutex_destroy(&g.out_lock);
    free(g.out_buf);
    LOGI("exited");
    return 0;
}
