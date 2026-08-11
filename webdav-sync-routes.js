'use strict';

const express = require('express');
const { WebDavSyncError, publicWebDavError } = require('./webdav-sync-service');

function defaultGetUserId(req) {
    return req.user?.userId
        || req.auth?.userId
        || req.authUser?.userId
        || req.session?.userId
        || '';
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requestAbortedError() {
    return new WebDavSyncError(499, 'webdav_request_aborted', true);
}

/* req.close is normal after a complete request body. res.close before res.end
 * is the client-disconnect signal for work that is still in progress. */
function attachRequestAbortSignal(req, res, next) {
    const controller = new AbortController();
    let cleaned = false;
    const abort = () => {
        if (!controller.signal.aborted) controller.abort(requestAbortedError());
    };
    const onRequestClose = () => {
        if (req.aborted) abort();
    };
    const onResponseClose = () => {
        if (!res.writableEnded) abort();
    };
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        req.removeListener('aborted', abort);
        req.removeListener('close', onRequestClose);
        res.removeListener('close', onResponseClose);
        res.removeListener('finish', cleanup);
        res.removeListener('close', cleanup);
    };

    req.webDavAbortSignal = controller.signal;
    req.on('aborted', abort);
    req.on('close', onRequestClose);
    res.on('close', onResponseClose);
    res.once('finish', cleanup);
    res.once('close', cleanup);
    next();
}

function sendWebDavError(res, error) {
    if (res.headersSent || res.writableEnded || res.destroyed) return undefined;
    const safe = publicWebDavError(error);
    return res.status(safe.status).json({
        ok: false,
        error: { code: safe.code, message: safe.message, retryable: safe.retryable },
    });
}

function stripSensitiveInput(req, _res, next) {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        const body = { ...req.body };
        delete body.secret;
        delete body.unlockGrant;
        req.body = body;
    }
    next();
}

function createWebDavSyncRouter({
    service,
    authentication,
    sensitiveRateLimiter,
    sensitiveVerification,
    getUserId = defaultGetUserId,
    expressModule = express,
} = {}) {
    if (!service?.getConfig || !service?.patchConfig || !service?.testConnection || !service?.syncNow
        || !service?.deleteConfigAndDrain) {
        throw new Error('createWebDavSyncRouter requires a WebDavSyncService');
    }
    if (typeof authentication !== 'function') {
        throw new Error('createWebDavSyncRouter requires authentication middleware');
    }
    if (typeof sensitiveRateLimiter !== 'function') {
        throw new Error('createWebDavSyncRouter requires sensitive rate limiter middleware');
    }
    if (typeof sensitiveVerification !== 'function') {
        throw new Error('createWebDavSyncRouter requires sensitive verification middleware');
    }
    if (typeof getUserId !== 'function') throw new Error('getUserId must be a function');

    const router = expressModule.Router();
    router.use(attachRequestAbortSignal);
    router.use(authentication);
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    function owner(req) {
        const userId = String(getUserId(req) || '');
        if (!userId) throw new WebDavSyncError(401, 'webdav_unauthorized');
        return userId;
    }

    router.get('/config', asyncRoute(async (req, res) => {
        res.json({ ok: true, config: await service.getConfig(owner(req)) });
    }));

    router.patch('/config', sensitiveRateLimiter, sensitiveVerification, stripSensitiveInput, asyncRoute(async (req, res) => {
        res.json({ ok: true, config: await service.patchConfig(owner(req), req.body || {}, { signal: req.webDavAbortSignal }) });
    }));

    router.delete('/config', sensitiveRateLimiter, sensitiveVerification, stripSensitiveInput, asyncRoute(async (req, res) => {
        const deleted = await service.deleteConfigAndDrain(owner(req), { signal: req.webDavAbortSignal });
        res.json({ ok: true, deleted: !!deleted });
    }));

    router.post('/test', sensitiveRateLimiter, sensitiveVerification, stripSensitiveInput, asyncRoute(async (req, res) => {
        res.json({ ok: true, result: await service.testConnection(owner(req), req.body || {}, { signal: req.webDavAbortSignal }) });
    }));

    router.post('/sync-now', sensitiveRateLimiter, sensitiveVerification, stripSensitiveInput, asyncRoute(async (req, res) => {
        res.json({ ok: true, result: await service.syncNow(owner(req), { signal: req.webDavAbortSignal }) });
    }));

    router.use((error, _req, res, _next) => sendWebDavError(res, error));
    return router;
}

module.exports = {
    attachRequestAbortSignal,
    createWebDavSyncRouter,
    defaultGetUserId,
    sendWebDavError,
    stripSensitiveInput,
};
