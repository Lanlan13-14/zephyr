import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
    flatten,
    unflatten,
    deepMerge,
    USER_ALLOWED_KEYS,
    UserSettingsService,
} = require(path.join(root, 'user-settings-service.js'));

test('notes.enabled is an allowed personal key and flattens both shapes', () => {
    assert.equal(USER_ALLOWED_KEYS.has('notes.enabled'), true);
    assert.deepEqual(flatten({ 'notes.enabled': true }), { 'notes.enabled': true });
    assert.deepEqual(flatten({ notes: { enabled: true } }), { 'notes.enabled': true });
    assert.deepEqual(unflatten({ 'notes.enabled': true }), { notes: { enabled: true } });
});

test('personal notes.enabled overrides platform default false', () => {
    const base = { notes: { enabled: false }, appearance: { theme: 'dark' } };
    const overrides = unflatten({ 'notes.enabled': true });
    const merged = deepMerge(base, overrides);
    assert.equal(merged.notes.enabled, true);
    assert.equal(merged.appearance.theme, 'dark');
});

test('UserSettingsService persists notes.enabled across re-read (admin-style dual write scenario)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-notes-settings-'));
    process.env.ZEPHYR_DATA_DIR = dataDir;
    // Re-require storage against a fresh data dir so init creates a clean sqlite file.
    delete require.cache[require.resolve(path.join(root, 'storage.js'))];
    delete require.cache[require.resolve(path.join(root, 'secret-crypto.js'))];
    const storage = require(path.join(root, 'storage.js'));
    storage.init({ hashPassword: (p) => `hash:${p}` });

    const userId = 'user-admin-1';
    const svc = new UserSettingsService(storage.rawDb(), storage);

    // Platform default remains off / missing.
    storage.updateSettings({ notes: { enabled: false } });
    assert.equal(!!storage.getSettings().notes?.enabled, false);

    // Personal opt-in (what saveNotesSettings must write for every role).
    svc.putUserOverrides(userId, { notes: { enabled: true } });
    const effective1 = svc.effective({ userId, role: 'admin', isSuperAdmin: true });
    assert.equal(effective1.notes.enabled, true);

    // Re-read from a fresh service instance (simulates page reload / new request).
    const svc2 = new UserSettingsService(storage.rawDb(), storage);
    const effective2 = svc2.effective({ userId, role: 'admin', isSuperAdmin: true });
    assert.equal(effective2.notes.enabled, true);
    assert.equal(svc2.getUserOverrides(userId).notes.enabled, true);

    // Superadmin client merge must keep personal notes over admin payload.
    const admin = storage.getSettings();
    const personal = effective2;
    const clientMerged = {
        ...admin,
        ...personal,
        notes: { ...(admin.notes || {}), ...(personal.notes || {}) },
    };
    assert.equal(clientMerged.notes.enabled, true);

    // Turning off personally still wins over a platform default that is on.
    storage.updateSettings({ notes: { enabled: true } });
    svc2.putUserOverrides(userId, { notes: { enabled: false } });
    assert.equal(svc2.effective({ userId }).notes.enabled, false);

    storage.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('frontend saveNotesSettings always writes personal notes override', () => {
    const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
    const fnStart = appSrc.indexOf('async function saveNotesSettings');
    assert.ok(fnStart > 0, 'saveNotesSettings must exist');
    const fnEnd = appSrc.indexOf('\nasync function ', fnStart + 1);
    const body = appSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1200);
    assert.match(body, /savePersonalSettings\(\{\s*notes:\s*\{\s*enabled\s*\}\s*\}\)/);
    assert.doesNotMatch(body, /if \(myIdentity\.role === 'admin'\) \{\s*settings = await savePlatformSettings\('notes'/);
    // Superadmin loadSettings must explicitly re-merge personal notes over platform defaults.
    assert.match(appSrc, /notes:\s*\{\s*\.\.\.\(admin\.notes \|\| \{\}\),\s*\.\.\.\(settings\.notes \|\| \{\}\)\s*\}/);
});
