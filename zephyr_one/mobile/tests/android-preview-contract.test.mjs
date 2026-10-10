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
const decoder = read('android/protocol-ffmpeg/src/main/kotlin/one/zephyr/mobile/protocol/ffmpeg/FfmpegImage.kt');
const ffmpegJni = read('android/protocol-ffmpeg/src/main/cpp/zephyr_ffmpeg.c');
const ffmpegCmake = read('android/protocol-ffmpeg/src/main/cpp/CMakeLists.txt');
const ffmpegGradle = read('android/protocol-ffmpeg/build.gradle.kts');
const notesGradle = read('android/feature-notes/build.gradle.kts');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/zephyr-one-mobile.yml'), 'utf8');
const buildScript = fs.readFileSync(path.join(root, 'zephyr_one/native/ffmpeg-core/scripts/build-ffmpeg-android.sh'), 'utf8');

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

test('byte budgets, RAW path and FFmpeg engine match desktop preview', () => {
    assert.match(policy, /IMAGE_PREVIEW_LIMIT = 32L \* 1024 \* 1024/);
    assert.match(policy, /MEDIA_PREVIEW_LIMIT = 256L \* 1024 \* 1024/);
    assert.match(policy, /MEDIA_CACHE_LIMIT = MEDIA_PREVIEW_LIMIT|MEDIA_CACHE_LIMIT = 256L \* 1024 \* 1024/);
    assert.match(desktopWasm, /MAX_IMAGE_BYTES = 32 \* 1024 \* 1024/);
    assert.match(desktopWasm, /MAX_MEDIA_BYTES = 256 \* 1024 \* 1024/);
    assert.match(decoder, /MAX_EDGE = 4096/);
    assert.match(decoder, /MAX_PIXELS = 32 \* 1024 \* 1024/);
    assert.match(decoder, /BROWSER_DIRECT = setOf\("jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"\)/);
    assert.match(decoder, /nativeConvert/);
    assert.match(decoder, /ImageDecoder/);
    assert.match(ffmpegJni, /frames:v/);
    assert.match(ffmpegJni, /force_original_aspect_ratio=decrease/);
    assert.match(player, /LibVLC/);
    assert.match(player, /addSlave/);
    assert.match(player, /mountedSubtitles\.add\(subtitle\.absolutePath\)/);
    // libvlc 3.6: detachViews() disables the video track before the vout is
    // torn down. stop() must run first or the next play() SIGSEGVs, and the
    // engine itself is process-lived (VlcEngine) — releasing it crashes too.
    const stopAt = player.indexOf('player.stop()');
    const detachAt = player.indexOf('player.detachViews()');
    const releaseAt = player.indexOf('player.release()');
    assert.ok(stopAt > 0 && detachAt > stopAt && releaseAt > detachAt, 'stop before detach before release');
    assert.match(player, /VlcEngine\.obtain/);
    // LibVLC.loadLibraries calls System.exit(1) when libvlc/libvlcjni fails to
    // load. That is an instant process death on Android 16, with no stack.
    const engine = read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/VlcEngine.kt');
    assert.match(engine, /System\.load/);
    assert.match(engine, /fun obtain\(context: Context\): LibVLC\?/);
    assert.doesNotMatch(engine, /System\.exit|loadLibraries\(\)/);
    assert.doesNotMatch(player, /engine\.release|removeCallbacksAndMessages\(null\)\s*\n\s*player\.stop/);
    assert.match(player, /events\.removeCallbacksAndMessages\(null\)/);
    // VideoPlayerActivity.startPlayback attaches the surface and only then
    // loads the media. setMedia before the vout exists SIGSEGVs on open,
    // which is the crash at "正在读取预览文件".
    const attachAt = player.indexOf('player.attachViews(view, null, true, false)');
    const setMediaAt = player.indexOf('player.media = media');
    assert.ok(attachAt > 0 && setMediaAt > attachAt, 'attach the surface before setMedia');
    assert.match(player, /setHWDecoderEnabled\(false, false\)/);
    assert.doesNotMatch(player, /setHWDecoderEnabled\(true/);
    assert.doesNotMatch(source + pane + player + image, /wasm-vips|vips-es6|preview\.zephyr\.invalid|android\.webkit\.WebView/);
    assert.doesNotMatch(source + pane + player, /ffmpeg\.|prepareMedia|forceTranscode|\/api\/.*transcode/);
    assert.match(notesGradle, /libvlc-all/);
    assert.match(notesGradle, /protocol-ffmpeg/);
    assert.doesNotMatch(browser, /BitmapFactory|VideoView|android\.media\.MediaPlayer/);
});

test('preview occupies the editor surface, not a floating window', () => {
    assert.match(pane, /Modifier\.fillMaxSize\(\)/);
    assert.match(pane, /返回文件列表/);
    assert.match(pane, /IconButton\(onClick = onBack\)/);
    assert.doesNotMatch(pane, /[^t]Dialog\(|layoutMenu|widthAdjust|left-quarter|right-quarter|半屏|四分之一/);
    assert.doesNotMatch(image, /WebView|JavascriptInterface|wasm-vips|vips-es6/);
});

test('viewer controls cover every desktop image toolbar action', () => {
    for (const label of ['＋', '−', '1:1', '重置', '上一张', '下一张', '左旋', '右旋', '水平翻转', '垂直翻转']) {
        assert.match(image, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const control of ['播放', '暂停', '−10秒', '\\+10秒', '循环', '音轨', '字幕', '静音', 'Slider']) {
        assert.match(player, new RegExp(control));
    }
    for (const layout of ['刷新', '本地字幕', '路径字幕']) {
        assert.match(pane, new RegExp(layout));
    }
});

test('credentials stay native and cannot cross preview origins', () => {
    assert.match(source, /拒绝将会话鉴权发送到其他来源/);
    assert.match(source, /带查询鉴权的地址不能再附加会话请求头/);
    assert.match(source, /followRedirects\(false\)/);
    assert.match(source, /followSslRedirects\(false\)/);
    assert.match(pane, /本地预览请使用「本地字幕」选择文件/);
    assert.doesNotMatch(image, /PreviewBridge\.(open|read|exec|fetch)/);
});

test('sidecar discovery follows the desktop basename-or-language-suffix rule and stays bounded', () => {
    assert.match(pane, /isSidecarSubtitle\(source\.name, it\.name\)/);
    assert.match(pane, /subtitleBase == mediaBase \|\| subtitleBase\.startsWith\("\$mediaBase\."\)/);
    assert.match(pane, /ext !in setOf\("vtt", "srt", "ass", "ssa"\)/);
    assert.match(pane, /\.take\(8\)/);
    assert.match(pane, /SUBTITLE_LIMIT/);
    for (const ext of ['vtt', 'srt', 'ass', 'ssa', 'sub']) assert.match(pane, new RegExp(`"${ext}"`));
});

test('CI builds and packages the pinned Android FFmpeg CLI', () => {
    assert.match(workflow, /build-ffmpeg-android\.sh arm64-v8a/);
    assert.match(workflow, /ZEPHYR_ANDROID_FFMPEG_ROOT/);
    assert.match(workflow, /lib\/arm64-v8a\/libzephyr_ffmpeg_android\.so/);
    assert.match(workflow, /lib\/arm64-v8a\/libffmpegexec\.so/);
    assert.match(workflow, /6\.1\.2\+libjxl-0\.10\.4/);
    assert.match(buildScript, /FFMPEG_TAG="n6\.1\.2"/);
    assert.match(buildScript, /enable-libjxl/);
    assert.match(buildScript, /enable-filter=scale/);
    assert.match(buildScript, /disable-gpl/);
    assert.doesNotMatch(buildScript, /--enable-gpl|--enable-libx264/);
    assert.match(ffmpegCmake, /6\.1\.2\+libjxl-0\.10\.4/);
    assert.match(ffmpegGradle, /libffmpegexec\.so/);
});

test('app pins arm64 so transitive AAR natives cannot bloat the APK', () => {
    const appGradle = read('android/app/build.gradle.kts');
    assert.match(appGradle, /abiFilters \+= listOf\("arm64-v8a"\)/);
    // libvlc-all ships four ABIs; without the filter the APK tripled in size.
    const notes = read('android/feature-notes/build.gradle.kts');
    assert.match(notes, /libvlc-all/);
});

test('mobile preview assets no longer vendor wasm-vips', () => {
    const assets = path.join(mobile, 'android/feature-notes/src/main/assets');
    assert.equal(fs.existsSync(path.join(assets, 'mobile-preview')), false);
    assert.equal(fs.existsSync(path.join(mobile, 'tools/sync-preview-assets.mjs')), false);
});
