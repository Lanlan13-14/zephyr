/**
 * RDP Native Session Manager — Node.js direct binding via N-API addon
 *
 * Replaces Python rdp_bridge.py + server.py with direct native calls.
 * Data flow: Browser ←(WS binary)→ Node.js ←(N-API)→ C/FreeRDP3 ←(TCP 3389)→ Windows
 *
 * Falls back to Python backend if the native addon is not available.
 */

'use strict';

const path = require('path');
const fs = require('fs');

/* ============================================================================
 * Keyboard scan code mapping (from Python rdp_bridge.py SCANCODE_MAP)
 * ============================================================================ */

const SCANCODE_MAP = {
    Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04,
    Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
    Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B, Minus: 0x0C,
    Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F, KeyQ: 0x10,
    KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
    KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18,
    KeyP: 0x19, BracketLeft: 0x1A, BracketRight: 0x1B,
    Enter: 0x1C, ControlLeft: 0x1D, KeyA: 0x1E, KeyS: 0x1F,
    KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
    KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
    Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A,
    Backslash: 0x2B, KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E,
    KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
    Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
    NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
    CapsLock: 0x3A, F1: 0x3B, F2: 0x3C, F3: 0x3D,
    F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42,
    F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
    NumpadSubtract: 0x4A, Numpad4: 0x4B, Numpad5: 0x4C,
    Numpad6: 0x4D, NumpadAdd: 0x4E, Numpad1: 0x4F,
    Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
    NumpadDecimal: 0x53, F11: 0x57, F12: 0x58,
    NumpadEnter: 0x1C, ControlRight: 0x1D, NumpadDivide: 0x35,
    PrintScreen: 0x37, AltRight: 0x38, Home: 0x47,
    ArrowUp: 0x48, PageUp: 0x49, ArrowLeft: 0x4B,
    ArrowRight: 0x4D, End: 0x4F, ArrowDown: 0x50,
    PageDown: 0x51, Insert: 0x52, Delete: 0x53,
    MetaLeft: 0x5B, MetaRight: 0x5C, ContextMenu: 0x5D,
};

const EXTENDED_KEYS = new Set([
    'NumpadEnter', 'ControlRight', 'NumpadDivide', 'PrintScreen',
    'AltRight', 'Home', 'ArrowUp', 'PageUp', 'ArrowLeft',
    'ArrowRight', 'End', 'ArrowDown', 'PageDown', 'Insert', 'Delete',
    'MetaLeft', 'MetaRight', 'ContextMenu',
]);

const RDP_MOUSE_FLAG_MOVE     = 0x0800;
const RDP_MOUSE_FLAG_BUTTON1  = 0x1000;
const RDP_MOUSE_FLAG_BUTTON2  = 0x2000;
const RDP_MOUSE_FLAG_BUTTON3  = 0x4000;
const RDP_MOUSE_FLAG_DOWN     = 0x8000;
const RDP_MOUSE_FLAG_WHEEL    = 0x0200;
const RDP_MOUSE_FLAG_HWHEEL   = 0x0400;
const RDP_MOUSE_FLAG_NEGATIVE = 0x0100;

const RDP_KBD_FLAG_DOWN     = 0x0000;
const RDP_KBD_FLAG_RELEASE  = 0x8000;
const RDP_KBD_FLAG_EXTENDED = 0x0100;

const RDP_STATE_CONNECTED = 2;

/* FACK wire format parser */
function parseFrameAck(data) {
    if (!data || data.length < 16) return null;
    if (data[0] !== 0x46 || data[1] !== 0x41 || data[2] !== 0x43 || data[3] !== 0x4B) return null;
    return {
        frameId: data.readUInt32LE(4),
        totalDecoded: data.readUInt32LE(8),
        queueDepth: data.readUInt32LE(12),
    };
}

/* ============================================================================
 * Try to load the N-API addon
 * ============================================================================ */

let addon = null;
let addonAvailable = false;

function tryLoadAddon() {
    const addonPaths = [
        process.env.RDP_ADDON_PATH,
        path.join(__dirname, 'addon', 'build', 'Release', 'rdp_addon.node'),
        path.join(__dirname, 'addon', 'build', 'Debug', 'rdp_addon.node'),
    ].filter(Boolean);

    for (const p of addonPaths) {
        try {
            if (!fs.existsSync(p)) continue;
            addon = require(p);
            break;
        } catch (e) {
            console.warn('[rdp-native] Failed to load addon from', p, e.message);
        }
    }

    if (!addon) return false;

    /* Load the native library */
    const libPaths = [
        process.env.RDP_BRIDGE_LIBRARY,
        '/usr/local/lib/librdp_bridge.so',
        path.join(__dirname, 'native', 'build', 'librdp_bridge.so'),
    ].filter(Boolean);

    for (const p of libPaths) {
        if (addon.loadLibrary(p)) {
            console.info('[rdp-native] Loaded librdp_bridge.so from', p);
            console.info('[rdp-native] Bridge version:', addon.version());

            const maxSessions = parseInt(process.env.RDP_MAX_SESSIONS || '100', 10);
            addon.setMaxSessions(Math.max(2, Math.min(1000, maxSessions)));

            addonAvailable = true;
            return true;
        }
    }

    console.warn('[rdp-native] librdp_bridge.so not found, falling back to Python backend');
    return false;
}

/* ============================================================================
 * Native RDP Session
 * ============================================================================ */

class NativeRdpSession {
    constructor(ws, conn, options = {}) {
        this.ws = ws;
        this.conn = conn;
        this.session = null;
        this.running = false;
        this.pollTimer = null;
        this.audioTimer = null;
        this.clipTimer = null;
        this.width = options.width || 1280;
        this.height = options.height || 720;
    }

    async start() {
        const { conn } = this;
        const host = conn.host || 'localhost';
        const port = Number(conn.port) || 3389;
        const username = conn.username || 'Administrator';
        const password = conn.password || '';
        const domain = conn.domain || '';

        this.session = addon.createSession(host, port, username, password, domain,
            this.width, this.height, 32);

        if (!this.session) {
            this._sendJson({ type: 'error', message: 'Failed to create RDP session' });
            return false;
        }

        addon.setAudioContext(this.session);

        /* connect() blocks the event loop during TLS/NLA handshake.
         * This is acceptable for the initial connection (~100-500ms).
         * After it returns, FreeRDP may already have queued GFX events. */
        const result = addon.connect(this.session);
        if (result !== 0) {
            const error = addon.getError(this.session);
            this._sendJson({ type: 'error', message: `RDP connection failed: ${error}` });
            addon.destroy(this.session);
            this.session = null;
            return false;
        }

        this.running = true;
        this._sendJson({ type: 'connected', width: this.width, height: this.height });

        /* Start poll loop — this is the main event driver */
        this._startPollLoop();
        this._startAudioLoop();
        this._startClipboardLoop();

        return true;
    }

    _sendJson(obj) {
        try {
            if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
        } catch {}
    }

    _sendBinary(buf) {
        try {
            if (this.ws.readyState === 1) this.ws.send(buf, { binary: true });
        } catch {}
    }

    _startPollLoop() {
        const poll = () => {
            if (!this.running || !this.session) return;

            /* Non-blocking poll (timeout=0). We MUST NOT block the event loop
             * because incoming FACK messages from the browser arrive via the
             * same thread. Blocking here delays frame ACKs → server disconnects.
             * Python uses run_in_executor() for this; we use setTimeout(0). */
            const result = addon.poll(this.session, 0);
            if (result < 0) {
                const error = addon.getError(this.session);
                this.running = false;
                this._sendJson({ type: 'disconnected', reason: error || 'Connection closed' });
                this.cleanup();
                return;
            }

            /* Drain GFX events — returns Buffer[] ready for ws.send() */
            const events = addon.drainGfxEvents(this.session);
            for (let i = 0; i < events.length; i++) {
                this._sendBinary(events[i]);
            }

            /* Use setImmediate to yield to the event loop between polls.
             * This ensures WebSocket FACK messages are processed promptly. */
            this.pollTimer = setImmediate(poll);
        };

        /* Start polling immediately after connect */
        this.pollTimer = setImmediate(poll);
    }

    _startAudioLoop() {
        const drain = () => {
            if (!this.running || !this.session) return;

            const buf = addon.drainOpusFrames(this.session);
            if (buf) {
                /* buf contains concatenated OPUS wire messages — split and send each */
                let offset = 0;
                while (offset + 12 <= buf.length) {
                    const frameSize = buf.readUInt16LE(offset + 10);
                    const msgLen = 12 + frameSize;
                    if (offset + msgLen > buf.length) break;
                    this._sendBinary(buf.slice(offset, offset + msgLen));
                    offset += msgLen;
                }
                this.audioTimer = setTimeout(drain, 0);
            } else {
                this.audioTimer = setTimeout(drain, 5);
            }
        };

        this.audioTimer = setTimeout(drain, 100);
    }

    _startClipboardLoop() {
        const check = () => {
            if (!this.running || !this.session) return;

            const json = addon.clipboardPopEvent(this.session);
            if (json) {
                this._sendJson(JSON.parse(json));
                this.clipTimer = setTimeout(check, 0);
            } else {
                this.clipTimer = setTimeout(check, 50);
            }
        };

        this.clipTimer = setTimeout(check, 200);
    }

    handleMessage(raw, isBinary) {
        if (!this.running || !this.session) return;

        if (isBinary) {
            /* Binary backchannel — FACK */
            const data = Buffer.from(raw);
            const ack = parseFrameAck(data);
            if (ack) {
                addon.sendFrameAck(this.session, ack.frameId, ack.totalDecoded, ack.queueDepth);
            }
            return;
        }

        let msg;
        try { msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return; }

        switch (msg.type) {
        case 'mouse': {
            let flags = 0;
            const action = msg.action;
            const button = msg.button || 0;

            if (action === 'move') {
                flags = RDP_MOUSE_FLAG_MOVE;
            } else if (action === 'down') {
                flags = RDP_MOUSE_FLAG_DOWN;
                if (button === 0) flags |= RDP_MOUSE_FLAG_BUTTON1;
                else if (button === 2) flags |= RDP_MOUSE_FLAG_BUTTON2;
                else if (button === 1) flags |= RDP_MOUSE_FLAG_BUTTON3;
            } else if (action === 'up') {
                if (button === 0) flags = RDP_MOUSE_FLAG_BUTTON1;
                else if (button === 2) flags = RDP_MOUSE_FLAG_BUTTON2;
                else if (button === 1) flags = RDP_MOUSE_FLAG_BUTTON3;
            } else if (action === 'wheel') {
                const dy = Math.round(msg.deltaY || 0);
                if (dy !== 0) {
                    flags = RDP_MOUSE_FLAG_WHEEL;
                    const clampedDy = Math.max(-0x00FF, Math.min(0x00FF, Math.abs(dy)));
                    if (dy > 0) flags |= RDP_MOUSE_FLAG_NEGATIVE;
                    flags |= (clampedDy & 0x00FF);
                }
                const dx = Math.round(msg.deltaX || 0);
                if (dx !== 0) {
                    flags = RDP_MOUSE_FLAG_HWHEEL;
                    const clampedDx = Math.max(-0x00FF, Math.min(0x00FF, Math.abs(dx)));
                    if (dx < 0) flags |= RDP_MOUSE_FLAG_NEGATIVE;
                    flags |= (clampedDx & 0x00FF);
                }
            }

            if (flags) addon.sendMouse(this.session, flags, msg.x || 0, msg.y || 0);
            break;
        }

        case 'key': {
            const code = msg.code || '';
            const action = msg.action;
            const key = msg.key || '';

            /* Try scancode first */
            const scancode = SCANCODE_MAP[code];
            if (scancode !== undefined) {
                let flags = action === 'up' ? RDP_KBD_FLAG_RELEASE : RDP_KBD_FLAG_DOWN;
                if (EXTENDED_KEYS.has(code)) flags |= RDP_KBD_FLAG_EXTENDED;
                addon.sendKeyboard(this.session, flags, scancode);
            } else if (key.length === 1) {
                /* Unicode character */
                const cp = key.codePointAt(0);
                const flags = action === 'up' ? RDP_KBD_FLAG_RELEASE : RDP_KBD_FLAG_DOWN;
                addon.sendUnicode(this.session, flags, cp);
            }
            break;
        }

        case 'keycombo': {
            const combo = msg.combo || '';
            const keys = combo.split('+').map(k => k.trim());
            /* Press all keys down, then release in reverse */
            for (const k of keys) {
                const sc = SCANCODE_MAP[k] || SCANCODE_MAP[k.replace(/^(.)/, c => c.toUpperCase()) + (k.length > 1 ? k.slice(1) : '')];
                if (sc !== undefined) {
                    let flags = RDP_KBD_FLAG_DOWN;
                    if (EXTENDED_KEYS.has(k)) flags |= RDP_KBD_FLAG_EXTENDED;
                    addon.sendKeyboard(this.session, flags, sc);
                }
            }
            for (const k of keys.reverse()) {
                const sc = SCANCODE_MAP[k] || SCANCODE_MAP[k.replace(/^(.)/, c => c.toUpperCase()) + (k.length > 1 ? k.slice(1) : '')];
                if (sc !== undefined) {
                    let flags = RDP_KBD_FLAG_RELEASE;
                    if (EXTENDED_KEYS.has(k)) flags |= RDP_KBD_FLAG_EXTENDED;
                    addon.sendKeyboard(this.session, flags, sc);
                }
            }
            break;
        }

        case 'resize':
            addon.resize(this.session,
                Math.max(640, Math.min(7680, msg.width || 1280)),
                Math.max(480, Math.min(4320, msg.height || 720)));
            break;

        case 'clipboard-set-text':
            addon.clipboardSetText(this.session, msg.text || '');
            this._sendJson({ type: 'clipboard-set-text-result', ok: true, paste: !!msg.paste });
            break;

        case 'clipboard-set-files':
            /* Files need to be staged on disk first — this path still uses JSON */
            this._sendJson({ type: 'clipboard-set-files-result', ok: false, paste: false, count: 0 });
            break;

        case 'disconnect':
            this.running = false;
            this.cleanup();
            this._sendJson({ type: 'disconnected' });
            break;

        case 'ping':
            this._sendJson({ type: 'pong' });
            break;
        }
    }

    cleanup() {
        this.running = false;
        if (this.pollTimer) { clearImmediate(this.pollTimer); clearTimeout(this.pollTimer); this.pollTimer = null; }
        if (this.audioTimer) { clearTimeout(this.audioTimer); this.audioTimer = null; }
        if (this.clipTimer) { clearTimeout(this.clipTimer); this.clipTimer = null; }

        if (this.session) {
            try { addon.disconnect(this.session); } catch {}
            try { addon.destroy(this.session); } catch {}
            this.session = null;
        }
    }
}

module.exports = {
    tryLoadAddon,
    isAvailable: () => addonAvailable,
    NativeRdpSession,
    parseFrameAck,
};
