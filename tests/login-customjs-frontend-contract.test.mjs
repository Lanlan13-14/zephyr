import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* Source-level contract for the login-page stored-XSS fix. The runtime proof
 * is covered by the API regression test; these assertions pin the frontend
 * behavior so the chain cannot be silently re-assembled:
 *   1. the login page never executes customJs (executeCustomJs: false);
 *   2. the unauthenticated public settings handler does not ship customJs;
 *   3. the personal effective-settings projection strips customJs;
 *   4. plain-admin saves cannot clobber the stored customJs. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('login page never executes admin-authored customJs', () => {
    const client = read('public/client.js');
    const calls = client.match(/applyZephyrColorScheme\([^;]*\);/g) || [];
    assert.ok(calls.length >= 2, 'client.js applyZephyrColorScheme calls disappeared');
    for (const call of calls) {
        assert.match(call, /executeCustomJs:\s*false/, `call without the guard: ${call}`);
    }
});

test('public settings endpoint does not leak customJs', () => {
    const server = read('server.js');
    const route = server.slice(server.indexOf("app.get('/api/public/settings'"), server.indexOf('app.get(\'/api/public/settings\'') + 1600);
    assert.ok(route, 'route not found');
    assert.doesNotMatch(route, /customJs/, 'GET /api/public/settings still ships customJs');
});

test('server keeps customJs writes on the super-admin path only', () => {
    const server = read('server.js');
    assert.match(server, /allowCustomJs:\s*!!req\.user\?\.isSuperAdmin/, 'customJs writes are no longer gated on the super admin');
    assert.match(server, /allowCustomJs:\s*true/, 'PUT /api/settings (super-admin route) lost customJs writes');
});

test('personal effective settings strip customJs', () => {
    const svc = read('user-settings-service.js');
    assert.match(svc, /delete\s+base\.appearance\.customJs/, 'effective() no longer deletes appearance.customJs');
});

test('plain admin appearance saves preserve the stored customJs', () => {
    const app = read('public/app.js');
    const save = app.slice(app.indexOf('async function saveAppearance'), app.indexOf('async function resetAppearance'));
    assert.ok(save, 'saveAppearance not found');
    assert.match(save, /customJs:\s*previous\.customJs/, 'saveAppearance no longer preserves stored customJs for plain admins');
    const reset = app.slice(app.indexOf('async function resetAppearance'), app.indexOf('async function resetAppearance') + 2000);
    assert.match(reset, /customJs:\s*previous\.customJs/, 'resetAppearance no longer preserves stored customJs for plain admins');
});
