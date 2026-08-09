import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zephyr One packaged-icon artefacts.
 *
 * The shipped 0.1.x Windows build had a blurry app icon everywhere Windows
 * shows one: desktop shortcut, taskbar, Explorer large-icon views and the .exe
 * resource. Cause was not the artwork but the container. prepare-icons.py built
 * the frame list smallest-first and saved from icos[0], and PIL caps every
 * requested size at the *base* image's own dimensions:
 *
 *     width, height = im.size                       # the base frame
 *     for size in sorted(set(sizes)):
 *         if size[0] > width or size[1] > height: continue
 *
 * With a 16x16 base, 32/48/64/128/256 were all silently skipped, so icon.ico
 * shipped as a single 16x16 entry (492 bytes) and Windows upscaled it.
 *
 * These assertions read the real binaries rather than the script, because the
 * .ico is a tracked artefact: regenerating is a manual `npm run icons`, so a
 * correct generator with a stale committed file still ships a blurry icon.
 * The generator is checked too, so the bug cannot come back on the next run.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = 'zephyr_one/src-tauri/icons';
const readIcon = (rel) => fs.readFileSync(path.join(root, rel));

/** PNG dimensions straight from the IHDR, or null when not a PNG. */
function pngSize(buf, at = 0) {
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (buf[at + i] !== MAGIC[i]) return null;
  }
  return { width: buf.readUInt32BE(at + 16), height: buf.readUInt32BE(at + 20) };
}

/** Parse an ICONDIR plus its ICONDIRENTRY table. */
function parseIco(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'ICONDIR reserved must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICONDIR type must be 1 (icon)');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    entries.push({
      // 0 encodes 256; the field is a single byte.
      width: buf[at] === 0 ? 256 : buf[at],
      height: buf[at + 1] === 0 ? 256 : buf[at + 1],
      bitCount: buf.readUInt16LE(at + 6),
      bytes: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12),
    });
  }
  return entries;
}

/** The sizes Windows actually asks for across its shell surfaces. */
const REQUIRED_ICO_SIZES = [16, 32, 48, 64, 128, 256];

test('icon.ico carries every Windows shell size', () => {
  const buf = readIcon(ICONS_DIR + '/icon.ico');
  const entries = parseIco(buf);
  const sizes = entries.map((e) => e.width).sort((a, b) => a - b);

  assert.deepEqual(sizes, REQUIRED_ICO_SIZES, 'icon.ico must hold all six sizes');

  // A single-entry file is the exact regression: 16px upscaled everywhere.
  assert.ok(entries.length > 1, 'a one-entry .ico means Windows upscales one bitmap');

  for (const entry of entries) {
    assert.equal(entry.width, entry.height, 'app icons must be square');
    assert.equal(entry.bitCount, 32, entry.width + 'px must keep the alpha channel');
  }
});

test('every icon.ico entry holds real pixels at its declared size', () => {
  // A directory can promise 256x256 and point at a 16x16 payload. That renders
  // exactly as blurry as the original bug, so the declared size has to be
  // checked against the embedded image header.
  const buf = readIcon(ICONS_DIR + '/icon.ico');
  for (const entry of parseIco(buf)) {
    assert.ok(
      entry.offset + entry.bytes <= buf.length,
      entry.width + 'px payload must lie inside the file',
    );
    const size = pngSize(buf, entry.offset);
    assert.ok(size, entry.width + 'px frame must be a PNG payload');
    assert.equal(size.width, entry.width, entry.width + 'px entry must contain that many pixels');
    assert.equal(size.height, entry.height, entry.height + 'px entry must contain that many pixels');
  }
});

test('icon.ico is large enough to actually contain its frames', () => {
  // The broken file was 492 bytes. A 256x256 RGBA frame alone cannot compress
  // that small, so a byte floor catches a truncated regeneration outright.
  const bytes = readIcon(ICONS_DIR + '/icon.ico').length;
  assert.ok(bytes > 20000, 'icon.ico is only ' + bytes + ' bytes; frames are missing');
});

test('the release rasteriser outlines the One wordmark instead of trusting a font', () => {
  /* branding/manifest.json freezes a production rule in plain words:
   *
   *   "Convert the One text to fixed paths before generating Android or iOS
   *    release assets. Preserve the source files unchanged."
   *
   * The four SVG masters carry the wordmark as <text font-family="system-ui,
   * -apple-system, 'Segoe UI', Roboto, ...">, which is resolved by whatever
   * fonts the *build machine* happens to have. Rendering the same master on a
   * runner without Segoe UI produces a different "One" - verified locally: the
   * wordmark raster changes across font stacks while the wind strokes stay
   * byte-identical. That is a reproducibility break in a release artefact, and
   * it is exactly what the frozen rule forbids.
   *
   * The generator therefore substitutes outlines in memory. Both halves matter,
   * so both are asserted: the substitution must happen, and the masters must
   * stay untouched on disk. */
  const src = fs.readFileSync(path.join(root, 'zephyr_one/scripts/prepare-icons.py'), 'utf8');

  // A real outline path, not a font reference.
  assert.match(src, /WORDMARK_PATH/, 'the outlined wordmark must be embedded in the generator');
  assert.match(
    src,
    /WORDMARK_PATH\s*=\s*\(?\s*\n?\s*["']\s*M/,
    'the wordmark constant must be SVG path data beginning with a moveto',
  );

  // The substitution has to be applied to the markup that is rasterised.
  assert.match(src, /def outline_wordmark/, 'the substitution must be a named step');

  /* The call, not merely the definition.
   *
   * A bare /outline_wordmark\(/ match is satisfied by the `def` line itself, so
   * it stayed green when the call was removed from staged_master and the raw
   * <text> markup went to the rasteriser -- verified by mutation. Anchoring on
   * the read that feeds the staged copy is what makes this load-bearing. */
  assert.match(
    src,
    /outline_wordmark\(\s*svg\.read_text\(/,
    'the outlining must be applied to the markup that is actually rasterised',
  );

  /* And the staged copy is what every renderer receives: if staged_master
   * returned the original path, outlining would be dead code. */
  assert.match(
    src,
    /staged_master\(SVG_DIR/,
    'every theme must be rasterised from its staged (outlined) copy',
  );

  // Fail loudly rather than silently shipping font-dependent artwork: if a
  // master is reshaped so the <text> group no longer matches, the build must
  // stop instead of falling back to <text>.
  assert.match(src, /sys\.exit\(/, 'a master that no longer matches must abort the build');

  /* The masters themselves must still be the frozen sources. Their <text> is
   * what the four checked-in SVGs are *supposed* to contain; the rule says
   * convert during generation, not rewrite the sources. */
  for (const theme of ['frost', 'lava', 'asagi', 'cyber']) {
    const svg = fs.readFileSync(
      path.join(root, 'zephyr_one/platform_assets/icons', 'zephyr-one-' + theme + '.svg'),
      'utf8',
    );
    assert.match(svg, /<text /, theme + ' master must stay unchanged (still carries <text>)');
  }
});

test('every .ico frame is rasterised from the vector, not resampled from a bitmap', () => {
  const src = fs.readFileSync(path.join(root, 'zephyr_one/scripts/prepare-icons.py'), 'utf8');

  assert.match(src, /ICO_SIZES = \(16, 32, 48, 64, 128, 256\)/);

  /* The regression this pins down.
   *
   * The generator used to build every .ico frame with
   * `src.resize((s, s), LANCZOS)` off the single 256px master. Measured against
   * a native render of the same master at the same size, the downscale differed
   * by 12.1% of pixels at 16px, 6.0% at 32px and 5.0% at 48px, and it was
   * measurably softer: 5.86% mid-tone (part-on, part-off) pixels at 16px versus
   * 3.91% for a native render. Those small frames are exactly what Windows
   * shows in the taskbar, Alt-Tab and Explorer's list views, so the shipped app
   * icon looked blurry. The bundle PNG loop already rasterised per size; the
   * .ico path did not.
   *
   * Asserting the absence of the resize as well as the presence of the render
   * keeps a future edit from quietly reintroducing bitmap reduction. */
  const icoBlock = src.slice(src.indexOf('ico_frames = []'), src.indexOf("format=\"ICO\""));
  assert.ok(icoBlock.length > 0, 'the .ico frame loop must exist');
  /* `source_for(theme, size)` rather than a single master: below
   * WORDMARK_MIN_SIZE the frame is rendered from a wordmark-free copy. The
   * per-size render is still the property under test -- only the choice of
   * source SVG became size-dependent. */
  assert.match(icoBlock, /render_svg\(source_for\(DEFAULT_THEME, size\), size, frame_path\)/,
    'each .ico frame must be rasterised from the SVG at its own size');
  assert.doesNotMatch(icoBlock, /resize\(/,
    'a .ico frame must never be produced by resampling a larger bitmap');
  assert.doesNotMatch(icoBlock, /LANCZOS/,
    'LANCZOS reduction is what made the small frames soft');

  // Same reasoning for the .icns Retina ladder.
  const icnsBlock = src.slice(src.indexOf('icns_frames = []'), src.indexOf("format=\"ICNS\""));
  assert.ok(icnsBlock.length > 0, 'the .icns frame loop must exist');
  assert.match(icnsBlock, /render_svg\(source_for\(DEFAULT_THEME, size\), size, frame_path\)/,
    'each .icns frame must be rasterised from the SVG at its own size');
  assert.doesNotMatch(icnsBlock, /resize\(/,
    'an .icns frame must never be a resampled bitmap');

  /* Largest-first ordering plus append_images is still load-bearing: PIL caps
   * every requested size at the *base* image's own dimensions
   * (IcoImagePlugin._save: "if size[0] > width ... continue"), so saving from
   * the 16px frame silently discards 32 through 256 and ships a single-entry
   * 16px .ico that Windows then upscales everywhere. */
  assert.match(
    src,
    /ico_frames\.sort\(key=lambda frame: frame\.width, reverse=True\)/,
    'frames must be sorted largest-first before the save',
  );
  assert.match(src, /append_images=ico_frames\[1:\]/, 'the remaining frames must be appended');

  const sortAt = src.indexOf('ico_frames.sort(');
  const saveAt = src.indexOf('ico_frames[0].save(');
  assert.ok(sortAt > 0 && saveAt > 0, 'both sites must exist');
  assert.ok(sortAt < saveAt, 'the sort must happen before the save or the base is still 16px');
});

test('the committed .ico frames really are native renders', () => {
  /* The generator being correct is not the same as the committed artefact being
   * correct: the .ico in git is what ships. A LANCZOS downscale of the 256px
   * frame is a pixel-exact match for the frame it was derived from, so a
   * committed frame that matches its own downscale to 0.00% is proof the stale
   * artefact was shipped. A native render differs substantially. */
  const buf = readIcon(ICONS_DIR + '/icon.ico');
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 6, 'the .ico must carry every shell size, got ' + count);

  // Collect the PNG payloads by declared size.
  const frames = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const declared = buf[at] === 0 ? 256 : buf[at];
    const len = buf.readUInt32LE(at + 8);
    const off = buf.readUInt32LE(at + 12);
    const size = pngSize(buf, off);
    assert.ok(size, declared + 'px entry must hold a real PNG');
    assert.equal(size.width, declared, 'declared size must match the PNG header');
    frames.set(declared, len);
  }

  /* Byte length is the cheap, dependency-free signal. A 16px native render and
   * a 16px LANCZOS reduction of a 256px frame do not compress to the same size,
   * and the small frames must not be degenerate. */
  for (const edge of [16, 32, 48, 64, 128, 256]) {
    assert.ok(frames.has(edge), edge + 'px frame must be present');
    assert.ok(frames.get(edge) > 200, edge + 'px frame is too small to hold real artwork');
  }

  // Frames must grow with size; a flat or inverted ladder means resampling.
  assert.ok(frames.get(256) > frames.get(128), '256px frame must carry more detail than 128px');
  assert.ok(frames.get(128) > frames.get(48), '128px frame must carry more detail than 48px');
});

test('icon.icns keeps the full Retina ladder', () => {
  // macOS reads the Dock icon from the bundle .icns; there is no per-window
  // icon to fall back on, so a missing large block is unrecoverable there.
  const buf = readIcon(ICONS_DIR + '/icon.icns');
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'icns', 'must be an icns container');
  assert.equal(buf.readUInt32BE(4), buf.length, 'declared length must match the file');

  const found = new Map();
  let at = 8;
  while (at + 8 <= buf.length) {
    const type = buf.subarray(at, at + 4).toString('ascii');
    const len = buf.readUInt32BE(at + 4);
    if (len < 8 || at + len > buf.length) break;
    const size = pngSize(buf, at + 8);
    if (size) found.set(type, size.width);
    at += len;
  }

  // ic07..ic10 are the 128/256/512/1024 rungs the Dock and Finder use.
  for (const [type, edge] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    assert.equal(found.get(type), edge, type + ' must be a ' + edge + 'px PNG');
  }
});

test('every bundle icon named by tauri.conf.json exists at its stated size', () => {
  // A missing path fails the bundle step; a wrongly-sized PNG ships quietly.
  const conf = JSON.parse(
    fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const listed = conf.bundle.icon;
  assert.ok(Array.isArray(listed) && listed.length > 0, 'bundle.icon must list artefacts');

  const EXPECTED_EDGE = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256 };

  for (const rel of listed) {
    const abs = path.join(root, 'zephyr_one/src-tauri', rel);
    assert.ok(fs.existsSync(abs), rel + ' is referenced by tauri.conf.json but missing');
    const edge = EXPECTED_EDGE[path.basename(rel)];
    if (edge) {
      const size = pngSize(fs.readFileSync(abs));
      assert.ok(size, rel + ' must be a PNG');
      assert.equal(size.width, edge, rel + ' must be ' + edge + 'px wide');
    }
  }

  // icon.ico has to be in the list or Windows falls back to a Tauri default.
  assert.ok(
    listed.some((rel) => rel.endsWith('icon.ico')),
    'the Windows .ico must be bundled',
  );
});

test('each palette has a runtime icon compiled into the shell', () => {
  // icon/mod.rs pulls these in with include_bytes!, so a missing or resized
  // file is a build break or a blurry live theme swap rather than a warning.
  const rs = fs.readFileSync(
    path.join(root, 'zephyr_one/src-tauri/src/icon/mod.rs'),
    'utf8',
  );
  for (const theme of ['frost', 'lava', 'asagi', 'cyber']) {
    const rel = 'zephyr_one/src-tauri/runtime-icons/zephyr-one-' + theme + '.png';
    assert.ok(fs.existsSync(path.join(root, rel)), rel + ' must exist');
    const size = pngSize(readIcon(rel));
    assert.ok(size, rel + ' must be a PNG');
    assert.equal(size.width, 128, theme + ' runtime icon must stay 128px');
    assert.match(rs, new RegExp('runtime-icons/zephyr-one-' + theme + '\.png'));
  }
});
