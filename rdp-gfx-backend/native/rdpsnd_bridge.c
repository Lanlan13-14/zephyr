/**
 * RDP Sound Bridge Plugin - Standalone RDPSND Device Plugin
 * 
 * Receives decoded PCM audio from FreeRDP3, encodes to Opus,
 * and writes to the session's audio buffer for WebSocket streaming.
 * 
 * Built as a separate .so for version independence from FreeRDP internals.
 */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <pthread.h>
#include <dlfcn.h>

#include <freerdp/freerdp.h>
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/client/rdpsnd.h>
#include <winpr/crt.h>
#include <opus/opus.h>

/* ============================================================================
 * Thread-Local Context Passing
 * 
 * Since this plugin is dynamically loaded by FreeRDP, we use thread-local
 * storage to pass the BridgeContext pointer from the main library.
 * ============================================================================ */

/* Opaque audio context - matches what rdp_bridge.c provides
 * For multi-session support, write_pos and read_pos are POINTERS
 * to the actual positions in the BridgeContext, allowing multiple
 * plugin instances to write to different session buffers correctly. */
typedef struct {
    uint8_t* opus_buffer;           /* Buffer for Opus frames with headers */
    size_t opus_buffer_size;        /* Total buffer size */
    size_t* opus_write_pos;         /* POINTER to write position in BridgeContext */
    size_t* opus_read_pos;          /* POINTER to read position in BridgeContext */
    pthread_mutex_t* opus_mutex;    /* Mutex for thread-safe access */
    int sample_rate;                /* Current sample rate */
    int channels;                   /* Current channel count */
    volatile int* initialized;      /* POINTER to initialization flag in BridgeContext */
} AudioContext;

/* Thread-local storage for current audio context */
static __thread AudioContext* g_current_audio_ctx = NULL;

/* Export functions for setting/getting context */
__attribute__((visibility("default")))
void rdpsnd_bridge_set_context(AudioContext* ctx)
{
    g_current_audio_ctx = ctx;
}

__attribute__((visibility("default")))
AudioContext* rdpsnd_bridge_get_context(void)
{
    return g_current_audio_ctx;
}

/* ============================================================================
 * Opus Frame Format
 * 
 * Each Opus frame in the buffer is stored as:
 * [2 bytes: frame_size (little-endian)] [frame_size bytes: Opus data]
 * ============================================================================ */

#define OPUS_FRAME_HEADER_SIZE 2
#define MAX_OPUS_FRAME_SIZE 4000  /* Max Opus frame size */
#define OPUS_FRAME_DURATION_MS 20 /* 20ms frames for good latency/efficiency balance */
#define OPUS_SAMPLE_RATE 48000    /* Opus encoding sample rate */

/* ============================================================================
 * Plugin Structure
 * ============================================================================ */

typedef struct {
    rdpsndDevicePlugin device;      /* Must be first - FreeRDP requires this */
    
    /* Opus encoder */
    OpusEncoder* encoder;
    unsigned char* opus_output;     /* Temporary buffer for encoded frame */
    int opus_output_size;
    
    /* PCM accumulation buffer for frame alignment (at Opus sample rate) */
    int16_t* pcm_buffer;
    size_t pcm_buffer_samples;      /* Samples per channel accumulated */
    size_t pcm_frame_samples;       /* Samples per channel per Opus frame (at 48kHz) */
    
    /* Resampling buffer for 44100->48000 conversion */
    int16_t* resample_buffer;
    size_t resample_buffer_size;    /* Size in samples per channel */
    double resample_pos;            /* Fractional position for interpolation */
    BOOL needs_resample;            /* TRUE if input is not 48000 Hz */
    UINT32 input_sample_rate;       /* Original input sample rate */
    
    /* Audio format */
    AUDIO_FORMAT format;
    UINT32 latency;
    BOOL opened;
    
    /* Back-pointer to audio context */
    AudioContext* audio_ctx;
    
} rdpsndBridgePlugin;

/* ============================================================================
 * Opus Buffer Write (called by Play callback)
 * ============================================================================ */

static void write_opus_frame(AudioContext* ctx, const unsigned char* data, int size)
{
    if (!ctx || !ctx->opus_buffer || !ctx->opus_mutex || !ctx->opus_write_pos || !ctx->opus_read_pos || size <= 0 || size > 0xFFFF)
        return;
    
    pthread_mutex_lock(ctx->opus_mutex);
    
    size_t total_size = OPUS_FRAME_HEADER_SIZE + size;
    
    /* Check if we have space (with wrap-around handling) 
     * Note: opus_write_pos and opus_read_pos are POINTERS to the actual values */
    size_t used;
    if (*ctx->opus_write_pos >= *ctx->opus_read_pos) {
        used = *ctx->opus_write_pos - *ctx->opus_read_pos;
    } else {
        /* This shouldn't happen with monotonic positions, but handle it */
        used = 0;
    }
    
    size_t available = ctx->opus_buffer_size - used;
    
    if (available < total_size + 64) {
        /* Buffer full - drop old frames one at a time until we have space.
         * This preserves as much audio as possible instead of dropping everything. */
        int frames_dropped = 0;
        while (available < total_size + 64 && *ctx->opus_read_pos < *ctx->opus_write_pos) {
            /* Read frame size at current read position */
            size_t read_pos = *ctx->opus_read_pos % ctx->opus_buffer_size;
            uint16_t old_frame_size = ctx->opus_buffer[read_pos];
            read_pos = (read_pos + 1) % ctx->opus_buffer_size;
            old_frame_size |= (uint16_t)ctx->opus_buffer[read_pos] << 8;
            
            /* Sanity check - if frame size is invalid, reset buffer */
            if (old_frame_size == 0 || old_frame_size > 4000) {
                *ctx->opus_read_pos = *ctx->opus_write_pos;
                available = ctx->opus_buffer_size;
                break;
            }
            
            /* Skip this old frame */
            *ctx->opus_read_pos += OPUS_FRAME_HEADER_SIZE + old_frame_size;
            frames_dropped++;
            
            /* Recalculate available space */
            used = *ctx->opus_write_pos - *ctx->opus_read_pos;
            available = ctx->opus_buffer_size - used;
        }
        
        /* Log overflow warning (will be per-occurrence, not rate-limited) */
        if (frames_dropped > 0) {
            fprintf(stderr, "[rdpsnd_bridge] WARNING: Buffer overflow, dropped %d frames\n",
                    frames_dropped);
        }
    }
    
    /* Write frame header (2-byte little-endian size) */
    size_t write_pos = *ctx->opus_write_pos % ctx->opus_buffer_size;
    ctx->opus_buffer[write_pos] = size & 0xFF;
    write_pos = (write_pos + 1) % ctx->opus_buffer_size;
    ctx->opus_buffer[write_pos] = (size >> 8) & 0xFF;
    write_pos = (write_pos + 1) % ctx->opus_buffer_size;
    
    /* Write Opus frame data (handle wrap-around) */
    size_t first_chunk = ctx->opus_buffer_size - write_pos;
    if (first_chunk >= (size_t)size) {
        memcpy(ctx->opus_buffer + write_pos, data, size);
    } else {
        memcpy(ctx->opus_buffer + write_pos, data, first_chunk);
        memcpy(ctx->opus_buffer, data + first_chunk, size - first_chunk);
    }
    
    *ctx->opus_write_pos += total_size;
    
    pthread_mutex_unlock(ctx->opus_mutex);
}

/* ============================================================================
 * RDPSND Device Plugin Callbacks
 * ============================================================================ */

static BOOL rdpsnd_bridge_format_supported(rdpsndDevicePlugin* device,
                                           const AUDIO_FORMAT* format)
{
    (void)device; /* Unused */
    
    if (!format)
        return FALSE;
    
    /* Accept PCM formats that we can encode to Opus.
     * Opus only supports: 8000, 12000, 16000, 24000, 48000 Hz.
     * We also accept 44100 Hz and resample to 48000 Hz. */
    switch (format->wFormatTag) {
        case WAVE_FORMAT_PCM:
            /* Accept Opus-native rates plus 44100 (will be resampled to 48000) */
            if (format->nSamplesPerSec == 48000 ||
                format->nSamplesPerSec == 44100 ||
                format->nSamplesPerSec == 24000 ||
                format->nSamplesPerSec == 16000 ||
                format->nSamplesPerSec == 12000 ||
                format->nSamplesPerSec == 8000) {
                /* Support mono and stereo, 16-bit */
                if ((format->nChannels == 1 || format->nChannels == 2) &&
                    format->wBitsPerSample == 16) {
                    return TRUE;
                }
            }
            break;
        default:
            break;
    }
    
    return FALSE;
}

static BOOL rdpsnd_bridge_open(rdpsndDevicePlugin* device,
                               const AUDIO_FORMAT* format, UINT32 latency)
{
    rdpsndBridgePlugin* bridge = (rdpsndBridgePlugin*)device;
    int error;
    
    if (!bridge || !format)
        return FALSE;
    
    /* Store format info */
    bridge->format = *format;
    bridge->latency = latency;
    
    /* Get audio context - first check thread-local, then try to fetch from rdp_bridge.so.
     * IMPORTANT: We COPY the context values at Open time, not just store a pointer,
     * because the global g_audio_ctx is reused for each connecting session. */
    AudioContext* src_ctx = g_current_audio_ctx;
    if (!src_ctx) {
        /* Try to get context from rdp_bridge.so via dlsym */
        typedef void* (*get_ctx_fn)(void);
        get_ctx_fn get_ctx = (get_ctx_fn)dlsym(RTLD_DEFAULT, "rdp_get_current_audio_context");
        if (get_ctx) {
            src_ctx = (AudioContext*)get_ctx();
        }
    }
    
    if (!src_ctx) {
        fprintf(stderr, "[rdpsnd_bridge] ERROR: No audio context available!\n");
        return FALSE;
    }
    
    if (!src_ctx->opus_buffer) {
        fprintf(stderr, "[rdpsnd_bridge] ERROR: Audio context has no buffer!\n");
        return FALSE;
    }
    
    /* Allocate our own copy of the audio context to store session-specific pointers */
    bridge->audio_ctx = malloc(sizeof(AudioContext));
    if (!bridge->audio_ctx) {
        fprintf(stderr, "[rdpsnd_bridge] ERROR: Failed to allocate audio context copy!\n");
        return FALSE;
    }
    
    /* Copy the context values - this captures the session's buffer pointers */
    bridge->audio_ctx->opus_buffer = src_ctx->opus_buffer;
    bridge->audio_ctx->opus_buffer_size = src_ctx->opus_buffer_size;
    bridge->audio_ctx->opus_write_pos = src_ctx->opus_write_pos;
    bridge->audio_ctx->opus_read_pos = src_ctx->opus_read_pos;
    bridge->audio_ctx->opus_mutex = src_ctx->opus_mutex;
    bridge->audio_ctx->sample_rate = src_ctx->sample_rate;
    bridge->audio_ctx->channels = src_ctx->channels;
    bridge->audio_ctx->initialized = src_ctx->initialized;
    
    /* Store input sample rate and check if resampling is needed */
    bridge->input_sample_rate = format->nSamplesPerSec;
    bridge->needs_resample = (format->nSamplesPerSec != OPUS_SAMPLE_RATE);
    bridge->resample_pos = 0.0;
    
    /* Calculate samples per Opus frame at 48kHz (Opus always operates at 48kHz internally) */
    bridge->pcm_frame_samples = (OPUS_SAMPLE_RATE * OPUS_FRAME_DURATION_MS) / 1000; /* 960 samples at 48kHz */
    
    /* Allocate resample buffer if needed */
    if (bridge->needs_resample) {
        /* Buffer size for resampled output - enough for one Opus frame */
        bridge->resample_buffer_size = bridge->pcm_frame_samples;
        bridge->resample_buffer = malloc(bridge->resample_buffer_size * format->nChannels * sizeof(int16_t));
        if (!bridge->resample_buffer) {
            fprintf(stderr, "[rdpsnd_bridge] Failed to allocate resample buffer\n");
            return FALSE;
        }
    } else {
        bridge->resample_buffer = NULL;
    }
    
    /* Create Opus encoder at 48kHz (required by Opus) */
    bridge->encoder = opus_encoder_create(
        OPUS_SAMPLE_RATE,
        format->nChannels,
        OPUS_APPLICATION_AUDIO,
        &error
    );
    
    if (error != OPUS_OK || !bridge->encoder) {
        fprintf(stderr, "[rdpsnd_bridge] Failed to create Opus encoder: %s\n",
                opus_strerror(error));
        return FALSE;
    }
    
    /* Configure encoder for low latency */
    opus_encoder_ctl(bridge->encoder, OPUS_SET_BITRATE(64000)); /* 64 kbps */
    opus_encoder_ctl(bridge->encoder, OPUS_SET_COMPLEXITY(5)); /* Balance quality/CPU */
    opus_encoder_ctl(bridge->encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_MUSIC));
    
    /* Allocate output buffer for Opus frames */
    bridge->opus_output_size = MAX_OPUS_FRAME_SIZE;
    bridge->opus_output = malloc(bridge->opus_output_size);
    if (!bridge->opus_output) {
        opus_encoder_destroy(bridge->encoder);
        bridge->encoder = NULL;
        return FALSE;
    }
    
    /* Allocate PCM accumulation buffer at 48kHz */
    size_t pcm_buffer_size = bridge->pcm_frame_samples * format->nChannels * sizeof(int16_t);
    bridge->pcm_buffer = malloc(pcm_buffer_size);
    if (!bridge->pcm_buffer) {
        free(bridge->opus_output);
        bridge->opus_output = NULL;
        if (bridge->resample_buffer) free(bridge->resample_buffer);
        bridge->resample_buffer = NULL;
        opus_encoder_destroy(bridge->encoder);
        bridge->encoder = NULL;
        return FALSE;
    }
    bridge->pcm_buffer_samples = 0;
    
    /* Update audio context format - report 48kHz since that's what Opus outputs
     * Note: initialized is a POINTER to the BridgeContext field */
    bridge->audio_ctx->sample_rate = OPUS_SAMPLE_RATE;
    bridge->audio_ctx->channels = format->nChannels;
    if (bridge->audio_ctx->initialized) {
        *bridge->audio_ctx->initialized = 1;
    }
    
    bridge->opened = TRUE;
    
    fprintf(stderr, "[rdpsnd_bridge] Initialized: %uHz -> 48kHz, %uch\n",
            format->nSamplesPerSec, format->nChannels);
    
    return TRUE;
}

static UINT rdpsnd_bridge_play(rdpsndDevicePlugin* device,
                               const BYTE* data, size_t size)
{
    rdpsndBridgePlugin* bridge = (rdpsndBridgePlugin*)device;
    
    if (!bridge || !bridge->opened || !data || size == 0)
        return CHANNEL_RC_OK;
    
    if (!bridge->encoder || !bridge->audio_ctx)
        return CHANNEL_RC_OK;
    
    const int16_t* pcm_input = (const int16_t*)data;
    size_t input_samples = size / (bridge->format.nChannels * sizeof(int16_t));
    int channels = bridge->format.nChannels;
    
    if (bridge->needs_resample) {
        /* Resample from input rate to 48kHz using linear interpolation */
        double ratio = (double)OPUS_SAMPLE_RATE / (double)bridge->input_sample_rate;
        size_t i = 0;
        
        while (i < input_samples) {
            /* Calculate how many output samples we can produce */
            while (bridge->resample_pos < (double)input_samples && 
                   bridge->pcm_buffer_samples < bridge->pcm_frame_samples) {
                
                size_t idx = (size_t)bridge->resample_pos;
                double frac = bridge->resample_pos - (double)idx;
                
                if (idx + 1 < input_samples) {
                    /* Linear interpolation between samples */
                    for (int c = 0; c < channels; c++) {
                        int32_t s0 = pcm_input[idx * channels + c];
                        int32_t s1 = pcm_input[(idx + 1) * channels + c];
                        int32_t interpolated = (int32_t)(s0 + frac * (s1 - s0));
                        bridge->pcm_buffer[bridge->pcm_buffer_samples * channels + c] = 
                            (int16_t)interpolated;
                    }
                } else {
                    /* Last sample - no interpolation */
                    for (int c = 0; c < channels; c++) {
                        bridge->pcm_buffer[bridge->pcm_buffer_samples * channels + c] = 
                            pcm_input[idx * channels + c];
                    }
                }
                
                bridge->pcm_buffer_samples++;
                bridge->resample_pos += 1.0 / ratio; /* Advance in input samples */
                
                /* Encode when we have a full frame */
                if (bridge->pcm_buffer_samples >= bridge->pcm_frame_samples) {
                    int encoded_bytes = opus_encode(
                        bridge->encoder,
                        bridge->pcm_buffer,
                        (int)bridge->pcm_frame_samples,
                        bridge->opus_output,
                        bridge->opus_output_size
                    );
                    
                    if (encoded_bytes > 0) {
                        write_opus_frame(bridge->audio_ctx, bridge->opus_output, encoded_bytes);
                    } else if (encoded_bytes < 0) {
                        fprintf(stderr, "[rdpsnd_bridge] Opus encode error: %s\n",
                                opus_strerror(encoded_bytes));
                    }
                    
                    bridge->pcm_buffer_samples = 0;
                }
            }
            
            /* Adjust position for next call */
            bridge->resample_pos -= (double)input_samples;
            if (bridge->resample_pos < 0) bridge->resample_pos = 0;
            break;
        }
    } else {
        /* No resampling needed - direct copy */
        size_t samples_consumed = 0;
        
        while (samples_consumed < input_samples) {
            size_t samples_needed = bridge->pcm_frame_samples - bridge->pcm_buffer_samples;
            size_t samples_available = input_samples - samples_consumed;
            size_t samples_to_copy = (samples_available < samples_needed) ? samples_available : samples_needed;
            
            memcpy(
                bridge->pcm_buffer + bridge->pcm_buffer_samples * channels,
                pcm_input + samples_consumed * channels,
                samples_to_copy * channels * sizeof(int16_t)
            );
            
            bridge->pcm_buffer_samples += samples_to_copy;
            samples_consumed += samples_to_copy;
            
            /* Encode when we have a full frame */
            if (bridge->pcm_buffer_samples >= bridge->pcm_frame_samples) {
                int encoded_bytes = opus_encode(
                    bridge->encoder,
                    bridge->pcm_buffer,
                    (int)bridge->pcm_frame_samples,
                    bridge->opus_output,
                    bridge->opus_output_size
                );
                
                if (encoded_bytes > 0) {
                    write_opus_frame(bridge->audio_ctx, bridge->opus_output, encoded_bytes);
                } else if (encoded_bytes < 0) {
                    fprintf(stderr, "[rdpsnd_bridge] Opus encode error: %s\n",
                            opus_strerror(encoded_bytes));
                }
                
                bridge->pcm_buffer_samples = 0;
            }
        }
    }
    
    return CHANNEL_RC_OK;
}

static void rdpsnd_bridge_close(rdpsndDevicePlugin* device)
{
    rdpsndBridgePlugin* bridge = (rdpsndBridgePlugin*)device;
    
    if (!bridge)
        return;
    
    bridge->opened = FALSE;
    
    /* Only log once on close, not in hot path */
}

static BOOL rdpsnd_bridge_set_volume(rdpsndDevicePlugin* device, UINT32 value)
{
    (void)device;
    (void)value;
    /* Volume control not implemented - Opus stream goes to browser which has its own volume */
    return TRUE;
}

static void rdpsnd_bridge_start(rdpsndDevicePlugin* device)
{
    (void)device;
    /* No-op - playback starts automatically when data arrives */
}

static void rdpsnd_bridge_free(rdpsndDevicePlugin* device)
{
    rdpsndBridgePlugin* bridge = (rdpsndBridgePlugin*)device;
    
    if (!bridge)
        return;
    
    if (bridge->encoder) {
        opus_encoder_destroy(bridge->encoder);
        bridge->encoder = NULL;
    }
    
    if (bridge->opus_output) {
        free(bridge->opus_output);
        bridge->opus_output = NULL;
    }
    
    if (bridge->pcm_buffer) {
        free(bridge->pcm_buffer);
        bridge->pcm_buffer = NULL;
    }
    
    if (bridge->resample_buffer) {
        free(bridge->resample_buffer);
        bridge->resample_buffer = NULL;
    }
    
    /* Free session-specific audio context copy (not the buffer itself) */
    if (bridge->audio_ctx) {
        free(bridge->audio_ctx);
        bridge->audio_ctx = NULL;
    }
    
    free(bridge);
}

/* ============================================================================
 * Plugin Entry Point
 * 
 * This is called by FreeRDP when loading the rdpsnd device plugin.
 * The function name MUST be: freerdp_rdpsnd_client_subsystem_entry
 * ============================================================================ */

#define RDPSND_DEVICE_EXPORT_FUNC_NAME "freerdp_rdpsnd_client_subsystem_entry"

__attribute__((visibility("default")))
FREERDP_ENTRY_POINT(UINT VCAPITYPE freerdp_rdpsnd_client_subsystem_entry(
    PFREERDP_RDPSND_DEVICE_ENTRY_POINTS pEntryPoints))
{
    rdpsndBridgePlugin* bridge;
    
    bridge = (rdpsndBridgePlugin*)calloc(1, sizeof(rdpsndBridgePlugin));
    if (!bridge) {
        fprintf(stderr, "[rdpsnd_bridge] Failed to allocate plugin\n");
        return ERROR_OUTOFMEMORY;
    }
    
    /* Set up device callbacks */
    bridge->device.FormatSupported = rdpsnd_bridge_format_supported;
    bridge->device.Open = rdpsnd_bridge_open;
    bridge->device.Play = rdpsnd_bridge_play;
    bridge->device.SetVolume = rdpsnd_bridge_set_volume;
    bridge->device.Start = rdpsnd_bridge_start;
    bridge->device.Close = rdpsnd_bridge_close;
    bridge->device.Free = rdpsnd_bridge_free;
    
    /* Register with rdpsnd */
    pEntryPoints->pRegisterRdpsndDevice(pEntryPoints->rdpsnd, &bridge->device);
    
    return CHANNEL_RC_OK;
}
