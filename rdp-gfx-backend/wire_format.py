"""
Wire Format Definitions for GFX Event Stream

All messages use 4-byte magic headers followed by binary payload.
Little-endian byte order throughout.

This module mirrors frontend/wire-format.js for consistent binary protocol.
"""

import struct
from typing import Optional

# ============================================================================
# Magic codes (4 bytes each)
# ============================================================================

class Magic:
    """4-byte magic headers for each message type"""
    
    # Surface management
    SURF = b'SURF'  # createSurface
    DELS = b'DELS'  # deleteSurface
    MAPS = b'MAPS'  # mapSurfaceToOutput
    
    # Frame lifecycle
    STFR = b'STFR'  # startFrame
    ENFR = b'ENFR'  # endFrame
    
    # Tile codecs
    PROG = b'PROG'  # progressive tile
    WEBP = b'WEBP'  # WebP tile
    TILE = b'TILE'  # raw RGBA tile
    CLRC = b'CLRC'  # ClearCodec tile (raw wire data for WASM decoding)
    
    # Surface operations
    SFIL = b'SFIL'  # solidFill
    S2SF = b'S2SF'  # surfaceToSurface
    C2SF = b'C2SF'  # cacheToSurface
    S2CH = b'S2CH'  # surfaceToCache (frontend stores in its cache)
    EVCT = b'EVCT'  # evictCache (frontend deletes cache slot)
    RSGR = b'RSGR'  # resetGraphics (frontend resets all state)
    CAPS = b'CAPS'  # capsConfirm (server capability confirmation)
    
    # Video
    H264 = b'H264'  # H.264 NAL
    
    # Backchannel (browser → server)
    FACK = b'FACK'  # frameAck
    
    # Audio
    OPUS = b'OPUS'  # Opus audio
    AUDI = b'AUDI'  # raw audio
    
    # Initialization
    INIT = b'INIT'  # initSettings (RDP session settings from freerdp_settings_get_bool)
    
    # Pointer/Cursor
    PPOS = b'PPOS'  # pointerPosition
    PSYS = b'PSYS'  # pointerSystem (null/default)
    PSET = b'PSET'  # pointerSet (cursor bitmap)


# ============================================================================
# Message Builders (server → browser)
# ============================================================================

def build_create_surface(surface_id: int, width: int, height: int, 
                         pixel_format: int = 0x20) -> bytes:
    """
    Build createSurface message.
    
    Layout: SURF(4) + surfaceId(2) + width(2) + height(2) + format(2) = 12 bytes
    
    Args:
        surface_id: Surface identifier (0-65535)
        width: Surface width in pixels
        height: Surface height in pixels
        pixel_format: Pixel format (0x20 = BGRA32, 0x21 = RGBA32)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sHHHH', 
                       Magic.SURF, 
                       surface_id, 
                       width, 
                       height, 
                       pixel_format)


def build_delete_surface(surface_id: int) -> bytes:
    """
    Build deleteSurface message.
    
    Layout: DELS(4) + surfaceId(2) = 6 bytes
    
    Args:
        surface_id: Surface identifier to delete
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sH', Magic.DELS, surface_id)


def build_map_surface_to_output(surface_id: int, output_x: int = 0, output_y: int = 0) -> bytes:
    """
    Build mapSurfaceToOutput message.
    
    Layout: MAPS(4) + surfaceId(2) + outputX(2) + outputY(2) = 10 bytes
    
    Args:
        surface_id: Surface to map to primary output
        output_x: X position on output (usually 0)
        output_y: Y position on output (usually 0)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sHHH', Magic.MAPS, surface_id, output_x, output_y)


def build_start_frame(frame_id: int) -> bytes:
    """
    Build startFrame message.
    
    Layout: STFR(4) + frameId(4) = 8 bytes
    
    Args:
        frame_id: Frame sequence number
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sI', Magic.STFR, frame_id)


def build_end_frame(frame_id: int) -> bytes:
    """
    Build endFrame message.
    
    Layout: ENFR(4) + frameId(4) = 8 bytes
    
    Args:
        frame_id: Frame sequence number (must match startFrame)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sI', Magic.ENFR, frame_id)


def build_solid_fill(frame_id: int, surface_id: int,
                     x: int, y: int, w: int, h: int,
                     color: int) -> bytes:
    """
    Build solidFill message.
    
    Layout: SFIL(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + color(4) = 22 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Target surface
        x, y: Destination coordinates
        w, h: Fill dimensions
        color: Fill color (BGRA32)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sIHhhHHI',
                       Magic.SFIL,
                       frame_id,
                       surface_id,
                       x, y, w, h,
                       color)


def build_surface_to_surface(frame_id: int, src_surface_id: int, dst_surface_id: int,
                             src_x: int, src_y: int, src_w: int, src_h: int,
                             dst_x: int, dst_y: int) -> bytes:
    """
    Build surfaceToSurface message.
    
    Layout: S2SF(4) + frameId(4) + srcSurfaceId(2) + dstSurfaceId(2) + 
            srcX(2) + srcY(2) + srcW(2) + srcH(2) + dstX(2) + dstY(2) = 24 bytes
    
    Args:
        frame_id: Frame sequence number
        src_surface_id: Source surface
        dst_surface_id: Destination surface
        src_x, src_y: Source coordinates
        src_w, src_h: Source dimensions
        dst_x, dst_y: Destination coordinates
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sIHHhhHHhh',
                       Magic.S2SF,
                       frame_id,
                       src_surface_id,
                       dst_surface_id,
                       src_x, src_y, src_w, src_h,
                       dst_x, dst_y)


def build_surface_to_cache(frame_id: int, surface_id: int, cache_slot: int,
                           x: int, y: int, w: int, h: int) -> bytes:
    """
    Build surfaceToCache message.
    
    Tells frontend to extract pixels from surface and store in its local cache.
    Layout: S2CH(4) + frameId(4) + surfaceId(2) + cacheSlot(2) + 
            x(2) + y(2) + w(2) + h(2) = 20 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Source surface
        cache_slot: Cache slot to store in (0-4095)
        x, y: Source rectangle origin
        w, h: Source rectangle dimensions
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sIHHhhHH',
                       Magic.S2CH,
                       frame_id,
                       surface_id,
                       cache_slot,
                       x, y, w, h)


def build_cache_to_surface(frame_id: int, surface_id: int, cache_slot: int,
                           dst_x: int, dst_y: int) -> bytes:
    """
    Build cacheToSurface message.
    
    Tells frontend to blit from its local cache to a surface.
    Layout: C2SF(4) + frameId(4) + surfaceId(2) + cacheSlot(2) + 
            dstX(2) + dstY(2) = 16 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Destination surface
        cache_slot: Cache slot to read from
        dst_x, dst_y: Destination coordinates
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sIHHhh',
                       Magic.C2SF,
                       frame_id,
                       surface_id,
                       cache_slot,
                       dst_x, dst_y)


def build_evict_cache(frame_id: int, cache_slot: int) -> bytes:
    """
    Build evictCache message.
    
    Tells frontend to delete a cache slot.
    Layout: EVCT(4) + frameId(4) + cacheSlot(2) = 10 bytes
    
    Args:
        frame_id: Frame sequence number
        cache_slot: Cache slot to evict
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sIH',
                       Magic.EVCT,
                       frame_id,
                       cache_slot)


def build_reset_graphics(width: int, height: int) -> bytes:
    """
    Build resetGraphics message.
    
    Tells frontend to reset all state (surfaces, cache, progressive decoder).
    Layout: RSGR(4) + width(2) + height(2) = 8 bytes
    
    Args:
        width: New display width
        height: New display height
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sHH',
                       Magic.RSGR,
                       width,
                       height)


def build_caps_confirm(version: int, flags: int) -> bytes:
    """
    Build capsConfirm message.
    
    Informs frontend about server's confirmed GFX capabilities.
    Layout: CAPS(4) + version(4) + flags(4) = 12 bytes
    
    Args:
        version: GFX capability version (e.g., 0x00080105 = 8.1)
        flags: GFX capability flags (THINCLIENT, SMALL_CACHE, AVC420_ENABLED, etc.)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sII',
                       Magic.CAPS,
                       version,
                       flags)


def build_init_settings(settings: dict) -> bytes:
    """
    Build initSettings message with RDP session configuration.
    
    Sends initialization-related settings from freerdp_settings_get_bool to the frontend,
    allowing the frontend to display the same settings as log_settings() in the backend.
    
    Layout: INIT(4) + colorDepth(4) + flagsLow(4) + flagsHigh(4) = 16 bytes
    
    Flags are packed as bitfields:
      flagsLow (bits 0-31):
        bit 0:  SupportGraphicsPipeline
        bit 1:  GfxH264
        bit 2:  GfxAVC444
        bit 3:  GfxAVC444v2
        bit 4:  GfxProgressive
        bit 5:  GfxProgressiveV2
        bit 6:  RemoteFxCodec
        bit 7:  NSCodec
        bit 8:  JpegCodec
        bit 9:  GfxPlanar
        bit 10: GfxSmallCache
        bit 11: GfxThinClient
        bit 12: GfxSendQoeAck
        bit 13: GfxSuspendFrameAck
        bit 14: AudioPlayback
        bit 15: AudioCapture
        bit 16: RemoteConsoleAudio
      
      flagsHigh: Reserved for future settings
    
    Args:
        settings: Dictionary with boolean settings and colorDepth
            {
                'colorDepth': int,
                'SupportGraphicsPipeline': bool,
                'GfxH264': bool,
                'GfxAVC444': bool,
                'GfxAVC444v2': bool,
                'GfxProgressive': bool,
                'GfxProgressiveV2': bool,
                'RemoteFxCodec': bool,
                'NSCodec': bool,
                'JpegCodec': bool,
                'GfxPlanar': bool,
                'GfxSmallCache': bool,
                'GfxThinClient': bool,
                'GfxSendQoeAck': bool,
                'GfxSuspendFrameAck': bool,
                'AudioPlayback': bool,
                'AudioCapture': bool,
                'RemoteConsoleAudio': bool,
            }
    
    Returns:
        Binary message ready to send via WebSocket
    """
    color_depth = settings.get('colorDepth', 32)
    
    # Pack boolean settings into flagsLow
    flags_low = 0
    if settings.get('SupportGraphicsPipeline', False): flags_low |= (1 << 0)
    if settings.get('GfxH264', False):                 flags_low |= (1 << 1)
    if settings.get('GfxAVC444', False):               flags_low |= (1 << 2)
    if settings.get('GfxAVC444v2', False):             flags_low |= (1 << 3)
    if settings.get('GfxProgressive', False):          flags_low |= (1 << 4)
    if settings.get('GfxProgressiveV2', False):        flags_low |= (1 << 5)
    if settings.get('RemoteFxCodec', False):           flags_low |= (1 << 6)
    if settings.get('NSCodec', False):                 flags_low |= (1 << 7)
    if settings.get('JpegCodec', False):               flags_low |= (1 << 8)
    if settings.get('GfxPlanar', False):               flags_low |= (1 << 9)
    if settings.get('GfxSmallCache', False):           flags_low |= (1 << 10)
    if settings.get('GfxThinClient', False):           flags_low |= (1 << 11)
    if settings.get('GfxSendQoeAck', False):           flags_low |= (1 << 12)
    if settings.get('GfxSuspendFrameAck', False):      flags_low |= (1 << 13)
    if settings.get('AudioPlayback', False):           flags_low |= (1 << 14)
    if settings.get('AudioCapture', False):            flags_low |= (1 << 15)
    if settings.get('RemoteConsoleAudio', False):      flags_low |= (1 << 16)
    
    # Reserved for future use
    flags_high = 0
    
    return struct.pack('<4sIII',
                       Magic.INIT,
                       color_depth,
                       flags_low,
                       flags_high)


def build_clearcodec_tile(frame_id: int, surface_id: int,
                          x: int, y: int, w: int, h: int,
                          data: bytes) -> bytes:
    """
    Build ClearCodec tile message.
    
    Layout: CLRC(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + 
            dataSize(4) + data
    Total header: 22 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Target surface
        x, y: Destination coordinates on surface
        w, h: Tile dimensions
        data: ClearCodec compressed data (raw wire data for WASM decoding)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    header = struct.pack('<4sIHHHHHI',
                         Magic.CLRC,
                         frame_id,
                         surface_id,
                         x, y, w, h,
                         len(data))
    return header + data


def build_progressive_tile(frame_id: int, surface_id: int,
                           x: int, y: int, w: int, h: int,
                           data: bytes) -> bytes:
    """
    Build progressive tile message.
    
    Layout: PROG(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + 
            dataSize(4) + data
    Total header: 22 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Target surface
        x, y: Destination coordinates
        w, h: Tile dimensions
        data: Progressive codec compressed data
    
    Returns:
        Binary message ready to send via WebSocket
    """
    header = struct.pack('<4sIHHHHHI',
                         Magic.PROG,
                         frame_id,
                         surface_id,
                         x, y, w, h,
                         len(data))
    return header + data


def build_webp_tile(frame_id: int, surface_id: int,
                    x: int, y: int, w: int, h: int,
                    data: bytes) -> bytes:
    """
    Build WebP tile message.
    
    Layout: WEBP(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + 
            dataSize(4) + data
    Total header: 22 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Target surface
        x, y: Destination coordinates
        w, h: Tile dimensions
        data: WebP compressed image data
    
    Returns:
        Binary message ready to send via WebSocket
    """
    header = struct.pack('<4sIHHHHHI',
                         Magic.WEBP,
                         frame_id,
                         surface_id,
                         x, y, w, h,
                         len(data))
    return header + data


def build_raw_tile(frame_id: int, surface_id: int,
                   x: int, y: int, w: int, h: int,
                   data: bytes) -> bytes:
    """
    Build raw RGBA tile message.
    
    Layout: TILE(4) + frameId(4) + surfaceId(2) + x(2) + y(2) + w(2) + h(2) + 
            dataSize(4) + data
    Total header: 22 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Target surface
        x, y: Destination coordinates
        w, h: Tile dimensions
        data: Raw BGRA/RGBA pixel data (w * h * 4 bytes)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    header = struct.pack('<4sIHHHHHI',
                         Magic.TILE,
                         frame_id,
                         surface_id,
                         x, y, w, h,
                         len(data))
    return header + data


def build_h264_frame(frame_id: int, surface_id: int, codec_id: int,
                     frame_type: int, x: int, y: int, w: int, h: int,
                     nal_data: bytes, chroma_data: bytes = b'') -> bytes:
    """
    Build H.264 frame message.
    
    Layout: H264(4) + frameId(4) + surfaceId(2) + codecId(2) + 
            frameType(1) + x(2) + y(2) + w(2) + h(2) +
            nalSize(4) + chromaNalSize(4) + nalData + chromaNalData
    Header: 25 bytes
    
    Args:
        frame_id: Frame sequence number
        surface_id: Target surface
        codec_id: H.264 codec variant (AVC420=0x08020, AVC444=0x08400)
        frame_type: I-frame=0, P-frame=1
        x, y: Destination coordinates
        w, h: Frame dimensions
        nal_data: H.264 NAL unit data
        chroma_data: Optional AVC444 chroma NAL data
    
    Returns:
        Binary message ready to send via WebSocket
    """
    header = struct.pack('<4sIHHBhhHHII',
                         Magic.H264,
                         frame_id,
                         surface_id,
                         codec_id,
                         frame_type,
                         x, y, w, h,
                         len(nal_data),
                         len(chroma_data))
    return header + nal_data + chroma_data


# ============================================================================
# Message Parsers (browser → server)
# ============================================================================

def build_pointer_position(x: int, y: int) -> bytes:
    """
    Build pointerPosition message.
    
    Layout: PPOS(4) + x(2) + y(2) = 8 bytes
    
    Args:
        x: Cursor X position
        y: Cursor Y position
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sHH', Magic.PPOS, x, y)


def build_pointer_system(ptr_type: int) -> bytes:
    """
    Build pointerSystem message.
    
    Layout: PSYS(4) + type(1) = 5 bytes
    
    Args:
        ptr_type: 0=hidden, 1=default
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sB', Magic.PSYS, ptr_type)


def build_pointer_set(width: int, height: int, hotspot_x: int, hotspot_y: int,
                      bgra_data: bytes) -> bytes:
    """
    Build pointerSet message with cursor bitmap.
    
    Layout: PSET(4) + width(2) + height(2) + hotspotX(2) + hotspotY(2) + 
            dataLen(4) + bgra_data(variable) = 16 + dataLen bytes
    
    Args:
        width: Cursor width in pixels
        height: Cursor height in pixels
        hotspot_x: Hotspot X coordinate
        hotspot_y: Hotspot Y coordinate
        bgra_data: BGRA32 pixel data (width * height * 4 bytes)
    
    Returns:
        Binary message ready to send via WebSocket
    """
    return struct.pack('<4sHHHHI',
                       Magic.PSET,
                       width, height,
                       hotspot_x, hotspot_y,
                       len(bgra_data)) + bgra_data


def parse_frame_ack(data: bytes) -> Optional[dict]:
    """
    Parse frameAck message from browser (MS-RDPEGFX 2.2.3.3 compliant).
    
    Layout: FACK(4) + frameId(4) + totalFramesDecoded(4) + queueDepth(4) = 16 bytes
    
    queueDepth values per spec:
      0x00000000 (QUEUE_DEPTH_UNAVAILABLE): Queue depth not available
      0xFFFFFFFF (SUSPEND_FRAME_ACKNOWLEDGEMENT): Suspend frame sending
      Other: Actual number of unprocessed frames in client queue
    
    Args:
        data: Binary message from WebSocket
    
    Returns:
        Parsed message dict or None if invalid
    """
    if len(data) < 16:
        return None
    if data[:4] != Magic.FACK:
        return None
    
    frame_id, total_decoded, queue_depth = struct.unpack('<III', data[4:16])
    return {
        'type': 'frameAck',
        'frame_id': frame_id,
        'total_frames_decoded': total_decoded,
        'queue_depth': queue_depth
    }


def get_message_type(data: bytes) -> Optional[str]:
    """
    Get message type from magic header.
    
    Args:
        data: Binary message
    
    Returns:
        Message type string or None if unrecognized
    """
    if len(data) < 4:
        return None
    
    magic = data[:4]
    
    # Map magic to type name
    type_map = {
        Magic.SURF: 'createSurface',
        Magic.DELS: 'deleteSurface',
        Magic.STFR: 'startFrame',
        Magic.ENFR: 'endFrame',
        Magic.PROG: 'progressiveTile',
        Magic.WEBP: 'webpTile',
        Magic.TILE: 'rawTile',
        Magic.SFIL: 'solidFill',
        Magic.S2SF: 'surfaceToSurface',
        Magic.C2SF: 'cacheToSurface',
        Magic.H264: 'h264Frame',
        Magic.FACK: 'frameAck',
        Magic.OPUS: 'opusAudio',
        Magic.AUDI: 'rawAudio',
    }
    
    return type_map.get(magic)
