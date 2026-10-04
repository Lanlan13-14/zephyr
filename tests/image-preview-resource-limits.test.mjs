import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
    PREVIEW_IMAGE_LIMITS,
    PreviewResourceError,
    assertPreviewSourceSize,
    validateImageMetadata,
    previewErrorResponse,
} = require('../preview/image/preview-service');

test('metadata inside the published limits is accepted', () => {
    const metadata = validateImageMetadata({ width: 32, height: 24 });
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 24);
    assert.equal(metadata.pages, 1);
    assert.ok(metadata.width <= PREVIEW_IMAGE_LIMITS.maxOutputWidth);
    assert.ok(metadata.height <= PREVIEW_IMAGE_LIMITS.maxOutputHeight);
});

test('rejects multi-page metadata and oversized sources before a browser fetch', () => {
    assert.throws(
        () => validateImageMetadata({ width: 16, height: 32, pageHeight: 16, pages: 2, delay: [0, 0] }),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_image_limits',
    );
    assert.throws(
        () => assertPreviewSourceSize(PREVIEW_IMAGE_LIMITS.maxInputBytes + 1),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_input_too_large',
    );
});

test('rejects dimensions and metadata that would blow up a browser decoder', () => {
    assert.throws(
        () => validateImageMetadata({ width: PREVIEW_IMAGE_LIMITS.maxWidth + 1, height: 1 }),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_image_limits',
    );
    assert.throws(
        () => validateImageMetadata({ width: 16, height: 16, exif: 'x'.repeat(PREVIEW_IMAGE_LIMITS.maxMetadataBytes + 1) }),
        (error) => error instanceof PreviewResourceError && error.code === 'preview_image_limits',
    );
});

test('safe preview errors never echo a path or decoder failure', () => {
    const response = previewErrorResponse(new Error('/private/path.tiff: decoder exploded'));
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.code, 'preview_decode_failed');
    assert.equal(JSON.stringify(response.body).includes('/private/path.tiff'), false);
    assert.equal(JSON.stringify(response.body).includes('decoder exploded'), false);
});
