import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

/* Cross-user isolation acceptance (FREEZE plan §24.1/§24.2):
 * admin + users A and B; A's private resources must be invisible to B and to
 * the admin's plain lists; sharing grants exactly the granted capabilities
 * and revocation takes effect immediately. */

let server;
let adminCookie;
let aCookie;
let bCookie;
let adminId, aId, bId;
let aliceConnectionId = null;

before(async () => {
    server = new TestServer();
    await server.start();
    const boot = await server.bootstrapAdmin('admin-pass-1');
    adminCookie = boot.cookie;

    const meAdmin = await server.api(adminCookie, 'GET', '/api/auth/me');
    adminId = meAdmin.body.user.userId;

    // admin creates users A and B
    const a = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'alice', password: 'alice-pass-1', role: 'user' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    aId = a.body.user.userId;
    const b = await server.api(adminCookie, 'POST', '/api/admin/users', { username: 'bob', password: 'bob-pass-1', role: 'user' });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    bId = b.body.user.userId;

    // new users must change the default password at first login
    const aLogin = await server.login('alice', 'alice-pass-1');
    aCookie = aLogin.cookie;
    const aPw = await server.api(aCookie, 'POST', '/api/auth/change-password', { currentPassword: 'alice-pass-1', newPassword: 'alice-real-pass-1' });
    assert.equal(aPw.status, 200, JSON.stringify(aPw.body));

    const bLogin = await server.login('bob', 'bob-pass-1');
    bCookie = bLogin.cookie;
    const bPw = await server.api(bCookie, 'POST', '/api/auth/change-password', { currentPassword: 'bob-pass-1', newPassword: 'bob-real-pass-1' });
    assert.equal(bPw.status, 200, JSON.stringify(bPw.body));
});

after(async () => {
    await server.cleanup();
});

test('users A and B can log in and get their own identity', async () => {
    const meA = await server.api(aCookie, 'GET', '/api/auth/me');
    assert.equal(meA.status, 200);
    assert.equal(meA.body.user.userId, aId);
    assert.equal(meA.body.user.role, 'user');
    const meB = await server.api(bCookie, 'GET', '/api/auth/me');
    assert.equal(meB.body.user.userId, bId);
});

test('A creates a private connection; B and admin cannot see it in lists', async () => {
    const created = await server.api(aCookie, 'POST', '/api/connections', {
        name: 'alice-box', host: '10.0.0.8', username: 'alice', password: 'topsecret-pw', protocol: 'SSH',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.connection.owner, 'own');
    assert.equal(created.body.connection.password, '******');
    const connId = created.body.connection.id;

    const listB = await server.api(bCookie, 'GET', '/api/connections');
    assert.equal(listB.status, 200);
    assert.ok(!listB.body.connections.some((c) => c.id === connId), "B must not discover A's private connection");

    const listAdmin = await server.api(adminCookie, 'GET', '/api/connections');
    assert.ok(!listAdmin.body.connections.some((c) => c.id === connId), "admin's plain list must not include user-private resources");

    // direct reads collapse to 404 (enumeration safety)
    const getB = await server.api(bCookie, 'PUT', `/api/connections/${connId}`, { name: 'pwned' });
    assert.ok([403, 404].includes(getB.status));
    const delB = await server.api(bCookie, 'DELETE', `/api/connections/${connId}`);
    assert.ok([403, 404].includes(delB.status));

    // reveal requires ownership
    const revealB = await server.api(bCookie, 'POST', `/api/connections/${connId}/open`, { purpose: 'reveal', secret: 'bob-real-pass-1' });
    assert.ok([403, 404].includes(revealB.status), 'B cannot reveal A\'s secrets');

    // test-connect with connectionId is denied for B
    const testB = await server.api(bCookie, 'POST', '/api/connections/test', { connectionId: connId });
    assert.ok([403, 404].includes(testB.status), 'B cannot test-connect to A\'s connection');

    // owner can reveal with their own password
    const revealA = await server.api(aCookie, 'POST', `/api/connections/${connId}/open`, { purpose: 'reveal', secret: 'alice-real-pass-1' });
    assert.equal(revealA.status, 200, JSON.stringify(revealA.body));
    assert.equal(revealA.body.connection.password, 'topsecret-pw', 'owner reveals their own secret');

    aliceConnectionId = connId;
});

test('sharing observer tier grants exactly observe; upgrade and revoke apply immediately', async () => {
    assert.ok(aliceConnectionId, 'previous test must have created Alice connection');
    const connId = aliceConnectionId;
    // share observer → B discovers and views
    const share = await server.api(aCookie, 'PUT', `/api/resources/connection/${connId}/shares`, {
        shares: [{ subjectId: bId, tier: 'observer' }],
    });
    assert.equal(share.status, 200, JSON.stringify(share.body));

    const listB = await server.api(bCookie, 'GET', '/api/connections');
    const shared = listB.body.connections.find((c) => c.id === connId);
    assert.ok(shared, 'B discovers the shared connection');
    assert.equal(shared.owner, 'shared');
    assert.equal(shared.password, '******', 'shared connection never exposes secrets in list payloads');
    assert.ok(shared.capabilities.includes('observe'));
    assert.ok(!shared.capabilities.includes('control'));

    // B still cannot edit/delete/reveal
    const editB = await server.api(bCookie, 'PUT', `/api/connections/${connId}`, { name: 'hacked' });
    assert.ok([403, 404].includes(editB.status));
    const revealB = await server.api(bCookie, 'POST', `/api/connections/${connId}/open`, { purpose: 'reveal', secret: 'bob-real-pass-1' });
    assert.ok([403, 404].includes(revealB.status));

    // upgrade to editor → B can rename
    const up = await server.api(aCookie, 'PUT', `/api/resources/connection/${connId}/shares`, {
        shares: [{ subjectId: bId, tier: 'editor' }],
    });
    assert.equal(up.status, 200);
    const editB2 = await server.api(bCookie, 'PUT', `/api/connections/${connId}`, { name: 'renamed-by-bob' });
    assert.equal(editB2.status, 200, JSON.stringify(editB2.body));
    assert.equal(editB2.body.connection.name, 'renamed-by-bob');

    // revoke → B loses access immediately
    const revoke = await server.api(aCookie, 'DELETE', `/api/resources/connection/${connId}/shares/${bId}`);
    assert.equal(revoke.status, 200);
    const listB2 = await server.api(bCookie, 'GET', '/api/connections');
    assert.ok(!listB2.body.connections.some((c) => c.id === connId), 'revoked share disappears from B\'s list');
    const editB3 = await server.api(bCookie, 'PUT', `/api/connections/${connId}`, { name: 'again' });
    assert.ok([403, 404].includes(editB3.status), 'post-revocation writes are denied');
});

test('non-admin cannot reach admin APIs; suspended users are locked out', async () => {
    const forbidden = await server.api(aCookie, 'GET', '/api/admin/users');
    assert.equal(forbidden.status, 403);

    const createB = await server.api(bCookie, 'POST', '/api/admin/users', { username: 'mallory', password: 'x1234' });
    assert.equal(createB.status, 403);

    // suspend A → her session dies; B is unaffected
    const suspend = await server.api(adminCookie, 'POST', `/api/admin/users/${aId}/suspend`);
    assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
    const meA = await server.api(aCookie, 'GET', '/api/auth/me');
    assert.equal(meA.status, 401, 'suspension revokes live sessions');
    const relogin = await fetch(server.url('/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'alice-real-pass-1' }),
    });
    assert.equal(relogin.status, 403, 'suspended user cannot log in');
    const meB = await server.api(bCookie, 'GET', '/api/auth/me');
    assert.equal(meB.status, 200, 'other users are unaffected by A\'s suspension');

    // reactivate for later tests
    const reactivate = await server.api(adminCookie, 'POST', `/api/admin/users/${aId}/reactivate`);
    assert.equal(reactivate.status, 200);
    const aLogin2 = await server.login('alice', 'alice-real-pass-1');
    aCookie = aLogin2.cookie;
});

test('last-admin protection: cannot demote, suspend or delete the final admin', async () => {
    const demote = await server.api(adminCookie, 'PATCH', `/api/admin/users/${adminId}`, { role: 'user' });
    assert.equal(demote.status, 409);
    const suspend = await server.api(adminCookie, 'POST', `/api/admin/users/${adminId}/suspend`);
    assert.equal(suspend.status, 409);
    const del = await server.api(adminCookie, 'DELETE', `/api/admin/users/${adminId}`);
    assert.ok([400, 409].includes(del.status));
});

test('admin force-password-reset invalidates sessions and requires change', async () => {
    const reset = await server.api(adminCookie, 'POST', `/api/admin/users/${bId}/force-password-reset`, { newPassword: 'bob-temp-pass-9' });
    assert.equal(reset.status, 200);
    const meB = await server.api(bCookie, 'GET', '/api/auth/me');
    assert.equal(meB.status, 401, 'admin reset revokes user sessions');
    const bLogin = await server.login('bob', 'bob-temp-pass-9');
    bCookie = bLogin.cookie;
    const meB2 = await server.api(bCookie, 'GET', '/api/auth/me');
    assert.equal(meB2.body.mustChangePassword, true, 'admin-set password forces change at next login');
    const listB = await server.api(bCookie, 'GET', '/api/connections');
    assert.equal(listB.status, 403, 'must-change-password blocks resource APIs');
    const chg = await server.api(bCookie, 'POST', '/api/auth/change-password', { currentPassword: 'bob-temp-pass-9', newPassword: 'bob-real-pass-2' });
    assert.equal(chg.status, 200);
});

test('user list and audit endpoints respond for admin', async () => {
    const users = await server.api(adminCookie, 'GET', '/api/admin/users');
    assert.equal(users.status, 200);
    assert.ok(users.body.users.length >= 3);
    for (const u of users.body.users) {
        assert.ok(!('passwordHash' in u), 'user list never exposes password hashes');
        assert.ok(!('totpSecret' in u), 'user list never exposes TOTP secrets');
    }
    const audit = await server.api(adminCookie, 'GET', '/api/admin/audit?limit=50');
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.events));
    assert.ok(audit.body.events.some((e) => e.action === 'user.create'));
});
