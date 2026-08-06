const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// sharp ships Linux native addons and cannot be required by Android Node.
// Delay resolution until an image conversion is actually requested so core
// startup remains available; Android can fall back to ImageMagick if supplied.
let sharpLoader;
function loadSharp() {
    if (process.platform === 'android') return null;
    if (sharpLoader === undefined) {
        try { sharpLoader = require('sharp'); } catch { sharpLoader = null; }
    }
    return sharpLoader;
}

function getImageExt(filePath = '') {
    const base = String(filePath || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
}

function safeCacheKey(parts) {
    return cryptoHash(parts).replace(/[^a-f0-9]/gi, '');
}

function cryptoHash(parts) {
    return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

function isBrowserImageExt(ext, browserExts) {
    return browserExts.has(String(ext || '').toLowerCase());
}

function isPreviewImageExt(ext, previewExts) {
    return previewExts.has(String(ext || '').toLowerCase());
}

function getBrowserImageContentType(ext, contentTypes) {
    return contentTypes.get(String(ext || '').toLowerCase()) || 'application/octet-stream';
}

function hasImageMagick() {
    return new Promise((resolve) => {
        const child = spawn('magick', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

function convertWithImageMagick(inputPath, outputPath, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const child = spawn('magick', [inputPath + '[0]', '-auto-orient', '-strip', '-quality', '82', 'webp:' + outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            reject(new Error('ImageMagick 转码超时'));
        }, timeoutMs);
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(outputPath);
            else reject(new Error((stderr || `ImageMagick 退出码 ${code}`).trim()));
        });
    });
}

async function convertImageToWebp(inputPath, outputPath) {
    const sharp = loadSharp();
    if (sharp) {
        try {
            await sharp(inputPath, { animated: false, pages: 1, limitInputPixels: false })
                .rotate()
                .webp({ quality: 82, effort: 4 })
                .toFile(outputPath);
            return { engine: 'sharp' };
        } catch (sharpErr) {
            if (!(await hasImageMagick())) throw sharpErr;
        }
    }
    if (!(await hasImageMagick())) {
        throw new Error('图片转码不可用：Android 不支持 sharp，且未找到 ImageMagick');
    }
    await convertWithImageMagick(inputPath, outputPath);
    return { engine: 'imagemagick' };
}

async function ensurePreviewCacheFile({ cache, cacheMap, cacheDir, sourcePath, sourceSize, sourceMtime, ext, readSourceFile }) {
    const key = safeCacheKey([sourcePath, String(sourceSize || 0), String(sourceMtime || 0), ext || '']);
    const outputPath = path.join(cacheDir, `${key}.webp`);
    const now = Date.now();
    const cached = cacheMap.get(key);
    if (cached && cached.outputPath === outputPath && fs.existsSync(outputPath)) {
        cached.expiresAt = now + cache.ttl;
        return { outputPath, cached: true, engine: cached.engine || 'cache' };
    }
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const inputPath = path.join(cacheDir, `${key}.source.${ext || 'img'}`);
    try {
        await readSourceFile(inputPath);
        const result = await convertImageToWebp(inputPath, outputPath);
        cacheMap.set(key, { outputPath, engine: result.engine, expiresAt: now + cache.ttl });
        return { outputPath, cached: false, engine: result.engine };
    } finally {
        fs.promises.unlink(inputPath).catch(() => {});
    }
}

function cleanupPreviewCache(cacheMap) {
    const now = Date.now();
    for (const [key, item] of cacheMap.entries()) {
        if (item.expiresAt > now) continue;
        cacheMap.delete(key);
        if (item.outputPath) fs.promises.unlink(item.outputPath).catch(() => {});
    }
}

module.exports = {
    getImageExt,
    isBrowserImageExt,
    isPreviewImageExt,
    getBrowserImageContentType,
    ensurePreviewCacheFile,
    cleanupPreviewCache,
};
