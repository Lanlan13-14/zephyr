/*
 * express-async-guard.js — keep one bad request from killing the process.
 *
 * Express 4 does not catch rejections from `async` route handlers. Under Node's
 * default --unhandled-rejections=throw, a single rejecting handler terminates
 * the process. That is how `POST /api/auth/change-password` took the whole core
 * down: storage.updateUser() threw `Unknown named parameter 'createdAt'` inside
 * an async handler, nothing caught it, and Node exited. Inside Zephyr One the
 * only visible symptom was the node.exe window vanishing and the WebView
 * reporting "Failed to fetch" — no stack, no status code, nothing to diagnose.
 *
 * Two pieces, deliberately separable so each is testable on its own:
 *   installAsyncHandlerGuard(app)  wraps async handlers registered on an app
 *                                  so rejections reach Express's error chain
 *   jsonErrorMiddleware            terminal 4-arity handler that turns those
 *                                  errors into a uniform JSON response
 *
 * Only AsyncFunction instances are wrapped. Routers, express.static, body
 * parsers and ordinary sync middleware pass through by identity, so mounting
 * behaviour and property access on them are unchanged.
 */
'use strict';

/** Route-registration methods that accept handler functions. */
const HANDLER_METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Wrap a single handler so an async rejection is forwarded to `next`.
 *
 * Non-async values are returned unchanged — identity is preserved, which is
 * what keeps `app.use(router)` and `app.use(express.static(...))` working.
 *
 * Express distinguishes error handlers purely by arity (`fn.length === 4`), so
 * the wrapper must keep a 4-arity handler at 4 arity. A 2-arity handler becomes
 * 3-arity, which is harmless: anything below 4 is treated as a normal handler.
 *
 * @param {*} fn candidate handler
 * @returns {*} wrapped handler, or `fn` unchanged
 */
function wrapAsyncHandler(fn) {
    if (typeof fn !== 'function') return fn;
    if (fn.constructor?.name !== 'AsyncFunction') return fn;

    const wrapped = fn.length === 4
        ? function guardedErrorHandler(err, req, res, next) {
            try {
                return Promise.resolve(fn.call(this, err, req, res, next)).catch(next);
            } catch (error) {
                return next(error);
            }
        }
        : function guardedHandler(req, res, next) {
            try {
                return Promise.resolve(fn.call(this, req, res, next)).catch(next);
            } catch (error) {
                return next(error);
            }
        };

    Object.defineProperty(wrapped, 'name', { value: fn.name || 'asyncHandler' });
    return wrapped;
}

/**
 * Patch an Express app/router so every async handler registered afterwards is
 * wrapped. Must run before any route is registered.
 *
 * @template T
 * @param {T} target Express application or router
 * @returns {T} the same object, patched in place
 */
function installAsyncHandlerGuard(target) {
    if (!target || target.__zephyrAsyncGuarded) return target;
    for (const method of HANDLER_METHODS) {
        const original = target[method];
        if (typeof original !== 'function') continue;
        target[method] = function guardedRouteMethod(...args) {
            return original.apply(this, args.map(wrapAsyncHandler));
        };
    }
    Object.defineProperty(target, '__zephyrAsyncGuarded', { value: true, enumerable: false });
    return target;
}

/**
 * Terminal error middleware. Register after every route.
 *
 * Express identifies error handlers by arity, so all four parameters are
 * load-bearing even though `next` is unused on the success path.
 */
// eslint-disable-next-line no-unused-vars
function jsonErrorMiddleware(err, req, res, next) {
    console.error('[route-error]', req.method, req.originalUrl, err);
    // A partially written response cannot be converted into a JSON error;
    // dropping the socket is the only honest signal left.
    if (res.headersSent) return res.destroy();
    const status = Number(err?.status || err?.statusCode) || 500;
    return res.status(status).json({
        error: err?.message || '服务器内部错误',
        code: err?.code || 'internal_error',
        retryable: !!err?.retryable,
    });
}

module.exports = {
    wrapAsyncHandler,
    installAsyncHandlerGuard,
    jsonErrorMiddleware,
    HANDLER_METHODS,
};
