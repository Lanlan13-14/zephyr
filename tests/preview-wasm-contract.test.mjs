import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { singleAssetVersion } from './helpers/cache-version.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const server = read('server.js');
const imageService = read('preview/image/preview-service.js');
const mediaService = read('preview/media/media-service.js');
const runtime = read('public/preview/preview-wasm.js');
const imagePreview = read('public/preview/image/image-preview.js');
const mediaPreview = read('public/preview/media/media-preview.js');
const terminalHtml = read('public/terminal.html');
const pkg = JSON.parse(read('package.json'));

test('the main end no longer decodes or transcodes a preview', () => {
    for (const source of [server, imageService, mediaService]) {
        assert.doesNotMatch(source, /spawn\(\s*['"]ff(mpeg|probe)['"]/);
        assert.doesNotMatch(source, /require\(['"]sharp['"]\)/);
        assert.doesNotMatch(source, /probeMediaFromStream|ffmpegArgsForMode|convertImageToWebp|ensurePreviewCacheFile/);
    }
    assert.equal(pkg.dependencies.sharp, undefined);
    assert.match(server, /X-Zephyr-Preview-Engine',\s*'browser-wasm'/);
    assert.match(server, /X-Zephyr-Media-Mode',\s*'RAW'/);
    assert.match(server, /engine:\s*'browser-wasm'/);
});

test('image and media previews decode through the vendored wasm runtimes', () => {
    assert.match(imagePreview, /ZephyrPreviewWasm\.decodeImage\(/);
    assert.match(mediaPreview, /ZephyrPreviewWasm\.prepareMedia\(/);
    assert.match(mediaPreview, /ZephyrPreviewWasm\.releaseMedia\(/);
    assert.match(runtime, /\/vendor\/wasm-vips\/vips-es6\.js/);
    assert.match(runtime, /\/vendor\/ffmpeg\/esm\/index\.js/);
    assert.match(runtime, /coreURL:\s*FFMPEG_CORE_URL/);
    assert.match(runtime, /wasmURL:\s*FFMPEG_WASM_URL/);
    assert.doesNotMatch(runtime, /https?:\/\/(unpkg|cdn|jsdelivr|esm\.sh)/);
    assert.match(runtime, /blockUntrusted\?\.\(true\)/);
    assert.match(runtime, /MAX_IMAGE_BYTES = 32 \* 1024 \* 1024/);

    const wasmAt = terminalHtml.indexOf('preview/preview-wasm.js?v=20261004-preview-wasm1');
    const imageAt = terminalHtml.indexOf('preview/image/image-preview.js?v=20261004-preview-wasm1');
    const mediaAt = terminalHtml.indexOf('preview/media/media-preview.js?v=20261004-preview-wasm1');
    assert.ok(wasmAt > 0 && wasmAt < imageAt && imageAt < mediaAt, 'wasm runtime must load before the preview modules');
    singleAssetVersion(terminalHtml, 'preview/preview-wasm.js', 'preview wasm runtime');
});

test('vendored wasm artifacts are the published builds and stay same-origin', () => {
    const files = {
        'public/vendor/wasm-vips/vips-es6.js': 80_000,
        'public/vendor/wasm-vips/vips.wasm': 4_000_000,
        'public/vendor/wasm-vips/vips-jxl.wasm': 1_000_000,
        'public/vendor/wasm-vips/vips-heif.wasm': 2_000_000,
        'public/vendor/wasm-vips/vips-resvg.wasm': 500_000,
        'public/vendor/ffmpeg/esm/index.js': 40,
        'public/vendor/ffmpeg/esm/worker.js': 1_000,
        'public/vendor/ffmpeg/ffmpeg-core.js': 50_000,
        'public/vendor/ffmpeg/ffmpeg-core.wasm': 20_000_000,
    };
    for (const [file, minimum] of Object.entries(files)) {
        const stat = fs.statSync(path.join(root, file));
        assert.ok(stat.size > minimum, `${file} is smaller than the published artifact`);
    }
    assert.match(read('public/vendor/wasm-vips/LICENSE'), /MIT License/);
    assert.match(read('public/vendor/ffmpeg/COPYING.GPLv2'), /GNU GENERAL PUBLIC LICENSE/);
    const notices = read('THIRD_PARTY_NOTICES.md');
    assert.match(notices, /wasm-vips 0\.0\.19/);
    assert.match(notices, /@ffmpeg\/core 0\.12\.10/);
    assert.doesNotMatch(notices, /\| sharp \|/);
});
