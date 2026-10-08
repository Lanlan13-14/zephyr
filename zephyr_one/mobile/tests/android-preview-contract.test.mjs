import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mobile = path.join(root, 'zephyr_one/mobile');
const read = rel => fs.readFileSync(path.join(mobile, rel), 'utf8');
const desktopImage = fs.readFileSync(path.join(root, 'public/preview/image/image-preview.js'), 'utf8');
const desktopMedia = fs.readFileSync(path.join(root, 'public/preview/media/media-preview.js'), 'utf8');
const desktopWasm = fs.readFileSync(path.join(root, 'public/preview/preview-wasm.js'), 'utf8');
const kinds = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshFileKinds.kt');
const policy = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpOpenPolicy.kt');
const source = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/PreviewSource.kt');
const pane = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/MobilePreviewPane.kt');
const image = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/RawImageViewer.kt');
const player = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/RawMediaPlayer.kt');
const browser = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt');
const viewer = read('android/feature-notes/src/main/assets/mobile-preview/image-viewer.js');
const page = read('android/feature-notes/src/main/assets/mobile-preview/image.html');
const gradle = read('android/feature-notes/build.gradle.kts');

function setFrom(text, name) {
    const match = text.match(new RegExp(`${name} = (?:new )?Set\\(\\[([\\s\\S]*?)\\]\\)|val ${name} = setOf\\(([\\s\\S]*?)\\)`));
    const body = match?.[1] || match?.[2] || '';
    return new Set([...body.matchAll(/["']([a-z0-9]+)/g)].map(item => item[1]));
}

test('Android image and media extensions match the desktop preview tables', () => {
    for (const [name, desktop] of [['IMAGE', desktopImage], ['VIDEO', desktopMedia], ['AUDIO', desktopMedia]]) {
        const left = setFrom(kinds, name);
        const right = setFrom(desktop, name === 'IMAGE' ? 'IMAGE_EXTENSIONS' : name === 'VIDEO' ? 'VIDEO_EXTENSIONS' : 'AUDIO_EXTENSIONS');
        assert.deepEqual([...left].sort(), [...right].sort(), name);
        assert.ok(left.size > 10, name);
    }
});

test('byte budgets, RAW path and client engines match desktop preview', () => {
    assert.match(policy, /IMAGE_PREVIEW_LIMIT = 32L \* 1024 \* 1024/);
    assert.match(policy, /MEDIA_PREVIEW_LIMIT = 256L \* 1024 \* 1024/);
    assert.match(policy, /MEDIA_CACHE_LIMIT = MEDIA_PREVIEW_LIMIT|MEDIA_CACHE_LIMIT = 256L \* 1024 \* 1024/);
    assert.match(desktopWasm, /MAX_IMAGE_BYTES = 32 \* 1024 \* 1024/);
    assert.match(desktopWasm, /MAX_MEDIA_BYTES = 256 \* 1024 \* 1024/);
    assert.match(viewer, /32 \* 1024 \* 1024/);
    assert.match(viewer, /thumbnailBuffer\(bytes, 4096/);
    assert.match(viewer, /webpsaveBuffer/);
    assert.match(viewer, /原图直出/);
    assert.match(viewer, /客户端转 WebP/);
    assert.match(player, /LibVLC/);
    assert.match(player, /addSlave/);
    assert.match(player, /mountedSubtitles\.add\(file\.absolutePath\)/);
    assert.match(image, /allowFileAccessFromFileURLs = false/);
    assert.match(image, /javaScriptCanOpenWindowsAutomatically = false/);
    assert.doesNotMatch(source + pane + player, /ffmpeg\.|prepareMedia|forceTranscode|\/api\/.*transcode/);
    assert.match(gradle, /libvlc-all/);
    assert.doesNotMatch(browser, /BitmapFactory|VideoView|android\.media\.MediaPlayer/);
});

test('viewer controls cover every desktop image toolbar action', () => {
    for (const action of ['zoomIn', 'zoomOut', 'oneToOne', 'reset', 'prev', 'next', 'rotateLeft', 'rotateRight', 'flipHorizontal', 'flipVertical']) {
        assert.match(page, new RegExp(`data-action="${action}"`));
        assert.match(viewer, new RegExp(`${action}:`));
    }
    for (const control of ['播放', '暂停', '−10秒', '\\+10秒', '循环', '音轨', '字幕', '静音', 'Slider']) {
        assert.match(player, new RegExp(control));
    }
    for (const layout of ['全屏', '半屏', '左侧四分之一', '右侧四分之一', '刷新', '本地字幕', '路径字幕']) {
        assert.match(pane, new RegExp(layout));
    }
});

test('credentials stay native and cannot cross preview origins', () => {
    assert.match(source, /拒绝将会话鉴权发送到其他来源/);
    assert.match(source, /带查询鉴权的地址不能再附加会话请求头/);
    assert.match(source, /followRedirects\(false\)/);
    assert.match(source, /followSslRedirects\(false\)/);
    assert.match(image, /allowFileAccess = false/);
    assert.match(image, /shouldOverrideUrlLoading/);
    assert.match(image, /preview\.zephyr\.invalid/);
    assert.match(image, /sibling\(delta: Int\)/);
    assert.match(pane, /本地预览请使用「本地字幕」选择文件/);
    assert.doesNotMatch(viewer, /PreviewBridge\.(open|read|exec|fetch)/);
});

test('sidecar discovery follows the desktop basename-or-language-suffix rule and stays bounded', () => {
    assert.match(pane, /isSidecarSubtitle\(source\.name, it\.name\)/);
    assert.match(pane, /subtitleBase == mediaBase \|\| subtitleBase\.startsWith\("\$mediaBase\."\)/);
    assert.match(pane, /ext !in setOf\("vtt", "srt", "ass", "ssa"\)/);
    assert.match(pane, /\.take\(8\)/);
    assert.match(pane, /SUBTITLE_LIMIT/);
    for (const ext of ['vtt', 'srt', 'ass', 'ssa', 'sub']) assert.match(pane, new RegExp(`"${ext}"`));
});
