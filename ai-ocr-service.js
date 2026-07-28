'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { HttpError } = require('./authz');

/**
 * S4 OCR fallback.
 * Implementation locked by this module:
 *   - Prefer ZEPHYR_OCR_URL (external HTTP API)
 *   - Else if tesseract binary available, try local CLI
 *   - Else fail closed with clear code ocr_unavailable
 *
 * External API contract (POST JSON or multipart):
 *   POST {imageBase64, mimeType} → { text: string }
 *   or POST multipart file field "file" → { text }
 */

function ocrConfigured() {
    if (process.env.ZEPHYR_OCR_URL) return { mode: 'http', url: process.env.ZEPHYR_OCR_URL };
    if (process.env.ZEPHYR_OCR_COMMAND) return { mode: 'command', command: process.env.ZEPHYR_OCR_COMMAND };
    return null;
}

async function fileExists(p) {
    try { await fsp.access(p); return true; } catch { return false; }
}

async function detectTesseract() {
    const candidates = ['/usr/bin/tesseract', '/bin/tesseract', 'tesseract'];
    for (const c of candidates) {
        if (c.includes('/') && !(await fileExists(c))) continue;
        return c;
    }
    return null;
}

async function ocrViaHttp(url, buffer, mimeType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.ZEPHYR_OCR_TIMEOUT_MS || 30000));
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ZEPHYR_OCR_TOKEN ? { Authorization: `Bearer ${process.env.ZEPHYR_OCR_TOKEN}` } : {}),
            },
            body: JSON.stringify({
                imageBase64: buffer.toString('base64'),
                mimeType: mimeType || 'image/png',
            }),
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new HttpError(502, 'ocr_failed', data.error || `OCR HTTP ${res.status}`);
        }
        const text = String(data.text || data.result || data.content || '').trim();
        if (!text) throw new HttpError(502, 'ocr_empty', 'OCR 返回空文本');
        return text;
    } finally {
        clearTimeout(timer);
    }
}

async function ocrViaTesseract(bin, buffer, workDir) {
    const { spawn } = require('child_process');
    await fsp.mkdir(workDir, { recursive: true });
    const imgPath = path.join(workDir, `ocr-${Date.now()}.png`);
    const outBase = path.join(workDir, `ocr-out-${Date.now()}`);
    await fsp.writeFile(imgPath, buffer);
    await new Promise((resolve, reject) => {
        const child = spawn(bin, [imgPath, outBase, '-l', process.env.ZEPHYR_OCR_LANG || 'eng+chi_sim'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(err || `tesseract exit ${code}`));
        });
    });
    const text = await fsp.readFile(`${outBase}.txt`, 'utf8');
    try { await fsp.unlink(imgPath); } catch { /* ignore */ }
    try { await fsp.unlink(`${outBase}.txt`); } catch { /* ignore */ }
    return String(text || '').trim();
}

/**
 * @returns {{ text: string, engine: string }}
 */
async function runOcr({ buffer, mimeType = 'image/png', workDir = '', spillPath = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new HttpError(400, 'ocr_empty_image', 'OCR 输入为空');
    }
    const cfg = ocrConfigured();
    if (cfg?.mode === 'http') {
        const text = await ocrViaHttp(cfg.url, buffer, mimeType);
        if (spillPath) {
            await fsp.mkdir(path.dirname(spillPath), { recursive: true });
            await fsp.writeFile(spillPath, text, 'utf8');
        }
        return { text, engine: 'http' };
    }
    const tess = cfg?.mode === 'command' ? cfg.command : await detectTesseract();
    if (tess) {
        const dir = workDir || path.join(require('os').tmpdir(), 'zephyr-ocr');
        const text = await ocrViaTesseract(tess, buffer, dir);
        if (!text) throw new HttpError(502, 'ocr_empty', 'OCR 返回空文本');
        if (spillPath) {
            await fsp.mkdir(path.dirname(spillPath), { recursive: true });
            await fsp.writeFile(spillPath, text, 'utf8');
        }
        return { text, engine: 'tesseract' };
    }
    throw new HttpError(
        400,
        'ocr_unavailable',
        '模型不支持图片输入且未配置 OCR（设置 ZEPHYR_OCR_URL 或安装 tesseract）'
    );
}

function isOcrAvailableSync() {
    return !!(process.env.ZEPHYR_OCR_URL || process.env.ZEPHYR_OCR_COMMAND);
}

module.exports = {
    runOcr,
    ocrConfigured,
    isOcrAvailableSync,
};
