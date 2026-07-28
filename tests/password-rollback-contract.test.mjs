import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('storage persists one-time password rollback tokens', () => {
    const storage = read('storage.js');
    assert.match(storage, /CREATE TABLE IF NOT EXISTS password_rollback_tokens \(/);
    for (const col of ['userId TEXT NOT NULL', 'username TEXT NOT NULL', 'tokenHash TEXT NOT NULL', 'oldPasswordHash TEXT NOT NULL', 'expiresAt INTEGER NOT NULL', 'used INTEGER DEFAULT 0', 'createdIp TEXT']) {
        assert.ok(storage.includes(col), `column: ${col}`);
    }
    for (const fn of ['createPasswordRollbackToken', 'findPasswordRollbackTokenByHash', 'markPasswordRollbackTokenUsed', 'invalidatePasswordRollbackTokensForUser']) {
        assert.match(storage, new RegExp(`function ${fn}\\(`), fn);
        assert.match(storage, new RegExp(`\\b${fn}\\b`), `export: ${fn}`);
    }
    /* Issuing a new token invalidates the previous live one for that user. */
    assert.match(storage, /function createPasswordRollbackToken\(rec\) \{\s*if \(rec\?\.username\) invalidatePasswordRollbackTokensForUser\(rec\.username\);/);
});

test('change-password captures pre-change hash, notifies by email, and exposes link only without mailbox', () => {
    const server = read('server.js');
    assert.match(server, /const PASSWORD_ROLLBACK_TTL_MS = 24 \* 60 \* 60 \* 1000;/);
    /* Token is created BEFORE updateUser overwrites the hash. */
    const tokenIdx = server.indexOf('storage.createPasswordRollbackToken({');
    const updateIdx = server.indexOf("storage.updateUser(user.username, { passwordHash: hashPassword(newPassword), defaultPassword: false });");
    assert.ok(tokenIdx > -1 && updateIdx > -1 && tokenIdx < updateIdx, 'rollback token must be created before the password update');
    assert.match(server, /oldPasswordHash: user\.passwordHash,/);
    assert.match(server, /tokenHash: sha256\(rollbackToken\),/);
    assert.match(server, /const rollbackUrl = `\$\{publicOrigin\(req\)\}\/password-rollback\?token=\$\{rollbackToken\}`;/);
    /* Notification email: bilingual (server has no per-user locale), contains link + expiry. */
    assert.match(server, /Zephyr 密码修改通知 \/ Password Change Notification/);
    assert.match(server, /await sendMail\('Zephyr 密码修改通知 \/ Password Change Notification', text, user\.email\);/);
    assert.match(server, /notifiedByEmail = true;/);
    /* Response: link travels by email when notified; in-app otherwise. */
    assert.match(server, /res\.json\(\{\s*ok: true,\s*notifiedByEmail,\s*rollbackExpiresAt,\s*\.\.\.\(notifiedByEmail \? \{\} : \{ rollbackUrl \}\),\s*\}\);/);
});

test('password-rollback API is public, rate-limited, single-use and kills all sessions', () => {
    const server = read('server.js');
    assert.match(server, /app\.post\('\/api\/auth\/password-rollback', async \(req, res\) => \{/);
    const start = server.indexOf("app.post('/api/auth/password-rollback'");
    const body = server.slice(start, start + 4000);
    assert.match(body, /takeRollbackVerifySlot\(ip\)/);
    assert.match(body, /storage\.findPasswordRollbackTokenByHash\(sha256\(token\)\)/);
    assert.match(body, /rec\.expiresAt < Date\.now\(\)/);
    assert.match(body, /storage\.updateUser\(user\.username, \{ passwordHash: rec\.oldPasswordHash, defaultPassword: false \}\)/);
    assert.match(body, /storage\.markPasswordRollbackTokenUsed\(rec\.id\)/);
    /* No exceptSid: a rollback means the change was hostile — every session dies. */
    assert.match(body, /sessionStore\.revokeAllForUser\(user\.userId, 'password-rollback'\)/);
    assert.doesNotMatch(body, /exceptSid/);
    assert.match(body, /Zephyr 密码已恢复 \/ Password Restored/);
    assert.match(server, /const rollbackVerifyHits = new Map\(\);/);
    assert.match(server, /function takeRollbackVerifySlot\(ip\)/);
});

test('rollback landing page is served publicly with no-store', () => {
    const server = read('server.js');
    assert.match(server, /app\.get\('\/password-rollback', \(req, res\) => sendNoStorePage\(res, 'password-rollback\.html'\)\);/);
    assert.match(server, /app\.get\('\/password-rollback\.html', \(req, res\) => sendNoStorePage\(res, 'password-rollback\.html'\)\);/);
    /* Must be reachable while logged out: no requirePageAuth on these routes. */
    assert.doesNotMatch(server, /app\.get\('\/password-rollback', requirePageAuth/);
});

test('rollback landing page markup and client follow i18n and post the token', () => {
    const html = read('public/password-rollback.html');
    assert.match(html, /<title data-i18n="恢复之前的密码 · Zephyr">/);
    assert.match(html, /data-i18n="恢复之前的密码">恢复之前的密码<\/h1>/);
    assert.match(html, /id="rollbackConfirmBtn" data-i18n="恢复密码"/);
    assert.match(html, /href="\/" data-i18n="返回登录"/);
    assert.match(html, /id="rollbackError" role="alert"/);
    assert.match(html, /src="\/password-rollback\.js\?v=20260728-ai-panel-edge-stop1" type="module"/);
    const js = read('public/password-rollback.js');
    assert.match(js, /import \{ t, initI18n \} from '\.\/i18n\/runtime\.js\?v=20260728-ai-panel-edge-stop1';/);
    assert.match(js, /new URLSearchParams\(location\.search\)\.get\('token'\)/);
    assert.match(js, /fetch\('\/api\/auth\/password-rollback'/);
    assert.match(js, /JSON\.stringify\(\{ token \}\)/);
    assert.match(js, /showInvalid\(t\('恢复链接无效、已使用或已过期。如需要，请重新修改密码。'\)\)/);
});

test('settings UI shows the factor policy hint and the post-change notification dialog', () => {
    const html = read('public/app.html');
    assert.match(html, /<p class="field-hint" id="passwordPolicyHint" aria-live="polite"><\/p>/);
    assert.match(html, /<div class="modal-backdrop" id="passwordChangedModal" aria-hidden="true">/);
    assert.match(html, /id="passwordChangedEmailHint" data-i18n="我们已向您的邮箱发送了通知邮件/);
    assert.match(html, /id="passwordChangedLinkBox">/);
    assert.match(html, /id="passwordChangedRollbackUrl" type="text" readonly/);
    assert.match(html, /id="passwordChangedCopyBtn" data-i18n="复制链接"/);
    assert.match(html, /id="passwordChangedOkBtn" data-i18n="我知道了"/);

    const js = read('public/app.js');
    for (const hint of ['当前账号已开启 TOTP 并绑定邮箱：修改密码需要当前密码 + TOTP 动态码 + 邮箱验证码。', '当前账号已开启 TOTP：修改密码需要当前密码 + TOTP 动态码。', '当前账号已绑定邮箱：修改密码需要当前密码 + 邮箱验证码。', '当前账号未开启 TOTP 且未绑定邮箱：仅验证当前密码。建议开启 TOTP 或绑定邮箱以提升安全性。']) {
        assert.ok(js.includes(`t('${hint}')`), hint);
    }
    assert.match(js, /function openPasswordChangedModal\(\{ notifiedByEmail, rollbackUrl, rollbackExpiresAt \} = \{\}\)/);
    assert.match(js, /const result = await api\('\/api\/auth\/change-password'/);
    assert.match(js, /openPasswordChangedModal\(result \|\| \{\}\);/);
    assert.match(js, /function closePasswordChangedModal\(\)/);
    /* The one-time link never lingers in the DOM after the dialog closes. */
    assert.match(js, /\/\* Never keep the one-time link in the DOM once dismissed\. \*\//);
    assert.match(js, /navigator\.clipboard\.writeText\(value\)/);
});

test('forced first-login change also surfaces the link when no mailbox exists', () => {
    const html = read('public/index.html');
    assert.match(html, /<div id="changeRollbackNotice" class="force-hidden">/);
    assert.match(html, /id="changeRollbackUrl" readonly/);
    assert.match(html, /id="changeRollbackCopyBtn" data-i18n="复制链接"/);
    assert.match(html, /id="changeRollbackContinueBtn" data-i18n="进入系统"/);
    const js = read('public/client.js');
    assert.match(js, /const result = await api\('\/api\/auth\/change-password'/);
    assert.match(js, /if \(result\?\.rollbackUrl\) \{/);
    assert.match(js, /\$\('#changeRollbackUrl'\)\.value = result\.rollbackUrl;/);
    assert.match(js, /changePasswordForm\.classList\.add\('force-hidden'\)/);
});

test('both catalogs carry the rollback and notification keys', () => {
    const zh = JSON.parse(read('public/i18n/locales/zh-CN.json'));
    const en = JSON.parse(read('public/i18n/locales/en.json'));
    const keys = [
        '密码已修改', '恢复链接', '复制链接', '我知道了', '链接已复制', '复制失败，请手动复制',
        '恢复密码', '正在恢复…', '恢复失败，请稍后再试', '有效期至：{time}',
        '恢复之前的密码', '恢复之前的密码 · Zephyr',
        '我们已向您的邮箱发送了通知邮件，其中包含一个恢复链接（24 小时内有效，仅可使用一次）。如果本次修改不是您本人操作，请通过邮件中的链接恢复之前的密码。',
        '当前账号未绑定邮箱，无法发送通知邮件。请立即妥善保存以下恢复链接：如果本次修改不是您本人操作，可在 24 小时内通过该链接恢复之前的密码。链接仅可使用一次，关闭本窗口后将无法再次查看。',
        '当前账号已开启 TOTP 并绑定邮箱：修改密码需要当前密码 + TOTP 动态码 + 邮箱验证码。',
        '当前账号已开启 TOTP：修改密码需要当前密码 + TOTP 动态码。',
        '当前账号已绑定邮箱：修改密码需要当前密码 + 邮箱验证码。',
        '当前账号未开启 TOTP 且未绑定邮箱：仅验证当前密码。建议开启 TOTP 或绑定邮箱以提升安全性。',
        '此链接用于在密码被非本人修改后，将账号恢复到修改前的密码。',
        '仅当本次密码修改不是您本人操作时，才应点击恢复。',
        '恢复后所有设备上的会话都会退出，请使用之前的密码重新登录。',
        '恢复链接无效、已使用或已过期。如需要，请重新修改密码。',
        '密码已恢复：所有会话已退出，请使用之前的密码重新登录。',
    ];
    for (const key of keys) {
        assert.ok(key in zh, `zh missing: ${key}`);
        assert.ok(key in en, `en missing: ${key}`);
        assert.ok(String(en[key]).length > 0 && en[key] !== key, `en not translated: ${key}`);
    }
    assert.equal(Object.keys(zh).length, Object.keys(en).length, 'catalog key counts must match');
});
