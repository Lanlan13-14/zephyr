import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

/* Regression guard for the stored-XSS chain reported against the login page:
 * a plain (non-super) admin could store appearance.customJs through
 * PUT /api/settings/appearance, the unauthenticated GET /api/public/settings
 * echoed it back, and the login page executed it via applyZephyrColorScheme.
 *
 * The fix keeps customJs functional for the super admin on the authenticated
 * SPA, but (1) plain admins can no longer write it, (2) the unauthenticated
 * public endpoint no longer ships it, and (3) it no longer rides the personal
 * effective-settings payload used by non-super surfaces. */

let server;
let superCookie;
let userCookie;
let adminCookie;

before(async () => {
    server = new TestServer();
    await server.start();
    superCookie = (await server.bootstrapAdmin('xss-super-pass')).cookie;

    const user = await server.api(superCookie, 'POST', '/api/admin/users', {
        username: 'xss-user', password: 'xss-user-temp', email: 'user@example.test', role: 'user',
    });
    assert.equal(user.status, 200, JSON.stringify(user.body));
    const userLogin = await server.login('xss-user', 'xss-user-temp');
    await server.api(userLogin.cookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'xss-user-temp', newPassword: 'xss-user-pass',
    });
    userCookie = userLogin.cookie;

    const admin = await server.api(superCookie, 'POST', '/api/admin/users', {
        username: 'xss-admin', password: 'xss-admin-temp', role: 'admin',
    });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const adminLogin = await server.login('xss-admin', 'xss-admin-temp');
    await server.api(adminLogin.cookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'xss-admin-temp', newPassword: 'xss-admin-pass',
    });
    adminCookie = adminLogin.cookie;
});

after(async () => { await server?.cleanup(); });

test('plain admin cannot store customJs and cannot clobber the stored value', async () => {
    const seed = await server.api(superCookie, 'PUT', '/api/settings/appearance', {
        appearance: { colorScheme: 'custom', customJs: 'window.__ZEPHYR_SEED=1' },
    });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));
    assert.equal(seed.body.appearance.customJs, 'window.__ZEPHYR_SEED=1');

    const inject = await server.api(adminCookie, 'PUT', '/api/settings/appearance', {
        appearance: { colorScheme: 'custom', customJs: 'window.__ZEPHYR_XSS_POC=1' },
    });
    assert.equal(inject.status, 200, JSON.stringify(inject.body.body || inject.body));
    /* The admin response body is the raw appearance section; the injected
     * payload must have been discarded in favor of the stored value. */
    assert.equal(inject.body.appearance.customJs, 'window.__ZEPHYR_SEED=1');
    assert.notEqual(inject.body.appearance.customJs, 'window.__ZEPHYR_XSS_POC=1');
});

test('super admin retains full customJs control', async () => {
    const update = await server.api(superCookie, 'PUT', '/api/settings/appearance', {
        appearance: { colorScheme: 'custom', customJs: 'window.__ZEPHYR_SUPER=1' },
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.appearance.customJs, 'window.__ZEPHYR_SUPER=1');

    const cleared = await server.api(superCookie, 'PUT', '/api/settings/appearance', {
        appearance: { customJs: '' },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.appearance.customJs, '');
});

test('unauthenticated public settings never expose customJs', async () => {
    await server.api(superCookie, 'PUT', '/api/settings/appearance', {
        appearance: { colorScheme: 'custom', customJs: 'window.__ZEPHYR_SECRET=1' },
    });
    const res = await server.fetch('/api/public/settings');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Object.hasOwn(body.appearance, 'customJs'), false);
    assert.equal(JSON.stringify(body).includes('__ZEPHYR_SECRET'), false);
});

test('personal effective settings strip customJs for users and plain admins', async () => {
    await server.api(superCookie, 'PUT', '/api/settings/appearance', {
        appearance: { colorScheme: 'custom', customJs: 'window.__ZEPHYR_SECRET=1' },
    });
    for (const cookie of [userCookie, adminCookie]) {
        const res = await server.api(cookie, 'GET', '/api/me/settings');
        assert.equal(res.status, 200);
        assert.equal(Object.hasOwn(res.body.settings.appearance, 'customJs'), false);
        assert.equal(JSON.stringify(res.body).includes('__ZEPHYR_SECRET'), false);
    }
});
