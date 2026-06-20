/**
 * Wire Format Definitions for GFX Event Stream
 * 
 * All messages use 4-byte magic headers followed by binary payload.
 * Little-endian byte order throughout.
 */

// ============================================================================
// Magic codes (4 bytes each)
// ============================================================================

export const Magic = {
    // Surface management
    SURF: new Uint8Array([0x53, 0x55, 0x52, 0x46]),  // "SURF" - createSurface
    DELS: new Uint8Array([0x44, 0x45, 0x4C, 0x53]),  // "DELS" - deleteSurface
    MAPS: new Uint8Array([0x4D, 0x41, 0x50, 0x53]),  // "MAPS" - mapSurfaceToOutput
    
    // Frame lifecycle
    STFR: new Uint8Array([0x53, 0x54, 0x46, 0x52]),  // "STFR" - startFrame
    ENFR: new Uint8Array([0x45, 0x4E, 0x46, 0x52]),  // "ENFR" - endFrame
    
    // Tile codecs
    PROG: new Uint8Array([0x50, 0x52, 0x4F, 0x47]),  // "PROG" - progressive tile
    WEBP: new Uint8Array([0x57, 0x45, 0x42, 0x50]),  // "WEBP" - WebP tile
    TILE: new Uint8Array([0x54, 0x49, 0x4C, 0x45]),  // "TILE" - raw RGBA tile
    CLRC: new Uint8Array([0x43, 0x4C, 0x52, 0x43]),  // "CLRC" - ClearCodec tile (raw wire for WASM)
    
    // Surface operations
    SFIL: new Uint8Array([0x53, 0x46, 0x49, 0x4C]),  // "SFIL" - solidFill
    S2SF: new Uint8Array([0x53, 0x32, 0x53, 0x46]),  // "S2SF" - surfaceToSurface
    C2SF: new Uint8Array([0x43, 0x32, 0x53, 0x46]),  // "C2SF" - cacheToSurface
    S2CH: new Uint8Array([0x53, 0x32, 0x43, 0x48]),  // "S2CH" - surfaceToCache
    EVCT: new Uint8Array([0x45, 0x56, 0x43, 0x54]),  // "EVCT" - evictCache
    RSGR: new Uint8Array([0x52, 0x53, 0x47, 0x52]),  // "RSGR" - resetGraphics
    CAPS: new Uint8Array([0x43, 0x41, 0x50, 0x53]),  // "CAPS" - capsConfirm
    
    // Video
    H264: new Uint8Array([0x48, 0x32, 0x36, 0x34]),  // "H264" - H.264 NAL
    
    // Backchannel (browser → server)
    FACK: new Uint8Array([0x46, 0x41, 0x43, 0x4B]),  // "FACK" - frameAck
    
    // Audio
    OPUS: new Uint8Array([0x4F, 0x50, 0x55, 0x53]),  // "OPUS" - Opus audio
    AUDI: new Uint8Array([0x41, 0x55, 0x44, 0x49]),  // "AUDI" - raw audio
    
    // Initialization
    INIT: new Uint8Array([0x49, 0x4E, 0x49, 0x54]),  // "INIT" - initSettings
    
    // Pointer/Cursor
    PPOS: new Uint8Array([0x50, 0x50, 0x4F, 0x53]),  // "PPOS" - pointerPosition
    PSYS: new Uint8Array([0x50, 0x53, 0x59, 0x53]),  // "PSYS" - pointerSystem
    PSET: new Uint8Array([0x50, 0x53, 0x45, 0x54]),  // "PSET" - pointerSet
};

// ============================================================================
// Message type detection
// ============================================================================

/**
 * Check if buffer starts with given magic bytes
 */
export function matchMagic(data, magic) {
    if (data.length < 4) return false;
    return data[0] === magic[0] && data[1] === magic[1] && 
           data[2] === magic[2] && data[3] === magic[3];
}

/**
 * Get message type from magic header
 */
export function getMessageType(data) {
    if (data.length < 4) return null;
    
    for (const [name, magic] of Object.entries(Magic)) {
        if (matchMagic(data, magic)) {
            return name;
        }
    }
    return null;
}

// ============================================================================
// Binary reading utilities
// ============================================================================

export function readU16LE(data, offset) {
    return data[offset] | (data[offset + 1] << 8);
}

export function readU32LE(data, offset) {
    return data[offset] | (data[offset + 1] << 8) | 
           (data[offset + 2] << 16) | (data[offset + 3] << 24);
}

export function readI16LE(data, offset) {
    const val = readU16LE(data, offset);
    return val > 0x7FFF ? val - 0x10000 : val;
}

// ============================================================================
// Binary writing utilities
// ============================================================================

export function writeU16LE(data, offset, value) {
    data[offset] = value & 0xFF;
    data[offset + 1] = (value >> 8) & 0xFF;
}

export function writeU32LE(data, offset, value) {
    data[offset] = value & 0xFF;
    data[offset + 1] = (value >> 8) & 0xFF;
    data[offset + 2] = (value >> 16) & 0xFF;
    data[offset + 3] = (value >> 24) & 0xFF;
}

// ============================================================================
// Message Parsers (server → browser)
// ============================================================================

/**
 * Parse createSurface message
 * Layout: SURF(4) + surfaceId(2) + width(2) + height(2) + format(2) = 12 bytes
 */
export function parseCreateSurface(data) {
    if (data.length < 12) return null;
    return {
        type: 'createSurface',
        surfaceId: readU16LE(data, 4),
        width: readU16LE(data, 6),
        height: readU16LE(data, 8),
        format: readU16LE(data, 10),
    };
}

/**
 * Parse deleteSurface message
 * Layout: DELS(4) + surfaceId(2) = 6 bytes
 */
export function parseDeleteSurface(data) {
    if (data.length < 6) return null;
    return {
        type: 'deleteSurface',
        surfaceId: readU16LE(data, 4),
    };
}

/**
 * Parse mapSurfaceToOutput message
 * Layout: MAPS(4) + surfaceId(2) + outputX(2) + outputY(2) = 10 bytes
 */
export function parseMapSurface(data) {
    if (data.length < 10) return null;
    return {
        type: 'mapSurface',
        surfaceId: readU16LE(data, 4),
        outputX: readU16LE(data, 6),
        outputY: readU16LE(data, 8),
    };
}

/**
 * Parse startFrame message
 * Layout: STFR(4) + frameId(4) = 8 bytes
 */
export function parseStartFrame(data) {
    if (data.length < 8) return null;
    return {
        type: 'startFrame',
        frameId: readU32LE(data, 4),
    };
}

/**
 * Parse endFrame message
 * Layout: ENFR(4) + frameId(4) = 8 bytes
 */
export function parseEndFrame(data) {
    if (data.length < 8) return null;
    return {
        type: 'endFrame',
        frameId: readU32LE(data, 4),
    };
}

/**
 * Parse progressive tile message
 * Layout: PROG(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + dataSize(4) + data
 * Total header: 22 bytes
 */
export function parseProgressiveTile(data) {
    if (data.length < 22) return null;
    const dataSize = readU32LE(data, 18);
    if (data.length < 22 + dataSize) return null;
    
    return {
        type: 'tile',
        codec: 'progressive',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        x: readU16LE(data, 10),
        y: readU16LE(data, 12),
        w: readU16LE(data, 14),
        h: readU16LE(data, 16),
        payload: data.subarray(22, 22 + dataSize),
    };
}

/**
 * Parse WebP tile message
 * Layout: WEBP(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + dataSize(4) + data
 * Total header: 22 bytes
 */
export function parseWebPTile(data) {
    if (data.length < 22) return null;
    const dataSize = readU32LE(data, 18);
    if (data.length < 22 + dataSize) return null;
    
    return {
        type: 'tile',
        codec: 'webp',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        x: readU16LE(data, 10),
        y: readU16LE(data, 12),
        w: readU16LE(data, 14),
        h: readU16LE(data, 16),
        payload: data.subarray(22, 22 + dataSize),
    };
}

/**
 * Parse raw RGBA tile message
 * Layout: TILE(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + data
 * Header: 18 bytes, data = w * h * 4 bytes
 */
export function parseRawTile(data) {
    if (data.length < 18) return null;
    const w = readU16LE(data, 14);
    const h = readU16LE(data, 16);
    const expectedSize = 18 + w * h * 4;
    if (data.length < expectedSize) return null;
    
    return {
        type: 'tile',
        codec: 'raw',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        x: readU16LE(data, 10),
        y: readU16LE(data, 12),
        w: w,
        h: h,
        payload: data.subarray(18, expectedSize),
    };
}

/**
 * Parse ClearCodec tile message
 * Layout: CLRC(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + dataSize(4) + data
 * Total header: 22 bytes
 */
export function parseClearCodecTile(data) {
    if (data.length < 22) return null;
    const dataSize = readU32LE(data, 18);
    if (data.length < 22 + dataSize) return null;
    
    return {
        type: 'tile',
        codec: 'clearcodec',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        x: readU16LE(data, 10),
        y: readU16LE(data, 12),
        w: readU16LE(data, 14),
        h: readU16LE(data, 16),
        payload: data.subarray(22, 22 + dataSize),
    };
}

/**
 * Parse solidFill message
 * Layout: SFIL(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + color(4) = 22 bytes
 */
export function parseSolidFill(data) {
    if (data.length < 22) return null;
    return {
        type: 'solidFill',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        x: readU16LE(data, 10),
        y: readU16LE(data, 12),
        w: readU16LE(data, 14),
        h: readU16LE(data, 16),
        color: readU32LE(data, 18),  // BGRA32
    };
}

/**
 * Parse surfaceToSurface message
 * Layout: S2SF(4) + frameId(4) + srcSurfaceId(2) + dstSurfaceId(2) + 
 *         srcX(2) + srcY(2) + srcW(2) + srcH(2) + dstX(2) + dstY(2) = 24 bytes
 */
export function parseSurfaceToSurface(data) {
    if (data.length < 24) return null;
    return {
        type: 'surfaceToSurface',
        frameId: readU32LE(data, 4),
        srcSurfaceId: readU16LE(data, 8),
        dstSurfaceId: readU16LE(data, 10),
        srcX: readU16LE(data, 12),
        srcY: readU16LE(data, 14),
        srcW: readU16LE(data, 16),
        srcH: readU16LE(data, 18),
        dstX: readU16LE(data, 20),
        dstY: readU16LE(data, 22),
    };
}

/**
 * Parse cacheToSurface message
 * Layout: C2SF(4) + frameId(4) + surfaceId(2) + cacheId(2) + dstX(2) + dstY(2) = 16 bytes
 */
export function parseCacheToSurface(data) {
    if (data.length < 16) return null;
    return {
        type: 'cacheToSurface',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        cacheSlot: readU16LE(data, 10),
        dstX: readI16LE(data, 12),
        dstY: readI16LE(data, 14),
    };
}

/**
 * Parse surfaceToCache message
 * Layout: S2CH(4) + frameId(4) + surfaceId(2) + cacheSlot(2) + x(2) + y(2) + w(2) + h(2) = 20 bytes
 */
export function parseSurfaceToCache(data) {
    if (data.length < 20) return null;
    return {
        type: 'surfaceToCache',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        cacheSlot: readU16LE(data, 10),
        x: readI16LE(data, 12),
        y: readI16LE(data, 14),
        w: readU16LE(data, 16),
        h: readU16LE(data, 18),
    };
}

/**
 * Parse evictCache message
 * Layout: EVCT(4) + frameId(4) + cacheSlot(2) = 10 bytes
 */
export function parseEvictCache(data) {
    if (data.length < 10) return null;
    return {
        type: 'evictCache',
        frameId: readU32LE(data, 4),
        cacheSlot: readU16LE(data, 8),
    };
}

/**
 * Parse resetGraphics message
 * Layout: RSGR(4) + width(2) + height(2) = 8 bytes
 */
export function parseResetGraphics(data) {
    if (data.length < 8) return null;
    return {
        type: 'resetGraphics',
        width: readU16LE(data, 4),
        height: readU16LE(data, 6),
    };
}

/**
 * Parse capsConfirm message
 * Layout: CAPS(4) + version(4) + flags(4) = 12 bytes
 */
export function parseCapsConfirm(data) {
    if (data.length < 12) return null;
    return {
        type: 'capsConfirm',
        version: readU32LE(data, 4),
        flags: readU32LE(data, 8),
    };
}

/**
 * Parse initSettings message
 * Layout: INIT(4) + colorDepth(4) + flagsLow(4) + flagsHigh(4) = 16 bytes
 * 
 * Decodes RDP session settings from the backend's freerdp_settings_get_bool calls.
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
export function parseInitSettings(data) {
    if (data.length < 16) return null;
    
    const colorDepth = readU32LE(data, 4);
    const flagsLow = readU32LE(data, 8);
    const flagsHigh = readU32LE(data, 12);
    
    return {
        type: 'initSettings',
        colorDepth: colorDepth,
        flagsLow: flagsLow,
        flagsHigh: flagsHigh,
        // Decoded boolean settings
        SupportGraphicsPipeline: !!(flagsLow & (1 << 0)),
        GfxH264:                 !!(flagsLow & (1 << 1)),
        GfxAVC444:               !!(flagsLow & (1 << 2)),
        GfxAVC444v2:             !!(flagsLow & (1 << 3)),
        GfxProgressive:          !!(flagsLow & (1 << 4)),
        GfxProgressiveV2:        !!(flagsLow & (1 << 5)),
        RemoteFxCodec:           !!(flagsLow & (1 << 6)),
        NSCodec:                 !!(flagsLow & (1 << 7)),
        JpegCodec:               !!(flagsLow & (1 << 8)),
        GfxPlanar:               !!(flagsLow & (1 << 9)),
        GfxSmallCache:           !!(flagsLow & (1 << 10)),
        GfxThinClient:           !!(flagsLow & (1 << 11)),
        GfxSendQoeAck:           !!(flagsLow & (1 << 12)),
        GfxSuspendFrameAck:      !!(flagsLow & (1 << 13)),
        AudioPlayback:           !!(flagsLow & (1 << 14)),
        AudioCapture:            !!(flagsLow & (1 << 15)),
        RemoteConsoleAudio:      !!(flagsLow & (1 << 16)),
    };
}

/**
 * Parse pointerPosition message
 * Layout: PPOS(4) + x(2) + y(2) = 8 bytes
 */
export function parsePointerPosition(data) {
    if (data.length < 8) return null;
    return {
        type: 'pointerPosition',
        x: readU16LE(data, 4),
        y: readU16LE(data, 6)
    };
}

/**
 * Parse pointerSystem message  
 * Layout: PSYS(4) + type(1) = 5 bytes
 */
export function parsePointerSystem(data) {
    if (data.length < 5) return null;
    return {
        type: 'pointerSystem',
        ptrType: data[4]  // 0=hidden, 1=default
    };
}

/**
 * Parse pointerSet message
 * Layout: PSET(4) + width(2) + height(2) + hotspotX(2) + hotspotY(2) + 
 *         dataLen(4) + bgra_data(variable) = 16 + dataLen bytes
 */
export function parsePointerSet(data) {
    if (data.length < 16) return null;
    const width = readU16LE(data, 4);
    const height = readU16LE(data, 6);
    const hotspotX = readU16LE(data, 8);
    const hotspotY = readU16LE(data, 10);
    const dataLen = readU32LE(data, 12);
    
    if (data.length < 16 + dataLen) return null;
    
    return {
        type: 'pointerSet',
        width,
        height,
        hotspotX,
        hotspotY,
        bgraData: data.subarray(16, 16 + dataLen)
    };
}

/**
 * Parse H.264 video frame (legacy format from existing implementation)
 * Layout: H264(4) + frameId(4) + surfaceId(2) + codecId(2) + frameType(1) + 
 *         destX(2) + destY(2) + destW(2) + destH(2) + nalSize(4) + chromaNalSize(4) + data
 */
export function parseH264Frame(data) {
    if (data.length < 29) return null;
    const nalSize = readU32LE(data, 21);
    const chromaNalSize = readU32LE(data, 25);
    if (data.length < 29 + nalSize + chromaNalSize) return null;
    
    return {
        type: 'videoFrame',
        frameId: readU32LE(data, 4),
        surfaceId: readU16LE(data, 8),
        codecId: readU16LE(data, 10),
        frameType: data[12],
        destX: readI16LE(data, 13),
        destY: readI16LE(data, 15),
        destW: readU16LE(data, 17),
        destH: readU16LE(data, 19),
        nalSize: nalSize,
        chromaNalSize: chromaNalSize,
        nalData: data.subarray(29, 29 + nalSize),
        chromaNalData: chromaNalSize > 0 ? data.subarray(29 + nalSize, 29 + nalSize + chromaNalSize) : null,
    };
}

// ============================================================================
// Message Builders (browser → server)
// ============================================================================

/**
 * Build frameAck message (MS-RDPEGFX 2.2.3.3 compliant)
 * Layout: FACK(4) + frameId(4) + totalFramesDecoded(4) + queueDepth(4) = 16 bytes
 * 
 * queueDepth values per spec:
 *   0x00000000: QUEUE_DEPTH_UNAVAILABLE - queue depth not known
 *   0xFFFFFFFF: SUSPEND_FRAME_ACKNOWLEDGEMENT - server should suspend
 *   Other: Actual number of unprocessed frames in client queue
 */
export function buildFrameAck(frameId, totalFramesDecoded, queueDepth = 0) {
    const data = new Uint8Array(16);
    data.set(Magic.FACK, 0);
    writeU32LE(data, 4, frameId);
    writeU32LE(data, 8, totalFramesDecoded);
    writeU32LE(data, 12, queueDepth);
    return data;
}

// ============================================================================
// Unified message parser
// ============================================================================

/**
 * Parse any incoming message based on magic header
 * @param {Uint8Array} data - Raw message bytes
 * @returns {Object|null} Parsed message or null if unknown
 */
export function parseMessage(data) {
    const type = getMessageType(data);
    
    switch (type) {
        case 'SURF': return parseCreateSurface(data);
        case 'DELS': return parseDeleteSurface(data);
        case 'MAPS': return parseMapSurface(data);
        case 'STFR': return parseStartFrame(data);
        case 'ENFR': return parseEndFrame(data);
        case 'PROG': return parseProgressiveTile(data);
        case 'WEBP': return parseWebPTile(data);
        case 'TILE': return parseRawTile(data);
        case 'CLRC': return parseClearCodecTile(data);
        case 'SFIL': return parseSolidFill(data);
        case 'S2SF': return parseSurfaceToSurface(data);
        case 'C2SF': return parseCacheToSurface(data);
        case 'S2CH': return parseSurfaceToCache(data);
        case 'EVCT': return parseEvictCache(data);
        case 'RSGR': return parseResetGraphics(data);
        case 'CAPS': return parseCapsConfirm(data);
        case 'INIT': return parseInitSettings(data);
        case 'H264': return parseH264Frame(data);
        case 'PPOS': return parsePointerPosition(data);
        case 'PSYS': return parsePointerSystem(data);
        case 'PSET': return parsePointerSet(data);
        default: return null;
    }
}
