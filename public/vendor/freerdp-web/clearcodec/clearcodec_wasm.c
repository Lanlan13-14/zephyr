/**
 * ClearCodec WASM Decoder
 * 
 * Standalone ClearCodec decoder for WebAssembly execution in browsers.
 * Based on FreeRDP's ClearCodec implementation (Apache 2.0 License).
 * 
 * Copyright 2014 Marc-Andre Moreau <marcandre.moreau@gmail.com>
 * Copyright 2016 Armin Novak <armin.novak@thincast.com>
 * Copyright 2016 Thincast Technologies GmbH
 * Adption by Marco Weber <https://github.com/qxsch>
 * 
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================================
 * Constants matching FreeRDP clear.c
 * ============================================================================ */

#define CLEARCODEC_FLAG_GLYPH_INDEX 0x01
#define CLEARCODEC_FLAG_GLYPH_HIT   0x02
#define CLEARCODEC_FLAG_CACHE_RESET 0x04

#define CLEARCODEC_VBAR_SIZE        32768
#define CLEARCODEC_VBAR_SHORT_SIZE  16384
#define CLEARCODEC_GLYPH_CACHE_SIZE 4000

/* Log2 floor lookup table - matching FreeRDP exactly */
static const uint32_t CLEAR_LOG2_FLOOR[256] = {
    0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
};

/* 8-bit masks for RLEX decoding */
static const uint8_t CLEAR_8BIT_MASKS[9] = { 0x00, 0x01, 0x03, 0x07, 0x0F, 0x1F, 0x3F, 0x7F, 0xFF };

/* Output format: RGBA (byte order for web) */
#define BYTES_PER_PIXEL 4

/* ============================================================================
 * Cache structures - matching FreeRDP exactly
 * ============================================================================ */

typedef struct {
    uint32_t size;     /* Allocated size in pixels */
    uint32_t count;    /* Current count of pixels */
    uint32_t* pixels;  /* RGBA pixel data */
} ClearGlyphEntry;

typedef struct {
    uint32_t size;     /* Allocated size in bytes */
    uint32_t count;    /* Current count of pixels */
    uint8_t* pixels;   /* RGBA pixel data (4 bytes per pixel) */
} ClearVBarEntry;

/* ============================================================================
 * ClearCodec context - session-level state
 * ============================================================================ */

typedef struct {
    /* Sequence number for ordering */
    uint32_t seqNumber;
    
    /* Temporary decode buffer */
    uint8_t* tempBuffer;
    uint32_t tempSize;
    
    /* Glyph cache (4000 entries per spec) */
    ClearGlyphEntry glyphCache[CLEARCODEC_GLYPH_CACHE_SIZE];
    
    /* VBar storage (32768 entries) */
    uint32_t vBarStorageCursor;
    ClearVBarEntry vBarStorage[CLEARCODEC_VBAR_SIZE];
    
    /* Short VBar storage (16384 entries) */
    uint32_t shortVBarStorageCursor;
    ClearVBarEntry shortVBarStorage[CLEARCODEC_VBAR_SHORT_SIZE];
} ClearContext;

/* ============================================================================
 * Stream reading utilities
 * ============================================================================ */

typedef struct {
    const uint8_t* data;
    size_t size;
    size_t pos;
} Stream;

static inline bool stream_check(const Stream* s, size_t required) {
    return (s->pos + required) <= s->size;
}

static inline uint8_t stream_read_u8(Stream* s) {
    return s->data[s->pos++];
}

static inline uint16_t stream_read_u16(Stream* s) {
    uint16_t v = s->data[s->pos] | ((uint16_t)s->data[s->pos + 1] << 8);
    s->pos += 2;
    return v;
}

static inline uint32_t stream_read_u32(Stream* s) {
    uint32_t v = s->data[s->pos] | 
                 ((uint32_t)s->data[s->pos + 1] << 8) |
                 ((uint32_t)s->data[s->pos + 2] << 16) |
                 ((uint32_t)s->data[s->pos + 3] << 24);
    s->pos += 4;
    return v;
}

static inline size_t stream_remaining(const Stream* s) {
    return s->size - s->pos;
}

/* ============================================================================
 * Color utilities - output is RGBA for web
 * ============================================================================ */

static inline uint32_t make_rgba(uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    /* RGBA byte order for web ImageData */
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | ((uint32_t)a << 24);
}

static inline void write_rgba_pixel(uint8_t* dst, uint32_t color) {
    dst[0] = (uint8_t)(color & 0xFF);         /* R */
    dst[1] = (uint8_t)((color >> 8) & 0xFF);  /* G */
    dst[2] = (uint8_t)((color >> 16) & 0xFF); /* B */
    dst[3] = (uint8_t)((color >> 24) & 0xFF); /* A */
}

static inline uint32_t read_rgba_pixel(const uint8_t* src) {
    return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | 
           ((uint32_t)src[2] << 16) | ((uint32_t)src[3] << 24);
}

/* ============================================================================
 * Cache management - matching FreeRDP exactly
 * ============================================================================ */

static void clear_reset_vbar_storage(ClearContext* ctx, bool freeMemory) {
    if (freeMemory) {
        for (size_t i = 0; i < CLEARCODEC_VBAR_SIZE; i++) {
            free(ctx->vBarStorage[i].pixels);
            ctx->vBarStorage[i].pixels = NULL;
            ctx->vBarStorage[i].size = 0;
            ctx->vBarStorage[i].count = 0;
        }
    }
    ctx->vBarStorageCursor = 0;
    
    if (freeMemory) {
        for (size_t i = 0; i < CLEARCODEC_VBAR_SHORT_SIZE; i++) {
            free(ctx->shortVBarStorage[i].pixels);
            ctx->shortVBarStorage[i].pixels = NULL;
            ctx->shortVBarStorage[i].size = 0;
            ctx->shortVBarStorage[i].count = 0;
        }
    }
    ctx->shortVBarStorageCursor = 0;
}

static void clear_reset_glyph_cache(ClearContext* ctx) {
    for (size_t i = 0; i < CLEARCODEC_GLYPH_CACHE_SIZE; i++) {
        free(ctx->glyphCache[i].pixels);
        ctx->glyphCache[i].pixels = NULL;
        ctx->glyphCache[i].size = 0;
        ctx->glyphCache[i].count = 0;
    }
}

static bool resize_vbar_entry(ClearVBarEntry* entry) {
    if (entry->count > entry->size) {
        const uint32_t oldBytes = entry->size * BYTES_PER_PIXEL;
        const uint32_t newBytes = entry->count * BYTES_PER_PIXEL;
        
        uint8_t* tmp = (uint8_t*)realloc(entry->pixels, newBytes);
        if (!tmp) {
            return false;
        }
        
        /* Zero-init new memory */
        memset(tmp + oldBytes, 0, newBytes - oldBytes);
        entry->pixels = tmp;
        entry->size = entry->count;
    }
    
    if (!entry->pixels && entry->size > 0) {
        return false;
    }
    
    return true;
}

static bool resize_temp_buffer(ClearContext* ctx, uint32_t width, uint32_t height) {
    uint32_t size = (width + 16) * (height + 16) * BYTES_PER_PIXEL;
    
    if (size > ctx->tempSize) {
        uint8_t* tmp = (uint8_t*)realloc(ctx->tempBuffer, size);
        if (!tmp) {
            return false;
        }
        memset(tmp, 0, size);
        ctx->tempBuffer = tmp;
        ctx->tempSize = size;
    }
    
    return true;
}

/* ============================================================================
 * RLEX subcodec decoder - matching FreeRDP exactly
 * ============================================================================ */

static bool clear_decompress_subcode_rlex(
    Stream* s, uint32_t bitmapDataByteCount,
    uint32_t width, uint32_t height,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDstRel, uint32_t nYDstRel,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    uint32_t x = 0, y = 0;
    uint32_t pixelIndex = 0;
    uint32_t pixelCount = width * height;
    uint32_t bitmapDataOffset = 0;
    uint8_t paletteCount;
    uint32_t palette[128] = {0};
    
    if (!stream_check(s, bitmapDataByteCount)) return false;
    if (!stream_check(s, 1)) return false;
    
    paletteCount = stream_read_u8(s);
    bitmapDataOffset = 1 + (paletteCount * 3);
    
    if (paletteCount > 127 || paletteCount < 1) {
        return false;
    }
    
    if (!stream_check(s, paletteCount * 3)) return false;
    
    /* Read palette - wire format is BGR */
    for (uint32_t i = 0; i < paletteCount; i++) {
        uint8_t b = stream_read_u8(s);
        uint8_t g = stream_read_u8(s);
        uint8_t r = stream_read_u8(s);
        palette[i] = make_rgba(r, g, b, 0xFF);
    }
    
    uint32_t numBits = CLEAR_LOG2_FLOOR[paletteCount - 1] + 1;
    
    while (bitmapDataOffset < bitmapDataByteCount) {
        uint8_t tmp;
        uint32_t runLengthFactor;
        uint8_t suiteDepth, stopIndex, startIndex, suiteIndex;
        uint32_t color;
        
        if (!stream_check(s, 2)) return false;
        
        tmp = stream_read_u8(s);
        runLengthFactor = stream_read_u8(s);
        bitmapDataOffset += 2;
        
        suiteDepth = (tmp >> numBits) & CLEAR_8BIT_MASKS[8 - numBits];
        stopIndex = tmp & CLEAR_8BIT_MASKS[numBits];
        startIndex = stopIndex - suiteDepth;
        
        if (runLengthFactor >= 0xFF) {
            if (!stream_check(s, 2)) return false;
            runLengthFactor = stream_read_u16(s);
            bitmapDataOffset += 2;
            
            if (runLengthFactor >= 0xFFFF) {
                if (!stream_check(s, 4)) return false;
                runLengthFactor = stream_read_u32(s);
                bitmapDataOffset += 4;
            }
        }
        
        if (startIndex >= paletteCount) {
            return false;
        }
        
        if (stopIndex >= paletteCount) {
            return false;
        }
        
        suiteIndex = startIndex;
        
        if (suiteIndex > 127) {
            return false;
        }
        
        color = palette[suiteIndex];
        
        if (pixelIndex + runLengthFactor > pixelCount) {
            return false;
        }
        
        /* Write run-length pixels */
        for (uint32_t i = 0; i < runLengthFactor; i++) {
            if ((nXDstRel + x < nDstWidth) && (nYDstRel + y < nDstHeight)) {
                uint8_t* pTmpData = &pDstData[(nXDstRel + x) * BYTES_PER_PIXEL + 
                                              (nYDstRel + y) * nDstStep];
                write_rgba_pixel(pTmpData, color);
            }
            
            if (++x >= width) {
                y++;
                x = 0;
            }
        }
        
        pixelIndex += runLengthFactor;
        
        if (pixelIndex + (suiteDepth + 1) > pixelCount) {
            return false;
        }
        
        /* Write suite pixels */
        for (uint32_t i = 0; i <= suiteDepth; i++) {
            if (suiteIndex > 127) {
                return false;
            }
            
            uint32_t ccolor = palette[suiteIndex];
            suiteIndex++;
            
            if ((nXDstRel + x < nDstWidth) && (nYDstRel + y < nDstHeight)) {
                uint8_t* pTmpData = &pDstData[(nXDstRel + x) * BYTES_PER_PIXEL +
                                              (nYDstRel + y) * nDstStep];
                write_rgba_pixel(pTmpData, ccolor);
            }
            
            if (++x >= width) {
                y++;
                x = 0;
            }
        }
        
        pixelIndex += (suiteDepth + 1);
    }
    
    if (pixelIndex != pixelCount) {
        return false;
    }
    
    return true;
}

/* ============================================================================
 * Residual data decoder - matching FreeRDP exactly
 * ============================================================================ */

static bool clear_decompress_residual_data(
    ClearContext* ctx, Stream* s,
    uint32_t residualByteCount,
    uint32_t nWidth, uint32_t nHeight,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDst, uint32_t nYDst,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    uint32_t suboffset = 0;
    uint32_t pixelIndex = 0;
    uint32_t pixelCount = nWidth * nHeight;
    
    if (!stream_check(s, residualByteCount)) return false;
    
    if (!resize_temp_buffer(ctx, nWidth, nHeight)) return false;
    
    uint8_t* dstBuffer = ctx->tempBuffer;
    
    while (suboffset < residualByteCount) {
        uint8_t b, g, r;
        uint32_t runLengthFactor;
        uint32_t color;
        
        if (!stream_check(s, 4)) return false;
        
        b = stream_read_u8(s);
        g = stream_read_u8(s);
        r = stream_read_u8(s);
        runLengthFactor = stream_read_u8(s);
        suboffset += 4;
        
        color = make_rgba(r, g, b, 0xFF);
        
        if (runLengthFactor >= 0xFF) {
            if (!stream_check(s, 2)) return false;
            runLengthFactor = stream_read_u16(s);
            suboffset += 2;
            
            if (runLengthFactor >= 0xFFFF) {
                if (!stream_check(s, 4)) return false;
                runLengthFactor = stream_read_u32(s);
                suboffset += 4;
            }
        }
        
        if (pixelIndex >= pixelCount || runLengthFactor > (pixelCount - pixelIndex)) {
            return false;
        }
        
        for (uint32_t i = 0; i < runLengthFactor; i++) {
            write_rgba_pixel(dstBuffer, color);
            dstBuffer += BYTES_PER_PIXEL;
        }
        
        pixelIndex += runLengthFactor;
    }
    
    if (pixelIndex != pixelCount) {
        return false;
    }
    
    /* Copy temp buffer to destination */
    uint32_t nSrcStep = nWidth * BYTES_PER_PIXEL;
    for (uint32_t y = 0; y < nHeight; y++) {
        if (nYDst + y >= nDstHeight) break;
        
        uint32_t copyWidth = nWidth;
        if (nXDst + copyWidth > nDstWidth) {
            copyWidth = nDstWidth - nXDst;
        }
        
        uint8_t* dst = &pDstData[(nYDst + y) * nDstStep + nXDst * BYTES_PER_PIXEL];
        uint8_t* src = &ctx->tempBuffer[y * nSrcStep];
        memcpy(dst, src, copyWidth * BYTES_PER_PIXEL);
    }
    
    return true;
}

/* ============================================================================
 * NSCodec decoder - matching FreeRDP nsc.c
 * 
 * NSCodec uses YCoCg color space with optional chroma subsampling.
 * Data format:
 *   - 4x UINT32: PlaneByteCount[0..3] (Y, Co, Cg, A planes)
 *   - UINT8: ColorLossLevel (1-7, shifts for color recovery)
 *   - UINT8: ChromaSubsamplingLevel (0 = none, 1 = 4:2:0)
 *   - 2 bytes: Reserved
 *   - Plane data (may be RLE compressed if PlaneByteCount < original)
 * ============================================================================ */

/* NSCodec RLE decompression */
static bool nsc_rle_decode(const uint8_t* in, size_t inSize, uint8_t* out,
                           uint32_t outSize, uint32_t originalSize)
{
    uint32_t left = originalSize;
    size_t inPos = 0;
    size_t outPos = 0;
    
    while (left > 4) {
        if (inPos >= inSize) return false;
        
        uint8_t value = in[inPos++];
        uint32_t len = 0;
        
        if (left == 5) {
            if (outPos >= outSize) return false;
            out[outPos++] = value;
            left--;
        } else if (inPos >= inSize) {
            return false;
        } else if (value == in[inPos]) {
            inPos++;
            
            if (inPos >= inSize) return false;
            
            if (in[inPos] < 0xFF) {
                len = in[inPos++];
                len += 2;
            } else {
                if (inPos + 5 > inSize) return false;
                inPos++; /* skip 0xFF marker */
                len = ((uint32_t)(in[inPos]));
                len |= ((uint32_t)(in[inPos + 1])) << 8;
                len |= ((uint32_t)(in[inPos + 2])) << 16;
                len |= ((uint32_t)(in[inPos + 3])) << 24;
                inPos += 4;
            }
            
            if ((outPos + len > outSize) || (left < len)) return false;
            
            memset(out + outPos, value, len);
            outPos += len;
            left -= len;
        } else {
            if (outPos >= outSize) return false;
            out[outPos++] = value;
            left--;
        }
    }
    
    if ((outPos + 4 > outSize) || (left < 4)) return false;
    if (inPos + 4 > inSize) return false;
    
    memcpy(out + outPos, in + inPos, 4);
    return true;
}

#define ROUND_UP_TO_8(x) (((x) + 7) & ~7)
#define ROUND_UP_TO_2(x) (((x) + 1) & ~1)

static inline int clamp_byte(int val) {
    if (val < 0) return 0;
    if (val > 255) return 255;
    return val;
}

/* NSCodec decoder for ClearCodec subcodec */
static bool clear_decompress_nscodec(
    Stream* s, uint32_t dataByteCount,
    uint32_t width, uint32_t height,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDstRel, uint32_t nYDstRel,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    /* Save stream position to track bytes consumed */
    size_t startPos = s->pos;
    
    /* Read NSCodec header */
    if (dataByteCount < 20) {
        return false;
    }
    
    if (!stream_check(s, 20)) return false;
    
    uint32_t planeByteCount[4];
    planeByteCount[0] = stream_read_u32(s);  /* Y plane */
    planeByteCount[1] = stream_read_u32(s);  /* Co plane */
    planeByteCount[2] = stream_read_u32(s);  /* Cg plane */
    planeByteCount[3] = stream_read_u32(s);  /* A plane */
    
    uint8_t colorLossLevel = stream_read_u8(s);
    uint8_t chromaSubsamplingLevel = stream_read_u8(s);
    stream_read_u16(s);  /* Reserved */
    
    if (colorLossLevel < 1 || colorLossLevel > 7) {
        return false;
    }
    
    uint8_t shift = colorLossLevel - 1;  /* Color recovery shift */
    
    /* Calculate total plane data size */
    size_t totalPlaneBytes = 0;
    for (int i = 0; i < 4; i++) {
        totalPlaneBytes += planeByteCount[i];
    }
    
    if (totalPlaneBytes > dataByteCount - 20) {
        return false;
    }
    
    if (!stream_check(s, totalPlaneBytes)) return false;
    
    const uint8_t* planeData = s->data + s->pos;
    
    /* Calculate plane dimensions */
    uint32_t tempWidth = ROUND_UP_TO_8(width);
    uint32_t tempHeight = ROUND_UP_TO_2(height);
    
    /* Calculate original plane sizes */
    uint32_t orgByteCount[4];
    if (chromaSubsamplingLevel) {
        orgByteCount[0] = tempWidth * height;       /* Y uses full width (rounded to 8) */
        orgByteCount[1] = (tempWidth >> 1) * (tempHeight >> 1);  /* Co 4:2:0 */
        orgByteCount[2] = orgByteCount[1];          /* Cg 4:2:0 */
        orgByteCount[3] = width * height;           /* A uses actual dimensions */
    } else {
        orgByteCount[0] = width * height;
        orgByteCount[1] = width * height;
        orgByteCount[2] = width * height;
        orgByteCount[3] = width * height;
    }
    
    /* Find max buffer size needed */
    uint32_t maxPlaneSize = 0;
    for (int i = 0; i < 4; i++) {
        if (orgByteCount[i] > maxPlaneSize) maxPlaneSize = orgByteCount[i];
    }
    
    /* Allocate plane buffers */
    uint8_t* planeBuffers[4] = {NULL, NULL, NULL, NULL};
    for (int i = 0; i < 4; i++) {
        planeBuffers[i] = (uint8_t*)malloc(maxPlaneSize);
        if (!planeBuffers[i]) {
            for (int j = 0; j < i; j++) free(planeBuffers[j]);
            return false;
        }
    }
    
    /* Decompress planes */
    const uint8_t* rle = planeData;
    size_t rleSize = totalPlaneBytes;
    
    for (int i = 0; i < 4; i++) {
        uint32_t origSize = orgByteCount[i];
        uint32_t compSize = planeByteCount[i];
        
        if (compSize == 0) {
            /* Empty plane - fill with 0xFF */
            memset(planeBuffers[i], 0xFF, origSize);
        } else if (compSize < origSize) {
            /* RLE compressed */
            if (!nsc_rle_decode(rle, rleSize, planeBuffers[i], maxPlaneSize, origSize)) {
                for (int j = 0; j < 4; j++) free(planeBuffers[j]);
                return false;
            }
        } else {
            /* Uncompressed - copy directly */
            if (rleSize < origSize) {
                for (int j = 0; j < 4; j++) free(planeBuffers[j]);
                return false;
            }
            memcpy(planeBuffers[i], rle, origSize);
        }
        
        rle += compSize;
        rleSize -= compSize;
    }
    
    /* YCoCg to RGB conversion and write to destination */
    /* Match FreeRDP exactly: Y plane uses tempWidth stride with chroma subsampling */
    
    for (uint32_t y = 0; y < height; y++) {
        if (nYDstRel + y >= nDstHeight) break;
        
        const uint8_t* yplane;
        const uint8_t* coplane;
        const uint8_t* cgplane;
        const uint8_t* aplane = planeBuffers[3] + y * width;
        
        if (chromaSubsamplingLevel) {
            /* With chroma subsampling: Y uses tempWidth stride, Co/Cg are subsampled */
            yplane = planeBuffers[0] + y * tempWidth;
            coplane = planeBuffers[1] + (y >> 1) * (tempWidth >> 1);
            cgplane = planeBuffers[2] + (y >> 1) * (tempWidth >> 1);
        } else {
            yplane = planeBuffers[0] + y * width;
            coplane = planeBuffers[1] + y * width;
            cgplane = planeBuffers[2] + y * width;
        }
        
        for (uint32_t x = 0; x < width; x++) {
            if (nXDstRel + x >= nDstWidth) break;
            
            /* Read Y value directly */
            int16_t y_val = (int16_t)yplane[x];
            
            /* For Co/Cg with chroma subsampling, use x >> 1 to get subsampled index */
            uint32_t chromaX = chromaSubsamplingLevel ? (x >> 1) : x;
            
            /* Apply shift for color loss recovery - cast to int8_t for sign extension */
            int16_t co_val = (int16_t)(int8_t)(((int16_t)coplane[chromaX]) << shift);
            int16_t cg_val = (int16_t)(int8_t)(((int16_t)cgplane[chromaX]) << shift);
            
            /* YCoCg to RGB conversion */
            int16_t r_val = y_val + co_val - cg_val;
            int16_t g_val = y_val + cg_val;
            int16_t b_val = y_val - co_val - cg_val;
            
            uint8_t r = (uint8_t)clamp_byte(r_val);
            uint8_t g = (uint8_t)clamp_byte(g_val);
            uint8_t b = (uint8_t)clamp_byte(b_val);
            uint8_t a = aplane[x];
            
            uint8_t* dst = &pDstData[(nYDstRel + y) * nDstStep + (nXDstRel + x) * BYTES_PER_PIXEL];
            write_rgba_pixel(dst, make_rgba(r, g, b, a));
        }
    }
    
    /* Cleanup */
    for (int i = 0; i < 4; i++) {
        free(planeBuffers[i]);
    }
    
    /* Seek to end of NSCodec data */
    s->pos = startPos + dataByteCount;
    
    return true;
}

/* ============================================================================
 * Subcodecs data decoder - matching FreeRDP exactly
 * ============================================================================ */

static bool clear_decompress_subcodecs_data(
    ClearContext* ctx, Stream* s,
    uint32_t subcodecByteCount,
    uint32_t nWidth, uint32_t nHeight,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDst, uint32_t nYDst,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    uint32_t suboffset = 0;
    
    if (!stream_check(s, subcodecByteCount)) return false;
    
    while (suboffset < subcodecByteCount) {
        uint16_t xStart, yStart, width, height;
        uint32_t bitmapDataByteCount;
        uint8_t subcodecId;
        
        if (!stream_check(s, 13)) return false;
        
        xStart = stream_read_u16(s);
        yStart = stream_read_u16(s);
        width = stream_read_u16(s);
        height = stream_read_u16(s);
        bitmapDataByteCount = stream_read_u32(s);
        subcodecId = stream_read_u8(s);
        suboffset += 13;
        
        if (!stream_check(s, bitmapDataByteCount)) return false;
        
        uint32_t nXDstRel = nXDst + xStart;
        uint32_t nYDstRel = nYDst + yStart;
        
        if ((uint32_t)xStart + width > nWidth) {
            return false;
        }
        
        if ((uint32_t)yStart + height > nHeight) {
            return false;
        }
        
        if (!resize_temp_buffer(ctx, width, height)) return false;
        
        switch (subcodecId) {
            case 0: {
                /* Uncompressed BGR24 */
                uint32_t nSrcStep = width * 3;
                size_t nSrcSize = (size_t)nSrcStep * height;
                
                if (bitmapDataByteCount != nSrcSize) {
                    return false;
                }
                
                /* Convert BGR24 to RGBA and write to destination */
                for (uint32_t y = 0; y < height; y++) {
                    if (nYDstRel + y >= nDstHeight) break;
                    
                    for (uint32_t x = 0; x < width; x++) {
                        if (nXDstRel + x >= nDstWidth) break;
                        
                        uint8_t b = stream_read_u8(s);
                        uint8_t g = stream_read_u8(s);
                        uint8_t r = stream_read_u8(s);
                        
                        uint8_t* dst = &pDstData[(nYDstRel + y) * nDstStep + 
                                                  (nXDstRel + x) * BYTES_PER_PIXEL];
                        write_rgba_pixel(dst, make_rgba(r, g, b, 0xFF));
                    }
                }
                break;
            }
            
            case 1:
                /* NSCodec (YCoCg color space) */
                if (!clear_decompress_nscodec(s, bitmapDataByteCount, width, height,
                        pDstData, nDstStep, nXDstRel, nYDstRel, nDstWidth, nDstHeight)) {
                    return false;
                }
                break;
            
            case 2:
                /* RLEX */
                if (!clear_decompress_subcode_rlex(s, bitmapDataByteCount, width, height,
                        pDstData, nDstStep, nXDstRel, nYDstRel, nDstWidth, nDstHeight)) {
                    return false;
                }
                break;
            
            default:
                return false;
        }
        
        suboffset += bitmapDataByteCount;
    }
    
    return true;
}

/* ============================================================================
 * Bands data decoder - matching FreeRDP exactly
 * ============================================================================ */

static bool clear_decompress_bands_data(
    ClearContext* ctx, Stream* s,
    uint32_t bandsByteCount,
    uint32_t nWidth, uint32_t nHeight,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDst, uint32_t nYDst,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    uint32_t suboffset = 0;
    
    if (!stream_check(s, bandsByteCount)) return false;
    
    while (suboffset < bandsByteCount) {
        uint16_t xStart, xEnd, yStart, yEnd;
        uint8_t cr, cg, cb;
        uint32_t colorBkg;
        uint16_t vBarHeader;
        uint16_t vBarYOn = 0, vBarYOff = 0;
        uint32_t vBarCount;
        uint32_t vBarPixelCount;
        uint32_t vBarShortPixelCount = 0;
        
        if (!stream_check(s, 11)) return false;
        
        xStart = stream_read_u16(s);
        xEnd = stream_read_u16(s);
        yStart = stream_read_u16(s);
        yEnd = stream_read_u16(s);
        cb = stream_read_u8(s);
        cg = stream_read_u8(s);
        cr = stream_read_u8(s);
        suboffset += 11;
        
        colorBkg = make_rgba(cr, cg, cb, 0xFF);
        
        if (xEnd < xStart) {
            return false;
        }
        
        if (yEnd < yStart) {
            return false;
        }
        
        vBarCount = (xEnd - xStart) + 1;
        
        for (uint32_t i = 0; i < vBarCount; i++) {
            ClearVBarEntry* vBarEntry = NULL;
            ClearVBarEntry* vBarShortEntry = NULL;
            bool vBarUpdate = false;
            const uint8_t* cpSrcPixel;
            
            if (!stream_check(s, 2)) return false;
            
            vBarHeader = stream_read_u16(s);
            suboffset += 2;
            
            uint32_t vBarHeight = (yEnd - yStart + 1);
            
            if (vBarHeight > 52) {
                return false;
            }
            
            if ((vBarHeader & 0xC000) == 0x4000) {
                /* SHORT_VBAR_CACHE_HIT */
                uint16_t vBarIndex = vBarHeader & 0x3FFF;
                
                if (vBarIndex >= CLEARCODEC_VBAR_SHORT_SIZE) {
                    return false;
                }
                
                vBarShortEntry = &ctx->shortVBarStorage[vBarIndex];
                
                if (!stream_check(s, 1)) return false;
                vBarYOn = stream_read_u8(s);
                suboffset += 1;
                
                /* Handle empty cache entry - fill with background color */
                if (vBarShortEntry->size == 0) {
                    vBarShortPixelCount = 0;
                } else {
                    vBarShortPixelCount = vBarShortEntry->count;
                }
                vBarUpdate = true;
            }
            else if ((vBarHeader & 0xC000) == 0x0000) {
                /* SHORT_VBAR_CACHE_MISS */
                vBarYOn = vBarHeader & 0xFF;
                vBarYOff = (vBarHeader >> 8) & 0x3F;
                
                if (vBarYOff < vBarYOn) {
                    return false;
                }
                
                vBarShortPixelCount = vBarYOff - vBarYOn;
                
                if (vBarShortPixelCount > 52) {
                    return false;
                }
                
                if (!stream_check(s, vBarShortPixelCount * 3)) return false;
                
                if (ctx->shortVBarStorageCursor >= CLEARCODEC_VBAR_SHORT_SIZE) {
                    return false;
                }
                
                vBarShortEntry = &ctx->shortVBarStorage[ctx->shortVBarStorageCursor];
                vBarShortEntry->count = vBarShortPixelCount;
                
                if (!resize_vbar_entry(vBarShortEntry)) return false;
                
                for (uint32_t y = 0; y < vBarShortPixelCount; y++) {
                    uint8_t b = stream_read_u8(s);
                    uint8_t g = stream_read_u8(s);
                    uint8_t r = stream_read_u8(s);
                    
                    uint32_t color = make_rgba(r, g, b, 0xFF);
                    write_rgba_pixel(&vBarShortEntry->pixels[y * BYTES_PER_PIXEL], color);
                }
                
                suboffset += vBarShortPixelCount * 3;
                ctx->shortVBarStorageCursor = 
                    (ctx->shortVBarStorageCursor + 1) % CLEARCODEC_VBAR_SHORT_SIZE;
                vBarUpdate = true;
            }
            else if ((vBarHeader & 0x8000) == 0x8000) {
                /* VBAR_CACHE_HIT */
                uint16_t vBarIndex = vBarHeader & 0x7FFF;
                
                if (vBarIndex >= CLEARCODEC_VBAR_SIZE) {
                    return false;
                }
                
                vBarEntry = &ctx->vBarStorage[vBarIndex];
                
                /* If cache was reset, fill with dummy data */
                if (vBarEntry->size == 0) {
                    vBarEntry->count = vBarHeight;
                    if (!resize_vbar_entry(vBarEntry)) return false;
                }
            }
            else {
                return false;
            }
            
            if (vBarUpdate) {
                if (ctx->vBarStorageCursor >= CLEARCODEC_VBAR_SIZE) {
                    return false;
                }
                
                vBarEntry = &ctx->vBarStorage[ctx->vBarStorageCursor];
                vBarPixelCount = vBarHeight;
                vBarEntry->count = vBarPixelCount;
                
                if (!resize_vbar_entry(vBarEntry)) return false;
                
                uint8_t* dstBuffer = vBarEntry->pixels;
                
                /* If y < vBarYOn, use colorBkg */
                uint32_t y = 0;
                uint32_t count = vBarYOn;
                
                if (y + count > vBarPixelCount) {
                    count = (vBarPixelCount > y) ? (vBarPixelCount - y) : 0;
                }
                
                for (uint32_t c = 0; c < count; c++) {
                    write_rgba_pixel(dstBuffer, colorBkg);
                    dstBuffer += BYTES_PER_PIXEL;
                }
                
                /* If y >= vBarYOn && y < vBarYOn + vBarShortPixelCount, use short pixels */
                y = vBarYOn;
                count = vBarShortPixelCount;
                
                if (y + count > vBarPixelCount) {
                    count = (vBarPixelCount > y) ? (vBarPixelCount - y) : 0;
                }
                
                if (count > 0 && vBarShortEntry && vBarShortEntry->pixels) {
                    for (uint32_t c = 0; c < count; c++) {
                        uint32_t srcOffset = c * BYTES_PER_PIXEL;
                        if (srcOffset < vBarShortEntry->count * BYTES_PER_PIXEL) {
                            uint32_t color = read_rgba_pixel(&vBarShortEntry->pixels[srcOffset]);
                            write_rgba_pixel(dstBuffer, color);
                        }
                        dstBuffer += BYTES_PER_PIXEL;
                    }
                }
                
                /* If y >= vBarYOn + vBarShortPixelCount, use colorBkg */
                y = vBarYOn + vBarShortPixelCount;
                count = (vBarPixelCount > y) ? (vBarPixelCount - y) : 0;
                
                for (uint32_t c = 0; c < count; c++) {
                    write_rgba_pixel(dstBuffer, colorBkg);
                    dstBuffer += BYTES_PER_PIXEL;
                }
                
                vBarEntry->count = vBarPixelCount;
                ctx->vBarStorageCursor = (ctx->vBarStorageCursor + 1) % CLEARCODEC_VBAR_SIZE;
            }
            
            if (vBarEntry->count != vBarHeight) {
                vBarEntry->count = vBarHeight;
                if (!resize_vbar_entry(vBarEntry)) return false;
            }
            
            /* Render vBar to destination */
            uint32_t nXDstRel = nXDst + xStart;
            uint32_t nYDstRel = nYDst + yStart;
            cpSrcPixel = vBarEntry->pixels;
            
            if (i < nWidth) {
                uint32_t count = vBarEntry->count;
                if (count > nHeight) count = nHeight;
                
                if (nXDstRel + i >= nDstWidth) continue;
                
                for (uint32_t y = 0; y < count; y++) {
                    if (nYDstRel + y >= nDstHeight) break;
                    
                    uint8_t* pDstPixel = &pDstData[(nYDstRel + y) * nDstStep +
                                                    (nXDstRel + i) * BYTES_PER_PIXEL];
                    
                    uint32_t color = read_rgba_pixel(cpSrcPixel);
                    write_rgba_pixel(pDstPixel, color);
                    
                    cpSrcPixel += BYTES_PER_PIXEL;
                }
            }
        }
    }
    
    return true;
}

/* ============================================================================
 * Glyph data decoder - matching FreeRDP exactly
 * ============================================================================ */

static bool clear_decompress_glyph_data(
    ClearContext* ctx, Stream* s,
    uint32_t glyphFlags,
    uint32_t nWidth, uint32_t nHeight,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDst, uint32_t nYDst,
    uint32_t nDstWidth, uint32_t nDstHeight,
    uint8_t** ppGlyphData)
{
    uint16_t glyphIndex;
    
    if (ppGlyphData) *ppGlyphData = NULL;
    
    if ((glyphFlags & CLEARCODEC_FLAG_GLYPH_HIT) && 
        !(glyphFlags & CLEARCODEC_FLAG_GLYPH_INDEX)) {
        return false;
    }
    
    if (!(glyphFlags & CLEARCODEC_FLAG_GLYPH_INDEX)) {
        return true;
    }
    
    if ((nWidth * nHeight) > (1024 * 1024)) {
        return false;
    }
    
    if (!stream_check(s, 2)) return false;
    
    glyphIndex = stream_read_u16(s);
    
    if (glyphIndex >= CLEARCODEC_GLYPH_CACHE_SIZE) {
        return false;
    }
    
    if (glyphFlags & CLEARCODEC_FLAG_GLYPH_HIT) {
        /* Cache hit - render glyph from cache */
        ClearGlyphEntry* glyphEntry = &ctx->glyphCache[glyphIndex];
        
        /* Handle empty cache entry by filling with opaque black for robustness */
        if (!glyphEntry->pixels) {
            uint32_t pixelCount = nWidth * nHeight;
            glyphEntry->count = pixelCount;
            glyphEntry->size = pixelCount;
            glyphEntry->pixels = (uint32_t*)malloc(pixelCount * BYTES_PER_PIXEL);
            if (!glyphEntry->pixels) {
                return false;
            }
            uint32_t opaqueBlack = make_rgba(0, 0, 0, 0xFF);
            for (uint32_t i = 0; i < pixelCount; i++) {
                glyphEntry->pixels[i] = opaqueBlack;
            }
        }
        
        if ((nWidth * nHeight) > glyphEntry->count) {
            /* Expand cache if requested size is larger */
            uint32_t pixelCount = nWidth * nHeight;
            uint32_t* tmp = (uint32_t*)realloc(glyphEntry->pixels, pixelCount * BYTES_PER_PIXEL);
            if (!tmp) {
                return false;
            }
            uint32_t opaqueBlack = make_rgba(0, 0, 0, 0xFF);
            for (uint32_t i = glyphEntry->count; i < pixelCount; i++) {
                tmp[i] = opaqueBlack;
            }
            glyphEntry->pixels = tmp;
            glyphEntry->count = pixelCount;
            glyphEntry->size = pixelCount;
        }
        
        /* Copy cached glyph to destination */
        uint32_t nSrcStep = nWidth * BYTES_PER_PIXEL;
        uint8_t* glyphData = (uint8_t*)glyphEntry->pixels;
        
        for (uint32_t y = 0; y < nHeight; y++) {
            if (nYDst + y >= nDstHeight) break;
            
            uint32_t copyWidth = nWidth;
            if (nXDst + copyWidth > nDstWidth) {
                copyWidth = nDstWidth - nXDst;
            }
            
            uint8_t* dst = &pDstData[(nYDst + y) * nDstStep + nXDst * BYTES_PER_PIXEL];
            uint8_t* src = &glyphData[y * nSrcStep];
            memcpy(dst, src, copyWidth * BYTES_PER_PIXEL);
        }
        
        return true;
    }
    
    if (glyphFlags & CLEARCODEC_FLAG_GLYPH_INDEX) {
        /* Glyph index set but not hit - prepare cache slot for later storage */
        ClearGlyphEntry* glyphEntry = &ctx->glyphCache[glyphIndex];
        glyphEntry->count = nWidth * nHeight;
        
        if (glyphEntry->count > glyphEntry->size) {
            uint32_t* tmp = (uint32_t*)realloc(glyphEntry->pixels, 
                                                glyphEntry->count * BYTES_PER_PIXEL);
            if (!tmp) {
                return false;
            }
            
            glyphEntry->size = glyphEntry->count;
            glyphEntry->pixels = tmp;
        }
        
        if (!glyphEntry->pixels) {
            return false;
        }
        
        if (ppGlyphData) {
            *ppGlyphData = (uint8_t*)glyphEntry->pixels;
        }
        
        return true;
    }
    
    return true;
}

/* ============================================================================
 * Main ClearCodec decompress function - matching FreeRDP exactly
 * ============================================================================ */

static int32_t clear_decompress_internal(
    ClearContext* ctx,
    const uint8_t* pSrcData, uint32_t SrcSize,
    uint32_t nWidth, uint32_t nHeight,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDst, uint32_t nYDst,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    Stream stream = { pSrcData, SrcSize, 0 };
    Stream* s = &stream;
    uint8_t seqNumber, glyphFlags;
    uint32_t residualByteCount, bandsByteCount, subcodecByteCount;
    uint8_t* glyphData = NULL;
    
    if (!pDstData) return -1002;
    if (nDstWidth == 0 || nDstHeight == 0) return -1022;
    if (nWidth > 0xFFFF || nHeight > 0xFFFF) return -1004;
    
    if (!stream_check(s, 2)) return -1;
    
    glyphFlags = stream_read_u8(s);
    seqNumber = stream_read_u8(s);
    
    /* Handle sequence number - sync if ctx is 0 or resync on mismatch
     * for recovery from reconnect/network issues */
    if (!ctx->seqNumber && seqNumber) {
        ctx->seqNumber = seqNumber;
    }
    
    if (seqNumber != ctx->seqNumber) {
        ctx->seqNumber = seqNumber;
    }
    
    ctx->seqNumber = (seqNumber + 1) % 256;
    
    /* Handle cache reset flag */
    if (glyphFlags & CLEARCODEC_FLAG_CACHE_RESET) {
        clear_reset_vbar_storage(ctx, false);
    }
    
    /* Decompress glyph data */
    if (!clear_decompress_glyph_data(ctx, s, glyphFlags, nWidth, nHeight,
            pDstData, nDstStep, nXDst, nYDst, nDstWidth, nDstHeight, &glyphData)) {
        return -1;
    }
    
    /* Read composition payload header */
    if (stream_remaining(s) < 12) {
        const uint32_t mask = CLEARCODEC_FLAG_GLYPH_HIT | CLEARCODEC_FLAG_GLYPH_INDEX;
        if ((glyphFlags & mask) == mask) {
            /* Glyph hit with no payload - success */
            return 0;
        }
        return -1;
    }
    
    residualByteCount = stream_read_u32(s);
    bandsByteCount = stream_read_u32(s);
    subcodecByteCount = stream_read_u32(s);
    
    /* Decompress residual data */
    if (residualByteCount > 0) {
        if (!clear_decompress_residual_data(ctx, s, residualByteCount,
                nWidth, nHeight, pDstData, nDstStep,
                nXDst, nYDst, nDstWidth, nDstHeight)) {
            return -1;
        }
    }
    
    /* Decompress bands data */
    if (bandsByteCount > 0) {
        if (!clear_decompress_bands_data(ctx, s, bandsByteCount,
                nWidth, nHeight, pDstData, nDstStep,
                nXDst, nYDst, nDstWidth, nDstHeight)) {
            return -1;
        }
    }
    
    /* Decompress subcodecs data */
    if (subcodecByteCount > 0) {
        if (!clear_decompress_subcodecs_data(ctx, s, subcodecByteCount,
                nWidth, nHeight, pDstData, nDstStep,
                nXDst, nYDst, nDstWidth, nDstHeight)) {
            return -1;
        }
    }
    
    /* Store decoded data in glyph cache if glyph index was set */
    if (glyphData) {
        uint32_t nSrcStep = nWidth * BYTES_PER_PIXEL;
        
        for (uint32_t y = 0; y < nHeight; y++) {
            uint8_t* dst = &glyphData[y * nSrcStep];
            uint8_t* src = &pDstData[(nYDst + y) * nDstStep + nXDst * BYTES_PER_PIXEL];
            memcpy(dst, src, nWidth * BYTES_PER_PIXEL);
        }
    }
    
    return 0;
}

/* ============================================================================
 * Exported WASM API
 * ============================================================================ */

/**
 * Create a new ClearCodec decoder context
 */
EMSCRIPTEN_KEEPALIVE
ClearContext* clear_create(void) {
    ClearContext* ctx = (ClearContext*)calloc(1, sizeof(ClearContext));
    if (!ctx) return NULL;
    
    /* Initialize with a reasonable temp buffer size */
    if (!resize_temp_buffer(ctx, 512, 512)) {
        free(ctx);
        return NULL;
    }
    
    return ctx;
}

/**
 * Free a ClearCodec decoder context
 */
EMSCRIPTEN_KEEPALIVE
void clear_free(ClearContext* ctx) {
    if (!ctx) return;
    
    clear_reset_vbar_storage(ctx, true);
    clear_reset_glyph_cache(ctx);
    
    free(ctx->tempBuffer);
    free(ctx);
}

/**
 * Reset the ClearCodec context (called on ResetGraphics)
 * Note: Per MS-RDPEGFX, ClearCodec caches are NOT reset on ResetGraphics
 */
EMSCRIPTEN_KEEPALIVE
bool clear_context_reset(ClearContext* ctx) {
    if (!ctx) return false;
    
    /* Only reset sequence number, not caches */
    ctx->seqNumber = 0;
    return true;
}

/**
 * Decompress ClearCodec data to RGBA output buffer
 * 
 * @param ctx         ClearCodec context (session-level state)
 * @param pSrcData    Compressed ClearCodec data
 * @param srcSize     Size of compressed data
 * @param nWidth      Width of the tile
 * @param nHeight     Height of the tile  
 * @param pDstData    Output RGBA buffer (must be at least nWidth*nHeight*4 bytes)
 * @param nDstStep    Stride of output buffer (typically nWidth*4)
 * @param nXDst       X offset in output buffer (usually 0)
 * @param nYDst       Y offset in output buffer (usually 0)
 * @param nDstWidth   Total width of output buffer
 * @param nDstHeight  Total height of output buffer
 * 
 * @return 0 on success, negative on error
 */
EMSCRIPTEN_KEEPALIVE
int32_t clear_decompress(
    ClearContext* ctx,
    const uint8_t* pSrcData, uint32_t srcSize,
    uint32_t nWidth, uint32_t nHeight,
    uint8_t* pDstData, uint32_t nDstStep,
    uint32_t nXDst, uint32_t nYDst,
    uint32_t nDstWidth, uint32_t nDstHeight)
{
    if (!ctx || !pSrcData || !pDstData) {
        return -1;
    }
    
    return clear_decompress_internal(ctx, pSrcData, srcSize,
                                     nWidth, nHeight,
                                     pDstData, nDstStep,
                                     nXDst, nYDst,
                                     nDstWidth, nDstHeight);
}

/**
 * Allocate output buffer for decoded tile
 */
EMSCRIPTEN_KEEPALIVE
uint8_t* clear_alloc_output(uint32_t width, uint32_t height) {
    return (uint8_t*)calloc(width * height * BYTES_PER_PIXEL, 1);
}

/**
 * Free output buffer
 */
EMSCRIPTEN_KEEPALIVE
void clear_free_output(uint8_t* buffer) {
    free(buffer);
}
