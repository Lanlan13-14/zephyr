"""
RDP Bridge Module - Native FreeRDP3 Integration

Uses a native C library (librdp_bridge.so) for direct RDP connection with:
- Direct input injection (no X11/xdotool)
- GFX event streaming with wire format binary protocol
- WebP encoding performed in C for optimal performance
"""

import asyncio
import base64
import ctypes
import io
import json
import logging
import os
import struct
import tempfile
import uuid
from ctypes import (
    POINTER, Structure, c_bool, c_char_p, c_int, c_int32, c_uint8,
    c_uint16, c_uint32, c_void_p
)
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# Import wire format for new binary protocol
from wire_format import (
    Magic, build_create_surface, build_delete_surface, build_start_frame,
    build_end_frame, build_solid_fill, build_surface_to_surface,
    build_surface_to_cache, build_cache_to_surface, build_evict_cache,
    build_map_surface_to_output, build_webp_tile, build_h264_frame,
    build_reset_graphics, parse_frame_ack, get_message_type,
    build_caps_confirm, build_init_settings,
    build_clearcodec_tile,
    build_pointer_position, build_pointer_system, build_pointer_set
)

# Import security policy for connection validation
from rdp_security import get_security_policy

logger = logging.getLogger('rdp-bridge')


@dataclass
class RDPConfig:
    """RDP connection configuration"""
    host: str
    port: int = 3389
    username: str = ''
    password: str = ''
    domain: str = ''
    width: int = 1280
    height: int = 720
    color_depth: int = 32
    fps: int = 60
    quality: str = 'balanced'


# Mouse button flags (matching native library)
RDP_MOUSE_FLAG_MOVE = 0x0800
RDP_MOUSE_FLAG_BUTTON1 = 0x1000  # Left
RDP_MOUSE_FLAG_BUTTON2 = 0x2000  # Right
RDP_MOUSE_FLAG_BUTTON3 = 0x4000  # Middle
RDP_MOUSE_FLAG_DOWN = 0x8000
RDP_MOUSE_FLAG_WHEEL = 0x0200
RDP_MOUSE_FLAG_HWHEEL = 0x0400
RDP_MOUSE_FLAG_NEGATIVE = 0x0100

# Keyboard flags
RDP_KBD_FLAG_DOWN = 0x0000
RDP_KBD_FLAG_RELEASE = 0x8000
RDP_KBD_FLAG_EXTENDED = 0x0100

# Session states
RDP_STATE_DISCONNECTED = 0
RDP_STATE_CONNECTING = 1
RDP_STATE_CONNECTED = 2
RDP_STATE_ERROR = 3

# Audio frame magic header (PCM - legacy)
AUDIO_FRAME_MAGIC = b'AUDI'

# Opus audio frame magic header
OPUS_AUDIO_MAGIC = b'OPUS'

# H.264 frame magic header (GFX pipeline)
H264_FRAME_MAGIC = b'H264'
CLRC_FRAME_MAGIC = b'CLRC'

# H.264 frame types
RDP_H264_FRAME_TYPE_IDR = 0  # Keyframe
RDP_H264_FRAME_TYPE_P = 1    # Predictive
RDP_H264_FRAME_TYPE_B = 2    # Bi-predictive

# GFX codec IDs (from FreeRDP's rdpgfx.h) - for logging only
RDP_GFX_CODEC_CLEARCODEC = 0x0003
RDP_GFX_CODEC_AVC420 = 0x0009
RDP_GFX_CODEC_AVC444 = 0x000B
RDP_GFX_CODEC_AVC444v2 = 0x000E
RDP_GFX_CODEC_PROGRESSIVE = 0x000C
RDP_GFX_CODEC_PROGRESSIVE_V2 = 0x000D

# Resolution limits - minimum and maximum allowed screen dimensions
RDP_MIN_WIDTH = 640
RDP_MAX_WIDTH = 4096
RDP_MIN_HEIGHT = 480
RDP_MAX_HEIGHT = 2304


class RdpRect(Structure):
    """Rectangle structure for GFX frame positioning (matches C struct)"""
    _fields_ = [
        ('x', c_int32),
        ('y', c_int32),
        ('width', c_int32),
        ('height', c_int32),
    ]


class RdpGfxSurface(Structure):
    """GFX surface descriptor (matches C struct)"""
    _fields_ = [
        ('surface_id', c_uint16),
        ('width', c_uint32),
        ('height', c_uint32),
        ('pixel_format', c_uint32),
        ('active', c_bool),
        ('mapped_to_output', c_bool),
        ('output_x', c_int32),
        ('output_y', c_int32),
    ]


# GFX event type constants (match C enum RdpGfxEventType)
RDP_GFX_EVENT_NONE = 0
RDP_GFX_EVENT_CREATE_SURFACE = 1
RDP_GFX_EVENT_DELETE_SURFACE = 2
RDP_GFX_EVENT_MAP_SURFACE = 3
RDP_GFX_EVENT_START_FRAME = 4
RDP_GFX_EVENT_END_FRAME = 5
RDP_GFX_EVENT_SOLID_FILL = 6
RDP_GFX_EVENT_SURFACE_TO_SURFACE = 7
RDP_GFX_EVENT_CACHE_TO_SURFACE = 8
RDP_GFX_EVENT_SURFACE_TO_CACHE = 9
RDP_GFX_EVENT_WEBP_TILE = 10
RDP_GFX_EVENT_VIDEO_FRAME = 11
RDP_GFX_EVENT_EVICT_CACHE = 12
RDP_GFX_EVENT_RESET_GRAPHICS = 13
RDP_GFX_EVENT_CAPS_CONFIRM = 14
RDP_GFX_EVENT_INIT_SETTINGS = 15
RDP_GFX_EVENT_POINTER_POSITION = 16
RDP_GFX_EVENT_POINTER_SYSTEM = 17
RDP_GFX_EVENT_POINTER_SET = 18


class RdpGfxEvent(Structure):
    """GFX event for wire format streaming (matches C struct)"""
    _fields_ = [
        ('type', c_int),
        ('frame_id', c_uint32),
        ('surface_id', c_uint16),
        ('dst_surface_id', c_uint16),
        ('width', c_uint32),
        ('height', c_uint32),
        ('pixel_format', c_uint32),
        ('x', c_int32),
        ('y', c_int32),
        ('src_x', c_int32),
        ('src_y', c_int32),
        ('color', c_uint32),
        ('cache_slot', c_uint16),
        ('bitmap_data', c_void_p),  # Pointer to bitmap data (for S2C)
        ('bitmap_size', c_uint32),  # Size of bitmap data
        # Video frame data (for VIDEO_FRAME - H.264/Progressive)
        ('codec_id', c_int),        # RdpGfxCodecId
        ('video_frame_type', c_int), # RdpH264FrameType
        ('nal_data', c_void_p),     # NAL/Progressive data pointer
        ('nal_size', c_uint32),     # Size of NAL data
        ('chroma_nal_data', c_void_p), # Chroma NAL for AVC444
        ('chroma_nal_size', c_uint32), # Size of chroma NAL
        # Capability confirmation (for CAPS_CONFIRM)
        ('gfx_version', c_uint32),  # GFX version from CapsConfirm
        ('gfx_flags', c_uint32),    # GFX flags from CapsConfirm
        # Initialization settings (for INIT_SETTINGS)
        ('init_color_depth', c_uint32),  # ColorDepth setting
        ('init_flags_low', c_uint32),    # Boolean settings packed as bitfield (bits 0-31)
        ('init_flags_high', c_uint32),   # Reserved for future settings (bits 32-63)
        # Pointer/cursor fields (for POINTER_POSITION, POINTER_SYSTEM, POINTER_SET)
        ('pointer_x', c_uint16),          # Pointer X position
        ('pointer_y', c_uint16),          # Pointer Y position
        ('pointer_hotspot_x', c_uint16),  # Hotspot X offset
        ('pointer_hotspot_y', c_uint16),  # Hotspot Y offset
        ('pointer_width', c_uint16),      # Cursor width
        ('pointer_height', c_uint16),     # Cursor height
        ('pointer_system_type', c_uint8), # System pointer type (0=NULL, 1=DEFAULT)
        ('pointer_data', c_void_p),       # BGRA cursor bitmap data
        ('pointer_data_size', c_uint32),  # Size of cursor data
    ]


# Keyboard scan code mapping (JS code -> RDP scan code)
SCANCODE_MAP = {
    'Escape': 0x01, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
    'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
    'Digit8': 0x09, 'Digit9': 0x0A, 'Digit0': 0x0B, 'Minus': 0x0C,
    'Equal': 0x0D, 'Backspace': 0x0E, 'Tab': 0x0F, 'KeyQ': 0x10,
    'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13, 'KeyT': 0x14,
    'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17, 'KeyO': 0x18,
    'KeyP': 0x19, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
    'Enter': 0x1C, 'ControlLeft': 0x1D, 'KeyA': 0x1E, 'KeyS': 0x1F,
    'KeyD': 0x20, 'KeyF': 0x21, 'KeyG': 0x22, 'KeyH': 0x23,
    'KeyJ': 0x24, 'KeyK': 0x25, 'KeyL': 0x26, 'Semicolon': 0x27,
    'Quote': 0x28, 'Backquote': 0x29, 'ShiftLeft': 0x2A,
    'Backslash': 0x2B, 'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E,
    'KeyV': 0x2F, 'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32,
    'Comma': 0x33, 'Period': 0x34, 'Slash': 0x35, 'ShiftRight': 0x36,
    'NumpadMultiply': 0x37, 'AltLeft': 0x38, 'Space': 0x39,
    'CapsLock': 0x3A, 'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D,
    'F4': 0x3E, 'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
    'F9': 0x43, 'F10': 0x44, 'NumLock': 0x45, 'ScrollLock': 0x46,
    'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
    'NumpadSubtract': 0x4A, 'Numpad4': 0x4B, 'Numpad5': 0x4C,
    'Numpad6': 0x4D, 'NumpadAdd': 0x4E, 'Numpad1': 0x4F,
    'Numpad2': 0x50, 'Numpad3': 0x51, 'Numpad0': 0x52,
    'NumpadDecimal': 0x53, 'F11': 0x57, 'F12': 0x58,
    # Extended keys (need EXTENDED flag)
    'NumpadEnter': 0x1C, 'ControlRight': 0x1D, 'NumpadDivide': 0x35,
    'PrintScreen': 0x37, 'AltRight': 0x38, 'Home': 0x47,
    'ArrowUp': 0x48, 'PageUp': 0x49, 'ArrowLeft': 0x4B,
    'ArrowRight': 0x4D, 'End': 0x4F, 'ArrowDown': 0x50,
    'PageDown': 0x51, 'Insert': 0x52, 'Delete': 0x53,
    'MetaLeft': 0x5B, 'MetaRight': 0x5C, 'ContextMenu': 0x5D,
}

# Extended keys that need the EXTENDED flag
EXTENDED_KEYS = {
    'NumpadEnter', 'ControlRight', 'NumpadDivide', 'PrintScreen',
    'AltRight', 'Home', 'ArrowUp', 'PageUp', 'ArrowLeft',
    'ArrowRight', 'End', 'ArrowDown', 'PageDown', 'Insert', 'Delete',
    'MetaLeft', 'MetaRight', 'ContextMenu',
}


class NativeLibrary:
    """Wrapper for the native RDP bridge library"""
    
    _instance: Optional['NativeLibrary'] = None
    _lib: Optional[ctypes.CDLL] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load_library()
        return cls._instance
    
    def _load_library(self):
        """Load the native library and set up function signatures"""
        env_path = os.getenv('RDP_BRIDGE_LIBRARY')
        lib_paths = [p for p in [
            env_path,
            str(Path(__file__).parent / 'native' / 'build' / 'librdp_bridge.so'),
            str(Path(__file__).parent / 'libs' / 'librdp_bridge.so'),
            '/usr/local/lib/librdp_bridge.so',
            'librdp_bridge.so',
        ] if p]
        
        for path in lib_paths:
            try:
                # Use RTLD_GLOBAL so symbols are visible to plugins loaded by FreeRDP
                # The rdpsnd bridge plugin uses dlsym(RTLD_DEFAULT, ...) to find
                # rdp_get_current_audio_context() exported by this library
                self._lib = ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                logger.info(f"Loaded native library from: {path}")
                break
            except OSError:
                continue
        
        if self._lib is None:
            raise RuntimeError(
                "Failed to load librdp_bridge.so. "
                "Ensure the native library is built and installed."
            )
        
        self._setup_functions()
    
    def _setup_functions(self):
        """Define function signatures for type safety"""
        lib = self._lib
        
        # rdp_create
        lib.rdp_create.argtypes = [
            c_char_p, c_uint16, c_char_p, c_char_p, c_char_p,
            c_uint32, c_uint32, c_uint32
        ]
        lib.rdp_create.restype = c_void_p
        
        # rdp_connect
        lib.rdp_connect.argtypes = [c_void_p]
        lib.rdp_connect.restype = c_int
        
        # rdp_get_state
        lib.rdp_get_state.argtypes = [c_void_p]
        lib.rdp_get_state.restype = c_int
        
        # rdp_get_error
        lib.rdp_get_error.argtypes = [c_void_p]
        lib.rdp_get_error.restype = c_char_p
        
        # rdp_poll
        lib.rdp_poll.argtypes = [c_void_p, c_int]
        lib.rdp_poll.restype = c_int
        
        # rdp_gfx_frame_in_progress
        lib.rdp_gfx_frame_in_progress.argtypes = [c_void_p]
        lib.rdp_gfx_frame_in_progress.restype = c_bool
        
        # rdp_gfx_get_last_completed_frame
        lib.rdp_gfx_get_last_completed_frame.argtypes = [c_void_p]
        lib.rdp_gfx_get_last_completed_frame.restype = c_uint32
        
        # rdp_send_mouse
        lib.rdp_send_mouse.argtypes = [c_void_p, c_uint16, c_int, c_int]
        lib.rdp_send_mouse.restype = None
        
        # rdp_send_keyboard
        lib.rdp_send_keyboard.argtypes = [c_void_p, c_uint16, c_uint16]
        lib.rdp_send_keyboard.restype = None
        
        # rdp_send_unicode
        lib.rdp_send_unicode.argtypes = [c_void_p, c_uint16, c_uint16]
        lib.rdp_send_unicode.restype = None
        
        # rdp_resize
        lib.rdp_resize.argtypes = [c_void_p, c_uint32, c_uint32]
        lib.rdp_resize.restype = c_int
        
        # rdp_disconnect
        lib.rdp_disconnect.argtypes = [c_void_p]
        lib.rdp_disconnect.restype = None
        
        # rdp_destroy
        lib.rdp_destroy.argtypes = [c_void_p]
        lib.rdp_destroy.restype = None
        
        # rdp_version
        lib.rdp_version.argtypes = []
        lib.rdp_version.restype = c_char_p
        
        # rdp_has_audio_data
        lib.rdp_has_audio_data.argtypes = [c_void_p]
        lib.rdp_has_audio_data.restype = c_bool
        
        # rdp_get_audio_format
        lib.rdp_get_audio_format.argtypes = [
            c_void_p, POINTER(c_int), POINTER(c_int), POINTER(c_int)
        ]
        lib.rdp_get_audio_format.restype = c_int
        
        # rdp_get_audio_data
        lib.rdp_get_audio_data.argtypes = [c_void_p, POINTER(c_uint8), c_int]
        lib.rdp_get_audio_data.restype = c_int
        
        # Opus audio API functions
        # rdp_has_opus_data
        lib.rdp_has_opus_data.argtypes = [c_void_p]
        lib.rdp_has_opus_data.restype = c_bool
        
        # rdp_get_opus_format
        lib.rdp_get_opus_format.argtypes = [
            c_void_p, POINTER(c_int), POINTER(c_int)
        ]
        lib.rdp_get_opus_format.restype = c_int
        
        # rdp_get_opus_frame
        lib.rdp_get_opus_frame.argtypes = [c_void_p, POINTER(c_uint8), c_int]
        lib.rdp_get_opus_frame.restype = c_int
        
        # rdp_get_audio_stats - for debugging audio buffer state
        lib.rdp_get_audio_stats.argtypes = [
            c_void_p, POINTER(c_int), POINTER(ctypes.c_size_t), 
            POINTER(ctypes.c_size_t), POINTER(ctypes.c_size_t)
        ]
        lib.rdp_get_audio_stats.restype = c_int
        
        # GFX/H.264 API functions
        # rdp_gfx_is_active
        lib.rdp_gfx_is_active.argtypes = [c_void_p]
        lib.rdp_gfx_is_active.restype = c_bool
        
        # rdp_gfx_get_codec
        lib.rdp_gfx_get_codec.argtypes = [c_void_p]
        lib.rdp_gfx_get_codec.restype = c_int
        
        # rdp_gfx_get_surface
        lib.rdp_gfx_get_surface.argtypes = [c_void_p, c_uint16, POINTER(RdpGfxSurface)]
        lib.rdp_gfx_get_surface.restype = c_int
        
        # rdp_gfx_get_primary_surface
        lib.rdp_gfx_get_primary_surface.argtypes = [c_void_p]
        lib.rdp_gfx_get_primary_surface.restype = c_uint16
        
        # rdp_gfx_send_frame_ack - send browser frame acknowledgment to server
        lib.rdp_gfx_send_frame_ack.argtypes = [c_void_p, c_uint32, c_uint32, c_uint32]
        lib.rdp_gfx_send_frame_ack.restype = c_int
        
        # GFX event queue API (for wire format streaming)
        # rdp_gfx_has_events
        lib.rdp_gfx_has_events.argtypes = [c_void_p]
        lib.rdp_gfx_has_events.restype = c_int
        
        # rdp_gfx_get_event
        lib.rdp_gfx_get_event.argtypes = [c_void_p, POINTER(RdpGfxEvent)]
        lib.rdp_gfx_get_event.restype = c_int
        
        # rdp_gfx_clear_events
        lib.rdp_gfx_clear_events.argtypes = [c_void_p]
        lib.rdp_gfx_clear_events.restype = None
        
        # rdp_free_gfx_event_data
        lib.rdp_free_gfx_event_data.argtypes = [c_void_p]
        lib.rdp_free_gfx_event_data.restype = None

        # Native CLIPRDR API
        lib.rdp_clipboard_set_text.argtypes = [c_void_p, c_char_p]
        lib.rdp_clipboard_set_text.restype = c_int
        lib.rdp_clipboard_set_files.argtypes = [c_void_p, c_char_p]
        lib.rdp_clipboard_set_files.restype = c_int
        lib.rdp_clipboard_pop_event.argtypes = [c_void_p]
        lib.rdp_clipboard_pop_event.restype = c_void_p
        lib.rdp_clipboard_download_file.argtypes = [c_void_p, c_uint32, c_char_p]
        lib.rdp_clipboard_download_file.restype = c_int
        lib.rdp_free.argtypes = [c_void_p]
        lib.rdp_free.restype = None
        
        # Session registry functions
        # rdp_set_max_sessions
        lib.rdp_set_max_sessions.argtypes = [c_int]
        lib.rdp_set_max_sessions.restype = c_int
        
        # rdp_get_max_sessions
        lib.rdp_get_max_sessions.argtypes = []
        lib.rdp_get_max_sessions.restype = c_int
        
        # Initialize session registry with configurable limit
        self._init_session_registry()
    
    def _init_session_registry(self):
        """Initialize the session registry with configurable limit from RDP_MAX_SESSIONS env var"""
        # Read environment variable with validation
        default_max = 100
        min_max = 2
        max_max = 1000
        
        max_sessions_str = os.environ.get('RDP_MAX_SESSIONS', '')
        if max_sessions_str:
            try:
                max_sessions = int(max_sessions_str)
                if max_sessions < min_max:
                    logger.warning(
                        f"RDP_MAX_SESSIONS={max_sessions} is below minimum {min_max}, using {min_max}"
                    )
                    max_sessions = min_max
                elif max_sessions > max_max:
                    logger.warning(
                        f"RDP_MAX_SESSIONS={max_sessions} exceeds maximum {max_max}, using {max_max}"
                    )
                    max_sessions = max_max
                else:
                    logger.info(f"RDP_MAX_SESSIONS configured: {max_sessions}")
            except ValueError:
                logger.warning(
                    f"RDP_MAX_SESSIONS='{max_sessions_str}' is not a valid integer, using default {default_max}"
                )
                max_sessions = default_max
        else:
            max_sessions = default_max
            logger.info(f"RDP_MAX_SESSIONS not set, using default: {max_sessions}")
        
        # Initialize the native session registry
        result = self._lib.rdp_set_max_sessions(max_sessions)
        if result == 0:
            actual_max = self._lib.rdp_get_max_sessions()
            logger.info(f"Session registry initialized: max_sessions={actual_max}")
        else:
            logger.error("Failed to initialize session registry")
    
    def __getattr__(self, name):
        """Proxy attribute access to the underlying library"""
        return getattr(self._lib, name)


class RDPBridge:
    """
    Bridge between WebSocket client and RDP session using native FreeRDP3.
    
    Features:
    - GFX event streaming with wire format binary protocol
    - WebP encoding in C for optimal performance
    - Direct input injection (no xdotool)
    """
    
    def __init__(self, config: RDPConfig, websocket):
        self.config = config
        self.websocket = websocket
        self._session: Optional[c_void_p] = None
        self._lib: Optional[NativeLibrary] = None
        self.running = False
        self._frame_task: Optional[asyncio.Task] = None
        self._audio_task: Optional[asyncio.Task] = None
        self._frame_count = 0
        
        # Frame rate control
        self._target_fps = max(15, min(60, int(getattr(config, 'fps', 60) or 60)))
        self._frame_interval = 1.0 / self._target_fps
        self._quality = str(getattr(config, 'quality', 'balanced') or 'balanced').lower()
        if self._quality not in ('performance', 'balanced', 'quality'):
            self._quality = 'balanced'
        
        # Audio settings
        self._audio_enabled = True
        self._audio_buffer_size = 8192  # PCM buffer size for reading

        # Native CLIPRDR clipboard bridge
        self._clipboard_task: Optional[asyncio.Task] = None
        self._clipboard_tmp = Path(tempfile.mkdtemp(prefix='zephyr-rdp-clip-'))
    
    async def connect(self) -> bool:
        """Connect to the RDP server"""
        try:
            # Clamp initial dimensions to allowed range
            self.config.width = max(RDP_MIN_WIDTH, min(self.config.width, RDP_MAX_WIDTH))
            self.config.height = max(RDP_MIN_HEIGHT, min(self.config.height, RDP_MAX_HEIGHT))
            
            # Validate connection against security policy
            security_policy = get_security_policy()
            validation_result = security_policy.validate(self.config.host, self.config.port)
            
            if not validation_result.allowed:
                logger.warning(
                    f"Security policy blocked connection to {self.config.host}:{self.config.port} - "
                    f"{validation_result.reason}"
                )
                # Send error to client if websocket is available
                if self.websocket:
                    try:
                        import json
                        await self.websocket.send(json.dumps({
                            'type': 'error',
                            'error': 'security_policy_violation',
                            'message': validation_result.reason
                        }))
                    except Exception:
                        pass
                return False            
            
            # Load native library
            try:
                self._lib = NativeLibrary()
                version = self._lib.rdp_version().decode('utf-8')
                logger.info(f"Native RDP bridge version: {version}")
            except RuntimeError as e:
                logger.error(f"Failed to load native library: {e}")
                return False
            
            # Create session
            self._session = self._lib.rdp_create(
                self.config.host.encode('utf-8'),
                self.config.port,
                self.config.username.encode('utf-8') if self.config.username else b'',
                self.config.password.encode('utf-8') if self.config.password else b'',
                self.config.domain.encode('utf-8') if self.config.domain else b'',
                self.config.width,
                self.config.height,
                self.config.color_depth
            )
            
            if not self._session:
                logger.error("Failed to create RDP session")
                return False
            
            # Connect (this may block briefly)
            logger.info(f"Connecting to {self.config.host}:{self.config.port}...")
            result = await asyncio.get_event_loop().run_in_executor(
                None, self._lib.rdp_connect, self._session
            )
            
            if result != 0:
                error = self._lib.rdp_get_error(self._session)
                error_msg = error.decode('utf-8') if error else 'Unknown error'
                logger.error(f"RDP connection failed: {error_msg}")
                self._lib.rdp_destroy(self._session)
                self._session = None
                return False
            
            logger.info("RDP connection established")
            self.running = True
            
            # Start frame streaming
            self._frame_task = asyncio.create_task(self._stream_frames())
            
            # Start audio streaming
            if self._audio_enabled:
                self._audio_task = asyncio.create_task(self._stream_audio())

            # Start native CLIPRDR clipboard event streaming
            self._clipboard_task = asyncio.create_task(self._stream_clipboard_events())
            
            return True
            
        except Exception as e:
            logger.error(f"Connection error: {e}")
            # Clean up any partially-created session
            if self._session and self._lib:
                try:
                    self._lib.rdp_destroy(self._session)
                except Exception:
                    pass
                self._session = None
            return False
    
    async def resize(self, width: int, height: int) -> bool:
        """Resize the RDP session"""
        try:
            # Clamp dimensions to allowed range
            width = max(RDP_MIN_WIDTH, min(width, RDP_MAX_WIDTH))
            height = max(RDP_MIN_HEIGHT, min(height, RDP_MAX_HEIGHT))
            
            # Skip if dimensions haven't changed
            if self.config.width == width and self.config.height == height:
                logger.debug(f"Skipping redundant resize to {width}x{height}")
                return True
            
            logger.info(f"Resizing session to {width}x{height}")
            
            self.config.width = width
            self.config.height = height
            
            if not self._session or not self._lib:
                return False
            
            result = self._lib.rdp_resize(self._session, width, height)
            return result == 0
            
        except Exception as e:
            logger.error(f"Resize error: {e}")
            return False
    
    def send_frame_ack(self, frame_id: int, total_frames_decoded: int, queue_depth: int = 0) -> bool:
        """Send a frame acknowledgment to the RDP server.
        
        This forwards the browser's FACK message to FreeRDP, providing proper
        backpressure. The server uses these ACKs to control its frame rate -
        if ACKs are delayed (browser is slow to decode), the server slows down.
        
        Per MS-RDPEGFX 2.2.3.3, queueDepth enables adaptive server-side rate control:
          0x00000000 (QUEUE_DEPTH_UNAVAILABLE): Queue depth not available
          0xFFFFFFFF (SUSPEND_FRAME_ACKNOWLEDGEMENT): Suspend frame sending
          Other: Actual number of unprocessed frames in client queue
        
        Args:
            frame_id: Frame ID to acknowledge (from END_FRAME event / browser FACK)
            total_frames_decoded: Running count of frames decoded by browser
            queue_depth: Number of unprocessed frames in browser decode queue
            
        Returns:
            True on success, False on error
        """
        if not self._session or not self._lib:
            logger.warning("Cannot send frame ACK: session not active")
            return False
        
        try:
            result = self._lib.rdp_gfx_send_frame_ack(self._session, frame_id, total_frames_decoded, queue_depth)
            return result == 0
        except Exception as e:
            logger.error(f"Frame ACK error: {e}")
            return False
    
    def _build_gfx_event_message(self, event: RdpGfxEvent) -> Optional[bytes]:
        """Build binary wire format message for a GFX event.
        
        Args:
            event: GFX event from native library
            
        Returns:
            Binary message or None if event type is not handled
        """
        if event.type == RDP_GFX_EVENT_CREATE_SURFACE:
            return build_create_surface(
                event.surface_id, 
                event.width, 
                event.height, 
                event.pixel_format
            )
        elif event.type == RDP_GFX_EVENT_DELETE_SURFACE:
            return build_delete_surface(event.surface_id)
        elif event.type == RDP_GFX_EVENT_MAP_SURFACE:
            return build_map_surface_to_output(
                event.surface_id,
                event.x,
                event.y
            )
        elif event.type == RDP_GFX_EVENT_START_FRAME:
            return build_start_frame(event.frame_id)
        elif event.type == RDP_GFX_EVENT_END_FRAME:
            return build_end_frame(event.frame_id)
        elif event.type == RDP_GFX_EVENT_SOLID_FILL:
            return build_solid_fill(
                event.frame_id,
                event.surface_id,
                event.x, event.y,
                event.width, event.height,
                event.color
            )
        elif event.type == RDP_GFX_EVENT_SURFACE_TO_SURFACE:
            return build_surface_to_surface(
                event.frame_id,
                event.surface_id,       # src surface
                event.dst_surface_id,   # dst surface
                event.src_x, event.src_y,
                event.width, event.height,
                event.x, event.y        # dst x, y
            )
        elif event.type == RDP_GFX_EVENT_SURFACE_TO_CACHE:
            return build_surface_to_cache(
                event.frame_id,
                event.surface_id,
                event.cache_slot,
                event.x, event.y,
                event.width, event.height
            )
        elif event.type == RDP_GFX_EVENT_CACHE_TO_SURFACE:
            return build_cache_to_surface(
                event.frame_id,
                event.surface_id,
                event.cache_slot,
                event.x, event.y
            )
        elif event.type == RDP_GFX_EVENT_EVICT_CACHE:
            return build_evict_cache(
                event.frame_id,
                event.cache_slot
            )
        elif event.type == RDP_GFX_EVENT_RESET_GRAPHICS:
            return build_reset_graphics(
                event.width,
                event.height
            )
        elif event.type == RDP_GFX_EVENT_CAPS_CONFIRM:
            return build_caps_confirm(
                event.gfx_version,
                event.gfx_flags
            )
        elif event.type == RDP_GFX_EVENT_INIT_SETTINGS:
            # Build init settings dict from packed flags
            settings = {
                'colorDepth': event.init_color_depth,
                'SupportGraphicsPipeline': bool(event.init_flags_low & (1 << 0)),
                'GfxH264':                 bool(event.init_flags_low & (1 << 1)),
                'GfxAVC444':               bool(event.init_flags_low & (1 << 2)),
                'GfxAVC444v2':             bool(event.init_flags_low & (1 << 3)),
                'GfxProgressive':          bool(event.init_flags_low & (1 << 4)),
                'GfxProgressiveV2':        bool(event.init_flags_low & (1 << 5)),
                'RemoteFxCodec':           bool(event.init_flags_low & (1 << 6)),
                'NSCodec':                 bool(event.init_flags_low & (1 << 7)),
                'JpegCodec':               bool(event.init_flags_low & (1 << 8)),
                'GfxPlanar':               bool(event.init_flags_low & (1 << 9)),
                'GfxSmallCache':           bool(event.init_flags_low & (1 << 10)),
                'GfxThinClient':           bool(event.init_flags_low & (1 << 11)),
                'GfxSendQoeAck':           bool(event.init_flags_low & (1 << 12)),
                'GfxSuspendFrameAck':      bool(event.init_flags_low & (1 << 13)),
                'AudioPlayback':           bool(event.init_flags_low & (1 << 14)),
                'AudioCapture':            bool(event.init_flags_low & (1 << 15)),
                'RemoteConsoleAudio':      bool(event.init_flags_low & (1 << 16)),
            }
            return build_init_settings(settings)
        elif event.type == RDP_GFX_EVENT_WEBP_TILE:
            # WebP tile with pre-encoded data from C
            if event.bitmap_data and event.bitmap_size > 0:
                webp_data = ctypes.string_at(event.bitmap_data, event.bitmap_size)
                # Free the C-allocated buffer now that we've copied it
                self._lib.rdp_free_gfx_event_data(event.bitmap_data)
                return build_webp_tile(
                    event.frame_id,
                    event.surface_id,
                    event.x, event.y,
                    event.width, event.height,
                    webp_data
                )
            return None
        elif event.type == RDP_GFX_EVENT_VIDEO_FRAME:
            # Video frame (H.264/Progressive/ClearCodec) - route by codec ID
            if event.nal_data and event.nal_size > 0:
                nal_data = ctypes.string_at(event.nal_data, event.nal_size)
                # Free the C-allocated buffer
                self._lib.rdp_free_gfx_event_data(event.nal_data)
                
                # Check codec type for wire format routing
                if event.codec_id == RDP_GFX_CODEC_CLEARCODEC:
                    # ClearCodec: Use CLRC wire format for WASM decoding
                    return build_clearcodec_tile(
                        event.frame_id,
                        event.surface_id,
                        event.x, event.y,
                        event.width, event.height,
                        nal_data
                    )
                
                # Chroma data for AVC444 (if present)
                chroma_data = b''
                if event.chroma_nal_data and event.chroma_nal_size > 0:
                    chroma_data = ctypes.string_at(event.chroma_nal_data, event.chroma_nal_size)
                    self._lib.rdp_free_gfx_event_data(event.chroma_nal_data)
                
                # Build H264 wire format message (for H.264 and Progressive)
                message = io.BytesIO()
                message.write(H264_FRAME_MAGIC)  # 4 bytes
                message.write(struct.pack('<I', event.frame_id))  # 4 bytes
                message.write(struct.pack('<H', event.surface_id))  # 2 bytes
                message.write(struct.pack('<H', event.codec_id))  # 2 bytes
                message.write(struct.pack('<B', event.video_frame_type))  # 1 byte
                message.write(struct.pack('<h', event.x))  # 2 bytes
                message.write(struct.pack('<h', event.y))  # 2 bytes
                message.write(struct.pack('<H', event.width))  # 2 bytes
                message.write(struct.pack('<H', event.height))  # 2 bytes
                message.write(struct.pack('<I', event.nal_size))  # 4 bytes
                message.write(struct.pack('<I', len(chroma_data)))  # 4 bytes
                message.write(nal_data)
                if chroma_data:
                    message.write(chroma_data)
                return message.getvalue()
            return None
        elif event.type == RDP_GFX_EVENT_POINTER_POSITION:
            # Pointer position update
            return build_pointer_position(event.pointer_x, event.pointer_y)
        elif event.type == RDP_GFX_EVENT_POINTER_SYSTEM:
            # System pointer (NULL=0 or DEFAULT=1)
            return build_pointer_system(event.pointer_system_type)
        elif event.type == RDP_GFX_EVENT_POINTER_SET:
            # Custom cursor bitmap (BGRA data)
            if event.pointer_data and event.pointer_data_size > 0:
                bgra_data = ctypes.string_at(event.pointer_data, event.pointer_data_size)
                # Free the C-allocated buffer now that we've copied it
                self._lib.rdp_free_gfx_event_data(event.pointer_data)
                return build_pointer_set(
                    event.pointer_width,
                    event.pointer_height,
                    event.pointer_hotspot_x,
                    event.pointer_hotspot_y,
                    bgra_data
                )
            return None
        else:
            # Unhandled event type
            return None
    
    async def _stream_frames(self):
        """Stream frames from native library - GFX event streaming with wire format"""
        logger.info("Starting frame streaming")
        
        poll_count = 0
        gfx_event = RdpGfxEvent()
        gfx_mode_logged = False
        
        # Track current frame ID for wire format tile messages
        current_frame_id = 0
        disconnect_reason = None
        
        while self.running:
            try:
                # Poll for events (non-blocking)
                result = await asyncio.get_event_loop().run_in_executor(
                    None, self._lib.rdp_poll, self._session, 16  # 16ms timeout
                )
                
                poll_count += 1                
                if result < 0:
                    # Error or disconnected - capture reason and signal shutdown
                    error = self._lib.rdp_get_error(self._session)
                    disconnect_reason = error.decode('utf-8') if error else 'Connection closed'
                    logger.error(f"RDP poll error: {disconnect_reason}")
                    self.running = False  # Signal all loops to stop
                    break
                
                # Check if GFX/H.264 pipeline is active (for logging only)
                gfx_active = self._lib.rdp_gfx_is_active(self._session)
                
                if gfx_active and not gfx_mode_logged:
                    codec = self._lib.rdp_gfx_get_codec(self._session)
                    codec_name = {
                        RDP_GFX_CODEC_AVC420: "AVC420",
                        RDP_GFX_CODEC_AVC444: "AVC444", 
                        RDP_GFX_CODEC_AVC444v2: "AVC444v2",
                        RDP_GFX_CODEC_PROGRESSIVE: "Progressive",
                        RDP_GFX_CODEC_PROGRESSIVE_V2: "ProgressiveV2",
                        RDP_GFX_CODEC_CLEARCODEC: "ClearCodec",
                    }.get(codec, f"Unknown({codec})")
                    logger.info(f"GFX pipeline active with codec: {codec_name}")
                    gfx_mode_logged = True
                
                # WIRE-THROUGH MODE: Consume GFX events from queue.
                # VIDEO_FRAME events (H.264/Progressive) are now in the GFX queue
                # for strict ordering with other GFX commands.
                events_sent = 0
                frame_completed = False  # Stop after completing one frame
                
                while self._lib.rdp_gfx_has_events(self._session) > 0 and not frame_completed:
                    ret = self._lib.rdp_gfx_get_event(
                        self._session, ctypes.byref(gfx_event)
                    )
                    if ret != 0:
                        break
                    
                    # Send event (all types including VIDEO_FRAME are handled by _build_gfx_event_message)
                    msg = self._build_gfx_event_message(gfx_event)
                    if msg:
                        await self.websocket.send(msg)
                        events_sent += 1
                    
                    # Track frame boundaries
                    if gfx_event.type == RDP_GFX_EVENT_START_FRAME:
                        current_frame_id = gfx_event.frame_id
                    elif gfx_event.type == RDP_GFX_EVENT_END_FRAME:
                        # Mark frame as completed - stop processing until next poll
                        # This ensures we don't send StartFrame(N+1) before all data is ready
                        frame_completed = True
                
                # Note: H264/Progressive frames are now in GFX queue as VIDEO_FRAME events,
                # so no separate H264 queue draining is needed.
                
                if events_sent > 0:
                    await asyncio.sleep(0)  # Yield after processing
                
                # Continue to next poll - rdp_poll will drive FreeRDP and queue more events
                if events_sent > 0:
                    continue
                
                # No events this cycle - just wait for more
                await asyncio.sleep(0)
                
            except asyncio.CancelledError:
                disconnect_reason = 'Cancelled'
                break
            except Exception as e:
                logger.error(f"Frame streaming error: {e}")
                await asyncio.sleep(0)
        
        logger.info(f"Frame streaming ended after {self._frame_count} frames")
        
        # Server-initiated disconnect: clean up native resources immediately
        # This prevents memory leaks when the RDP server terminates but the
        # WebSocket client is still connected (e.g., server reboot/shutdown).
        # Don't wait for disconnect() to be called from server.py's finally block.
        if disconnect_reason and self._session and self._lib:
            logger.info(f"Server-initiated disconnect: cleaning up native session")
            try:
                self._lib.rdp_disconnect(self._session)
                self._lib.rdp_destroy(self._session)
            except Exception as e:
                logger.error(f"Error cleaning up native session: {e}")
            finally:
                self._session = None
        
        # Notify WebSocket client about disconnect
        if disconnect_reason and self.websocket:
            try:
                await self.websocket.send(json.dumps({
                    'type': 'disconnected',
                    'reason': disconnect_reason
                }))
                logger.info(f"Sent disconnect notification to client: {disconnect_reason}")
                # Close the WebSocket to break the server's message loop
                await self.websocket.close(1000, disconnect_reason[:120])  # WebSocket close reason max 123 bytes
            except Exception as e:
                logger.debug(f"Could not send disconnect notification: {e}")
    
    async def _stream_audio(self):
        """Stream Opus audio from native FreeRDP buffer (no PulseAudio required)"""
        logger.info("Starting native Opus audio streaming")
        
        # Opus frame buffer (max ~4KB per frame)
        opus_buffer_size = 4096
        opus_buffer = (c_uint8 * opus_buffer_size)()
        
        # Track format for header
        sample_rate = c_int()
        channels = c_int()
        last_sample_rate = 48000
        last_channels = 2
        
        frames_sent = 0
        
        # Audio health monitoring
        last_frame_time = asyncio.get_event_loop().time()
        consecutive_empty_polls = 0
        error_count = 0
        max_errors_before_reset = 10
        
        # Target ~20ms between sends (Opus frame duration)
        target_interval = 0.018  # slightly less than 20ms to avoid underruns
        
        while self.running:
            try:
                # Check if session is still valid (may be destroyed by _stream_frames on server disconnect)
                if not self._session:
                    logger.debug("Audio streaming: session destroyed, exiting")
                    break
                    
                # Check if Opus data is available
                if not self._lib.rdp_has_opus_data(self._session):
                    consecutive_empty_polls += 1
                    
                    # Adaptive sleep: back off when idle to reduce CPU usage
                    if consecutive_empty_polls < 100:
                        await asyncio.sleep(0.0001)  # 0.1ms for responsiveness
                    elif consecutive_empty_polls < 1000:
                        await asyncio.sleep(0.001)   # 1ms when idle
                    else:
                        await asyncio.sleep(0.005)   # 5ms for extended idle
                    continue
                
                consecutive_empty_polls = 0
                error_count = 0  # Reset error count on successful data
                
                # Get audio format
                if self._lib.rdp_get_opus_format(
                    self._session,
                    ctypes.byref(sample_rate),
                    ctypes.byref(channels)
                ) == 0:
                    last_sample_rate = sample_rate.value
                    last_channels = channels.value
                
                # Send multiple frames if they've accumulated
                frames_this_batch = 0
                max_frames_per_batch = 10  # Limit to avoid large bursts
                
                while self._lib.rdp_has_opus_data(self._session) and frames_this_batch < max_frames_per_batch:
                    # Read Opus frame from native buffer
                    frame_size = self._lib.rdp_get_opus_frame(
                        self._session,
                        opus_buffer,
                        opus_buffer_size
                    )
                    
                    if frame_size > 0:
                        # Build Opus audio message:
                        # [OPUS magic (4)] [sample_rate (4)] [channels (2)] [frame_size (2)] [Opus data...]
                        message = io.BytesIO()
                        message.write(OPUS_AUDIO_MAGIC)
                        message.write(struct.pack('<I', last_sample_rate))
                        message.write(struct.pack('<H', last_channels))
                        message.write(struct.pack('<H', frame_size))
                        message.write(ctypes.string_at(opus_buffer, frame_size))
                        
                        await self.websocket.send(message.getvalue())
                        frames_sent += 1
                        frames_this_batch += 1
                        last_frame_time = asyncio.get_event_loop().time()
                        
                        # Log first audio frame only
                        if frames_sent == 1:
                            logger.info(f"Audio stream started: {last_sample_rate}Hz, {last_channels}ch")
                    elif frame_size == -2:
                        logger.warning("Opus frame buffer too small")
                        break
                    else:
                        break
                
                # Small delay to prevent tight loop and allow batching
                await asyncio.sleep(0)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                error_count += 1
                if error_count <= 3 or error_count % 100 == 0:
                    logger.error(f"Native audio streaming error (#{error_count}): {e}")
                
                # Exponential backoff on repeated errors
                if error_count >= max_errors_before_reset:
                    logger.warning(f"Audio stream encountered {error_count} errors, backing off")
                    await asyncio.sleep(0.1)  # 100ms backoff
                else:
                    await asyncio.sleep(0.001)  # 1ms between retries
        
        logger.info(f"Native audio streaming ended after {frames_sent} frames")
    
    async def _stream_clipboard_events(self):
        """Forward native CLIPRDR events to the browser as JSON messages."""
        while self.running and self._session and self._lib:
            try:
                ptr = self._lib.rdp_clipboard_pop_event(self._session)
                if ptr:
                    try:
                        raw = ctypes.string_at(ptr).decode('utf-8', errors='replace')
                    finally:
                        self._lib.rdp_free(ptr)
                    await self.websocket.send(raw)
                    continue
                await asyncio.sleep(0.05)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Clipboard event stream error: {e}")
                await asyncio.sleep(0.25)

    async def set_clipboard_text(self, text: str) -> bool:
        """Publish UTF-8 text to the remote Windows clipboard via native CLIPRDR."""
        if not self.running or not self._session or not self._lib:
            return False
        data = str(text or '').encode('utf-8')
        result = await asyncio.get_event_loop().run_in_executor(
            None, self._lib.rdp_clipboard_set_text, self._session, data
        )
        return result == 0

    async def set_clipboard_files(self, files: list[dict]) -> bool:
        """Stage browser-provided files and publish them as native RDP file clipboard."""
        if not self.running or not self._session or not self._lib:
            return False
        staged = []
        batch = self._clipboard_tmp / f"local-{uuid.uuid4().hex}"
        batch.mkdir(parents=True, exist_ok=True)
        for item in files or []:
            name = Path(str(item.get('name') or 'clipboard-file')).name or 'clipboard-file'
            b64 = str(item.get('data') or '')
            if ',' in b64 and b64.startswith('data:'):
                b64 = b64.split(',', 1)[1]
            try:
                data = base64.b64decode(b64, validate=False)
            except Exception:
                logger.warning(f"Skipping invalid clipboard file payload: {name}")
                continue
            target = batch / name
            if target.exists():
                stem = target.stem or 'file'
                suffix = target.suffix
                target = batch / f"{stem}-{uuid.uuid4().hex[:8]}{suffix}"
            target.write_bytes(data)
            staged.append(str(target))
        if not staged:
            return False
        payload = ('\n'.join(staged) + '\n').encode('utf-8')
        result = await asyncio.get_event_loop().run_in_executor(
            None, self._lib.rdp_clipboard_set_files, self._session, payload
        )
        return result == 0

    async def download_clipboard_file(self, index: int, request_id: str = ''):
        """Download a remote clipboard file through CLIPRDR FileContents PDUs and stream chunks to browser."""
        if not self.running or not self._session or not self._lib:
            await self.websocket.send(json.dumps({'type': 'clipboard-file-error', 'requestId': request_id, 'message': 'RDP session not running'}))
            return
        out = self._clipboard_tmp / f"remote-{uuid.uuid4().hex}.bin"
        result = await asyncio.get_event_loop().run_in_executor(
            None, self._lib.rdp_clipboard_download_file, self._session, int(index), str(out).encode('utf-8')
        )
        if result != 0 or not out.exists():
            await self.websocket.send(json.dumps({'type': 'clipboard-file-error', 'requestId': request_id, 'message': 'CLIPRDR FileContents download failed'}))
            return
        total = out.stat().st_size
        await self.websocket.send(json.dumps({'type': 'clipboard-file-start', 'requestId': request_id, 'index': int(index), 'size': total}))
        offset = 0
        chunk_index = 0
        with out.open('rb') as f:
            while True:
                chunk = f.read(512 * 1024)
                if not chunk:
                    break
                await self.websocket.send(json.dumps({
                    'type': 'clipboard-file-chunk',
                    'requestId': request_id,
                    'index': int(index),
                    'chunkIndex': chunk_index,
                    'offset': offset,
                    'data': base64.b64encode(chunk).decode('ascii'),
                }))
                offset += len(chunk)
                chunk_index += 1
        await self.websocket.send(json.dumps({'type': 'clipboard-file-end', 'requestId': request_id, 'index': int(index), 'size': total}))

    async def disconnect(self):
        """Disconnect from the RDP server.
        
        This method is idempotent - safe to call multiple times.
        Native resources may already be freed by _stream_frames on server-initiated disconnect.
        """
        self.running = False
        
        if self._frame_task:
            self._frame_task.cancel()
            try:
                await self._frame_task
            except (asyncio.CancelledError, Exception):
                pass  # Task was cancelled or already finished with error
            finally:
                self._frame_task = None
        
        if self._audio_task:
            self._audio_task.cancel()
            try:
                await self._audio_task
            except (asyncio.CancelledError, Exception):
                pass  # Task was cancelled or already finished with error
            finally:
                self._audio_task = None

        if self._clipboard_task:
            self._clipboard_task.cancel()
            try:
                await self._clipboard_task
            except (asyncio.CancelledError, Exception):
                pass
            finally:
                self._clipboard_task = None
        
        # Clean up native session if not already cleaned up by _stream_frames
        if self._session and self._lib:
            logger.debug("disconnect() cleaning up native session")
            self._lib.rdp_disconnect(self._session)
            self._lib.rdp_destroy(self._session)
            self._session = None
        
        logger.info("RDP session disconnected")
    
    async def send_mouse_event(
        self, action: str, x: int, y: int,
        button: int = 0, delta_x: int = 0, delta_y: int = 0
    ):
        """Send mouse event to VM"""
        if not self.running:
            return
        
        if not self._session or not self._lib:
            return
        
        try:
            flags = 0
            
            if action == 'move':
                flags = RDP_MOUSE_FLAG_MOVE
            elif action == 'down':
                # Map button index to flag
                button_map = {
                    0: RDP_MOUSE_FLAG_BUTTON1,  # Left
                    1: RDP_MOUSE_FLAG_BUTTON3,  # Middle (button index 1 in JS)
                    2: RDP_MOUSE_FLAG_BUTTON2,  # Right
                }
                flags = button_map.get(button, RDP_MOUSE_FLAG_BUTTON1) | RDP_MOUSE_FLAG_DOWN
            elif action == 'up':
                button_map = {
                    0: RDP_MOUSE_FLAG_BUTTON1,
                    1: RDP_MOUSE_FLAG_BUTTON3,
                    2: RDP_MOUSE_FLAG_BUTTON2,
                }
                flags = button_map.get(button, RDP_MOUSE_FLAG_BUTTON1)
            elif action == 'wheel':
                # Wheel events: deltaY for vertical, deltaX for horizontal
                # RDP wheel encoding per MS-RDPBCGR 2.2.8.1.1.3.1.1.3:
                # - PTR_FLAGS_WHEEL (0x0200) = vertical wheel event
                # - PTR_FLAGS_HWHEEL (0x0400) = horizontal wheel event
                # - WheelRotationMask (0x01FF) = 9-bit TWO'S COMPLEMENT signed value
                #
                # The lower 9 bits form a signed value. Server sign-extends from 9 to 16 bits.
                # Browser: deltaY > 0 = scroll down, deltaX > 0 = scroll right
                # RDP: Positive = scroll up/left, Negative = scroll down/right
                # So we NEGATE browser deltas for RDP encoding.
                
                v_delta = int(delta_y) if delta_y else 0
                h_delta = int(delta_x) if delta_x else 0
                
                # Handle vertical wheel
                if v_delta != 0:
                    rotation = max(-256, min(255, -v_delta))
                    if rotation < 0:
                        rotation_bits = rotation & 0x1FF
                    else:
                        rotation_bits = rotation & 0xFF
                    flags = RDP_MOUSE_FLAG_WHEEL | rotation_bits
                    self._lib.rdp_send_mouse(self._session, flags, x, y)
                
                # Handle horizontal wheel (separate event per RDP spec)
                if h_delta != 0:
                    rotation = max(-256, min(255, -h_delta))
                    if rotation < 0:
                        rotation_bits = rotation & 0x1FF
                    else:
                        rotation_bits = rotation & 0xFF
                    flags = RDP_MOUSE_FLAG_HWHEEL | rotation_bits
                    self._lib.rdp_send_mouse(self._session, flags, x, y)
                
                return  # Already sent mouse events above                
            
            self._lib.rdp_send_mouse(self._session, flags, x, y)
            
        except Exception as e:
            logger.error(f"Mouse event error: {e}")
    
    async def send_key_event(
        self, action: str, key: str, code: str,
        key_code: int = 0, ctrl: bool = False,
        shift: bool = False, alt: bool = False,
        meta: bool = False
    ):
        """Send keyboard event to VM
        
        Uses Unicode input for printable characters to support international
        keyboard layouts (e.g., German QWERTZ). Falls back to scancodes for
        special keys, modifiers, and key combinations.
        """
        if not self.running:
            return
        
        if not self._session or not self._lib:
            return
        
        try:
            # Build flags
            flags = RDP_KBD_FLAG_DOWN if action == 'down' else RDP_KBD_FLAG_RELEASE
            
            # Determine if we should use Unicode input:
            # - Single printable character (not a special key name)
            # - No modifier keys held (except Shift which is already reflected in key)
            # - Not a special key code
            use_unicode = (
                len(key) == 1 and  # Single character
                not ctrl and not alt and not meta and  # No modifiers (Shift is OK)
                code not in EXTENDED_KEYS and  # Not an extended key
                code not in ('Tab', 'Enter', 'Backspace', 'Escape', 'Space',
                            'CapsLock', 'NumLock', 'ScrollLock')
            )
            
            if use_unicode:
                # Use Unicode keyboard event for proper international layout support
                unicode_char = ord(key)
                self._lib.rdp_send_unicode(self._session, flags, unicode_char)
            else:
                # Use scancode for special keys and key combinations
                scancode = SCANCODE_MAP.get(code)
                
                if scancode is None:
                    logger.debug(f"Unknown key code: {code}")
                    return
                
                # Check if extended key
                if code in EXTENDED_KEYS:
                    flags |= RDP_KBD_FLAG_EXTENDED
                
                self._lib.rdp_send_keyboard(self._session, flags, scancode)
            
        except Exception as e:
            logger.error(f"Key event error: {e}")
    
    async def send_key_combo(self, combo: str):
        """Send a key combination like Ctrl+Alt+Delete"""
        if not self.running:
            return
        
        logger.info(f"Sending key combo: {combo}")
        
        keys = combo.split('+')
        
        # Press all keys
        for key in keys:
            code = self._key_to_code(key)
            await self.send_key_event('down', key, code)
            await asyncio.sleep(0.05)
        
        # Release all keys in reverse
        for key in reversed(keys):
            code = self._key_to_code(key)
            await self.send_key_event('up', key, code)
            await asyncio.sleep(0.05)
    
    def _key_to_code(self, key: str) -> str:
        """Convert key name to JS code"""
        key_map = {
            'Ctrl': 'ControlLeft',
            'Control': 'ControlLeft',
            'Alt': 'AltLeft',
            'Shift': 'ShiftLeft',
            'Meta': 'MetaLeft',
            'Win': 'MetaLeft',
            'Delete': 'Delete',
            'Enter': 'Enter',
            'Tab': 'Tab',
            'Escape': 'Escape',
            'Esc': 'Escape',
            'Backspace': 'Backspace',
            'Space': 'Space',
            'Insert': 'Insert',
            'Home': 'Home',
            'End': 'End',
            'PageUp': 'PageUp',
            'PageDown': 'PageDown',
            'ArrowUp': 'ArrowUp',
            'ArrowDown': 'ArrowDown',
            'ArrowLeft': 'ArrowLeft',
            'ArrowRight': 'ArrowRight',
            'CapsLock': 'CapsLock',
            'NumLock': 'NumLock',
            'ScrollLock': 'ScrollLock',
            'PrintScreen': 'PrintScreen',
            'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4',
            'F5': 'F5', 'F6': 'F6', 'F7': 'F7', 'F8': 'F8',
            'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
        }
        return key_map.get(key, f'Key{key.upper()}')
