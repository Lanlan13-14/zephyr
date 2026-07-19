import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';
let s, superCookie, adminCookie, userACookie, userBCookie;
let superId, adminId, userAId, userBId, providerId;

before(async () => {
  s = new TestServer(); await s.start();
  const boot = await s.bootstrapAdmin('super-pass-1'); superCookie = boot.cookie;
  superId = (await s.api(superCookie, 'GET', '/api/auth/me')).body.user.userId;
  const mk = async (username, password, role = 'user') => {
    const r = await s.api(superCookie, 'POST', '/api/admin/users', { username, password, role });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const login = await s.login(username, password);
    await s.api(login.cookie, 'POST', '/api/auth/change-password', { currentPassword: password, newPassword: `${password}-real` });
    return { id: r.body.user.userId, cookie: login.cookie };
  };
  ({ id: adminId, cookie: adminCookie } = await mk('shareAdmin', 'admin-pass', 'admin'));
  ({ id: userAId, cookie: userACookie } = await mk('shareUserA', 'usera-pass'));
  ({ id: userBId, cookie: userBCookie } = await mk('shareUserB', 'userb-pass'));
});
after(async () => { await s?.cleanup(); });

test('owner creates private provider; key never leaks', async () => {
  const r = await s.api(userACookie, 'POST', '/api/ai/providers', {
    name: 'UserA Provider', type: 'openai_compatible', baseUrl: 'https://example.invalid/v1',
    apiKey: 'PRIVATE-AI-KEY', defaultModel: 'model-a', modelWhitelist: ['model-a']
  });
  assert.equal(r.status, 200, JSON.stringify(r.body)); providerId = r.body.provider.id;
  assert.equal(r.body.provider.ownerUserId, userAId); assert.equal(r.body.provider.apiKey, undefined);
  assert.equal(r.body.provider.hasApiKey, true);
  for (const cookie of [superCookie, adminCookie, userBCookie]) {
    const list = await s.api(cookie, 'GET', '/api/ai/providers');
    assert.ok(!(list.body.providers || []).some((p) => p.id === providerId));
    assert.ok(!JSON.stringify(list.body).includes('PRIVATE-AI-KEY'));
  }
});

test('owner shares to all admins only', async () => {
  const r = await s.api(userACookie, 'PUT', `/api/ai/providers/${providerId}/shares`, { shareWithAdmins: true, shareWithUsers: false, sharedUserIds: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const cookie of [superCookie, adminCookie]) {
    const list = await s.api(cookie, 'GET', '/api/ai/providers');
    assert.ok(list.body.providers.some((p) => p.id === providerId));
  }
  const b = await s.api(userBCookie, 'GET', '/api/ai/providers');
  assert.ok(!b.body.providers.some((p) => p.id === providerId));
});

test('owner can share with one or multiple specified users', async () => {
  await s.api(userACookie, 'PUT', `/api/ai/providers/${providerId}/shares`, { shareWithAdmins: false, shareWithUsers: false, sharedUserIds: [userBId] });
  const b = await s.api(userBCookie, 'GET', '/api/ai/providers');
  assert.ok(b.body.providers.some((p) => p.id === providerId));
  const admin = await s.api(adminCookie, 'GET', '/api/ai/providers');
  assert.ok(!admin.body.providers.some((p) => p.id === providerId));
  const targetList = await s.api(userACookie, 'GET', '/api/ai/share-targets');
  assert.ok(targetList.body.users.some((u) => u.userId === userBId));
});

test('shared users cannot edit, delete, reshare or reveal key', async () => {
  for (const [method, path, body] of [
    ['PATCH', `/api/ai/providers/${providerId}`, { name: 'hijacked' }],
    ['DELETE', `/api/ai/providers/${providerId}`, undefined],
    ['PUT', `/api/ai/providers/${providerId}/shares`, { shareWithUsers: true }],
    ['POST', `/api/ai/providers/${providerId}/open`, { secret: 'userb-pass-real' }],
  ]) {
    const r = await s.api(userBCookie, method, path, body);
    assert.ok([403, 404].includes(r.status), `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('shareWithUsers exposes provider to all authenticated users', async () => {
  await s.api(userACookie, 'PUT', `/api/ai/providers/${providerId}/shares`, { shareWithAdmins: false, shareWithUsers: true, sharedUserIds: [] });
  for (const cookie of [superCookie, adminCookie, userBCookie]) {
    const list = await s.api(cookie, 'GET', '/api/ai/providers');
    assert.ok(list.body.providers.some((p) => p.id === providerId));
    assert.ok(!JSON.stringify(list.body).includes('PRIVATE-AI-KEY'));
  }
});
