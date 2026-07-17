// Worker-side E2E for the RDP compositor on OffscreenCanvas (production env).
// Mirrors the T9 sequence: upload / fractional-UV partial upload / cache
// round-trip / same-surface copy / OOB copy / solid fill / present.
import { RdpGpuSurfaceCompositor } from '../public/rdp-renderer.js';

const W = 1920, H = 1080;
const decodeXY = (buf, o) => [buf[o] | ((buf[o + 2] & 0xF) << 8), buf[o + 1] | ((buf[o + 2] >> 4) << 8)];

self.onmessage = () => {
  try {
    const canvas = new OffscreenCanvas(W, H);
    let cb = null;
    const r = new RdpGpuSurfaceCompositor(canvas, { requestFrame: fn => (cb = fn, 1), cancelFrame() {} });
    r.reset(W, H); r.createSurface(1, W, H); r.mapSurface(1, 0, 0, W, H);
    const wire = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const row = H - 1 - y;
      for (let x = 0; x < W; x++) {
        const o = (row * W + x) * 4;
        wire[o] = ((x >> 8) & 0xF) | (((y >> 8) & 0xF) << 4);
        wire[o + 1] = y & 0xFF; wire[o + 2] = x & 0xFF; wire[o + 3] = 255;
      }
    }
    r.uploadBitmap(1, { left: 0, top: 0, right: W, bottom: H }, wire, W * 4);
    const pw = 300, ph = 200;
    const partWire = new Uint8Array(pw * ph * 4);
    for (let y = 0; y < ph; y++) {
      const row = ph - 1 - y;
      for (let x = 0; x < pw; x++) {
        const o = (row * pw + x) * 4;
        const gx = 500 + x, gy = 300 + y;
        partWire[o] = ((gx >> 8) & 0xF) | (((gy >> 8) & 0xF) << 4);
        partWire[o + 1] = gy & 0xFF; partWire[o + 2] = gx & 0xFF; partWire[o + 3] = 255;
      }
    }
    r.uploadBitmap(1, { left: 500, top: 300, right: 800, bottom: 500 }, partWire, pw * 4);
    r.cacheSurface(1, 5, { left: 50, top: 60, right: 350, bottom: 260 });
    r.drawCache(5, 1, 1200, 700);
    r.copySurface(1, 1, { left: 400, top: 100, right: 650, bottom: 250 }, 800, 850);
    r.copySurface(1, 1, { left: 0, top: 0, right: 100, bottom: 100 }, 1750, 950);
    r.solidFill(1, { left: 1500, top: 100, right: 1700, bottom: 300 }, 0xFFFF00FF);
    r.beginFrame(1); r.endFrame(1); cb();
    const gl = r.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const expAt = (x, y) => {
      if (x >= 1500 && x < 1700 && y >= 100 && y < 300) return 'fill';
      if (x >= 1750 && x < 1850 && y >= 950 && y < 1050) return [x - 1750, y - 950];
      if (x >= 1200 && x < 1500 && y >= 700 && y < 900) return [50 + (x - 1200), 60 + (y - 700)];
      if (x >= 800 && x < 1050 && y >= 850 && y < 1000) return [400 + (x - 800), 100 + (y - 850)];
      return [x, y];
    };
    let bad = 0; const samples = []; const regionBad = { base: 0, paste: 0, copy: 0, oobcopy: 0, fill: 0 };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = ((H - 1 - y) * W + x) * 4;
      const exp = expAt(x, y);
      let good, region;
      if (exp === 'fill') { good = buf[o] === 255 && buf[o + 1] === 0 && buf[o + 2] === 255 && buf[o + 3] === 255; region = 'fill'; }
      else {
        const [dx, dy] = decodeXY(buf, o);
        good = dx === exp[0] && dy === exp[1] && buf[o + 3] === 255;
        region = (x >= 1750 && y >= 950 && x < 1850 && y < 1050) ? 'oobcopy'
          : (x >= 1200 && x < 1500 && y >= 700 && y < 900) ? 'paste'
          : (x >= 800 && x < 1050 && y >= 850 && y < 1000) ? 'copy' : 'base';
      }
      if (!good) {
        bad++; regionBad[region]++;
        if (samples.length < 8) samples.push({ at: [x, y], region, got: [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]], exp });
      }
    }
    r.destroy();
    self.postMessage({ pass: bad === 0, mismatches: bad, regionBad, samples });
  } catch (e) {
    self.postMessage({ pass: false, error: String(e && e.stack || e) });
  }
};
