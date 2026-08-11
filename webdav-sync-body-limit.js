'use strict';

const express = require('express');

const WEBDAV_SYNC_JSON_LIMIT_BYTES = 16 * 1024;

function sendBodyError(res, status, code, message) {
    return res.status(status).json({
        ok: false,
        error: { code, message, retryable: false },
    });
}

/**
 * Parse the small JSON envelopes accepted by the WebDAV sync API before the
 * application's general 24 MB parser has a chance to buffer them.  Matching
 * every content type intentionally prevents a client from bypassing the cap
 * by omitting or changing Content-Type.
 */
function createWebDavSyncJsonBodyLimit({
    limitBytes = WEBDAV_SYNC_JSON_LIMIT_BYTES,
    expressModule = express,
} = {}) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
        throw new Error('WebDAV JSON body limit must be a positive integer');
    }

    const parseJson = expressModule.json({
        limit: limitBytes,
        strict: true,
        type: () => true,
    });

    return function webDavSyncJsonBodyLimit(req, res, next) {
        const contentLength = req.headers['content-length'];
        const declaredBytes = typeof contentLength === 'string' ? Number(contentLength) : NaN;
        if (Number.isSafeInteger(declaredBytes) && declaredBytes > limitBytes) {
            return sendBodyError(res, 413, 'webdav_request_too_large', 'The WebDAV request body is too large.');
        }

        return parseJson(req, res, (error) => {
            if (!error) return next();
            if (error.type === 'entity.too.large' || error.status === 413 || error.statusCode === 413) {
                return sendBodyError(res, 413, 'webdav_request_too_large', 'The WebDAV request body is too large.');
            }
            if (error.status === 400 || error.statusCode === 400 || error.type === 'entity.parse.failed') {
                return sendBodyError(res, 400, 'webdav_request_invalid_json', 'The WebDAV request body must be valid JSON.');
            }
            return next(error);
        });
    };
}

module.exports = {
    WEBDAV_SYNC_JSON_LIMIT_BYTES,
    createWebDavSyncJsonBodyLimit,
};
