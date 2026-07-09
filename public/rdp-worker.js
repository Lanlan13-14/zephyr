/* Zephyr RDP Worker — owns Rust/IronRDP WASM and protocol I/O. */

let RdpWasm = null;
let wasmReady = false;
let sab = null;
let ctrl = null;
let pixels = null;
let frameWidth = 0;
let frameHeight = 0;
const CTRL_I32_LEN = 69;
const PIXELS_OFFSET = 276;

async function ensureWasm() {
  if (wasmReady) return;
  RdpWasm = await import('./vendor/rdp-client/rdp_client_wasm.js');
  const wasmUrl = new URL('./vendor/rdp-client/rdp_client_wasm_bg.wasm', import.meta.url);
  await RdpWasm.default({ module_or_path: wasmUrl });
  if (typeof RdpWasm.setup === 'function') RdpWasm.setup('info');
  wasmReady = true;
}

function setDesktopSize(width, height) {
  frameWidth = width | 0;
  frameHeight = height | 0;
  if (ctrl) {
    Atomics.store(ctrl, 5, frameWidth);
    Atomics.store(ctrl, 6, frameHeight);
  }
}

function blitRGBA(x, y, w, h, data) {
  if (!ctrl || !pixels || !frameWidth || !frameHeight) {
    self.postMessage({ type: 'bitmap_rgba', x, y, w, h, data }, [data.buffer]);
    return true;
  }
  x |= 0; y |= 0; w |= 0; h |= 0;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return false;
  const clippedW = Math.min(w, frameWidth - x);
  const clippedH = Math.min(h, frameHeight - y);
  if (clippedW <= 0 || clippedH <= 0) return false;
  const rowBytes = clippedW * 4;
  const srcStride = w * 4;
  for (let row = 0; row < clippedH; row++) {
    const src = row * srcStride;
    const dst = ((y + row) * frameWidth + x) * 4;
    pixels.set(data.subarray(src, src + rowBytes), dst);
  }
  const dirty = Atomics.load(ctrl, 0);
  if (dirty === 0) {
    Atomics.store(ctrl, 1, x);
    Atomics.store(ctrl, 2, y);
    Atomics.store(ctrl, 3, x + clippedW);
    Atomics.store(ctrl, 4, y + clippedH);
  } else {
    Atomics.store(ctrl, 1, Math.min(Atomics.load(ctrl, 1), x));
    Atomics.store(ctrl, 2, Math.min(Atomics.load(ctrl, 2), y));
    Atomics.store(ctrl, 3, Math.max(Atomics.load(ctrl, 3), x + clippedW));
    Atomics.store(ctrl, 4, Math.max(Atomics.load(ctrl, 4), y + clippedH));
  }
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0, 1);
  return true;
}

globalThis.rdpDrawBitmapRGBA = (x, y, w, h, data) => blitRGBA(x, y, w, h, data instanceof Uint8Array ? data : new Uint8Array(data));
globalThis.rdpOnDesktopResize = (width, height) => {
  setDesktopSize(width, height);
  self.postMessage({ type: 'desktop_resize', width, height });
};
globalThis.rdpOnReady = () => self.postMessage({ type: 'ready_rdp' });
globalThis.rdpOnError = (message) => self.postMessage({ type: 'error', message: String(message || '') });
globalThis.rdpOnClose = () => self.postMessage({ type: 'close' });
globalThis.rdpOnClipboard = (text) => self.postMessage({ type: 'clipboard', text });
globalThis.rdpOnRemoteFiles = (files) => self.postMessage({ type: 'remote_files', files });
globalThis.rdpOnH264 = (dx, dy, w, h, isKey, data) => self.postMessage({ type: 'h264', dx, dy, w, h, isKey, data }, [data.buffer]);
globalThis.rdpAudioPlay = (sr, ch, bps, data) => self.postMessage({ type: 'audio', sr, ch, bps, data }, [data.buffer]);
globalThis.rdpAudioReset = () => self.postMessage({ type: 'audio_reset' });
globalThis.rdpOnPointerUpdate = (...args) => self.postMessage({ type: 'pointer_update', args });
globalThis.rdpOnPointerHide = () => self.postMessage({ type: 'pointer_hide' });
globalThis.rdpOnPointerCached = (idx) => self.postMessage({ type: 'pointer_cached', idx });

const combos = {
  ctrl_alt_del: [[0x1D, false], [0x38, false], [0xE053, true]],
  win_tab: [[0xE05B, true], [0x0F, false]],
  win_d: [[0xE05B, true], [0x20, false]],
  alt_left: [[0x38, false], [0xE04B, true]],
  alt_right: [[0x38, false], [0xE04D, true]],
};

function keyCombo(combo) {
  const keys = combos[combo] || [];
  for (const [sc, ext] of keys) RdpWasm?.rdp_key_down(sc, ext);
  setTimeout(() => {
    for (const [sc, ext] of keys.slice().reverse()) RdpWasm?.rdp_key_up(sc, ext);
  }, 50);
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      await ensureWasm();
      sab = msg.sab || null;
      ctrl = sab ? new Int32Array(sab, 0, CTRL_I32_LEN) : null;
      pixels = sab ? new Uint8Array(sab, PIXELS_OFFSET, msg.width * msg.height * 4) : null;
      setDesktopSize(msg.width, msg.height);
      self.postMessage({ type: 'ready' });
      return;
    }
    await ensureWasm();
    switch (msg.type) {
      case 'connect':
        await RdpWasm.rdp_connect(msg.proxyWsUrl, msg.host, msg.port, msg.domain || '', msg.user || '', msg.password || '', msg.width, msg.height, !!msg.swapAltMeta, !!msg.micEnabled, !!msg.locationEnabled, !!msg.storageEnabled, !!msg.cameraEnabled, !!msg.h264Supported, !!msg.wallpaper);
        return;
      case 'disconnect': RdpWasm.rdp_disconnect(); return;
      case 'mouse_move': RdpWasm.rdp_mouse_move(msg.x, msg.y); return;
      case 'mouse_down': RdpWasm.rdp_mouse_down(msg.button, msg.x, msg.y); return;
      case 'mouse_up': RdpWasm.rdp_mouse_up(msg.button, msg.x, msg.y); return;
      case 'mouse_wheel': RdpWasm.rdp_mouse_wheel(msg.delta, msg.x || 0, msg.y || 0); return;
      case 'mouse_h_scroll': RdpWasm.rdp_mouse_h_scroll(msg.delta, msg.x || 0, msg.y || 0); return;
      case 'key_down': RdpWasm.rdp_key_down(msg.scancode, !!msg.extended); return;
      case 'key_up': RdpWasm.rdp_key_up(msg.scancode, !!msg.extended); return;
      case 'key_combo': keyCombo(msg.combo); return;
      case 'clipboard_changed': await RdpWasm.rdp_clipboard_changed(msg.text || ''); return;
      case 'notify_files': RdpWasm.rdp_notify_files_changed(); return;
      case 'download_file': RdpWasm.rdp_download_server_file(msg.index, (data) => self.postMessage({ type: 'download_file_result', requestId: msg.requestId, index: msg.index, data })); return;
      case 'fs_attach_drive': self.postMessage({ type: 'fs_attach_drive_result', agentId: msg.agentId, deviceId: RdpWasm.rdp_fs_attach_drive(msg.agentId, msg.driveName, !!msg.readOnly) }); return;
      case 'fs_detach_drive': RdpWasm.rdp_fs_detach_drive(msg.agentId); return;
      case 'audin_data': RdpWasm.rdp_audin_data(msg.data); return;
      case 'location_data': RdpWasm.rdp_location_data(msg.lat, msg.lon, msg.alt ?? null, msg.accuracy, msg.speed ?? null, msg.heading ?? null); return;
      case 'camera_frame': RdpWasm.rdp_camera_frame(msg.data, !!msg.isKey); return;
      case 'resize_display': RdpWasm.rdp_resize_display(msg.width, msg.height); return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
