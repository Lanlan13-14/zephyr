import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('forgot-password page has a complete accessible reset flow', () => {
    const html = read('public/index.html');
    assert.match(html, /<form id="forgotRequestForm"[^>]*>/);
    assert.match(html, /<label for="forgotEmail" data-i18n="管理员邮箱">/);
    assert.match(html, /<form id="forgotResetForm" class="force-hidden">/);
    assert.match(html, /<label for="resetCode" data-i18n="重置令牌">/);
    assert.match(html, /id="resetCode" autocomplete="one-time-code"/);
    assert.match(html, /<label for="resetPassword" data-i18n="新密码">/);
    assert.match(html, /id="resetPassword" minlength="4" autocomplete="new-password"/);
    assert.match(html, /id="backLoginLink"/);
});

test('forgot-password client submits the exact backend payload and handles both states', () => {
    const js = read('public/client.js');
    assert.match(js, /\/api\/auth\/forgot-password\/request/);
    assert.match(js, /\/api\/auth\/forgot-password\/reset/);
    assert.match(js, /JSON\.stringify\(\{ email: \$\('#forgotEmail'\)\.value, code: \$\('#resetCode'\)\.value, newPassword: \$\('#resetPassword'\)\.value \}\)/);
    assert.match(js, /forgotRequestForm\.classList\.add\('force-hidden'\)/);
    assert.match(js, /forgotResetForm\.classList\.remove\('force-hidden'\)/);
    assert.match(js, /showLogin\(\); showError\(errorBanner, t\('密码已重置，请重新登录'\)\)/);
});

test('password-change settings UI sends current password and required second-factor codes', () => {
    const html = read('public/app.html');
    const js = read('public/app.js');
    assert.match(html, /id="passwordForm"/);
    assert.match(html, /id="settingsCurrentPassword"/);
    assert.match(html, /id="settingsNewPassword"/);
    assert.match(html, /id="settingsConfirmPassword"/);
    assert.match(html, /id="settingsTotpCode"/);
    assert.match(html, /id="settingsEmailCode"/);
    assert.match(html, /id="settingsSendCodeBtn"/);
    assert.match(js, /\/api\/auth\/change-password\/request-code/);
    assert.match(js, /JSON\.stringify\(\{ currentPassword, newPassword, totpCode, emailCode \}\)/);
    assert.match(js, /updatePasswordFormFields\(\);/);
});

test('admin reset action points to the implemented force-password-reset backend route', () => {
    const js = read('public/app.js');
    const server = read('server.js');
    assert.match(js, /data-admin-action="reset-pw"/);
    assert.match(js, /\/api\/admin\/users\/\$\{userId\}\/force-password-reset/);
    assert.match(server, /app\.post\('\/api\/admin\/users\/:userId\/force-password-reset', requireAdmin/);
});
