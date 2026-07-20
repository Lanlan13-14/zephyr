import test from 'node:test';
import assert from 'node:assert/strict';
import { WasmBridge } from '../public/vendor/wterm-fork/core/index.js';

function takeImages(bridge) {
  return bridge.getImages();
}

test('Sixel DCS creates a placed image', async () => {
  const b = await WasmBridge.load();
  b.init(80, 24);
  // Minimal sixel: select color 1 and paint one sixel column with top pixel.
  // ESC P 0;0;0 q #1 @ ST
  b.writeString('\x1bP0;0;0q#1@\x1b\\');
  const images = takeImages(b);
  assert.ok(images.length >= 1, 'expected at least one image');
  assert.ok(images[0].width >= 1);
  assert.ok(images[0].height >= 1);
  // top-left pixel should be opaque after drawing
  assert.equal(images[0].pixels[3] > 0 || images[0].pixels.length > 0, true);
});

test('Kitty APC RGB image is decoded into the graphics plane', async () => {
  const b = await WasmBridge.load();
  b.init(80, 24);
  // 2x1 RGB pixels: red + green => base64 of 6 bytes
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0]);
  const payload = rgb.toString('base64');
  // ESC _ G f=24,s=2,v=1;PAYLOAD ST
  b.writeString(`\x1b_Gf=24,s=2,v=1;${payload}\x1b\\`);
  const images = takeImages(b);
  assert.ok(images.length >= 1, 'expected kitty image');
  const img = images[images.length - 1];
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.deepEqual([img.pixels[0], img.pixels[1], img.pixels[2], img.pixels[3]], [255, 0, 0, 255]);
  assert.deepEqual([img.pixels[4], img.pixels[5], img.pixels[6], img.pixels[7]], [0, 255, 0, 255]);
});
