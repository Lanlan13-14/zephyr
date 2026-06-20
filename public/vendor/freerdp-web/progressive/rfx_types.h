/**
 * RFX Progressive Codec Types
 * Standalone types for WASM progressive decoder
 * Based on FreeRDP's RFX codec (Apache 2.0 License)
 */

#ifndef RFX_TYPES_H
#define RFX_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/* Tile size is always 64x64 */
#define RFX_TILE_SIZE 64

/* Maximum surfaces and tiles */
#define RFX_MAX_SURFACES 256
#define RFX_MAX_TILES_PER_SURFACE 16384

/* Progressive block types */
#define PROGRESSIVE_WBT_SYNC          0xCCC0
#define PROGRESSIVE_WBT_FRAME_BEGIN   0xCCC1
#define PROGRESSIVE_WBT_FRAME_END     0xCCC2
#define PROGRESSIVE_WBT_CONTEXT       0xCCC3
#define PROGRESSIVE_WBT_REGION        0xCCC4
#define PROGRESSIVE_WBT_TILE_SIMPLE   0xCCC5
#define PROGRESSIVE_WBT_TILE_FIRST    0xCCC6
#define PROGRESSIVE_WBT_TILE_UPGRADE  0xCCC7

/* Pixel format - output is always BGRA32 */
#define RFX_PIXEL_FORMAT_BGRA32 0x20

/* Component codec quant (10 values per component)
 * Order must match FreeRDP: LL3, HL3, LH3, HH3, HL2, LH2, HH2, HL1, LH1, HH1
 * IMPORTANT: Note HL comes before LH at each level! */
typedef struct {
    uint8_t LL3;
    uint8_t HL3;
    uint8_t LH3;
    uint8_t HH3;
    uint8_t HL2;
    uint8_t LH2;
    uint8_t HH2;
    uint8_t HL1;
    uint8_t LH1;
    uint8_t HH1;
} RfxComponentCodecQuant;

/* Helper macros to access RfxComponentCodecQuant fields by index (0-9) */
#define QUANT_GET(q, i) (((const uint8_t*)&(q))[i])
#define QUANT_SET(q, i, v) (((uint8_t*)&(q))[i] = (uint8_t)(v))

/* Progressive codec quant (quality progression) */
typedef struct {
    RfxComponentCodecQuant yQuant;
    RfxComponentCodecQuant cbQuant;
    RfxComponentCodecQuant crQuant;
} RfxProgressiveCodecQuant;

/* Rectangle */
typedef struct {
    uint16_t x;
    uint16_t y;
    uint16_t width;
    uint16_t height;
} RfxRect;

/* Tile state for progressive refinement */
typedef struct {
    /* Grid position */
    uint16_t xIdx;
    uint16_t yIdx;
    
    /* Pixel position */
    uint16_t x;
    uint16_t y;
    
    /* Current pass (0 = not decoded, 1+ = progressive passes) */
    uint16_t pass;
    
    /* Quality level */
    uint8_t quality;
    
    /* Decoded BGRA pixels (64*64*4 = 16384 bytes) */
    uint8_t* data;
    
    /* Sign buffer for progressive refinement (4096*3 int16_t = 24576 bytes)
     * Using int16_t like FreeRDP for compatibility with upgrade functions */
    int16_t* sign;
    
    /* Current wavelet coefficients Y/Cb/Cr (64*64*2 = 8192 bytes each) */
    int16_t* yData;
    int16_t* cbData;
    int16_t* crData;
    
    /* Quantization values for this tile */
    RfxComponentCodecQuant yQuant;
    RfxComponentCodecQuant cbQuant;
    RfxComponentCodecQuant crQuant;
    
    /* Progressive quantization values (from quality index) */
    RfxComponentCodecQuant yProgQuant;
    RfxComponentCodecQuant cbProgQuant;
    RfxComponentCodecQuant crProgQuant;
    
    /* Per-subband bit positions (quant + progQuant) - updated each pass */
    RfxComponentCodecQuant yBitPos;
    RfxComponentCodecQuant cbBitPos;
    RfxComponentCodecQuant crBitPos;
    
    /* Dirty flag - tile was updated this frame and needs to be rendered */
    bool dirty;
    
    /* Valid flag - tile has valid decoded content
     * Set to true after TILE_FIRST decode, false after SYNC/CONTEXT reset.
     * TILE_UPGRADE should skip tiles with valid=false to avoid refining garbage. */
    bool valid;
} RfxTile;

/* Surface context */
typedef struct {
    uint16_t id;
    uint32_t width;
    uint32_t height;
    uint32_t gridWidth;   /* width / 64 */
    uint32_t gridHeight;  /* height / 64 */
    uint32_t gridSize;    /* gridWidth * gridHeight */
    
    /* Tile grid (indexed as [yIdx * gridWidth + xIdx]) */
    RfxTile** tiles;
    
    /* Last frame ID processed */
    uint32_t frameId;
} RfxSurface;

/* Block state tracking flags */
#define FLAG_WBT_SYNC        0x01
#define FLAG_WBT_CONTEXT     0x02
#define FLAG_WBT_FRAME_BEGIN 0x04
#define FLAG_WBT_FRAME_END   0x08

/* Main progressive decoder context */
typedef struct {
    /* Surface contexts */
    RfxSurface* surfaces[RFX_MAX_SURFACES];
    
    /* Quantization tables (per frame) */
    RfxComponentCodecQuant quantVals[256];
    uint8_t numQuant;
    
    /* Progressive quantization tables */
    RfxProgressiveCodecQuant quantProgVals[256];
    uint8_t numProgQuant;
    
    /* Current frame state */
    uint32_t frameId;
    uint16_t currentSurfaceId;
    
    /* Block state tracking (like FreeRDP's progressive->state) */
    uint32_t state;
    
    /* Context block values */
    uint8_t ctxId;
    uint16_t tileSize;
    uint8_t ctxFlags;
    
    /* Region flags - bit 0 = RFX_DWT_REDUCE_EXTRAPOLATE */
    bool extrapolate;
    
    /* Frame tracking */
    uint32_t frameIndex;
    uint16_t regionCount;
    
    /* Updated tile tracking (for batch surface writes) */
    uint32_t numUpdatedTiles;
    uint32_t updatedTileIndices[RFX_MAX_TILES_PER_SURFACE];
    
    /* Per-tile clipRect tracking - stores clipRects active when each tile was decoded
     * This is necessary because multiple regions per frame can have different clipRects */
    uint16_t tileClipRectStart[RFX_MAX_TILES_PER_SURFACE];  /* Start index in perTileClipRects */
    uint16_t tileClipRectCount[RFX_MAX_TILES_PER_SURFACE];  /* Count of clipRects for this tile */
    RfxRect perTileClipRects[RFX_MAX_TILES_PER_SURFACE * 8]; /* Buffer for all tile clipRects (8 per tile max) */
    uint32_t perTileClipRectsTotal;  /* Total clipRects stored in buffer */
    
    /* Clipping rectangles for current region (per MS-RDPEGFX 2.2.4.2)
     * Tiles are only rendered if they intersect with at least one clip rect.
     * This prevents Progressive from overwriting ClearCodec content. */
    RfxRect clipRects[256];
    uint16_t numClipRects;
    
    /* Temporary decode buffers */
    int16_t* yBuffer;   /* 64*64 */
    int16_t* cbBuffer;  /* 64*64 */
    int16_t* crBuffer;  /* 64*64 */
    
    /* RLGR decode buffer */
    int16_t* rlgrBuffer;
    size_t rlgrBufferSize;
} ProgressiveContext;

/* Inline utilities */
static inline uint16_t read_u16_le(const uint8_t* p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static inline uint32_t read_u32_le(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | 
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline int16_t read_i16_le(const uint8_t* p) {
    return (int16_t)read_u16_le(p);
}

#endif /* RFX_TYPES_H */
