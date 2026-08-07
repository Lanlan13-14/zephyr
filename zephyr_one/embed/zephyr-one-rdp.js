/*
 * zephyr-one-rdp.js — canvas presenter for Zephyr One's native RDP session.
 *
 * Zephyr One only. Copied into the staged core by scripts/stage-native-rdp.mjs;
 * the browser product never receives it and keeps its Go/WASM client.
 *
 * Division of labour:
 *   native helper  — the entire RDP protocol via libfreerdp (codecs, NLA, audio,
 *                    clipboard, RDPDR drive redirection)
 *   Node bridge    — auth, credential resolution, process lifecycle, framing
 *   this file      — blit damage rects, forward input. Nothing protocol-aware.
 *
 * Wire format (binary WebSocket, length prefix already stripped by the bridge):
 *   inbound  0x81 FRAME  x:u16 y:u16 w:u16 h:u16 then w*h*4 RGBA bytes
 *            0x82 EVENT  UTF-8 JSON
 *   outbound [kind, ...payload]; the bridge adds the length prefix.
 *
 * Byte order note: the helper packs RGBA (it swaps FreeRDP's BGRA in C), which
 * is exactly what ImageData wants, so there is no per-pixel work here. That
 * ordering is asserted against a live session by e2e/live-session.py rather than
 * trusted from FreeRDP's PIXEL_FORMAT_* naming.
 */
'use strict';

/* Must match zephyr-one-rdp-native.js MSG and the Rust proto.rs. */
var MSG = {
    MOUSE: 0x01,
    MOUSE_EX: 0x02,
    SCANCODE: 0x03,
    UNICODE: 0x04,
    SYNC: 0x05,
    RESIZE: 0x06,
    CLIPBOARD: 0x07,
    FULL_FRAME: 0x08,
    STOP: 0x09,
    FRAME: 0x81,
    EVENT: 0x82,
};

/* MS-RDPBCGR 2.2.8.1.1.3.1.1.1 */
var PTR_FLAGS_MOVE = 0x0800;
var PTR_FLAGS_DOWN = 0x8000;
var PTR_FLAGS_BUTTON1 = 0x1000;
var PTR_FLAGS_BUTTON2 = 0x2000;
var PTR_FLAGS_BUTTON3 = 0x4000;
var PTR_FLAGS_WHEEL = 0x0200;
var PTR_FLAGS_HWHEEL = 0x0400;
var PTR_FLAGS_WHEEL_NEGATIVE = 0x0100;
var PTR_XFLAGS_DOWN = 0x8000;
var PTR_XFLAGS_BUTTON1 = 0x0001;
var PTR_XFLAGS_BUTTON2 = 0x0002;

var KBD_FLAGS_EXTENDED = 0x0100;
var KBD_FLAGS_RELEASE = 0x8000;

var canvas = document.getElementById('screen');
var ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;

var overlay = document.getElementById('overlay');
var ovTitle = document.getElementById('ovTitle');
var ovBody = document.getElementById('ovBody');
var ovDetail = document.getElementById('ovDetail');
var ovActions = document.getElementById('ovActions');
var ovRetry = document.getElementById('ovRetry');
var ime = document.getElementById('ime');

var params = new URLSearchParams(location.search);
var connectionId = params.get('connectionId') || '';
var tabId = params.get('tabId') || '';

var socket = null;
var connected = false;
var closingForGood = false;

/* Reused ImageData, grown on demand. Allocating per frame would churn the GC at
 * 60 fps with multi-megabyte buffers. */
var scratch = null;

function ensureScratch(w, h) {
    if (!scratch || scratch.width !== w || scratch.height !== h) {
        scratch = ctx.createImageData(w, h);
    }
    return scratch;
}

function showOverlay(title, body, opts) {
    var options = opts || {};
    overlay.hidden = false;
    ovTitle.innerHTML = options.busy === false
        ? ''
        : '<span class="spinner"></span>';
    ovTitle.appendChild(document.createTextNode(title));
    ovBody.textContent = body || '';
    ovBody.className = options.error ? 'err' : '';
    if (options.detail) {
        ovDetail.hidden = false;
        ovDetail.textContent = options.detail;
    } else {
        ovDetail.hidden = true;
        ovDetail.textContent = '';
    }
    ovActions.hidden = !options.retry;
}

function hideOverlay() {
    overlay.hidden = true;
}

function resizeCanvas(w, h) {
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    fitCanvas();
}

/*
 * Fit the remote desktop into the tab without distortion. The canvas keeps its
 * device-pixel size; only the CSS box changes, so the pixels the helper sent are
 * never resampled by us — the compositor scales once, on the GPU.
 */
function fitCanvas() {
    var availW = document.documentElement.clientWidth;
    var availH = document.documentElement.clientHeight;
    if (!canvas.width || !canvas.height || !availW || !availH) return;
    var scale = Math.min(availW / canvas.width, availH / canvas.height);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    canvas.style.width = Math.floor(canvas.width * scale) + 'px';
    canvas.style.height = Math.floor(canvas.height * scale) + 'px';
}

function drawFrame(view) {
    /* 1 kind + 8 header, then pixels. */
    if (view.byteLength < 9) return;
    var x = view.getUint16(1, true);
    var y = view.getUint16(3, true);
    var w = view.getUint16(5, true);
    var h = view.getUint16(7, true);
    if (!w || !h) return;
    var need = w * h * 4;
    if (view.byteLength - 9 < need) return;

    var img = ensureScratch(w, h);
    var src = new Uint8Array(view.buffer, view.byteOffset + 9, need);
    img.data.set(src);
    ctx.putImageData(img, x, y);
}

function handleEvent(event) {
    switch (event.type) {
        case 'hello':
            /* Recorded because "which FreeRDP is actually linked" is the first
             * question any protocol bug raises, and because it states plainly
             * whether the folder mapping was accepted. */
            console.info('[one-rdp] helper ready', {
                freerdpMajor: event.freerdpMajor,
                driveMapped: event.driveMapped,
                driveName: event.driveName,
            });
            if (event.driveMapped) {
                showOverlay('正在连接…', '已映射文件夹为磁盘：' + (event.driveName || ''));
            }
            break;

        case 'connected':
            connected = true;
            resizeCanvas(event.width, event.height);
            hideOverlay();
            canvas.focus();
            /* Announce the local toggle state once the channel exists. */
            send1(MSG.SYNC, new Uint8Array(4));
            break;

        case 'resize':
            resizeCanvas(event.width, event.height);
            break;

        case 'clipboard':
            if (navigator.clipboard && event.text) {
                navigator.clipboard.writeText(event.text).catch(function () { /* denied */ });
            }
            break;

        case 'certificate':
            console.info('[one-rdp] server certificate fingerprint', event.fingerprint);
            break;

        /* A virtual channel came up. `rdpdr` is the one that matters for folder
         * mapping: it is the observable proof the drive channel opened, as
         * opposed to the mapping merely having been configured. Kept separate
         * from `certificate` because both used to share one shim event code, and
         * a channel name reported as a TLS fingerprint would send anyone
         * investigating a certificate mismatch down a false trail. */
        case 'channel':
            console.info('[one-rdp] channel connected', event.name);
            break;

        case 'disconnected':
            connected = false;
            if (!closingForGood) {
                showOverlay('会话已结束', '远程主机断开了连接。', {
                    busy: false, retry: true,
                });
            }
            break;

        case 'error':
            connected = false;
            showOverlay('连接失败', event.message || '未知错误', {
                busy: false, error: true, retry: true,
            });
            break;

        case 'helper-exit':
            if (!connected && !closingForGood) {
                showOverlay('本机 RDP 组件已退出', 'FreeRDP 会话进程结束。', {
                    busy: false, error: true, retry: true, detail: event.detail || '',
                });
            }
            break;

        case 'log':
            console.debug('[one-rdp]', event.message || '');
            break;

        default:
            console.debug('[one-rdp] unhandled event', event);
            break;
    }
}

/* ── outbound ─────────────────────────────────────────────────────────────── */

function sendBytes(bytes) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
        socket.send(bytes);
    } catch (error) {
        console.debug('[one-rdp] send failed', error);
    }
}

function send1(kind, payload) {
    var body = new Uint8Array(1 + (payload ? payload.length : 0));
    body[0] = kind;
    if (payload && payload.length) body.set(payload, 1);
    sendBytes(body);
}

function sendMouse(kind, flags, x, y) {
    var body = new Uint8Array(7);
    var view = new DataView(body.buffer);
    body[0] = kind;
    view.setUint16(1, flags, true);
    view.setUint16(3, x, true);
    view.setUint16(5, y, true);
    sendBytes(body);
}

function sendKey(kind, flags, code) {
    var body = new Uint8Array(5);
    var view = new DataView(body.buffer);
    body[0] = kind;
    view.setUint16(1, flags, true);
    view.setUint16(3, code, true);
    sendBytes(body);
}

/* Canvas CSS box → remote desktop coordinates. Clamped because a pointer can
 * legitimately be a fraction of a pixel outside the box during a drag, and the
 * wire format is unsigned. */
function toRemote(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var x = Math.round((clientX - rect.left) * (canvas.width / rect.width));
    var y = Math.round((clientY - rect.top) * (canvas.height / rect.height));
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > canvas.width - 1) x = canvas.width - 1;
    if (y > canvas.height - 1) y = canvas.height - 1;
    return { x: x, y: y };
}

var BUTTON_FLAG = {
    0: PTR_FLAGS_BUTTON1,
    1: PTR_FLAGS_BUTTON3, /* middle */
    2: PTR_FLAGS_BUTTON2, /* right  */
};
var XBUTTON_FLAG = { 3: PTR_XFLAGS_BUTTON1, 4: PTR_XFLAGS_BUTTON2 };

canvas.addEventListener('pointerdown', function (event) {
    var pos = toRemote(event.clientX, event.clientY);
    if (!pos) return;
    canvas.focus();
    if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    }
    if (XBUTTON_FLAG[event.button] !== undefined) {
        sendMouse(MSG.MOUSE_EX, PTR_XFLAGS_DOWN | XBUTTON_FLAG[event.button], pos.x, pos.y);
    } else {
        var flag = BUTTON_FLAG[event.button];
        if (flag === undefined) return;
        sendMouse(MSG.MOUSE, PTR_FLAGS_DOWN | flag, pos.x, pos.y);
    }
    event.preventDefault();
});

canvas.addEventListener('pointerup', function (event) {
    var pos = toRemote(event.clientX, event.clientY);
    if (!pos) return;
    if (XBUTTON_FLAG[event.button] !== undefined) {
        sendMouse(MSG.MOUSE_EX, XBUTTON_FLAG[event.button], pos.x, pos.y);
    } else {
        var flag = BUTTON_FLAG[event.button];
        if (flag === undefined) return;
        sendMouse(MSG.MOUSE, flag, pos.x, pos.y);
    }
    event.preventDefault();
});

canvas.addEventListener('pointermove', function (event) {
    var pos = toRemote(event.clientX, event.clientY);
    if (!pos) return;
    sendMouse(MSG.MOUSE, PTR_FLAGS_MOVE, pos.x, pos.y);
});

canvas.addEventListener('contextmenu', function (event) {
    /* The remote side draws its own context menu; the browser's would cover it. */
    event.preventDefault();
});

canvas.addEventListener('wheel', function (event) {
    var pos = toRemote(event.clientX, event.clientY);
    if (!pos) return;
    /*
     * RDP encodes wheel distance in the low 9 bits with a separate sign bit, so
     * the magnitude is clamped to 255 rather than wrapped — a large trackpad
     * fling would otherwise scroll the wrong way.
     */
    var vertical = event.deltaY;
    var horizontal = event.deltaX;
    if (vertical) {
        var vmag = Math.min(255, Math.max(1, Math.round(Math.abs(vertical))));
        var vflags = PTR_FLAGS_WHEEL | vmag;
        if (vertical > 0) vflags |= PTR_FLAGS_WHEEL_NEGATIVE; /* down = negative */
        sendMouse(MSG.MOUSE, vflags, pos.x, pos.y);
    }
    if (horizontal) {
        var hmag = Math.min(255, Math.max(1, Math.round(Math.abs(horizontal))));
        var hflags = PTR_FLAGS_HWHEEL | hmag;
        if (horizontal < 0) hflags |= PTR_FLAGS_WHEEL_NEGATIVE;
        sendMouse(MSG.MOUSE, hflags, pos.x, pos.y);
    }
    event.preventDefault();
}, { passive: false });

/*
 * KeyboardEvent.code → PC/AT set-1 scancode.
 *
 * Built from event.code, not event.key: code is layout-independent, so a Dvorak
 * or AZERTY user gets the physical key the remote keyboard layout expects.
 * Printable characters that fall outside this table go through the Unicode path
 * instead, which is how CJK IME composition reaches the session at all.
 */
var SCAN = {
    Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
    Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a,
    Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
    KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
    KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
    BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
    KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
    KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28,
    Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
    KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31,
    KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
    NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
    F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
    F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
    Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
    Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
    NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
    IntlRo: 0x73, IntlYen: 0x7d,
};

/* Keys that must carry the E0 prefix. */
var SCAN_EXT = {
    ControlRight: 0x1d, AltRight: 0x38, NumpadEnter: 0x1c, NumpadDivide: 0x35,
    Home: 0x47, ArrowUp: 0x48, PageUp: 0x49, ArrowLeft: 0x4b,
    ArrowRight: 0x4d, End: 0x4f, ArrowDown: 0x50, PageDown: 0x51,
    Insert: 0x52, Delete: 0x53, MetaLeft: 0x5b, MetaRight: 0x5c,
    ContextMenu: 0x5d, PrintScreen: 0x37, Pause: 0x45,
};

function scancodeFor(code) {
    if (SCAN[code] !== undefined) return { code: SCAN[code], extended: false };
    if (SCAN_EXT[code] !== undefined) return { code: SCAN_EXT[code], extended: true };
    return null;
}

function onKey(event, down) {
    var mapped = scancodeFor(event.code);
    if (!mapped) {
        /* Unmapped printable key: send the character itself. This is also the
         * path IME-composed CJK text takes. */
        if (down && event.key && event.key.length === 1) {
            var unit = event.key.charCodeAt(0);
            sendKey(MSG.UNICODE, 0, unit);
        }
        return;
    }
    var flags = 0;
    if (mapped.extended) flags |= KBD_FLAGS_EXTENDED;
    if (!down) flags |= KBD_FLAGS_RELEASE;
    sendKey(MSG.SCANCODE, flags, mapped.code);
    /* Browser shortcuts (Ctrl+W, Ctrl+R, F5, …) belong to the remote session. */
    event.preventDefault();
}

canvas.addEventListener('keydown', function (event) { onKey(event, true); });
canvas.addEventListener('keyup', function (event) { onKey(event, false); });

/* IME composition: commit the composed string as Unicode key events. Scancodes
 * cannot express it, and this is the only path CJK input has. */
ime.addEventListener('compositionend', function (event) {
    var text = event.data || '';
    for (var i = 0; i < text.length; i++) {
        sendKey(MSG.UNICODE, 0, text.charCodeAt(i));
    }
    ime.value = '';
});

/* Push local clipboard on focus so a copy made outside the tab is available
 * inside the session. Silently ignored when the permission is refused. */
canvas.addEventListener('focus', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    navigator.clipboard.readText().then(function (text) {
        if (!text) return;
        var bytes = new TextEncoder().encode(text);
        send1(MSG.CLIPBOARD, bytes);
    }).catch(function () { /* denied — expected without a user gesture */ });
});

/*
 * Viewport changes ask the remote desktop to follow, via the disp channel. The
 * request is debounced because a drag emits a resize per frame and each one
 * would be a monitor-layout PDU.
 */
var resizeTimer = null;
window.addEventListener('resize', function () {
    fitCanvas();
    if (!connected) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
        resizeTimer = null;
        var w = Math.max(200, Math.min(8192, document.documentElement.clientWidth)) & ~1;
        var h = Math.max(200, Math.min(8192, document.documentElement.clientHeight)) & ~1;
        var body = new Uint8Array(9);
        var view = new DataView(body.buffer);
        body[0] = MSG.RESIZE;
        view.setUint32(1, w, true);
        view.setUint32(5, h, true);
        sendBytes(body);
    }, 300);
});

/* Re-attaching a backgrounded tab: the canvas still holds the last frame, but
 * anything that changed while hidden was never sent, so ask for a full repaint
 * rather than showing a stale screen. */
document.addEventListener('visibilitychange', function () {
    if (!document.hidden && connected) send1(MSG.FULL_FRAME, null);
});

/* ── transport ────────────────────────────────────────────────────────────── */

function connect() {
    closingForGood = false;
    showOverlay('正在连接…', '正在启动本机 FreeRDP 会话。');

    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var query = new URLSearchParams({
        connectionId: connectionId,
        tabId: tabId,
        width: String(document.documentElement.clientWidth || 1920),
        height: String(document.documentElement.clientHeight || 1080),
    });
    socket = new WebSocket(scheme + '//' + location.host + '/zephyr-one-rdp?' + query);
    socket.binaryType = 'arraybuffer';

    socket.onmessage = function (event) {
        if (typeof event.data === 'string') {
            /* Bridge-level JSON (auth failure, helper exit) — the helper's own
             * events arrive as binary 0x82 instead. */
            try {
                handleEvent(JSON.parse(event.data));
            } catch (error) {
                console.debug('[one-rdp] bad text message', error);
            }
            return;
        }
        var view = new DataView(event.data);
        if (view.byteLength < 1) return;
        var kind = view.getUint8(0);
        if (kind === MSG.FRAME) {
            drawFrame(view);
        } else if (kind === MSG.EVENT) {
            var json = new TextDecoder().decode(
                new Uint8Array(event.data, 1, view.byteLength - 1));
            try {
                handleEvent(JSON.parse(json));
            } catch (error) {
                console.debug('[one-rdp] bad event payload', error);
            }
        }
    };

    socket.onerror = function () {
        if (!connected) {
            showOverlay('无法连接本机服务', '请确认 Zephyr One 本地核心正在运行。', {
                busy: false, error: true, retry: true,
            });
        }
    };

    socket.onclose = function () {
        var wasConnected = connected;
        connected = false;
        if (closingForGood) return;
        showOverlay(
            wasConnected ? '会话已结束' : '连接已关闭',
            wasConnected ? '与远程主机的连接已断开。' : '本机 RDP 会话未能建立。',
            { busy: false, error: !wasConnected, retry: true },
        );
    };
}

ovRetry.addEventListener('click', function () {
    if (socket) {
        closingForGood = true;
        try { socket.close(); } catch (error) { /* already closed */ }
        socket = null;
    }
    connect();
});

/* Tell the helper to disconnect cleanly instead of letting the RDP session time
 * out server-side when the tab goes away. */
window.addEventListener('beforeunload', function () {
    closingForGood = true;
    send1(MSG.STOP, null);
    if (socket) {
        try { socket.close(); } catch (error) { /* already closed */ }
    }
});

if (!connectionId) {
    showOverlay('缺少连接参数', '未提供 connectionId，无法建立会话。', {
        busy: false, error: true,
    });
} else {
    fitCanvas();
    connect();
}
