import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const express = require('express');
const {
    wrapAsyncHandler,
    installAsyncHandlerGuard,
    jsonErrorMiddleware,
} = require('../express-async-guard.js');

/**
 * Regression cover for the crash reported from Zephyr One on Windows: entering
 * a new password at first login killed node.exe outright and the WebView could
 * only report "Failed to fetch".
 *
 * Root cause chain:
 *   1. storage.updateUser() passes a full row object into a statement naming a
 *      subset of columns. node:sqlite threw `Unknown named parameter
 *      'createdAt'` where better-sqlite3 ignores extras. (Fixed in
 *      sqlite-driver.js; covered by sqlite-driver-named-params.test.mjs.)
 *   2. That throw happened inside an `async` Express handler. Express 4 does
 *      not catch async rejections, so it escaped as an unhandledRejection.
 *   3. server.js had no unhandledRejection handler, so Node's default
 *      --unhandled-rejections=throw terminated the process.
 *
 * Link 1 is one bug; links 2-3 turn *any* future async bug into a process
 * kill. These tests cover links 2-3 — the containment, not the single bug.
 */

/** Start an app on an ephemeral port and return { origin, close }. */
async function serve(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function getJson(origin, routePath) {
    const res = await fetch(`${origin}${routePath}`);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

test('an async handler rejection becomes a JSON 500 instead of an escaped rejection', async () => {
    const app = express();
    installAsyncHandlerGuard(app);

    // Exactly the shape of /api/auth/change-password: async handler, sync throw
    // from a synchronous DB call inside it.
    app.post('/api/thing', async () => {
        throw new RangeError("Unknown named parameter 'createdAt'");
    });
    app.use(jsonErrorMiddleware);

    const { origin, close } = await serve(app);
    const escaped = [];
    const onRejection = (reason) => escaped.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
        const res = await fetch(`${origin}/api/thing`, { method: 'POST' });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.match(body.error, /Unknown named parameter/);
        assert.equal(body.code, 'internal_error');
        // Give the microtask queue a turn so a genuine escape would surface.
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(escaped, [], 'no rejection may escape to the process');
    } finally {
        process.off('unhandledRejection', onRejection);
        await close();
    }
});

test('a rejected promise (not just a sync throw) is also contained', async () => {
    const app = express();
    installAsyncHandlerGuard(app);
    app.get('/reject', async () => Promise.reject(new Error('async db failure')));
    app.use(jsonErrorMiddleware);

    const { origin, close } = await serve(app);
    try {
        const { status, body } = await getJson(origin, '/reject');
        assert.equal(status, 500);
        assert.equal(body.error, 'async db failure');
    } finally {
        await close();
    }
});

test('err.status is honoured so HttpError-style rejections keep their code', async () => {
    const app = express();
    installAsyncHandlerGuard(app);
    app.get('/nope', async () => {
        const err = new Error('连接不存在');
        err.status = 404;
        err.code = 'connection_not_found';
        err.retryable = false;
        throw err;
    });
    app.use(jsonErrorMiddleware);

    const { origin, close } = await serve(app);
    try {
        const { status, body } = await getJson(origin, '/nope');
        assert.equal(status, 404);
        assert.deepEqual(body, {
            error: '连接不存在',
            code: 'connection_not_found',
            retryable: false,
        });
    } finally {
        await close();
    }
});

test('successful async handlers are untouched', async () => {
    const app = express();
    installAsyncHandlerGuard(app);
    app.get('/ok', async (req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        res.json({ ok: true, value: 42 });
    });
    app.use(jsonErrorMiddleware);

    const { origin, close } = await serve(app);
    try {
        const { status, body } = await getJson(origin, '/ok');
        assert.equal(status, 200);
        assert.deepEqual(body, { ok: true, value: 42 });
    } finally {
        await close();
    }
});

test('async middleware chains still hand off correctly', async () => {
    const app = express();
    installAsyncHandlerGuard(app);
    const seen = [];
    app.use(async (req, res, next) => { seen.push('mw1'); next(); });
    app.get('/chain', async (req, res, next) => { seen.push('h1'); next(); }, async (req, res) => {
        seen.push('h2');
        res.json({ seen });
    });
    app.use(jsonErrorMiddleware);

    const { origin, close } = await serve(app);
    try {
        const { status, body } = await getJson(origin, '/chain');
        assert.equal(status, 200);
        assert.deepEqual(body.seen, ['mw1', 'h1', 'h2']);
    } finally {
        await close();
    }
});

test('sync handlers, routers and static middleware pass through unwrapped', () => {
    const syncFn = (req, res) => res.end();
    assert.equal(wrapAsyncHandler(syncFn), syncFn, 'sync handler must be identical');

    const router = express.Router();
    assert.equal(wrapAsyncHandler(router), router, 'router must not be wrapped');

    const staticMw = express.static('.');
    assert.equal(wrapAsyncHandler(staticMw), staticMw, 'static middleware must not be wrapped');

    const notAFunction = { index: 'index.html' };
    assert.equal(wrapAsyncHandler(notAFunction), notAFunction, 'options objects pass through');

    const path = '/api/thing';
    assert.equal(wrapAsyncHandler(path), path, 'route paths pass through');
});

test('a 4-arity async error handler stays recognisable to Express', async () => {
    // Express keys off fn.length === 4. If the wrapper collapsed arity, a
    // custom async error handler would silently become a normal handler.
    const asyncErrorHandler = async (err, req, res, next) => {
        res.status(418).json({ handled: err.message });
    };
    const wrapped = wrapAsyncHandler(asyncErrorHandler);
    assert.equal(wrapped.length, 4, 'arity must survive wrapping');

    const app = express();
    installAsyncHandlerGuard(app);
    app.get('/boom', async () => { throw new Error('from-route'); });
    app.use(asyncErrorHandler);

    const { origin, close } = await serve(app);
    try {
        const { status, body } = await getJson(origin, '/boom');
        assert.equal(status, 418, 'the async error handler must have run');
        assert.equal(body.handled, 'from-route');
    } finally {
        await close();
    }
});

test('the guard is installed before any route is registered in server.js', () => {
    // Ordering is load-bearing: routes registered before the guard runs would
    // keep the raw handler and stay able to kill the process.
    const src = require('node:fs').readFileSync(
        new URL('../server.js', import.meta.url),
        'utf8',
    );
    const install = src.indexOf('installAsyncHandlerGuard(app)');
    assert.ok(install > 0, 'server.js must install the guard');

    const firstRoute = Math.min(
        ...['app.get(', 'app.post(', 'app.use(applyCrossOriginIsolationHeaders']
            .map((needle) => {
                const at = src.indexOf(needle);
                return at === -1 ? Number.MAX_SAFE_INTEGER : at;
            }),
    );
    assert.ok(
        install < firstRoute,
        'the guard must be installed before the first route/middleware registration',
    );

    // The terminal error middleware must be last, and reached via the module.
    assert.match(src, /app\.use\(jsonErrorMiddleware\)/);
    const errAt = src.indexOf('app.use(jsonErrorMiddleware)');
    /* Anchor to the *invocation* at column 0. `indexOf('startServer()')` would
     * match the `async function startServer() {` declaration instead, which sits
     * above the error middleware and inverts the comparison. */
    const invokeAt = src.search(/^startServer\(\)/m);
    assert.ok(invokeAt > 0, 'server.js must invoke startServer() at top level');
    assert.ok(
        errAt < invokeAt,
        'error middleware must register before startServer() is invoked',
    );
});

test('server.js keeps process-level guards so no single request can kill the core', () => {
    const src = require('node:fs').readFileSync(
        new URL('../server.js', import.meta.url),
        'utf8',
    );
    assert.match(src, /process\.on\('unhandledRejection'/);
    assert.match(src, /process\.on\('uncaughtException'/);
    // They must be armed only after a successful listen, so a genuine startup
    // failure still exits non-zero instead of hanging forever.
    const thenAt = src.search(/^startServer\(\)\r?\n[ \t]*\.then\(\(\) => \{/m);
    const catchAt = src.indexOf('.catch(', thenAt);
    const rejectionAt = src.indexOf("process.on('unhandledRejection'");
    const exceptionAt = src.indexOf("process.on('uncaughtException'");
    assert.ok(thenAt > 0, 'server startup must have a success callback');
    assert.ok(catchAt > thenAt, 'server startup must retain its failure callback');
    assert.ok(
        rejectionAt > thenAt && rejectionAt < catchAt
        && exceptionAt > thenAt && exceptionAt < catchAt,
        'guards arm inside the success callback after listen succeeds',
    );
});
