import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let superCookie;
let userCookie;
let adminCookie;

before(async () => {
    server = new TestServer();
    await server.start();
    superCookie = (await server.bootstrapAdmin('permission-super-pass')).cookie;

    const user = await server.api(superCookie, 'POST', '/api/admin/users', {
        username: 'permission-user', password: 'permission-user-temp', email: 'user@example.test', role: 'user',
    });
    assert.equal(user.status, 200, JSON.stringify(user.body));
    const userLogin = await server.login('permission-user', 'permission-user-temp');
    await server.api(userLogin.cookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'permission-user-temp', newPassword: 'permission-user-pass',
    });
    userCookie = userLogin.cookie;

    const admin = await server.api(superCookie, 'POST', '/api/admin/users', {
        username: 'permission-admin', password: 'permission-admin-temp', role: 'admin',
    });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const adminLogin = await server.login('permission-admin', 'permission-admin-temp');
    await server.api(adminLogin.cookie, 'POST', '/api/auth/change-password', {
        currentPassword: 'permission-admin-temp', newPassword: 'permission-admin-pass',
    });
    adminCookie = adminLogin.cookie;
});

after(async () => { await server?.cleanup(); });

test('platform settings and destructive APIs require the super admin', async () => {
    const userLegacySettings = await server.api(userCookie, 'GET', '/api/settings');
    assert.equal(userLegacySettings.status, 200);
    assert.ok(userLegacySettings.body.appearance);
    assert.equal(Object.hasOwn(userLegacySettings.body, 'mail'), false);
    assert.equal(Object.hasOwn(userLegacySettings.body, 'security'), false);

    for (const [method, path, body] of [
        ['PUT', '/api/settings/mail', { mail: { enabled: false } }],
        ['GET', '/api/settings/admin'],
        ['GET', '/api/data/export'],
        ['DELETE', '/api/security/ip-bans/1.2.3.4'],
        ['DELETE', '/api/activities'],
        ['GET', '/api/security/login-events'],
    ]) {
        const response = await server.api(userCookie, method, path, body);
        assert.equal(response.status, 403, `${method} ${path}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.code, 'super_admin_required');
    }

    const regularAdminMail = await server.api(adminCookie, 'PUT', '/api/settings/mail', { mail: { enabled: false } });
    assert.equal(regularAdminMail.status, 403, JSON.stringify(regularAdminMail.body));
    assert.equal(regularAdminMail.body.code, 'super_admin_required');

    const regularAdminAppearance = await server.api(adminCookie, 'PUT', '/api/settings/appearance', {
        appearance: { brandName: 'Permission Test', theme: 'dark', colorScheme: 'frost' },
    });
    assert.equal(regularAdminAppearance.status, 200, JSON.stringify(regularAdminAppearance.body));
    assert.equal(Object.hasOwn(regularAdminAppearance.body, 'mail'), false);
    assert.equal(Object.hasOwn(regularAdminAppearance.body, 'captcha'), false);
    assert.equal(Object.hasOwn(regularAdminAppearance.body, 'security'), false);

    const regularAdminNotes = await server.api(adminCookie, 'PUT', '/api/settings/notes', { notes: { enabled: true } });
    assert.equal(regularAdminNotes.status, 200, JSON.stringify(regularAdminNotes.body));
    assert.deepEqual(regularAdminNotes.body.notes, { enabled: true });

    const superMail = await server.api(superCookie, 'PUT', '/api/settings/mail', {
        mail: { enabled: false, host: 'smtp.example.test', pass: 'mail-secret', notifyLoginToUser: false },
    });
    assert.equal(superMail.status, 200, JSON.stringify(superMail.body));
    assert.equal(superMail.body.mail.pass, '******');
    const adminSettings = await server.api(superCookie, 'GET', '/api/settings/admin');
    assert.equal(adminSettings.status, 200);
    assert.equal(adminSettings.body.mail.pass, '******');
});

test('personal settings stay isolated and allow login notification preference', async () => {
    const update = await server.api(userCookie, 'PUT', '/api/me/settings', {
        appearance: { theme: 'light' },
        workspace: { sessionPersistence: false },
        mail: { notifyLogin: false },
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.overrides.appearance.theme, 'light');
    assert.equal(update.body.overrides.workspace.sessionPersistence, false);
    assert.equal(update.body.settings.workspace.sessionPersistence, false);
    assert.equal(update.body.overrides.mail.notifyLogin, false);
    assert.equal(update.body.settings.mail.notifyLogin, false);
    assert.equal(Object.hasOwn(update.body.settings.mail, 'host'), false);

    const adminPersonal = await server.api(adminCookie, 'GET', '/api/me/settings');
    assert.equal(adminPersonal.status, 200);
    assert.equal(Object.hasOwn(adminPersonal.body.settings, 'security'), false);
    assert.equal(Object.hasOwn(adminPersonal.body.settings, 'captcha'), false);
    assert.equal(Object.hasOwn(adminPersonal.body.settings, 'dataManage'), false);
});

test('login events expose only the current user through the personal route', async () => {
    const mine = await server.api(userCookie, 'GET', '/api/security/login-events/mine');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.ok(mine.body.events.length >= 1);
    assert.ok(mine.body.events.every((event) => event.username === 'permission-user'));

    const all = await server.api(superCookie, 'GET', '/api/security/login-events');
    assert.equal(all.status, 200);
    assert.ok(all.body.events.some((event) => event.username === 'permission-user'));
    assert.ok(all.body.events.some((event) => event.username === 'permission-admin'));
});

test('agent token lists are isolated by active user identity', async () => {
    const userToken = await server.api(userCookie, 'POST', '/api/rdp/file-agent-tokens', { name: 'user-device' });
    const adminToken = await server.api(adminCookie, 'POST', '/api/rdp/file-agent-tokens', { name: 'admin-device' });
    assert.equal(userToken.status, 200, JSON.stringify(userToken.body));
    assert.equal(adminToken.status, 200, JSON.stringify(adminToken.body));

    const userList = await server.api(userCookie, 'GET', '/api/rdp/file-agent-tokens');
    const adminList = await server.api(adminCookie, 'GET', '/api/rdp/file-agent-tokens');
    assert.deepEqual(userList.body.tokens.map((token) => token.name), ['user-device']);
    assert.deepEqual(adminList.body.tokens.map((token) => token.name), ['admin-device']);
    assert.equal(userList.body.tokens.some((token) => token.id === adminToken.body.token.id), false);
    assert.equal(adminList.body.tokens.some((token) => token.id === userToken.body.token.id), false);
});

test('workspace client contract persists rich state and avoids beforeunload', async () => {
    const app = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
    const terminal = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../public/terminal.js', import.meta.url), 'utf8'));
    assert.match(app, /version:\s*2/);
    assert.match(app, /Promise\.allSettled\(savedTabs\.map\(restoreTab\)\)/);
    assert.match(app, /settingsSubTab/);
    assert.match(app, /splitX/);
    assert.match(app, /captureTerminalSnapshots/);
    assert.doesNotMatch(app, /addEventListener\(['"]beforeunload/);
    assert.match(terminal, /__zephyrGetWorkspaceState/);
    assert.match(terminal, /restore-workspace-state/);
    assert.match(terminal, /__zephyrGetScreenText/);
});
