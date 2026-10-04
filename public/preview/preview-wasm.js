(function () {
    'use strict';

    const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
    const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
    const MAX_EDGE = 4096;
    const BROWSER_DIRECT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);
    const VIPS_URL = '/vendor/wasm-vips/vips-es6.js';
    const FFMPEG_URL = '/vendor/ffmpeg/esm/index.js';
    const FFMPEG_CORE_URL = '/vendor/ffmpeg/ffmpeg-core.js';
    const FFMPEG_WASM_URL = '/vendor/ffmpeg/ffmpeg-core.wasm';

    let vipsPromise = null;
    let ffmpegPromise = null;

    function extensionOf(name) {
        const base = String(name || '').split(/[\\/?]/).pop() || '';
        const dot = base.lastIndexOf('.');
        return dot > -1 ? base.slice(dot + 1).toLowerCase() : 'bin';
    }

    async function readBounded(url, maxBytes) {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`读取预览文件失败（${response.status}）`);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) throw new Error('文件超过浏览器预览大小限制');
        const reader = response.body?.getReader?.();
        if (!reader) {
            const buffer = new Uint8Array(await response.arrayBuffer());
            if (buffer.byteLength > maxBytes) throw new Error('文件超过浏览器预览大小限制');
            return buffer;
        }
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                try { await reader.cancel(); } catch {}
                throw new Error('文件超过浏览器预览大小限制');
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }

    function loadVips() {
        if (!vipsPromise) {
            vipsPromise = import(VIPS_URL).then((mod) => {
                const Vips = mod.default;
                return Vips({ dynamicLibraries: ['vips-jxl.wasm', 'vips-heif.wasm', 'vips-resvg.wasm'] });
            }).then((vips) => {
                try { vips.concurrency?.(1); } catch {}
                try { vips.blockUntrusted?.(true); } catch {}
                return vips;
            }).catch((err) => {
                vipsPromise = null;
                throw err;
            });
        }
        return vipsPromise;
    }

    function loadFfmpeg() {
        if (!ffmpegPromise) {
            ffmpegPromise = import(FFMPEG_URL).then(async (mod) => {
                const ffmpeg = new mod.FFmpeg();
                await ffmpeg.load({ coreURL: FFMPEG_CORE_URL, wasmURL: FFMPEG_WASM_URL });
                return ffmpeg;
            }).catch((err) => {
                ffmpegPromise = null;
                throw err;
            });
        }
        return ffmpegPromise;
    }

    function browserCanPlay(kind, capabilities) {
        if (kind === 'audio') {
            const audio = capabilities?.audio || {};
            return !!(audio.aac || audio.mp3 || audio.opus || audio.flac || audio.vorbis || audio.pcm_s16le);
        }
        const video = capabilities?.video || {};
        return !!(video.h264 || video.vp8 || video.vp9 || video.av1);
    }

    async function decodeImage(url) {
        const bytes = await readBounded(url, MAX_IMAGE_BYTES);
        const vips = await loadVips();
        let image = null;
        try {
            image = vips.Image.thumbnailBuffer(bytes, MAX_EDGE, { height: MAX_EDGE, size: 'down' });
            const width = image.width;
            const height = image.height;
            if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_IMAGE_BYTES) {
                throw new Error('图片超过浏览器解码安全限制');
            }
            const encoded = image.webpsaveBuffer({ Q: 82, keep: 0 });
            const copy = new Uint8Array(encoded.byteLength);
            copy.set(encoded);
            return {
                url: URL.createObjectURL(new Blob([copy], { type: 'image/webp' })),
                width,
                height,
                converted: true,
                engine: 'wasm-vips',
            };
        } finally {
            try { image?.delete?.(); } catch {}
        }
    }

    async function prepareMedia(url, { kind = 'video', name = 'media', capabilities = {} } = {}) {
        const ext = extensionOf(name);
        const direct = kind === 'video'
            ? ['mp4', 'm4v', 'webm'].includes(ext)
            : ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba'].includes(ext);
        if (direct && browserCanPlay(kind, capabilities)) {
            return { url, owned: false, mode: 'DIRECT', engine: 'browser' };
        }
        const bytes = await readBounded(url, MAX_MEDIA_BYTES);
        const ffmpeg = await loadFfmpeg();
        const input = `input.${ext || 'bin'}`;
        const output = kind === 'audio' ? 'output.m4a' : 'output.mp4';
        const args = kind === 'audio'
            ? ['-i', input, '-vn', '-c:a', 'aac', '-b:a', '160k', output]
            : ['-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output];
        await ffmpeg.writeFile(input, bytes);
        let code = 1;
        try {
            code = await ffmpeg.exec(args, 120000);
            if (code !== 0) throw new Error(`浏览器转码失败（${code}）`);
            const data = await ffmpeg.readFile(output);
            const copy = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
            const type = kind === 'audio' ? 'audio/mp4' : 'video/mp4';
            return {
                url: URL.createObjectURL(new Blob([copy], { type })),
                owned: true,
                mode: 'TRANSCODED',
                engine: 'ffmpeg.wasm',
            };
        } finally {
            try { await ffmpeg.deleteFile(input); } catch {}
            try { await ffmpeg.deleteFile(output); } catch {}
        }
    }

    function releaseMedia(prepared) {
        if (prepared?.owned && prepared.url) URL.revokeObjectURL(prepared.url);
    }

    window.ZephyrPreviewWasm = { decodeImage, prepareMedia, releaseMedia, BROWSER_DIRECT };
})();
