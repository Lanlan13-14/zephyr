import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(mobile, '../..');
const decoder = fs.readFileSync(path.join(mobile, 'android/protocol-ffmpeg/src/main/kotlin/one/zephyr/mobile/protocol/ffmpeg/FfmpegImage.kt'), 'utf8');
const viewer = fs.readFileSync(path.join(mobile, 'android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/RawImageViewer.kt'), 'utf8');

test('image transform math: zoom clamps, one-to-one, rotate, flip, pan and reset', () => {
    assert.match(viewer, /zoom = \(zoom \* 1\.2f\)\.coerceIn\(0\.05f, 20f\)/);
    assert.match(viewer, /zoom = \(zoom \/ 1\.2f\)\.coerceIn\(0\.05f, 20f\)/);
    assert.match(viewer, /val fit = minOf\(viewport\.width\.toFloat\(\) \/ image\.width, viewport\.height\.toFloat\(\) \/ image\.height, 1f\)/);
    assert.match(viewer, /angle = \(angle - 90f\) % 360f/);
    assert.match(viewer, /flipX \*= -1f/);
    assert.match(viewer, /flipY \*= -1f/);
    assert.match(viewer, /offset = Offset\.Zero/);
    assert.match(viewer, /detectTransformGestures/);
    assert.match(viewer, /onDoubleTap/);
});

test('FFmpeg still-image conversion is the only non-platform decoder', () => {
    assert.match(decoder, /System\.loadLibrary\("zephyr_ffmpeg_android"\)/);
    assert.match(decoder, /libffmpegexec\.so/);
    assert.match(decoder, /decodeWithFfmpeg/);
    assert.match(decoder, /nativeConvert\(ffmpeg\.absolutePath, input\.absolutePath, output\.absolutePath, MAX_EDGE\)/);
    assert.doesNotMatch(decoder, /wasm-vips|android\.webkit\.WebView|vips-es6/);
});

const ffmpeg = process.env.ZEPHYR_HOST_FFMPEG || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], {encoding: 'utf8'}).status === 0;

function convert(input, output) {
    const result = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', input, '-an', '-frames:v', '1',
        '-vf', "scale='min(4096,iw)':'min(4096,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '3', output,
    ], {encoding: 'utf8'});
    return result;
}

test('host FFmpeg converts the desktop-previewable still formats the decoder claims', {skip: !hasFfmpeg}, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ffmpeg-cov-'));
    const src = path.join(dir, 'src.png');
    const generated = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=64x64',
        '-frames:v', '1', '-update', '1', src,
    ], {encoding: 'utf8'});
    assert.equal(generated.status, 0, generated.stderr);
    const samples = {
        jpg: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.jpg')]),
        png: () => ({status: 0}),
        webp: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.webp')]),
        gif: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.gif')]),
        bmp: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.bmp')]),
        tif: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.tif')]),
        jp2: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-update', '1', path.join(dir, 'a.jp2')]),
        j2k: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-update', '1', path.join(dir, 'a.j2k')]),
        tga: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.tga')]),
        sgi: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.sgi')]),
        pcx: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.pcx')]),
        pam: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.pam')]),
        ppm: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.ppm')]),
        hdr: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.hdr')]),
        exr: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-update', '1', path.join(dir, 'a.exr')]),
        dds: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.dds')]),
        jxl: () => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, path.join(dir, 'a.jxl')]),
    };
    const decoded = [];
    const skipped = [];
    for (const [ext, make] of Object.entries(samples)) {
        const made = make();
        const input = ext === 'png' ? src : path.join(dir, `a.${ext}`);
        if ((made.status ?? 1) !== 0 || !fs.existsSync(input) || fs.statSync(input).size === 0) {
            skipped.push(ext);
            continue;
        }
        const output = path.join(dir, `out-${ext}.jpg`);
        const result = convert(input, output);
        if (result.status === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) decoded.push(ext);
        else skipped.push(`${ext}:${(result.stderr || '').trim().split('\n').pop() || 'fail'}`);
    }
    assert.ok(decoded.includes('jpg'));
    assert.ok(decoded.includes('png'));
    assert.ok(decoded.includes('webp'));
    assert.ok(decoded.includes('bmp'));
    assert.ok(decoded.includes('tif'));
    assert.ok(decoded.includes('jp2'));
    assert.ok(decoded.includes('exr'));
    assert.ok(decoded.length >= 10, `too few formats decoded: ${decoded.join(',')} skipped=${skipped.join(',')}`);
    fs.rmSync(dir, {recursive: true, force: true});
});

test('FFmpeg refuses garbage bytes the way the Kotlin decoder surfaces failure', {skip: !hasFfmpeg}, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ffmpeg-fail-'));
    const input = path.join(dir, 'not-an-image.bin');
    const output = path.join(dir, 'out.jpg');
    fs.writeFileSync(input, 'not an image');
    const result = convert(input, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr || '', /Invalid data|could not find codec|No such file|not contain any stream|Invalid/i);
    fs.rmSync(dir, {recursive: true, force: true});
});
