"""
RDP WebSocket Proxy Server
Bridges browser clients to remote Windows VMs via FreeRDP
"""

import asyncio
import json
import logging
import os
from http import HTTPStatus
from typing import Dict, Optional

from dotenv import load_dotenv
from websockets.asyncio.server import serve, ServerConnection
from websockets.http11 import Response
from websockets.datastructures import Headers

from rdp_bridge import RDPBridge, RDPConfig, NativeLibrary
from wire_format import parse_frame_ack, get_message_type, Magic

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('rdp-server')

# Filter out noisy websocket errors from empty connections (TCP probes, health checks)
class WebSocketErrorFilter(logging.Filter):
    """Filter out benign WebSocket handshake errors from empty connections."""
    
    FILTERED_MESSAGES = (
        'stream ends after 0 bytes',
        'connection closed while reading HTTP request',
        'did not receive a valid HTTP request',
        'opening handshake failed',
    )
    
    def filter(self, record: logging.LogRecord) -> bool:
        # Only filter ERROR level from websockets.server
        if record.levelno < logging.ERROR:
            return True
        
        # Check main message
        message = record.getMessage()
        for filtered in self.FILTERED_MESSAGES:
            if filtered in message:
                return False
        
        # Check exception info if present
        if record.exc_info and record.exc_info[1]:
            exc_str = str(record.exc_info[1])
            for filtered in self.FILTERED_MESSAGES:
                if filtered in exc_str:
                    return False
        
        return True

# Apply filter to websockets logger (keeps other errors visible)
websockets_logger = logging.getLogger('websockets.server')
websockets_logger.addFilter(WebSocketErrorFilter())

RDP_MAX_DIMENSION = int(os.getenv('RDP_MAX_DIMENSION', '7680'))
RDP_MAX_WIDTH = int(os.getenv('RDP_MAX_WIDTH', str(RDP_MAX_DIMENSION)))
RDP_MAX_HEIGHT = int(os.getenv('RDP_MAX_HEIGHT', '4320'))
RDP_MAX_FPS = int(os.getenv('RDP_MAX_FPS', '144'))
RDP_QUALITY_MODES = {'auto', 'performance', 'balanced', 'quality'}

def normalize_quality(value: object) -> str:
    quality = str(value or 'balanced').lower()
    return quality if quality in RDP_QUALITY_MODES else 'balanced'

# Active sessions: websocket -> RDPBridge
sessions: Dict[ServerConnection, RDPBridge] = {}

# HTML response for non-WebSocket requests
INFO_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RDP WebSocket Server</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
               max-width: 600px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
        h1 { color: #00d9ff; }
        code { background: #16213e; padding: 2px 8px; border-radius: 4px; }
        .info { background: #16213e; padding: 15px; border-radius: 8px; border-left: 4px solid #00d9ff; }
    </style>
</head>
<body>
    <h1>🖥️ RDP WebSocket Server</h1>
    <div class="info">
        <p>This is a <strong>WebSocket endpoint</strong> for RDP streaming.</p>
        <p>To connect, use a WebSocket client with:</p>
        <p><code>ws://hostname:8765</code></p>
    </div>
    <h2>Endpoints</h2>
    <ul>
        <li><code>GET /health</code> - Health check (returns 200 OK)</li>
        <li><code>WebSocket /</code> - RDP streaming connection</li>
    </ul>
</body>
</html>
"""


def check_native_library() -> tuple[bool, str]:
    """Check if the native RDP library can be loaded."""
    try:
        lib = NativeLibrary()
        if lib._lib is not None:
            return True, "Native library loaded"
        return False, "Native library is None"
    except Exception as e:
        return False, str(e)


def process_request(connection, request):
    """
    Handle non-WebSocket HTTP requests.
    
    Returns:
        - Response for health checks and regular HTTP requests
        - None to proceed with WebSocket handshake
    """
    # Health check endpoint
    if request.path == '/health' or request.path == '/healthz':
        lib_ok, lib_msg = check_native_library()
        
        if lib_ok:
            headers = Headers([("Content-Type", "application/json")])
            body = json.dumps({
                "status": "healthy",
                "native_library": lib_msg
            }).encode('utf-8')
            return Response(
                HTTPStatus.OK.value,
                "OK",
                headers,
                body
            )
        else:
            headers = Headers([("Content-Type", "application/json")])
            body = json.dumps({
                "status": "unhealthy",
                "native_library": lib_msg
            }).encode('utf-8')
            return Response(
                HTTPStatus.SERVICE_UNAVAILABLE.value,
                "Service Unavailable",
                headers,
                body
            )
    
    # Check if this is a WebSocket upgrade request
    upgrade_header = None
    for name, value in request.headers.raw_items():
        if name.lower() == 'upgrade':
            upgrade_header = value.lower()
            break
    
    # If not a WebSocket upgrade, return informational page with 426 status
    if upgrade_header != 'websocket':
        headers = Headers([
            ("Content-Type", "text/html; charset=utf-8"),
            ("Upgrade", "websocket")
        ])
        return Response(
            HTTPStatus.UPGRADE_REQUIRED.value,
            "Upgrade Required",
            headers,
            INFO_PAGE_HTML.encode('utf-8')
        )
    
    # Proceed with WebSocket handshake
    return None


async def handle_binary_message(data: bytes, rdp_bridge: Optional[RDPBridge], client_id: int):
    """Handle binary backchannel messages from browser (FACK)
    
    Args:
        data: Binary message data
        rdp_bridge: RDP bridge instance (may be None if not connected)
        client_id: Client ID for logging
    """
    if len(data) < 4:
        logger.warning(f"Client {client_id}: Binary message too short ({len(data)} bytes)")
        return
    
    msg_type = get_message_type(data)
    
    if msg_type == 'frameAck':
        # Frame acknowledgment from browser - forward to FreeRDP!
        # This is critical for proper backpressure. The browser sends FACK after
        # it has decoded and presented the frame. We forward this to FreeRDP which
        # sends FrameAcknowledge to the RDP server. This tells the server we're
        # ready for more frames - if the browser is slow, ACKs are delayed and
        # the server throttles its frame rate.
        #
        # Per MS-RDPEGFX 2.2.3.3, queueDepth enables adaptive server-side rate control:
        #   0x00000000: QUEUE_DEPTH_UNAVAILABLE
        #   0xFFFFFFFF: SUSPEND_FRAME_ACKNOWLEDGEMENT
        #   Other: Actual unprocessed frames in browser decode queue
        parsed = parse_frame_ack(data)
        if parsed and rdp_bridge:
            frame_id = parsed['frame_id']
            total_decoded = parsed['total_frames_decoded']
            queue_depth = parsed['queue_depth']
            if rdp_bridge.send_frame_ack(frame_id, total_decoded, queue_depth):
                logger.debug(f"Client {client_id}: Forwarded frame ACK for frame {frame_id} (total decoded: {total_decoded}, queue depth: {queue_depth})")
            else:
                logger.warning(f"Client {client_id}: Failed to forward frame ACK for frame {frame_id}")
        elif not rdp_bridge:
            logger.warning(f"Client {client_id}: Frame ACK received but no RDP bridge active")
            
    else:
        # Unknown binary message
        magic = data[:4].decode('latin-1', errors='replace')
        logger.warning(f"Client {client_id}: Unknown binary message type '{magic}'")


async def handle_client(websocket: ServerConnection):
    """Handle a WebSocket client connection"""
    client_id = id(websocket)
    logger.info(f"Client {client_id} connected from {websocket.remote_address}")
    
    rdp_bridge: Optional[RDPBridge] = None
    
    try:
        async for message in websocket:
            try:
                # Handle binary messages (backchannel: FACK)
                if isinstance(message, bytes):
                    await handle_binary_message(message, rdp_bridge, client_id)
                    continue
                
                data = json.loads(message)
                msg_type = data.get('type')
                
                if msg_type == 'connect':
                    if not all(k in data for k in ('host', 'username', 'password')):
                        logger.info(f"Client {client_id} missing required fields for connect")
                        await websocket.send(json.dumps({
                            'type': 'error',
                            'message': 'Failed to connect to RDP host - missing required fields'
                        }))


                    # Start RDP session
                    quality = normalize_quality(data.get('quality', 'balanced'))
                    os.environ['RDP_GFX_WEBP_QUALITY'] = {'performance': '58', 'balanced': '82', 'quality': '100', 'auto': '82'}.get(quality, '82')
                    config = RDPConfig(
                        host=data['host'],
                        port=data.get('port', 3389),
                        username=data['username'],
                        password=data['password'],
                        domain=data.get('domain', ''),
                        width=max(640, min(RDP_MAX_WIDTH, int(data.get('width', 1280) or 1280))),
                        height=max(480, min(RDP_MAX_HEIGHT, int(data.get('height', 720) or 720))),
                        fps=max(15, min(RDP_MAX_FPS, int(data.get('fps', 60) or 60))),
                        quality=quality,
                    )
                    
                    rdp_bridge = RDPBridge(config, websocket)
                    sessions[websocket] = rdp_bridge
                    
                    # Start the RDP session (this will begin streaming frames)
                    success = await rdp_bridge.connect()
                    
                    if success:
                        await websocket.send(json.dumps({
                            'type': 'connected',
                            'width': config.width,
                            'height': config.height
                        }))
                        logger.info(f"Client {client_id} RDP session started to {config.host}")
                    else:
                        await websocket.send(json.dumps({
                            'type': 'error',
                            'message': 'Failed to connect to RDP host'
                        }))
                
                elif msg_type == 'disconnect':
                    if rdp_bridge:
                        await rdp_bridge.disconnect()
                    await websocket.send(json.dumps({'type': 'disconnected'}))
                    break
                
                elif msg_type == 'mouse':
                    if rdp_bridge:
                        await rdp_bridge.send_mouse_event(
                            action=data['action'],
                            x=data['x'],
                            y=data['y'],
                            button=data.get('button', 0),
                            delta_x=data.get('deltaX', 0),
                            delta_y=data.get('deltaY', 0)
                        )
                
                elif msg_type == 'key':
                    if rdp_bridge:
                        await rdp_bridge.send_key_event(
                            action=data['action'],
                            key=data.get('key', ''),
                            code=data.get('code', ''),
                            key_code=data.get('keyCode', 0),
                            ctrl=data.get('ctrlKey', False),
                            shift=data.get('shiftKey', False),
                            alt=data.get('altKey', False),
                            meta=data.get('metaKey', False)
                        )
                
                elif msg_type == 'keycombo':
                    if rdp_bridge:
                        await rdp_bridge.send_key_combo(data['combo'])

                elif msg_type == 'text':
                    if rdp_bridge:
                        for ch in str(data.get('text', '')):
                            if ch in ('\n', '\r'):
                                await rdp_bridge.send_key_combo('Enter')
                            elif ch == '\t':
                                await rdp_bridge.send_key_combo('Tab')
                            else:
                                await rdp_bridge.send_key_event('down', ch, '', 0, False, False, False, False)
                                await rdp_bridge.send_key_event('up', ch, '', 0, False, False, False, False)

                elif msg_type == 'backspace':
                    if rdp_bridge:
                        for _ in range(max(1, min(100, int(data.get('count', 1) or 1)))):
                            await rdp_bridge.send_key_event('down', 'Backspace', 'Backspace', 8, False, False, False, False)
                            await rdp_bridge.send_key_event('up', 'Backspace', 'Backspace', 8, False, False, False, False)

                elif msg_type == 'clipboard-set-text':
                    if rdp_bridge:
                        ok = await rdp_bridge.set_clipboard_text(data.get('text', ''))
                        await websocket.send(json.dumps({
                            'type': 'clipboard-set-text-result',
                            'ok': ok,
                            'paste': bool(data.get('paste', False))
                        }))

                elif msg_type == 'clipboard-set-files':
                    if rdp_bridge:
                        ok = await rdp_bridge.set_clipboard_files(data.get('files', []))
                        await websocket.send(json.dumps({
                            'type': 'clipboard-set-files-result',
                            'ok': ok,
                            'paste': bool(data.get('paste', False)),
                            'count': len(data.get('files', []) or [])
                        }))

                elif msg_type == 'clipboard-download-file':
                    if rdp_bridge:
                        asyncio.create_task(rdp_bridge.download_clipboard_file(
                            int(data.get('index', 0)),
                            str(data.get('requestId', ''))
                        ))
                
                elif msg_type == 'resize':
                    if rdp_bridge:
                        new_width = data.get('width', 1280)
                        new_height = data.get('height', 720)
                        logger.info(f"Client {client_id} requested resize to {new_width}x{new_height}")
                        success = await rdp_bridge.resize(new_width, new_height)
                        if success:
                            await websocket.send(json.dumps({
                                'type': 'resize',
                                'width': new_width,
                                'height': new_height
                            }))
                        else:
                            await websocket.send(json.dumps({
                                'type': 'error',
                                'message': 'Failed to resize session'
                            }))

                elif msg_type in ('settings', 'reconnect'):
                    if rdp_bridge:
                        fps = max(15, min(RDP_MAX_FPS, int(data.get('fps', rdp_bridge._target_fps) or rdp_bridge._target_fps)))
                        quality = normalize_quality(data.get('quality', rdp_bridge._quality))
                        os.environ['RDP_GFX_WEBP_QUALITY'] = {'performance': '58', 'balanced': '82', 'quality': '100', 'auto': '82'}.get(quality, '82')
                        rdp_bridge._target_fps = fps
                        rdp_bridge._frame_interval = 1.0 / fps
                        rdp_bridge._quality = quality
                        logger.info(f"Client {client_id} updated runtime settings: quality={quality}, fps={fps}")
                        await websocket.send(json.dumps({'type': 'settings', 'quality': quality, 'fps': fps}))
                
                elif msg_type == 'ping':
                    await websocket.send(json.dumps({'type': 'pong'}))
                
                elif msg_type == 'ack_frame':
                    # Acknowledge H.264 frame - FreeRDP handles this automatically
                    # Just log for debugging
                    frame_id = data.get('frame_id', 0)
                    logger.debug(f"Frame ack received: {frame_id}")
                
                else:
                    logger.warning(f"Unknown message type: {msg_type}")
                    
            except json.JSONDecodeError:
                logger.error("Invalid JSON received")
            except KeyError as e:
                logger.error(f"Missing required field: {e}")
            except Exception as e:
                logger.error(f"Error handling message: {e}")
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': str(e)
                }))
    
    except Exception as e:
        logger.error(f"Client {client_id} error: {e}")
    
    finally:
        # Cleanup
        if rdp_bridge:
            await rdp_bridge.disconnect()
        if websocket in sessions:
            del sessions[websocket]
        logger.info(f"Client {client_id} disconnected")


async def main():
    """Main server entry point"""
    host = os.getenv('WS_HOST', '0.0.0.0')
    port = int(os.getenv('WS_PORT', '8765'))
    
    logger.info(f"Starting RDP WebSocket server on ws://{host}:{port}")
    logger.info("Health check available at: http://{}:{}/health".format(host, port))
    
    async with serve(handle_client, host, port, process_request=process_request):
        logger.info("Server is running. Press Ctrl+C to stop.")
        await asyncio.Future()  # Run forever


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
