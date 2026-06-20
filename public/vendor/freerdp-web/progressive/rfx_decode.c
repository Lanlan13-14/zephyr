/**
 * RFX Decode - YCbCr to BGRA conversion for WebAssembly execution in browsers.
 * Based on FreeRDP's prim_colors.c (Apache 2.0 License)
 * Adption by Marco Weber <https://github.com/qxsch>
 * 
 * IMPORTANT: DWT output is in 11.5 fixed-point format!
 * Values are scaled by << 5 (32x), so Y=128 becomes Y=4096.
 * 
 * The conversion uses:
 * 1. Add Y_OFFSET (128 << 5 = 4096) to Y
 * 2. Apply color conversion with scaled constants
 * 3. Right-shift result by 5 to get 8-bit pixel values
 */

#include "rfx_types.h"

/* 
 * Y offset in 11.5 fixed-point: 128 << 5 = 4096
 * This is because DWT output values are pre-scaled by 32
 */
#define Y_OFFSET_FP 4096

/* 
 * YCbCr to RGB conversion constants (ITU-R BT.601) scaled by << 5
 * These match FreeRDP's ycbcr_constants[5] = { 45, 23, 11, 57 }
 * 
 * R = Y + 1.402525 * Cr  -> R = Y + (45 * Cr) >> 5
 * G = Y - 0.343730 * Cb - 0.714401 * Cr -> G = Y - (11 * Cb + 23 * Cr) >> 5
 * B = Y + 1.769905 * Cb  -> B = Y + (57 * Cb) >> 5
 */
#define CR_R 45
#define CR_G 23
#define CB_G 11
#define CB_B 57

/* Clamp value to 0-255 range */
static inline uint8_t clamp_byte(int val) {
    if (val < 0) return 0;
    if (val > 255) return 255;
    return (uint8_t)val;
}

/**
 * Convert YCbCr coefficients to BGRA32 pixels
 * 
 * DWT output is in 11.5 fixed-point format (values scaled << 5)
 * 
 * @param yData   Y coefficients in 11.5 fixed-point
 * @param cbData  Cb coefficients in 11.5 fixed-point
 * @param crData  Cr coefficients in 11.5 fixed-point
 * @param dst     Output BGRA32 buffer (64x64x4 bytes)
 * @param dstStride Stride in bytes
 */
void rfx_ycbcr_to_bgra(const int16_t* yData, const int16_t* cbData, 
                       const int16_t* crData, uint8_t* dst, int dstStride) {
    int x, y;
    
    for (y = 0; y < RFX_TILE_SIZE; y++) {
        uint8_t* row = dst + y * dstStride;
        
        for (x = 0; x < RFX_TILE_SIZE; x++) {
            int idx = y * RFX_TILE_SIZE + x;
            
            /* Get YCbCr values - already in 11.5 fixed-point */
            int32_t Y  = yData[idx] + Y_OFFSET_FP;  /* Add offset (128 << 5) */
            int32_t Cb = cbData[idx];
            int32_t Cr = crData[idx];
            
            /* 
             * Color conversion formula (ITU-R BT.601):
             *   R = Y + 1.402525 * Cr
             *   G = Y - 0.343730 * Cb - 0.714401 * Cr
             *   B = Y + 1.769905 * Cb
             * 
             * FreeRDP's ycbcr_constants[16] = { 91916, 46819, 22527, 115992 }
             * Index mapping: [0]=CrR, [1]=CrG, [2]=CbG, [3]=CbB
             */
            int64_t Y_scaled = (int64_t)Y << 16;
            int64_t CrR = (int64_t)Cr * 91916;   /* [0] = 1.402525 * 65536 */
            int64_t CrG = (int64_t)Cr * 46819;   /* [1] = 0.714401 * 65536 */
            int64_t CbG = (int64_t)Cb * 22527;   /* [2] = 0.343730 * 65536 */
            int64_t CbB = (int64_t)Cb * 115992;  /* [3] = 1.769905 * 65536 */
            
            int R = (int)((Y_scaled + CrR) >> 21);  /* >> 16 + 5 combined */
            int G = (int)((Y_scaled - CbG - CrG) >> 21);
            int B = (int)((Y_scaled + CbB) >> 21);
            
            /* Write BGRA */
            row[x * 4 + 0] = clamp_byte(B);
            row[x * 4 + 1] = clamp_byte(G);
            row[x * 4 + 2] = clamp_byte(R);
            row[x * 4 + 3] = 255;  /* Alpha */
        }
    }
}

/**
 * Convert YCbCr to RGBA32 (for browser canvas which expects RGBA)
 * 
 * DWT output is in 11.5 fixed-point format (values scaled << 5)
 */
void rfx_ycbcr_to_rgba(const int16_t* yData, const int16_t* cbData, 
                       const int16_t* crData, uint8_t* dst, int dstStride) {
    int x, y;
    
    for (y = 0; y < RFX_TILE_SIZE; y++) {
        uint8_t* row = dst + y * dstStride;
        
        for (x = 0; x < RFX_TILE_SIZE; x++) {
            int idx = y * RFX_TILE_SIZE + x;
            
            /* Get YCbCr values - already in 11.5 fixed-point */
            int32_t Y  = yData[idx] + Y_OFFSET_FP;  /* Add offset (128 << 5) */
            int32_t Cb = cbData[idx];
            int32_t Cr = crData[idx];
            
            /* 
             * Color conversion formula (ITU-R BT.601):
             *   R = Y + 1.402525 * Cr
             *   G = Y - 0.343730 * Cb - 0.714401 * Cr
             *   B = Y + 1.769905 * Cb
             * 
             * FreeRDP's ycbcr_constants[16] = { 91916, 46819, 22527, 115992 }
             * Index mapping: [0]=CrR, [1]=CrG, [2]=CbG, [3]=CbB
             */
            int64_t Y_scaled = (int64_t)Y << 16;
            int64_t CrR = (int64_t)Cr * 91916;   /* [0] = 1.402525 * 65536 */
            int64_t CrG = (int64_t)Cr * 46819;   /* [1] = 0.714401 * 65536 */
            int64_t CbG = (int64_t)Cb * 22527;   /* [2] = 0.343730 * 65536 */
            int64_t CbB = (int64_t)Cb * 115992;  /* [3] = 1.769905 * 65536 */
            
            int R = (int)((Y_scaled + CrR) >> 21);  /* >> 16 + 5 combined */
            int G = (int)((Y_scaled - CbG - CrG) >> 21);
            int B = (int)((Y_scaled + CbB) >> 21);
            
            /* Write RGBA */
            row[x * 4 + 0] = clamp_byte(R);
            row[x * 4 + 1] = clamp_byte(G);
            row[x * 4 + 2] = clamp_byte(B);
            row[x * 4 + 3] = 255;
        }
    }
}

/**
 * Apply region offset to tile output
 * Copies a decoded 64x64 tile to destination at specified position
 */
void rfx_copy_tile_to_surface(const uint8_t* tile, int tileStride,
                              uint8_t* surface, int surfaceWidth,
                              int dstX, int dstY, int copyWidth, int copyHeight) {
    for (int y = 0; y < copyHeight; y++) {
        const uint8_t* src = tile + y * tileStride;
        uint8_t* dst = surface + (dstY + y) * surfaceWidth * 4 + dstX * 4;
        memcpy(dst, src, copyWidth * 4);
    }
}
