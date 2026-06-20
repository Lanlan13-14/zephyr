/**
 * RDP Bridge Native Library Header
 * 
 * Direct FreeRDP3 integration for low-latency RDP streaming.
 * Provides frame capture via GDI surface and direct input injection.
 */

#ifndef RDP_BRIDGE_H
#define RDP_BRIDGE_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* GFX pipeline constants */
#define RDP_MAX_GFX_SURFACES 256
#define RDP_GFX_EVENTS_INITIAL 2048   /* Initial GFX event queue size (~295 KB) */
#define RDP_GFX_EVENTS_GROW 1024      /* Grow queue in 1024-slot increments */
#define RDP_MAX_GFX_EVENTS 16384      /* Max GFX event queue size (~2.3 MB) */

/* Session registry limits (compile-time defaults, runtime configurable) */
#define RDP_MAX_SESSIONS_DEFAULT 100
#define RDP_MAX_SESSIONS_MIN 2
#define RDP_MAX_SESSIONS_MAX 1000

/* Mouse button flags (compatible with FreeRDP PTR_FLAGS_*) */
#define RDP_MOUSE_FLAG_MOVE     0x0800
#define RDP_MOUSE_FLAG_BUTTON1  0x1000  /* Left */
#define RDP_MOUSE_FLAG_BUTTON2  0x2000  /* Right */
#define RDP_MOUSE_FLAG_BUTTON3  0x4000  /* Middle */
#define RDP_MOUSE_FLAG_DOWN     0x8000
#define RDP_MOUSE_FLAG_WHEEL    0x0200
#define RDP_MOUSE_FLAG_HWHEEL   0x0400
#define RDP_MOUSE_FLAG_NEGATIVE 0x0100

/* Keyboard flags */
#define RDP_KBD_FLAG_DOWN       0x0000
#define RDP_KBD_FLAG_RELEASE    0x8000
#define RDP_KBD_FLAG_EXTENDED   0x0100
#define RDP_KBD_FLAG_EXTENDED1  0x0200

/* Session states */
typedef enum {
    RDP_STATE_DISCONNECTED = 0,
    RDP_STATE_CONNECTING,
    RDP_STATE_CONNECTED,
    RDP_STATE_ERROR
} RdpState;

/* Rectangle structure (used for GFX frame positioning) */
typedef struct {
    int32_t x;
    int32_t y;
    int32_t width;
    int32_t height;
} RdpRect;

/* GFX codec identifiers (from MS-RDPEGFX) */
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

/* H.264 frame type */
typedef enum {
    RDP_H264_FRAME_TYPE_IDR = 0,  /* Keyframe (I-frame) */
    RDP_H264_FRAME_TYPE_P = 1,    /* Predictive frame */
    RDP_H264_FRAME_TYPE_B = 2     /* Bi-predictive frame */
} RdpH264FrameType;

/* GFX surface descriptor */
typedef struct {
    uint16_t surface_id;
    uint32_t width;
    uint32_t height;
    uint32_t pixel_format;        /* PIXEL_FORMAT_* constant */
    bool active;
    bool mapped_to_output;        /* Whether mapped to main display */
    int32_t output_x;             /* Output origin X */
    int32_t output_y;             /* Output origin Y */
} RdpGfxSurface;

/* GFX event types for wire format streaming */
typedef enum {
    RDP_GFX_EVENT_NONE = 0,
    RDP_GFX_EVENT_CREATE_SURFACE,   /* Surface created */
    RDP_GFX_EVENT_DELETE_SURFACE,   /* Surface deleted */
    RDP_GFX_EVENT_MAP_SURFACE,      /* Map surface to output (3) */
    RDP_GFX_EVENT_START_FRAME,      /* Frame processing started */
    RDP_GFX_EVENT_END_FRAME,        /* Frame processing ended */
    RDP_GFX_EVENT_SOLID_FILL,       /* Solid fill operation */
    RDP_GFX_EVENT_SURFACE_TO_SURFACE, /* Surface copy operation */
    RDP_GFX_EVENT_CACHE_TO_SURFACE, /* Cache to surface blit */
    RDP_GFX_EVENT_SURFACE_TO_CACHE, /* Store surface region in cache (9) */
    RDP_GFX_EVENT_WEBP_TILE,        /* WebP-encoded tile (10) */
    RDP_GFX_EVENT_VIDEO_FRAME,      /* H.264/Progressive video frame (11) */
    RDP_GFX_EVENT_EVICT_CACHE,      /* Evict cache slot (12) */
    RDP_GFX_EVENT_RESET_GRAPHICS,   /* Reset graphics (13) - new dimensions */
    RDP_GFX_EVENT_CAPS_CONFIRM,     /* Server capability confirmation (14) */
    RDP_GFX_EVENT_INIT_SETTINGS,    /* Initialization settings from FreeRDP (15) */
    
    /* Pointer/Cursor events */
    RDP_GFX_EVENT_POINTER_POSITION, /* Cursor position update (16) */
    RDP_GFX_EVENT_POINTER_SYSTEM,   /* System pointer (null/default) (17) */
    RDP_GFX_EVENT_POINTER_SET,      /* Set/show a cursor (bitmap data) (18) */
} RdpGfxEventType;

/* GFX event for Python consumption */
typedef struct {
    RdpGfxEventType type;
    uint32_t frame_id;              /* Frame ID (for START_FRAME/END_FRAME) */
    uint16_t surface_id;            /* Surface ID */
    uint16_t dst_surface_id;        /* Destination surface (for SURFACE_TO_SURFACE) */
    uint32_t width;                 /* Width (for CREATE_SURFACE, SOLID_FILL, S2S, S2C, WEBP_TILE) */
    uint32_t height;                /* Height (for CREATE_SURFACE, SOLID_FILL, S2S, S2C, WEBP_TILE) */
    uint32_t pixel_format;          /* Pixel format (for CREATE_SURFACE) */
    int32_t x;                      /* X coordinate (dest X for S2S/C2S/WEBP_TILE) */
    int32_t y;                      /* Y coordinate (dest Y for S2S/C2S/WEBP_TILE) */
    int32_t src_x;                  /* Source X (for SURFACE_TO_SURFACE) */
    int32_t src_y;                  /* Source Y (for SURFACE_TO_SURFACE) */
    uint32_t color;                 /* Fill color (ARGB, for SOLID_FILL) */
    uint16_t cache_slot;            /* Cache slot (for CACHE_TO_SURFACE, SURFACE_TO_CACHE) */
    /* Binary data (WebP for WEBP_TILE, unused for S2C - frontend extracts) */
    uint8_t* bitmap_data;           /* WebP data (caller frees after Python read) */
    uint32_t bitmap_size;           /* Size of WebP data in bytes */
    /* Video frame data (for VIDEO_FRAME - H.264/Progressive) */
    RdpGfxCodecId codec_id;         /* Codec ID (AVC420/AVC444/Progressive) */
    RdpH264FrameType video_frame_type; /* IDR/P/B for H.264 */
    uint8_t* nal_data;              /* NAL data (H.264) or Progressive raw data */
    uint32_t nal_size;              /* Size of NAL/Progressive data */
    uint8_t* chroma_nal_data;       /* Chroma NAL for AVC444 (NULL for others) */
    uint32_t chroma_nal_size;       /* Size of chroma NAL (0 for non-AVC444) */
    /* Capability confirmation (for CAPS_CONFIRM) */
    uint32_t gfx_version;           /* GFX version from CapsConfirm */
    uint32_t gfx_flags;             /* GFX flags from CapsConfirm */
    /* Initialization settings (for INIT_SETTINGS) */
    uint32_t init_color_depth;      /* ColorDepth setting */
    uint32_t init_flags_low;        /* Boolean settings packed as bitfield (bits 0-31) */
    uint32_t init_flags_high;       /* Reserved for future settings (bits 32-63) */
    
    /* Pointer/Cursor fields */
    uint16_t pointer_x;             /* Cursor X position (for POINTER_POSITION) */
    uint16_t pointer_y;             /* Cursor Y position (for POINTER_POSITION) */
    uint16_t pointer_hotspot_x;     /* Hotspot X (for POINTER_SET) */
    uint16_t pointer_hotspot_y;     /* Hotspot Y (for POINTER_SET) */
    uint16_t pointer_width;         /* Cursor width in pixels */
    uint16_t pointer_height;        /* Cursor height in pixels */
    uint8_t pointer_system_type;    /* 0=null/hidden, 1=default (for POINTER_SYSTEM) */
    uint8_t* pointer_data;          /* BGRA32 cursor image (caller frees) */
    uint32_t pointer_data_size;     /* Size of pointer_data in bytes */
} RdpGfxEvent;

/* Opaque session handle */
typedef struct RdpSession RdpSession;

/* ============================================================================
 * Session Registry API (for multi-user audio isolation)
 * ============================================================================ */

/**
 * Set the maximum number of concurrent RDP sessions allowed
 * 
 * Must be called before any sessions are created. The limit is clamped to
 * the range [RDP_MAX_SESSIONS_MIN, RDP_MAX_SESSIONS_MAX].
 * 
 * @param limit     Maximum number of sessions (default: 100, range: 2-1000)
 * @return          0 on success, -1 on failure
 */
int rdp_set_max_sessions(int limit);

/**
 * Get the current maximum sessions limit
 * 
 * @return          Current maximum session limit
 */
int rdp_get_max_sessions(void);

/**
 * Create a new RDP session (does not connect yet)
 * 
 * @param host      RDP server hostname or IP
 * @param port      RDP port (usually 3389)
 * @param username  Login username
 * @param password  Login password
 * @param domain    Windows domain (can be NULL or empty)
 * @param width     Initial display width
 * @param height    Initial display height
 * @param bpp       Bits per pixel (16, 24, or 32)
 * @return          Session handle or NULL on failure
 */
RdpSession* rdp_create(
    const char* host,
    uint16_t port,
    const char* username,
    const char* password,
    const char* domain,
    uint32_t width,
    uint32_t height,
    uint32_t bpp
);

/**
 * Connect to the RDP server
 * 
 * @param session   Session handle from rdp_create()
 * @return          0 on success, negative error code on failure
 */
int rdp_connect(RdpSession* session);

/**
 * Get current session state
 */
RdpState rdp_get_state(RdpSession* session);

/**
 * Get last error message
 * 
 * @param session   Session handle
 * @return          Error string (valid until next rdp_* call)
 */
const char* rdp_get_error(RdpSession* session);

/**
 * Poll for events and process frame updates
 * 
 * @param session       Session handle
 * @param timeout_ms    Maximum time to wait for events (0 = non-blocking)
 * @return              1 if new frame available, 0 if no update, negative on error
 */
int rdp_poll(RdpSession* session, int timeout_ms);

/**
 * Check if a GFX frame is currently being processed
 * 
 * When true, Python should wait before sending frames to avoid sending
 * incomplete buffer state. This is set between StartFrame and EndFrame
 * callbacks in the GFX pipeline.
 * 
 * @return true if a frame is being processed, false if safe to send
 */
bool rdp_gfx_frame_in_progress(RdpSession* session);

/**
 * Get the last completed GFX frame ID
 * 
 * Returns the frame ID of the most recently completed GFX frame (after EndFrame).
 * Python can track this to know when new GFX events are ready to be streamed.
 * 
 * @return Last completed frame ID, or 0 if no frames completed yet
 */
uint32_t rdp_gfx_get_last_completed_frame(RdpSession* session);

/**
 * Send mouse input event
 * 
 * @param session   Session handle
 * @param flags     Combination of RDP_MOUSE_FLAG_* values
 * @param x         X coordinate
 * @param y         Y coordinate
 */
void rdp_send_mouse(RdpSession* session, uint16_t flags, int x, int y);

/**
 * Send keyboard input event
 * 
 * @param session   Session handle
 * @param flags     RDP_KBD_FLAG_DOWN, RDP_KBD_FLAG_RELEASE, optionally | RDP_KBD_FLAG_EXTENDED
 * @param scancode  Keyboard scan code
 */
void rdp_send_keyboard(RdpSession* session, uint16_t flags, uint16_t scancode);

/**
 * Send unicode character input
 * 
 * @param session   Session handle
 * @param flags     RDP_KBD_FLAG_DOWN or RDP_KBD_FLAG_RELEASE
 * @param code      Unicode code point
 */
void rdp_send_unicode(RdpSession* session, uint16_t flags, uint16_t code);

/**
 * Resize the RDP session
 * 
 * May cause brief disconnection depending on server capabilities.
 * 
 * @param session   Session handle
 * @param width     New width
 * @param height    New height
 * @return          0 on success, negative on error
 */
int rdp_resize(RdpSession* session, uint32_t width, uint32_t height);

/**
 * Check if audio data is available
 * 
 * @param session   Session handle
 * @return          true if audio data is available
 */
bool rdp_has_audio_data(RdpSession* session);

/**
 * Get the current audio format
 * 
 * @param session       Session handle
 * @param sample_rate   Output: sample rate in Hz (e.g., 48000)
 * @param channels      Output: number of channels (1=mono, 2=stereo)
 * @param bits          Output: bits per sample (8, 16, or 32)
 * @return              0 on success, negative if audio not initialized
 */
int rdp_get_audio_format(RdpSession* session, int* sample_rate, int* channels, int* bits);

/**
 * Get available audio data
 * 
 * Reads PCM audio data from the internal buffer.
 * 
 * @param session   Session handle
 * @param buffer    Output buffer for audio data
 * @param max_size  Maximum bytes to read
 * @return          Number of bytes read, 0 if no data, negative on error
 */
int rdp_get_audio_data(RdpSession* session, uint8_t* buffer, int max_size);

/**
 * Write audio data to the buffer (internal use by rdpsnd callback)
 * 
 * @param session       Session handle
 * @param data          Audio PCM data
 * @param size          Size in bytes
 * @param sample_rate   Sample rate in Hz
 * @param channels      Number of channels
 * @param bits          Bits per sample
 */
void rdp_write_audio_data(RdpSession* session, const uint8_t* data, size_t size,
                          int sample_rate, int channels, int bits);

/* ============================================================================
 * Opus Audio API (for native audio streaming without PulseAudio)
 * ============================================================================ */

/**
 * AudioContext structure for RDPSND bridge plugin
 * 
 * This is exposed so the rdpsnd_bridge.so plugin can access the audio buffer.
 * The plugin is dynamically loaded by FreeRDP, so we use this as a shared
 * interface between rdp_bridge.so and rdpsnd_bridge.so.
 */
typedef struct {
    uint8_t* opus_buffer;           /* Ring buffer for Opus frames */
    size_t opus_buffer_size;        /* Total buffer size */
    size_t opus_write_pos;          /* Write position */
    size_t opus_read_pos;           /* Read position */
    void* opus_mutex;               /* pthread_mutex_t* for thread-safe access */
    int sample_rate;                /* Current sample rate (e.g., 48000) */
    int channels;                   /* Current channel count (1 or 2) */
    volatile int initialized;       /* Non-zero when audio is ready */
} RdpAudioContext;

/**
 * Set the audio context for the RDPSND bridge plugin
 * 
 * Must be called before rdp_connect() to allow the dynamically loaded
 * rdpsnd_bridge.so plugin to access the audio buffer.
 * 
 * @param session   Session handle
 */
void rdp_set_audio_context(RdpSession* session);

/**
 * Check if Opus audio data is available
 * 
 * @param session   Session handle
 * @return          true if Opus frames are available
 */
bool rdp_has_opus_data(RdpSession* session);

/**
 * Get Opus audio format information
 * 
 * @param session       Session handle
 * @param sample_rate   Output: sample rate in Hz (e.g., 48000)
 * @param channels      Output: number of channels (1 or 2)
 * @return              0 on success, negative if audio not initialized
 */
int rdp_get_opus_format(RdpSession* session, int* sample_rate, int* channels);

/**
 * Get next Opus frame from the buffer
 * 
 * Each Opus frame is a self-contained encoded packet that can be decoded
 * independently by the browser's WebCodecs AudioDecoder.
 * 
 * @param session   Session handle
 * @param buffer    Output buffer for Opus frame data
 * @param max_size  Maximum bytes to read
 * @return          Size of Opus frame, 0 if no data, negative on error
 */
int rdp_get_opus_frame(RdpSession* session, uint8_t* buffer, int max_size);

/**
 * Get audio buffer debug statistics for diagnostics
 *
 * @param session       Session handle
 * @param initialized   Output: 1 if audio is initialized, 0 otherwise
 * @param write_pos     Output: current write position in buffer
 * @param read_pos      Output: current read position in buffer
 * @param buffer_size   Output: total buffer size
 * @return              0 on success, negative on error
 */
int rdp_get_audio_stats(RdpSession* session, int* initialized, size_t* write_pos, 
                        size_t* read_pos, size_t* buffer_size);

/* ============================================================================
 * Native CLIPRDR API (text + file clipboard, no shared-drive fallback)
 * ============================================================================ */

/** Publish UTF-8 text as the local RDP clipboard (CF_UNICODETEXT). */
int rdp_clipboard_set_text(RdpSession* session, const char* utf8_text);

/** Publish newline-separated local file paths as FileGroupDescriptorW/FileContents. */
int rdp_clipboard_set_files(RdpSession* session, const char* newline_paths);

/** Pop the next clipboard event JSON string. Caller must free with rdp_free(). */
char* rdp_clipboard_pop_event(RdpSession* session);

/** Download a remote clipboard file by index through FileContentsRequest PDUs. */
int rdp_clipboard_download_file(RdpSession* session, uint32_t index, const char* output_path);

/** Free memory returned by native API helpers. */
void rdp_free(void* ptr);

/**
 * Disconnect from the RDP server
 */
void rdp_disconnect(RdpSession* session);

/**
 * Destroy session and free all resources
 */
void rdp_destroy(RdpSession* session);

/**
 * Get library version string
 */
const char* rdp_version(void);

/* ============================================================================
 * GFX Pipeline / H.264 API (for AVC420/AVC444 streaming)
 * ============================================================================ */

/**
 * Check if GFX pipeline is active (H.264/AVC mode negotiated)
 * 
 * @param session   Session handle
 * @return          true if GFX pipeline is active with H.264 codec
 */
bool rdp_gfx_is_active(RdpSession* session);

/**
 * Get negotiated GFX codec ID
 * 
 * @param session   Session handle
 * @return          Active codec ID (RDP_GFX_CODEC_AVC420, AVC444, etc.) or 0
 */
RdpGfxCodecId rdp_gfx_get_codec(RdpSession* session);

/**
 * Get information about a GFX surface
 * 
 * @param session       Session handle
 * @param surface_id    Surface ID
 * @param surface       Output: surface descriptor
 * @return              0 on success, -1 if surface not found
 */
int rdp_gfx_get_surface(RdpSession* session, uint16_t surface_id, RdpGfxSurface* surface);

/**
 * Get the primary output surface ID
 * 
 * @param session   Session handle
 * @return          Primary surface ID or 0 if not mapped
 */
uint16_t rdp_gfx_get_primary_surface(RdpSession* session);

/**
 * Send a frame acknowledgment to the RDP server
 * 
 * In wire-through mode, ACKs are sent by the browser after decoding/presenting
 * frames. This provides proper backpressure - if the browser is slow to decode,
 * ACKs are delayed and the server throttles its frame rate.
 * 
 * Call this when the browser sends a FACK (frame ack) message after compositing
 * a frame received via the GFX event stream.
 * 
 * Per MS-RDPEGFX 2.2.3.3, queueDepth enables adaptive server-side rate control:
 *   0x00000000 (QUEUE_DEPTH_UNAVAILABLE): Queue depth not available
 *   0xFFFFFFFF (SUSPEND_FRAME_ACKNOWLEDGEMENT): Suspend frame sending
 *   Other: Actual number of unprocessed frames in client queue
 * 
 * @param session              Session handle
 * @param frame_id             Frame ID to acknowledge (from END_FRAME event / browser FACK)
 * @param total_frames_decoded Running count of frames decoded by browser
 * @param queue_depth          Number of unprocessed frames in browser decode queue
 * @return                     0 on success, -1 on error
 */
int rdp_gfx_send_frame_ack(RdpSession* session, uint32_t frame_id, uint32_t total_frames_decoded, uint32_t queue_depth);

/* ============================================================================
 * GFX Event Queue API (for wire format streaming)
 * ============================================================================ */

/**
 * Check if GFX events are available
 * 
 * @param session   Session handle
 * @return          Number of events available (0 if none)
 */
int rdp_gfx_has_events(RdpSession* session);

/**
 * Get next GFX event from the queue
 * 
 * @param session   Session handle
 * @param event     Output: event descriptor
 * @return          0 on success, -1 if no events
 */
int rdp_gfx_get_event(RdpSession* session, RdpGfxEvent* event);

/**
 * Clear all pending GFX events
 * 
 * @param session   Session handle
 */
void rdp_gfx_clear_events(RdpSession* session);

/**
 * Free GFX event data (WebP tile data allocated by C)
 * 
 * Call this after copying bitmap_data from a WEBP_TILE event.
 * 
 * @param data      Pointer returned in RdpGfxEvent.bitmap_data
 */
void rdp_free_gfx_event_data(void* data);

#ifdef __cplusplus
}
#endif

#endif /* RDP_BRIDGE_H */
