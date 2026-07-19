import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

let server;
let superCookie;
let userACookie;
let userBCookie;
let regularAdminCookie;
let superId;
let userAId;
let regularAdminId;

before(async () => {
  server = new TestServer();
  await server.start();
  const boot = await server.bootstrapAdmin('super-pass-1');
  superCookie = boot.cookie;
  const me = await server.api(superCookie, 'GET', '/api/auth/me');
  superId = me.body.user.userId;

  const a = await server.api(superCookie, 'POST', '/api/admin/users', { username: 'roleA', password: 'roleA-pass-1', role: 'user' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  userAId = a.body.user.userId;
  const b = await server.api(superCookie, 'POST', '/api/admin/users', { username: 'roleB', password: 'roleB-pass-1', role: 'user' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const ra = await server.api(superCookie, 'POST', '/api/admin/users', { username: 'roleAdmin', password: 'roleAdmin-pass-1', role: 'admin' });
  assert.equal(ra.status, 200, JSON.stringify(ra.body));
  regularAdminId = ra.body.user.userId;

  const la = await server.login('roleA', 'roleA-pass-1');
  await server.api(la.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'roleA-pass-1', newPassword: 'roleA-real-1' });
  userACookie = la.cookie;
  const lb = await server.login('roleB', 'roleB-pass-1');
  await server.api(lb.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'roleB-pass-1', newPassword: 'roleB-real-1' });
  userBCookie = lb.cookie;
  const lra = await server.login('roleAdmin', 'roleAdmin-pass-1');
  await server.api(lra.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'roleAdmin-pass-1', newPassword: 'roleAdmin-real-1' });
  regularAdminCookie = lra.cookie;
});

after(async () => { await server?.cleanup(); });

test('super/admin roles bind to immutable userId and survive username rename', async () => {
  const beforeMe = await server.api(superCookie, 'GET', '/api/auth/me');
  assert.equal(beforeMe.body.user.isSuperAdmin, true);
  assert.equal(beforeMe.body.user.role, 'admin');
  const rename = await server.api(superCookie, 'PUT', '/api/security/profile', { username: 'renamedSuper', email: '' });
  assert.equal(rename.status, 200, JSON.stringify(rename.body));
  const afterMe = await server.api(superCookie, 'GET', '/api/auth/me');
  assert.equal(afterMe.body.user.userId, superId);
  assert.equal(afterMe.body.user.isSuperAdmin, true);
  assert.equal(afterMe.body.user.role, 'admin');
});

test('regular admin cannot promote another admin or transfer super admin', async () => {
  const promote = await server.api(regularAdminCookie, 'PATCH', `/api/admin/users/${userAId}`, { role: 'admin' });
  assert.equal(promote.status, 403, JSON.stringify(promote.body));
  assert.equal(promote.body.code, 'super_admin_required');
  const transfer = await server.api(regularAdminCookie, 'POST', `/api/admin/users/${userAId}/transfer-super-admin`);
  assert.equal(transfer.status, 403, JSON.stringify(transfer.body));
});

test('super admin can transfer only to another existing admin', async () => {
  const toUser = await server.api(superCookie, 'POST', `/api/admin/users/${userAId}/transfer-super-admin`);
  assert.equal(toUser.status, 400, JSON.stringify(toUser.body));
  assert.equal(toUser.body.code, 'target_must_be_active_admin');
  const promote = await server.api(superCookie, 'PATCH', `/api/admin/users/${userAId}`, { role: 'admin' });
  assert.equal(promote.status, 200, JSON.stringify(promote.body));
  const transfer = await server.api(superCookie, 'POST', `/api/admin/users/${userAId}/transfer-super-admin`);
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  const oldMe = await server.api(superCookie, 'GET', '/api/auth/me');
  assert.equal(oldMe.body.user.isSuperAdmin, false);
  assert.equal(oldMe.body.user.role, 'admin');
  const newLogin = await server.login('roleA', 'roleA-real-1');
  userACookie = newLogin.cookie;
  const newMe = await server.api(newLogin.cookie, 'GET', '/api/auth/me');
  assert.equal(newMe.body.user.isSuperAdmin, true);
});

test('notes enabled is isolated per user', async () => {
  await server.api(userACookie, 'PUT', '/api/me/settings', { 'notes.enabled': true });
  await server.api(userBCookie, 'PUT', '/api/me/settings', { 'notes.enabled': false });
  const a = await server.api(userACookie, 'GET', '/api/me/settings');
  const b = await server.api(userBCookie, 'GET', '/api/me/settings');
  assert.equal(a.body.settings.notes.enabled, true);
  assert.equal(b.body.settings.notes.enabled, false);
});

test('connection share users/admins is persisted and filters lists', async () => {
  const own = await server.api(userACookie, 'POST', '/api/connections', { name: 'shared-box', host: '10.0.0.55', port: 22, protocol: 'SSH', username: 'u', shareWithUsers: true, shareWithAdmins: true });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.connection.shareWithUsers, true);
  assert.equal(own.body.connection.shareWithAdmins, true);
  const bList = await server.api(userBCookie, 'GET', '/api/connections');
  assert.ok(bList.body.connections.some((c) => c.id === own.body.connection.id && c.owner === 'shared'));
  const adminList = await server.api(regularAdminCookie, 'GET', '/api/connections');
  assert.ok(adminList.body.connections.some((c) => c.id === own.body.connection.id));
});

test('notes can share with users and admins independently', async () => {
  await server.api(userACookie, 'PUT', '/api/me/settings', { 'notes.enabled': true });
  const n1 = await server.api(userACookie, 'POST', '/api/notes', { title: 'users note', content: 'u', shareWithUsers: true, shareWithAdmins: false });
  const n2 = await server.api(userACookie, 'POST', '/api/notes', { title: 'admins note', content: 'a', shareWithUsers: false, shareWithAdmins: true });
  assert.equal(n1.status, 200);
  assert.equal(n2.status, 200);
  const bList = await server.api(userBCookie, 'GET', '/api/notes');
  assert.ok(bList.body.notes.some((n) => n.noteId === n1.body.note.noteId));
  assert.ok(!bList.body.notes.some((n) => n.noteId === n2.body.note.noteId));
  const adminList = await server.api(regularAdminCookie, 'GET', '/api/notes');
  assert.ok(adminList.body.notes.some((n) => n.noteId === n1.body.note.noteId));
  assert.ok(adminList.body.notes.some((n) => n.noteId === n2.body.note.noteId));
});
