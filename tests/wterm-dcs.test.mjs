import test from 'node:test';
import assert from 'node:assert/strict';
import { WasmBridge } from '../public/vendor/wterm-fork/core/index.js';

function writeAll(bridge, text) {
  bridge.writeString(text);
}

function takeResponse(bridge) {
  const resp = bridge.getResponse();
  if (resp == null) return null;
  // clear so subsequent queries are isolated
  if (typeof bridge.clearResponse === 'function') bridge.clearResponse();
  return resp;
}

function hexAscii(str) {
  return Buffer.from(str, 'utf8').toString('hex').toUpperCase();
}

test('DECRQSS reports SGR / scroll region / cursor style', async () => {
  const b = await WasmBridge.load();
  b.init(80, 24);

  // default SGR
  writeAll(b, '\x1bP$qm\x1b\\');
  assert.equal(takeResponse(b), '\x1bP1$r0m\x1b\\');

  // bold + red fg
  writeAll(b, '\x1b[1;31m\x1bP$qm\x1b\\');
  assert.equal(takeResponse(b), '\x1bP1$r0;1;31m\x1b\\');

  // scroll region 2;20
  writeAll(b, '\x1b[2;20r\x1bP$qr\x1b\\');
  assert.equal(takeResponse(b), '\x1bP1$r2;20r\x1b\\');

  // DECSCUSR bar (style 6)
  writeAll(b, '\x1b[6 q\x1bP$q q\x1b\\');
  assert.equal(takeResponse(b), '\x1bP1$r6 q\x1b\\');

  // DECSCL
  writeAll(b, '\x1bP$q"p\x1b\\');
  assert.equal(takeResponse(b), '\x1bP1$r62;1"p\x1b\\');

  // unsupported Pt
  writeAll(b, '\x1bP$qZ\x1b\\');
  assert.equal(takeResponse(b), '\x1bP0$r\x1b\\');
});

test('XTGETTCAP answers known capabilities and rejects unknown', async () => {
  const b = await WasmBridge.load();
  b.init(80, 24);

  const tn = hexAscii('TN');
  const co = hexAscii('Co');
  const rgb = hexAscii('RGB');
  const unknown = hexAscii('ZZ');

  writeAll(b, `\x1bP+q${tn}\x1b\\`);
  assert.equal(
    takeResponse(b),
    `\x1bP1+r${tn}=${hexAscii('xterm-256color')}\x1b\\`,
  );

  writeAll(b, `\x1bP+q${tn};${co};${rgb}\x1b\\`);
  assert.equal(
    takeResponse(b),
    `\x1bP1+r${tn}=${hexAscii('xterm-256color')};${co}=${hexAscii('256')};${rgb}=${hexAscii('8/8/8')}\x1b\\`,
  );

  writeAll(b, `\x1bP+q${unknown}\x1b\\`);
  assert.equal(takeResponse(b), `\x1bP0+r${unknown}\x1b\\`);

  // mixed known+unknown => invalid bit 0, but still returns known pairs
  writeAll(b, `\x1bP+q${tn};${unknown}\x1b\\`);
  assert.equal(
    takeResponse(b),
    `\x1bP0+r${tn}=${hexAscii('xterm-256color')};${unknown}\x1b\\`,
  );
});
