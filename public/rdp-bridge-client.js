/**
 * rdp-bridge-client.js — FreeRDP Bridge 前端 (clean)
 */
const MSG_BITMAP_BGRA = 1, MSG_H264_FRAME = 2, MSG_DESKTOP_SIZE = 3;
const MSG_CONNECTED = 4, MSG_DISCONNECTED = 5, MSG_ERROR = 6;
const MSG_FRAME_START = 8, MSG_FRAME_END = 9, MSG_CAPABILITIES = 10;
const MSG_MOUSE_EVENT = 100, MSG_KEYBOARD_EVENT = 101, MSG_UNICODE_EVENT = 102;
const MSG_DISCONNECT = 104, MSG_FRAME_ACK = 105;

const PTR_FLAGS_MOVE = 0x0800, PTR_FLAGS_DOWN = 0x8000;
const PTR_FLAGS_BUTTON1 = 0x1000, PTR_FLAGS_BUTTON2 = 0x2000, PTR_FLAGS_BUTTON3 = 0x4000;
const PTR_FLAGS_WHEEL = 0x0200, PTR_FLAGS_WHEEL_NEGATIVE = 0x0100;
const KBD_FLAGS_DOWN = 0x4000, KBD_FLAGS_RELEASE = 0x8000, KBD_FLAGS_EXTENDED = 0x0100;

/* DOM setup — create canvas in #display */
const displayDiv = document.getElementById('display');
const canvas = document.createElement('canvas');
canvas.id = 'rdpCanvas';
canvas.tabIndex = 0;
canvas.style.display = 'block';
canvas.style.width = '100%';
canvas.style.height = '100%';
canvas.style.background = '#000';
canvas.style.touchAction = 'none';
displayDiv.innerHTML = '';
displayDiv.appendChild(canvas);

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const overlay = document.getElementById('rdpOverlay');
const overlayMsg = document.getElementById('overlayMsg');
const connInfo = document.getElementById('connInfo');

let ws = null, gl = null, glTex = null, glProg = null, glSampLoc = null;
let texW = 0, texH = 0, desktopW = 1920, desktopH = 1080;
let connected = false, h264Decoder = null;
let frameCount = 0;

function setStatus(msg, isConnected = false) {
    if (statusText) statusText.textContent = msg;
    if (statusDot) { statusDot.classList.toggle('connected', isConnected); statusDot.classList.toggle('disconnected', !isConnected); }
    if (overlay && overlayMsg) { overlayMsg.textContent = msg; overlay.classList.toggle('hidden', isConnected); }
}

/* ─── WebGL init ─────────────────────────────────────────────── */
function initWebGL(w, h) {
    canvas.width = w; canvas.height = h; desktopW = w; desktopH = h;
    if (gl) { gl.deleteTexture(glTex); gl.deleteProgram(glProg); }
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) { console.error('[rdp] WebGL not available'); return false; }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, 1,1,1,0]), gl.STATIC_DRAW);

    const vs = `attribute vec2 a_pos; attribute vec2 a_tex; varying vec2 v_tex;
    void main() { gl_Position = vec4(a_pos, 0, 1); v_tex = a_tex; }`;
    const fs = `precision mediump float; uniform sampler2D u_tex; varying vec2 v_tex;
    void main() { vec4 c = texture2D(u_tex, v_tex); gl_FragColor = vec4(c.b, c.g, c.r, 1.0); }`;

    const cs = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
    glProg = gl.createProgram();
    gl.attachShader(glProg, cs(gl.VERTEX_SHADER, vs));
    gl.attachShader(glProg, cs(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(glProg);
    gl.useProgram(glProg);

    const pl = gl.getAttribLocation(glProg, 'a_pos'), tl = gl.getAttribLocation(glProg, 'a_tex');
    gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(tl); gl.vertexAttribPointer(tl, 2, gl.FLOAT, false, 16, 8);
    glSampLoc = gl.getUniformLocation(glProg, 'u_tex'); gl.uniform1i(glSampLoc, 0);

    glTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    texW = w; texH = h; gl.viewport(0, 0, w, h); gl.disable(gl.BLEND);
    return true;
}

function drawBGRA(x, y, w, h, data) {
    if (!gl || !glTex) return;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/* ─── Frame parser ───────────────────────────────────────────── */
function parseFrame(buf) {
    if (buf.byteLength < 8) return;
    const dv = new DataView(buf);
    const type = dv.getUint32(0, true), plen = dv.getUint32(4, true);
    if (buf.byteLength < 8 + plen) return;

    switch (type) {
        case MSG_DESKTOP_SIZE: {
            if (plen >= 4) {
                const w = new DataView(buf, 8).getUint16(0, true), h = new DataView(buf, 8).getUint16(2, true);
                if (w > 0 && h > 0) initWebGL(w, h);
            }
            break;
        }
        case MSG_CONNECTED:
            connected = true; setStatus('已连接', true);
            if ('VideoDecoder' in window && !h264Decoder) {
                h264Decoder = new VideoDecoder({ output: (f) => { frameCount++; f.close(); }, error: () => {} });
                h264Decoder.configure({ codec: 'avc1.640028', optimizeForLatency: true });
            }
            break;
        case MSG_DISCONNECTED:
            connected = false; setStatus('连接已断开'); break;
        case MSG_ERROR:
            setStatus('错误: ' + new TextDecoder().decode(new Uint8Array(buf, 8, plen))); break;
        case MSG_BITMAP_BGRA: {
            if (plen < 8) break;
            const pv = new DataView(buf, 8);
            const x = pv.getUint16(0, true), y = pv.getUint16(2, true);
            const w = pv.getUint16(4, true), h = pv.getUint16(6, true);
            if (w > 0 && h > 0 && plen >= 8 + w*h*4) {
                drawBGRA(x, y, w, h, new Uint8Array(buf, 16, w*h*4));
                frameCount++;
            }
            break;
        }
        case MSG_FRAME_END:
            if (plen >= 4 && ws?.readyState === WebSocket.OPEN) {
                const fid = new DataView(buf, 8).getUint32(0, true);
                const ab = new ArrayBuffer(12);
                new DataView(ab).setUint32(0, MSG_FRAME_ACK, true);
                new DataView(ab).setUint32(4, 4, true);
                new DataView(ab).setUint32(8, fid, true);
                ws.send(ab);
            }
            break;
    }
}

/* ─── Send helper ────────────────────────────────────────────── */
function sendMsg(type, cb, pl) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const ab = new ArrayBuffer(8 + pl);
    new DataView(ab).setUint32(0, type, true);
    new DataView(ab).setUint32(4, pl, true);
    if (cb) cb(new DataView(ab, 8));
    ws.send(ab);
}

/* ─── Input events ───────────────────────────────────────────── */
const keyMap = {
    KeyA:0x1E,KeyB:0x30,KeyC:0x2E,KeyD:0x20,KeyE:0x12,KeyF:0x21,KeyG:0x22,KeyH:0x23,
    KeyI:0x17,KeyJ:0x24,KeyK:0x25,KeyL:0x26,KeyM:0x32,KeyN:0x31,KeyO:0x18,KeyP:0x19,
    KeyQ:0x10,KeyR:0x13,KeyS:0x1F,KeyT:0x14,KeyU:0x16,KeyV:0x2F,KeyW:0x11,KeyX:0x2D,
    KeyY:0x15,KeyZ:0x2C,
    Digit1:0x02,Digit2:0x03,Digit3:0x04,Digit4:0x05,Digit5:0x06,Digit6:0x07,
    Digit7:0x08,Digit8:0x09,Digit9:0x0A,Digit0:0x0B,Minus:0x0C,Equal:0x0D,
    Backspace:0x0E,Tab:0x0F,BracketLeft:0x1A,BracketRight:0x1B,Enter:0x1C,
    Semicolon:0x27,Quote:0x28,Backquote:0x29,Backslash:0x2B,Comma:0x33,
    Period:0x34,Slash:0x35,Space:0x39,CapsLock:0x3A,
    F1:0x3B,F2:0x3C,F3:0x3D,F4:0x3E,F5:0x3F,F6:0x40,F7:0x41,F8:0x42,F9:0x43,F10:0x44,F11:0x57,F12:0x58,
    Escape:0x01,Insert:0xE052,Delete:0xE053,Home:0xE047,End:0xE04F,
    PageUp:0xE049,PageDown:0xE051,ArrowUp:0xE048,ArrowDown:0xE050,
    ArrowLeft:0xE04B,ArrowRight:0xE04D,ShiftLeft:0x2A,ShiftRight:0x36,
    ControlLeft:0x1D,ControlRight:0xE01D,AltLeft:0x38,AltRight:0xE038,
    MetaLeft:0xE05B,MetaRight:0xE05C,
};

function canvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0,Math.min(desktopW-1,Math.round((e.clientX-r.left)*desktopW/r.width))),
            Math.max(0,Math.min(desktopH-1,Math.round((e.clientY-r.top)*desktopH/r.height)))];
}

canvas.addEventListener('mousemove', (e) => { const [x,y]=canvasXY(e); sendMsg(MSG_MOUSE_EVENT, d=>{d.setUint16(0,PTR_FLAGS_MOVE,true);d.setUint16(2,x,true);d.setUint16(4,y,true);},6); });
canvas.addEventListener('mousedown', (e) => { e.preventDefault(); const [x,y]=canvasXY(e); const b=e.button===0?PTR_FLAGS_BUTTON1:e.button===2?PTR_FLAGS_BUTTON2:PTR_FLAGS_BUTTON3; sendMsg(MSG_MOUSE_EVENT,d=>{d.setUint16(0,PTR_FLAGS_DOWN|b,true);d.setUint16(2,x,true);d.setUint16(4,y,true);},6); });
canvas.addEventListener('mouseup', (e) => { e.preventDefault(); const [x,y]=canvasXY(e); const b=e.button===0?PTR_FLAGS_BUTTON1:e.button===2?PTR_FLAGS_BUTTON2:PTR_FLAGS_BUTTON3; sendMsg(MSG_MOUSE_EVENT,d=>{d.setUint16(0,b,true);d.setUint16(2,x,true);d.setUint16(4,y,true);},6); });
canvas.addEventListener('contextmenu', e=>e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); const [x,y]=canvasXY(e); const n=e.deltaY>0?PTR_FLAGS_WHEEL_NEGATIVE:0; sendMsg(MSG_MOUSE_EVENT,d=>{d.setUint16(0,PTR_FLAGS_WHEEL|n|Math.min(Math.abs(Math.round(e.deltaY)),0xFF),true);d.setUint16(2,x,true);d.setUint16(4,y,true);},6); },{passive:false});

document.addEventListener('keydown', (e) => { if(!connected)return;const sc=keyMap[e.code];if(!sc)return;sendMsg(MSG_KEYBOARD_EVENT,d=>{d.setUint16(0,KBD_FLAGS_DOWN|((sc&0xE000)?KBD_FLAGS_EXTENDED:0),true);d.setUint16(2,sc&0xFF,true);},4);e.preventDefault(); });
document.addEventListener('keyup', (e) => { if(!connected)return;const sc=keyMap[e.code];if(!sc)return;sendMsg(MSG_KEYBOARD_EVENT,d=>{d.setUint16(0,KBD_FLAGS_RELEASE|((sc&0xE000)?KBD_FLAGS_EXTENDED:0),true);d.setUint16(2,sc&0xFF,true);},4);e.preventDefault(); });

/* ─── Buttons ────────────────────────────────────────────────── */
document.getElementById('reconnectBtn')?.addEventListener('click', () => { try{ws?.close(1000);}catch{} ws=null; setTimeout(connect, 300); });
document.getElementById('disconnectBtn')?.addEventListener('click', () => { sendMsg(MSG_DISCONNECT,null,0); ws?.close(1000); });

/* ─── Connect ────────────────────────────────────────────────── */
let reconnectTimer = null;
function connect() {
    const p = new URLSearchParams(location.search);
    const cid = p.get('connectionId') || '';
    if (!cid) { setStatus('缺少 connectionId'); return; }
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

    initWebGL(desktopW, desktopH);
    setStatus('正在连接...');

    const wsUrl = `${location.protocol==='https:'?'wss':'ws'}://${location.host}/rdp-bridge?connectionId=${encodeURIComponent(cid)}`;
    ws = new WebSocket(wsUrl, ['zephyr-rdp']);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => { setStatus('已连接，等待画面...'); canvas.focus(); });
    ws.addEventListener('message', (e) => parseFrame(e.data));
    ws.addEventListener('close', (e) => { connected = false; setStatus(`断开 (${e.code})`); reconnectTimer = setTimeout(connect, 2000); });
    ws.addEventListener('error', () => setStatus('连接错误'));
}
window.addEventListener('beforeunload', () => { if (ws?.readyState === WebSocket.OPEN) sendMsg(MSG_DISCONNECT, null, 0); });

connect();
