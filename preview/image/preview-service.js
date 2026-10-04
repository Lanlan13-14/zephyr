const PREVIEW_IMAGE_LIMITS = Object.freeze({
    maxInputBytes: 32 * 1024 * 1024,
    maxInputPixels: 32 * 1024 * 1024,
    maxWidth: 8192,
    maxHeight: 8192,
    maxPages: 1,
    maxFrames: 1,
    maxMetadataBytes: 1024 * 1024,
    maxOutputWidth: 4096,
    maxOutputHeight: 4096,
    inputReadTimeoutMs: 20 * 1000,
    decodeTimeoutMs: 30 * 1000,
});

const PREVIEW_ERROR_DETAILS = Object.freeze({
    preview_input_too_large: { statusCode: 413, message: 'Image preview exceeds the size limit.' },
    preview_input_timeout: { statusCode: 408, message: 'Image preview timed out.' },
    preview_input_aborted: { statusCode: 408, message: 'Image preview was cancelled.' },
    preview_image_limits: { statusCode: 422, message: 'Image preview exceeds decoder safety limits.' },
    preview_tiff_unsupported: { statusCode: 415, message: 'TIFF previews are not supported.' },
    preview_svg_unsupported: { statusCode: 415, message: 'SVG previews are not supported.' },
    preview_format_mismatch: { statusCode: 415, message: 'Image content does not match its filename.' },
    preview_cache_identity_required: { statusCode: 503, message: 'Image preview is temporarily unavailable.' },
    preview_decoder_unavailable: { statusCode: 503, message: 'Image preview is temporarily unavailable.' },
    preview_decode_failed: { statusCode: 422, message: 'Image preview could not be processed.' },
});

class PreviewResourceError extends Error {
    constructor(code) {
        const detail = PREVIEW_ERROR_DETAILS[code] || PREVIEW_ERROR_DETAILS.preview_decode_failed;
        super(detail.message);
        this.name = 'PreviewResourceError';
        this.code = code in PREVIEW_ERROR_DETAILS ? code : 'preview_decode_failed';
        this.statusCode = detail.statusCode;
        this.publicMessage = detail.message;
    }
}

function previewError(code) {
    return new PreviewResourceError(code);
}

function asPreviewError(error) {
    if (error instanceof PreviewResourceError) return error;
    if (/pixel|dimension|image limit/i.test(String(error?.message || ''))) {
        return previewError('preview_image_limits');
    }
    return previewError('preview_decode_failed');
}

function previewErrorResponse(error) {
    const safe = asPreviewError(error);
    return {
        statusCode: safe.statusCode,
        body: { error: safe.publicMessage, code: safe.code },
    };
}

function getImageExt(filePath = '') {
    const base = String(filePath || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
}

function isPreviewImageExt(ext, previewExts) {
    return previewExts.has(String(ext || '').toLowerCase());
}

function assertPreviewSourceSize(sourceSize, limits = PREVIEW_IMAGE_LIMITS) {
    const size = Number(sourceSize);
    if (!Number.isFinite(size) || size < 0) return;
    if (size > limits.maxInputBytes) throw previewError('preview_input_too_large');
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function metadataByteLength(value) {
    if (Buffer.isBuffer(value)) return value.length;
    if (value instanceof Uint8Array) return value.byteLength;
    if (typeof value === 'string') return Buffer.byteLength(value);
    return 0;
}

function validateImageMetadata(metadata, limits = PREVIEW_IMAGE_LIMITS) {
    const width = positiveInteger(metadata?.width);
    const height = positiveInteger(metadata?.height);
    const pages = metadata?.pages === undefined ? 1 : positiveInteger(metadata.pages);
    const pageHeight = metadata?.pageHeight === undefined ? height : positiveInteger(metadata.pageHeight);
    const frameCount = Array.isArray(metadata?.delay) ? metadata.delay.length : pages;

    if (!width || !height || !pages || !pageHeight || !frameCount) {
        throw previewError('preview_image_limits');
    }
    if (
        width > limits.maxWidth
        || height > limits.maxHeight
        || pageHeight > limits.maxHeight
        || pages > limits.maxPages
        || frameCount > limits.maxFrames
    ) {
        throw previewError('preview_image_limits');
    }
    const framePixels = width * pageHeight;
    const totalPixels = framePixels * pages;
    if (!Number.isSafeInteger(framePixels) || !Number.isSafeInteger(totalPixels)
        || framePixels > limits.maxInputPixels || totalPixels > limits.maxInputPixels) {
        throw previewError('preview_image_limits');
    }

    const metadataBytes = ['exif', 'icc', 'iptc', 'xmp'].reduce(
        (total, field) => total + metadataByteLength(metadata?.[field]),
        0,
    );
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > limits.maxMetadataBytes) {
        throw previewError('preview_image_limits');
    }
    return { width, height, pages, pageHeight, frameCount };
}

module.exports = {
    PREVIEW_IMAGE_LIMITS,
    PreviewResourceError,
    getImageExt,
    isPreviewImageExt,
    assertPreviewSourceSize,
    validateImageMetadata,
    previewErrorResponse,
};
