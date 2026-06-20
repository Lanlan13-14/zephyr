/**
 * FreeRDP: A Remote Desktop Protocol Implementation for WebAssembly execution in browsers.
 * RemoteFX Codec Library - RLGR
 *
 * Copyright 2011 Vic Lee
 * Adption by Marco Weber <https://github.com/qxsch>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * This implementation of RLGR refers to
 * [MS-RDPRFX] 3.1.8.1.7.3 RLGR1/RLGR3 Pseudocode
 */

#include "rfx_types.h"
#include <string.h>

/* Constants used in RLGR1/RLGR3 algorithm */
#define KPMAX (80)  /* max value for kp or krp */
#define LSGR (3)    /* shift count to convert kp to k */
#define UP_GR (4)   /* increase in kp after a zero run in RL mode */
#define DN_GR (6)   /* decrease in kp after a nonzero symbol in RL mode */
#define UQ_GR (3)   /* increase in kp after zero symbol in GR mode */
#define DQ_GR (3)   /* decrease in kp after nonzero symbol in GR mode */

/**
 * Bitstream structure - matches FreeRDP's wBitStream with prefetch
 * 
 * Uses a 32-bit accumulator with a 32-bit prefetch register.
 * When bits are shifted out, bits from prefetch are shifted in.
 * When 32 bits have been consumed, prefetch is refilled from buffer.
 */
typedef struct {
    const uint8_t* buffer;    /* Original buffer start */
    const uint8_t* pointer;   /* Current read position (advances by 4 bytes) */
    uint32_t capacity;        /* Total buffer size in bytes */
    uint32_t length;          /* Total bits available (capacity * 8) */
    uint32_t position;        /* Bits consumed so far */
    uint32_t offset;          /* Bits consumed within current 32-bit word (0-31) */
    uint32_t accumulator;     /* Current 32 bits being read */
    uint32_t prefetch;        /* Next 32 bits to be read */
    uint32_t mask;            /* Temporary mask for extraction */
} BITSTREAM;

/**
 * Count leading zeros in a 32-bit value
 */
static inline uint32_t lzcnt32(uint32_t x)
{
    if (x == 0) return 32;
    
    uint32_t n = 0;
    if ((x & 0xFFFF0000) == 0) { n += 16; x <<= 16; }
    if ((x & 0xFF000000) == 0) { n += 8;  x <<= 8; }
    if ((x & 0xF0000000) == 0) { n += 4;  x <<= 4; }
    if ((x & 0xC0000000) == 0) { n += 2;  x <<= 2; }
    if ((x & 0x80000000) == 0) { n += 1; }
    return n;
}

/**
 * Prefetch next 32 bits from buffer (bytes 4-7 from current pointer)
 */
static inline void BitStream_Prefetch(BITSTREAM* bs)
{
    bs->prefetch = 0;
    intptr_t diff = bs->pointer - bs->buffer;
    
    if ((diff + 4) < (intptr_t)bs->capacity)
        bs->prefetch |= ((uint32_t)bs->pointer[4] << 24);
    if ((diff + 5) < (intptr_t)bs->capacity)
        bs->prefetch |= ((uint32_t)bs->pointer[5] << 16);
    if ((diff + 6) < (intptr_t)bs->capacity)
        bs->prefetch |= ((uint32_t)bs->pointer[6] << 8);
    if ((diff + 7) < (intptr_t)bs->capacity)
        bs->prefetch |= ((uint32_t)bs->pointer[7] << 0);
}

/**
 * Fetch current 32 bits into accumulator (bytes 0-3 from current pointer)
 */
static inline void BitStream_Fetch(BITSTREAM* bs)
{
    bs->accumulator = 0;
    intptr_t diff = bs->pointer - bs->buffer;
    
    if ((diff + 0) < (intptr_t)bs->capacity)
        bs->accumulator |= ((uint32_t)bs->pointer[0] << 24);
    if ((diff + 1) < (intptr_t)bs->capacity)
        bs->accumulator |= ((uint32_t)bs->pointer[1] << 16);
    if ((diff + 2) < (intptr_t)bs->capacity)
        bs->accumulator |= ((uint32_t)bs->pointer[2] << 8);
    if ((diff + 3) < (intptr_t)bs->capacity)
        bs->accumulator |= ((uint32_t)bs->pointer[3] << 0);
    
    BitStream_Prefetch(bs);
}

/**
 * Attach buffer to bitstream
 */
static void BitStream_Attach(BITSTREAM* bs, const uint8_t* buffer, uint32_t nbytes)
{
    bs->buffer = buffer;
    bs->pointer = buffer;
    bs->capacity = nbytes;
    bs->length = nbytes * 8;
    bs->position = 0;
    bs->offset = 0;
    bs->accumulator = 0;
    bs->prefetch = 0;
    bs->mask = 0;
}

/**
 * Get remaining bits in stream
 */
static inline uint32_t BitStream_GetRemainingLength(BITSTREAM* bs)
{
    if (bs->position >= bs->length)
        return 0;
    return bs->length - bs->position;
}

/**
 * Shift accumulator by n bits and refill from prefetch
 * This matches FreeRDP's BitStream_Shift exactly
 */
static void BitStream_Shift(BITSTREAM* bs, uint32_t nbits)
{
    if (nbits == 0)
        return;
    
    if (nbits > 0 && nbits < 32)
    {
        bs->accumulator <<= nbits;
        bs->position += nbits;
        bs->offset += nbits;
        
        if (bs->offset < 32)
        {
            /* Still within current 32-bit word, pull from prefetch */
            bs->mask = ((1u << nbits) - 1);
            bs->accumulator |= ((bs->prefetch >> (32 - nbits)) & bs->mask);
            bs->prefetch <<= nbits;
        }
        else
        {
            /* Crossed 32-bit boundary */
            bs->mask = ((1u << nbits) - 1);
            bs->accumulator |= ((bs->prefetch >> (32 - nbits)) & bs->mask);
            bs->prefetch <<= nbits;
            bs->offset -= 32;
            bs->pointer += 4;
            BitStream_Prefetch(bs);
            
            if (bs->offset)
            {
                bs->mask = ((1u << bs->offset) - 1);
                bs->accumulator |= ((bs->prefetch >> (32 - bs->offset)) & bs->mask);
                bs->prefetch <<= bs->offset;
            }
        }
    }
}

/**
 * Shift accumulator by exactly 32 bits (two 16-bit shifts)
 */
static inline void BitStream_Shift32(BITSTREAM* bs)
{
    BitStream_Shift(bs, 16);
    BitStream_Shift(bs, 16);
}

/**
 * Update parameter and clamp to [0, KPMAX], return parameter >> LSGR
 * Matches FreeRDP's UpdateParam exactly with unsigned parameter
 */
static inline uint32_t UpdateParam(uint32_t* param, int32_t deltaP)
{
    if (deltaP < 0)
    {
        const uint32_t udeltaP = (uint32_t)(-deltaP);
        if (udeltaP > *param)
            *param = 0;
        else
            *param -= udeltaP;
    }
    else
    {
        *param += (uint32_t)deltaP;
    }
    
    if (*param > KPMAX)
        *param = KPMAX;
    
    return (*param) >> LSGR;
}

/**
 * rfx_rlgr_decode - RLGR1 decoder matching FreeRDP algorithm exactly
 * 
 * @param input     Input RLGR1 bitstream
 * @param inputSize Input size in bytes
 * @param output    Output coefficient buffer (int16_t)
 * @param outputSize Maximum output count
 * @return Number of coefficients decoded, or -1 on error
 */
int rfx_rlgr_decode(const uint8_t* input, size_t inputSize,
                    int16_t* output, size_t outputSize)
{
    BITSTREAM bs;
    uint32_t vk, cnt;
    uint32_t k, kp, kr, krp;  /* FreeRDP uses UINT32 for these */
    uint16_t code;
    int16_t mag;
    size_t run, offset, size;
    int16_t* pOutput;
    
    if (!input || inputSize == 0 || !output || outputSize == 0)
        return -1;
    
    /* Initialize parameters - k=1, kr=1 */
    k = 1;
    kp = k << LSGR;
    kr = 1;
    krp = kr << LSGR;
    
    pOutput = output;
    BitStream_Attach(&bs, input, (uint32_t)inputSize);
    BitStream_Fetch(&bs);  /* CRITICAL: Fetch initial 32 bits into accumulator */
    
    while ((BitStream_GetRemainingLength(&bs) > 0) && 
           ((size_t)(pOutput - output) < outputSize))
    {
        if (k)
        {
            /* Run-Length (RL) Mode */
            run = 0;
            
            /* Count number of leading 0s in accumulator */
            cnt = lzcnt32(bs.accumulator);
            
            size_t nbits = BitStream_GetRemainingLength(&bs);
            if (cnt > nbits)
                cnt = (uint32_t)nbits;
            
            vk = cnt;
            
            /* Handle case where all 32 bits are zero */
            while (cnt == 32 && BitStream_GetRemainingLength(&bs) > 0)
            {
                BitStream_Shift32(&bs);
                cnt = lzcnt32(bs.accumulator);
                
                nbits = BitStream_GetRemainingLength(&bs);
                if (cnt > nbits)
                    cnt = (uint32_t)nbits;
                
                vk += cnt;
            }
            
            /* Shift past the zeros */
            BitStream_Shift(&bs, vk % 32);
            
            if (BitStream_GetRemainingLength(&bs) < 1)
                break;
            
            /* Shift past the terminating 1 bit */
            BitStream_Shift(&bs, 1);
            
            /* Accumulate run length from unary part */
            while (vk--)
            {
                run += ((size_t)1 << k);  /* add (1 << k) to run length */
                
                /* Update k, kp params */
                kp += UP_GR;
                if (kp > KPMAX)
                    kp = KPMAX;
                k = kp >> LSGR;
            }
            
            /* Next k bits contain run length remainder */
            if (BitStream_GetRemainingLength(&bs) < (uint32_t)k)
                break;
            
            bs.mask = ((1u << k) - 1);
            run += ((bs.accumulator >> (32 - k)) & bs.mask);
            BitStream_Shift(&bs, (uint32_t)k);
            
            /* Read sign bit */
            if (BitStream_GetRemainingLength(&bs) < 1)
                break;
            
            uint32_t sign = (bs.accumulator & 0x80000000) ? 1 : 0;
            BitStream_Shift(&bs, 1);
            
            /* Count number of leading 1s (for GR code of magnitude) */
            cnt = lzcnt32(~bs.accumulator);
            
            nbits = BitStream_GetRemainingLength(&bs);
            if (cnt > nbits)
                cnt = (uint32_t)nbits;
            
            vk = cnt;
            
            while (cnt == 32 && BitStream_GetRemainingLength(&bs) > 0)
            {
                BitStream_Shift32(&bs);
                cnt = lzcnt32(~bs.accumulator);
                
                nbits = BitStream_GetRemainingLength(&bs);
                if (cnt > nbits)
                    cnt = (uint32_t)nbits;
                
                vk += cnt;
            }
            
            BitStream_Shift(&bs, vk % 32);
            
            if (BitStream_GetRemainingLength(&bs) < 1)
                break;
            
            BitStream_Shift(&bs, 1);  /* Skip terminating 0 bit */
            
            /* Next kr bits contain code remainder */
            if (BitStream_GetRemainingLength(&bs) < (uint32_t)kr)
                break;
            
            bs.mask = ((1u << kr) - 1);
            if (kr > 0)
                code = (uint16_t)((bs.accumulator >> (32 - kr)) & bs.mask);
            else
                code = 0;
            BitStream_Shift(&bs, (uint32_t)kr);
            
            /* Add (vk << kr) to code */
            code |= (uint16_t)(vk << kr);
            
            /* Update kr, krp params */
            if (vk == 0)
            {
                if (krp > 2)
                    krp -= 2;
                else
                    krp = 0;
                kr = krp >> LSGR;
            }
            else if (vk != 1)
            {
                krp += vk;
                if (krp > KPMAX)
                    krp = KPMAX;
                kr = krp >> LSGR;
            }
            
            /* Update k, kp params */
            if (kp > DN_GR)
                kp -= DN_GR;
            else
                kp = 0;
            k = kp >> LSGR;
            
            /* Compute magnitude from code */
            if (sign)
                mag = (int16_t)(-((int32_t)code + 1));
            else
                mag = (int16_t)(code + 1);
            
            /* Write run of zeros to output */
            offset = (size_t)(pOutput - output);
            size = run;
            
            if ((offset + size) > outputSize)
                size = outputSize - offset;
            
            if (size)
            {
                memset(pOutput, 0, size * sizeof(int16_t));
                pOutput += size;
            }
            
            /* Write non-zero value */
            if ((size_t)(pOutput - output) < outputSize)
            {
                *pOutput = mag;
                pOutput++;
            }
        }
        else
        {
            /* Golomb-Rice (GR) Mode */
            
            /* Count number of leading 1s */
            cnt = lzcnt32(~bs.accumulator);
            
            size_t nbits = BitStream_GetRemainingLength(&bs);
            if (cnt > nbits)
                cnt = (uint32_t)nbits;
            
            vk = cnt;
            
            while (cnt == 32 && BitStream_GetRemainingLength(&bs) > 0)
            {
                BitStream_Shift32(&bs);
                cnt = lzcnt32(~bs.accumulator);
                
                nbits = BitStream_GetRemainingLength(&bs);
                if (cnt > nbits)
                    cnt = (uint32_t)nbits;
                
                vk += cnt;
            }
            
            BitStream_Shift(&bs, vk % 32);
            
            if (BitStream_GetRemainingLength(&bs) < 1)
                break;
            
            BitStream_Shift(&bs, 1);  /* Skip terminating 0 bit */
            
            /* Next kr bits contain code remainder */
            if (BitStream_GetRemainingLength(&bs) < (uint32_t)kr)
                break;
            
            bs.mask = ((1u << kr) - 1);
            if (kr > 0)
                code = (uint16_t)((bs.accumulator >> (32 - kr)) & bs.mask);
            else
                code = 0;
            BitStream_Shift(&bs, (uint32_t)kr);
            
            /* Add (vk << kr) to code */
            code |= (uint16_t)(vk << kr);
            
            /* Update kr, krp params */
            if (vk == 0)
            {
                if (krp > 2)
                    krp -= 2;
                else
                    krp = 0;
                kr = krp >> LSGR;
            }
            else if (vk != 1)
            {
                krp += vk;
                if (krp > KPMAX)
                    krp = KPMAX;
                kr = krp >> LSGR;
            }
            
            /* RLGR1 mode: code = 2 * mag - sign */
            if (code == 0)
            {
                /* Update k, kp params - increase k for zero */
                kp += UQ_GR;
                if (kp > KPMAX)
                    kp = KPMAX;
                k = kp >> LSGR;
                
                mag = 0;
            }
            else
            {
                /* Update k, kp params - decrease k for nonzero */
                if (kp > DQ_GR)
                    kp -= DQ_GR;
                else
                    kp = 0;
                k = kp >> LSGR;
                
                /*
                 * code = 2 * mag - sign
                 * sign + code = 2 * mag
                 */
                if (code & 1)
                    mag = (int16_t)(-((int32_t)(code + 1) >> 1));
                else
                    mag = (int16_t)(code >> 1);
            }
            
            if ((size_t)(pOutput - output) < outputSize)
            {
                *pOutput = mag;
                pOutput++;
            }
        }
    }
    
    /* Zero-fill remaining output */
    offset = (size_t)(pOutput - output);
    if (offset < outputSize)
    {
        size = outputSize - offset;
        memset(pOutput, 0, size * sizeof(int16_t));
        pOutput += size;
    }
    
    return (int)(pOutput - output);
}

/**
 * SRL (Subband Residual Layer) state for progressive upgrades
 */
typedef struct {
    BITSTREAM* bs;
    int32_t kp;
    int32_t nz;       /* remaining zeros in current run */
    int mode;         /* 0 = zero encoding, 1 = unary encoding */
} SRL_STATE;

/**
 * Read a single SRL-encoded value
 */
static int16_t srl_read_value(SRL_STATE* state, uint32_t numBits)
{
    BITSTREAM* bs = state->bs;
    
    if (state->nz > 0)
    {
        state->nz--;
        return 0;
    }
    
    uint32_t k = state->kp / 8;
    
    if (state->mode == 0)
    {
        /* Zero encoding mode */
        uint32_t bit = (bs->accumulator & 0x80000000) ? 1 : 0;
        BitStream_Shift(bs, 1);
        
        if (bit == 0)
        {
            /* '0' bit: nz >= (1 << k), nz = (1 << k) */
            state->nz = (1 << k);
            state->kp += 4;
            if (state->kp > 80)
                state->kp = 80;
            
            state->nz--;
            return 0;
        }
        else
        {
            /* '1' bit: nz < (1 << k), nz = next k bits */
            state->nz = 0;
            state->mode = 1;  /* Switch to unary encoding */
            
            if (k > 0)
            {
                bs->mask = ((1u << k) - 1);
                state->nz = (int32_t)((bs->accumulator >> (32 - k)) & bs->mask);
                BitStream_Shift(bs, k);
            }
            
            if (state->nz > 0)
            {
                state->nz--;
                return 0;
            }
        }
    }
    
    /* Unary encoding mode - decode a non-zero value */
    state->mode = 0;  /* Switch back to zero encoding */
    
    /* Read sign bit */
    uint32_t sign = (bs->accumulator & 0x80000000) ? 1 : 0;
    BitStream_Shift(bs, 1);
    
    /* Update kp */
    if (state->kp < 6)
        state->kp = 0;
    else
        state->kp -= 6;
    
    if (numBits == 1)
        return sign ? -1 : 1;
    
    /* Read magnitude using unary encoding */
    uint32_t mag = 1;
    uint32_t max = (1u << numBits) - 1;
    
    while (mag < max)
    {
        uint32_t bit = (bs->accumulator & 0x80000000) ? 1 : 0;
        BitStream_Shift(bs, 1);
        
        if (bit)
            break;
        
        mag++;
    }
    
    if (mag > 32767)
        mag = 32767;
    
    return sign ? -(int16_t)mag : (int16_t)mag;
}

/* Subband offsets and sizes for extrapolated tiles (from FreeRDP progressive.c) */
static const struct {
    size_t offset;
    size_t length;
} SUBBAND_EXTRAPOLATED[10] = {
    { 0,    1023 },  /* HL1 */
    { 1023, 1023 },  /* LH1 */
    { 2046, 961  },  /* HH1 */
    { 3007, 272  },  /* HL2 */
    { 3279, 272  },  /* LH2 */
    { 3551, 256  },  /* HH2 */
    { 3807, 72   },  /* HL3 */
    { 3879, 72   },  /* LH3 */
    { 3951, 64   },  /* HH3 */
    { 4015, 81   },  /* LL3 */
};

/* Subband offsets and sizes for non-extrapolated tiles */
static const struct {
    size_t offset;
    size_t length;
} SUBBAND_NORMAL[10] = {
    { 0,    1024 },  /* HL1 */
    { 1024, 1024 },  /* LH1 */
    { 2048, 1024 },  /* HH1 */
    { 3072, 256  },  /* HL2 */
    { 3328, 256  },  /* LH2 */
    { 3584, 256  },  /* HH2 */
    { 3840, 64   },  /* HL3 */
    { 3904, 64   },  /* LH3 */
    { 3968, 64   },  /* HH3 */
    { 4032, 64   },  /* LL3 */
};

/**
 * Upgrade a single subband block using SRL and RAW streams
 * Based on FreeRDP's progressive_rfx_upgrade_block
 *
 * @param srl        SRL bitstream state
 * @param raw        RAW bitstream state  
 * @param current    Coefficient buffer for this subband
 * @param sign       Sign buffer for this subband
 * @param length     Number of coefficients in subband
 * @param shift      Shift amount for this subband
 * @param numBits    Number of bits to read per coefficient
 * @param isLL3      True if this is LL3 subband (uses only RAW)
 */
static void upgrade_subband_block(SRL_STATE* srl, BITSTREAM* raw,
                                   int16_t* current, int16_t* sign,
                                   size_t length, int shift, int numBits, bool isLL3)
{
    if (numBits == 0)
        return;
    
    uint32_t mask = (1u << numBits) - 1;
    
    for (size_t i = 0; i < length; i++)
    {
        int32_t input = 0;
        
        if (isLL3)
        {
            /* LL3 subband: always read from RAW stream */
            if (BitStream_GetRemainingLength(raw) >= numBits)
            {
                input = (int16_t)((raw->accumulator >> (32 - numBits)) & mask);
                BitStream_Shift(raw, numBits);
            }
        }
        else if (sign[i] > 0)
        {
            /* Positive sign: read from RAW stream */
            if (BitStream_GetRemainingLength(raw) >= numBits)
            {
                input = (int16_t)((raw->accumulator >> (32 - numBits)) & mask);
                BitStream_Shift(raw, numBits);
            }
        }
        else if (sign[i] < 0)
        {
            /* Negative sign: read from RAW stream and negate */
            if (BitStream_GetRemainingLength(raw) >= numBits)
            {
                input = (int16_t)((raw->accumulator >> (32 - numBits)) & mask);
                BitStream_Shift(raw, numBits);
                input = -input;
            }
        }
        else
        {
            /* Zero sign: read from SRL stream */
            if (BitStream_GetRemainingLength(srl->bs) > 0)
            {
                input = srl_read_value(srl, numBits);
                /* Store actual decoded value (not just sign bit) like FreeRDP */
                sign[i] = (int16_t)input;
            }
        }
        
        /* Apply shift and add to current coefficient */
        int32_t val = input << shift;
        int32_t result = current[i] + val;
        
        /* Clamp to int16_t range */
        if (result > 32767) result = 32767;
        if (result < -32768) result = -32768;
        
        current[i] = (int16_t)result;
    }
}

/**
 * rfx_progressive_upgrade_component - Full per-subband upgrade
 * Based on FreeRDP's progressive_rfx_upgrade_component
 *
 * @param srlData      SRL bitstream data
 * @param srlLen       SRL data length in bytes
 * @param rawData      RAW bitstream data
 * @param rawLen       RAW data length in bytes  
 * @param current      Current coefficient buffer (4096 int16_t)
 * @param sign         Sign buffer (4096 int16_t, stored as int16_t for FreeRDP compat)
 * @param shift        Per-subband shift values
 * @param numBits      Per-subband numBits values (difference from previous bitPos)
 * @param extrapolate  True if using extrapolated tile layout
 * @return 0 on success, -1 on error
 */
int rfx_progressive_upgrade_component(
    const uint8_t* srlData, size_t srlLen,
    const uint8_t* rawData, size_t rawLen,
    int16_t* current, int16_t* sign,
    const RfxComponentCodecQuant* shift,
    const RfxComponentCodecQuant* numBits,
    bool extrapolate)
{
    BITSTREAM bsSrl, bsRaw;
    
    /* Initialize SRL stream */
    if (srlData && srlLen > 0) {
        BitStream_Attach(&bsSrl, srlData, (uint32_t)srlLen);
        BitStream_Fetch(&bsSrl);
    } else {
        memset(&bsSrl, 0, sizeof(bsSrl));
    }
    
    /* Initialize RAW stream */
    if (rawData && rawLen > 0) {
        BitStream_Attach(&bsRaw, rawData, (uint32_t)rawLen);
        BitStream_Fetch(&bsRaw);
    } else {
        memset(&bsRaw, 0, sizeof(bsRaw));
    }
    
    SRL_STATE srlState;
    srlState.bs = &bsSrl;
    srlState.kp = 8;
    srlState.nz = 0;
    srlState.mode = 0;
    
    /* Select subband layout based on extrapolate flag */
    const struct { size_t offset; size_t length; }* subbands = 
        extrapolate ? SUBBAND_EXTRAPOLATED : SUBBAND_NORMAL;
    
    /* Process each subband with its own shift and numBits */
    /* Order: HL1, LH1, HH1, HL2, LH2, HH2, HL3, LH3, HH3, LL3 */
    upgrade_subband_block(&srlState, &bsRaw, 
        &current[subbands[0].offset], &sign[subbands[0].offset],
        subbands[0].length, shift->HL1, numBits->HL1, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[1].offset], &sign[subbands[1].offset],
        subbands[1].length, shift->LH1, numBits->LH1, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[2].offset], &sign[subbands[2].offset],
        subbands[2].length, shift->HH1, numBits->HH1, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[3].offset], &sign[subbands[3].offset],
        subbands[3].length, shift->HL2, numBits->HL2, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[4].offset], &sign[subbands[4].offset],
        subbands[4].length, shift->LH2, numBits->LH2, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[5].offset], &sign[subbands[5].offset],
        subbands[5].length, shift->HH2, numBits->HH2, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[6].offset], &sign[subbands[6].offset],
        subbands[6].length, shift->HL3, numBits->HL3, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[7].offset], &sign[subbands[7].offset],
        subbands[7].length, shift->LH3, numBits->LH3, false);
    
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[8].offset], &sign[subbands[8].offset],
        subbands[8].length, shift->HH3, numBits->HH3, false);
    
    /* LL3 uses only RAW stream (isLL3 = true) */
    upgrade_subband_block(&srlState, &bsRaw,
        &current[subbands[9].offset], &sign[subbands[9].offset],
        subbands[9].length, shift->LL3, numBits->LL3, true);
    
    return 0;
}

/**
 * rfx_srl_decode - Legacy SRL decoder (kept for compatibility)
 * NOTE: This uses simplified flat processing. For proper progressive upgrades,
 * use rfx_progressive_upgrade_component which handles per-subband shifts.
 */
int rfx_srl_decode(const uint8_t* srlData, size_t srlLen,
                   int16_t* current, int8_t* sign,
                   size_t length, int shiftBits)
{
    if (!srlData || srlLen == 0 || !current || !sign || length == 0)
        return -1;
    
    BITSTREAM bs;
    BitStream_Attach(&bs, srlData, (uint32_t)srlLen);
    BitStream_Fetch(&bs);
    
    SRL_STATE state;
    state.bs = &bs;
    state.kp = 8;
    state.nz = 0;
    state.mode = 0;
    
    uint32_t numBits = 1;
    
    for (size_t i = 0; i < length && BitStream_GetRemainingLength(&bs) > 0; i++)
    {
        if (sign[i] == 0)
        {
            int16_t val = srl_read_value(&state, numBits);
            
            if (val != 0 && shiftBits > 0) {
                int32_t shifted = (int32_t)val << shiftBits;
                if (shifted > 32767) shifted = 32767;
                if (shifted < -32768) shifted = -32768;
                val = (int16_t)shifted;
            }
            
            current[i] += val;
            sign[i] = (val > 0) ? 1 : ((val < 0) ? -1 : 0);
        }
    }
    
    return 0;
}
