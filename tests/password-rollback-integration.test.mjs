import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { TestServer } from './test-server.mjs';

/* Full-factor-matrix integration test for change-password + rollback:
 * degraded / TOTP-only / TOTP+email / email-only against the real server,
 * with a stub SMTP endpoint and locally generated TOTP codes. */

let server;
let smtp;
let cookie;
let mailSeq = 0;

function base32Decode(str) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(str).replace(/=+$/, '').toUpperCase();
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
}

function totpToken(secret, offset = 0) {
    const key = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / 30) + offset;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1_000_000;
    return String(code).padStart(6, '0');
}

/* nodemailer ships non-ASCII bodies with Content-Transfer-Encoding (base64 or
 * quoted-printable). Decode the body so tests can match the human-readable
 * templates; headers stay raw (Subject is encoded-word, we assert on body). */
function decodeMail(raw) {
    const splitAt = raw.indexOf('\n\n');
    if (splitAt < 0) return raw;
    const headers = raw.slice(0, splitAt);
    const body = raw.slice(splitAt + 2);
    const cte = (headers.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1] || '';
    if (cte.toLowerCase() === 'base64') {
        return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (cte.toLowerCase() === 'quoted-printable') {
        const folded = body.replace(/=\n/g, '');
        const bytes = [];
        for (let i = 0; i < folded.length; i++) {
            const ch = folded[i];
            if (ch === '=' && /[0-9A-Fa-f]{2}/.test(folded.slice(i + 1, i + 3))) {
                bytes.push(parseInt(folded.slice(i + 1, i + 3), 16));
                i += 2;
            } else {
                bytes.push(...Buffer.from(ch, 'utf8'));
            }
        }
        return Buffer.from(bytes).toString('utf8');
    }
    return body;
}

class SmtpStub {
    constructor() {
        this.messages = [];
        this.server = net.createServer((sock) => this.handle(sock));
    }
    async start() {
        await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
        this.port = this.server.address().port;
    }
    handle(sock) {
        let buffer = '';
        let inData = false;
        let data = '';
        sock.write('220 stub.local ESMTP\r\n');
        sock.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\r\n')) >= 0) {
                let line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                if (inData) {
                    if (line === '.') {
                        inData = false;
                        this.messages.push(data);
                        sock.write('250 2.0.0 Ok\r\n');
                    } else {
                        if (line.startsWith('..')) line = line.slice(1);
                        data += line + '\n';
                    }
                    continue;
                }
                const cmd = line.slice(0, 4).toUpperCase();
                if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-stub.local\r\n250 8BITMIME\r\n');
                else if (cmd === 'MAIL') sock.write('250 2.1.0 Ok\r\n');
                else if (cmd === 'RCPT') sock.write('250 2.1.5 Ok\r\n');
                else if (cmd === 'DATA') { inData = true; data = ''; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
                else if (cmd === 'RSET') sock.write('250 2.0.0 Ok\r\n');
                else if (cmd === 'NOOP') sock.write('250 2.0.0 Ok\r\n');
                else if (cmd === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
                else sock.write('250 2.0.0 Ok\r\n');
            }
        });
    }
    async waitForMessage(count, timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        while (this.messages.length < count && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(this.messages.length >= count, `expected ${count} mails, got ${this.messages.length}`);
        return decodeMail(this.messages[this.messages.length - 1]);
    }
    async close() { await new Promise((r) => this.server.close(r)); }
}

async function rawLogin(username, password) {
    const res = await fetch(server.url('/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    const m = (res.headers.get('set-cookie') || '').match(/zephyr_sid=([^;]+)/);
    return { status: res.status, body, cookie: m ? `zephyr_sid=${m[1]}` : null };
}

async function loginFull(username, password, totpSecret = '') {
    const first = await rawLogin(username, password);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    if (first.body.requireTotp) {
        assert.ok(totpSecret, 'login requires TOTP but no secret given');
        const res = await fetch(server.url('/api/auth/totp/verify'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tempToken: first.body.tempToken, code: totpToken(totpSecret) }),
        });
        const body = await res.json().catch(() => ({}));
        assert.equal(res.status, 200, JSON.stringify(body));
        const m = (res.headers.get('set-cookie') || '').match(/zephyr_sid=([^;]+)/);
        assert.ok(m, 'no session cookie after totp verify');
        return `zephyr_sid=${m[1]}`;
    }
    assert.ok(first.cookie, 'no session cookie issued');
    return first.cookie;
}

function extractCode(mailText) {
    const m = mailText.match(/验证码：([A-Za-z0-9_-]+)/);
    assert.ok(m, 'mail did not contain a verification code');
    return m[1];
}

function extractRollbackUrl(mailText) {
    const m = mailText.match(/\/password-rollback\?token=([A-Za-z0-9_-]+)/);
    assert.ok(m, 'mail did not contain a rollback link');
    return m[0];
}

async function changePassword(payload) {
    return server.api(cookie, 'POST', '/api/auth/change-password', payload);
}

async function rollback(token) {
    return server.api(null, 'POST', '/api/auth/password-rollback', { token });
}

before(async () => {
    smtp = new SmtpStub();
    await smtp.start();
    server = new TestServer();
    await server.start();
    cookie = await loginFull('admin', 'admin');
});

after(async () => {
    await server.cleanup();
    await smtp.close();
});

test('degraded (no TOTP, no email): current password only, link returned in-app, rollback restores and kills sessions', async () => {
    const res = await changePassword({ currentPassword: 'admin', newPassword: 'pw-degraded-1' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.notifiedByEmail, false);
    assert.ok(res.body.rollbackUrl, 'no-email account must receive the rollback link in-app');
    assert.ok(res.body.rollbackExpiresAt > Date.now());
    const token = new URL(res.body.rollbackUrl).searchParams.get('token');
    assert.ok(token);

    /* Wrong current password is still rejected. */
    const bad = await changePassword({ currentPassword: 'nope', newPassword: 'pw-x' });
    assert.equal(bad.status, 400);

    const rb = await rollback(token);
    assert.equal(rb.status, 200, JSON.stringify(rb.body));

    /* Every session is dead, including the one that changed the password. */
    const me = await server.api(cookie, 'GET', '/api/auth/me');
    assert.equal(me.status, 401);

    /* Previous password works again, the hostile one does not. */
    const fail = await rawLogin('admin', 'pw-degraded-1');
    assert.equal(fail.status, 401);
    cookie = await loginFull('admin', 'admin');

    /* Token is single-use. */
    const reuse = await rollback(token);
    assert.equal(reuse.status, 400);
});

test('TOTP-only: code required and sufficient, notification falls back to in-app link', async () => {
    const setup = await server.api(cookie, 'POST', '/api/security/totp/setup', {});
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const secret = setup.body.secret;
    assert.ok(secret);
    let enable = await server.api(cookie, 'POST', '/api/security/totp/enable', { code: totpToken(secret) });
    if (enable.status !== 200) enable = await server.api(cookie, 'POST', '/api/security/totp/enable', { code: totpToken(secret, 1) });
    assert.equal(enable.status, 200, JSON.stringify(enable.body));

    const missing = await changePassword({ currentPassword: 'admin', newPassword: 'pw-totp-1' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'totp_required');
    const wrong = await changePassword({ currentPassword: 'admin', newPassword: 'pw-totp-1', totpCode: '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'totp_invalid');

    const ok = await changePassword({ currentPassword: 'admin', newPassword: 'pw-totp-1', totpCode: totpToken(secret) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.notifiedByEmail, false);
    assert.ok(ok.body.rollbackUrl, 'TOTP without email still needs the in-app link');

    const token = new URL(ok.body.rollbackUrl).searchParams.get('token');
    const rb = await rollback(token);
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    cookie = await loginFull('admin', 'admin', secret);
    globalThis.__totpSecret = secret;
});

test('TOTP + email: both factors required, notification email carries the rollback link', async () => {
    const secret = globalThis.__totpSecret;
    const profile = await server.api(cookie, 'PUT', '/api/security/profile', { username: 'admin', email: 'admin@test.local' });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));

    const mailCfg = await server.api(cookie, 'PUT', '/api/settings/mail', {
        mail: {
            enabled: true, host: '127.0.0.1', port: smtp.port, secure: false,
            user: '', pass: '', from: 'zephyr@test.local', adminEmail: '',
            notifyLoginSuccess: false, notifyLoginFailure: false, notifyLoginToUser: false, geoLookupEnabled: false,
        },
    });
    assert.equal(mailCfg.status, 200, JSON.stringify(mailCfg.body));

    const totpOnly = await changePassword({ currentPassword: 'admin', newPassword: 'pw-both-1', totpCode: totpToken(secret) });
    assert.equal(totpOnly.status, 400);
    assert.equal(totpOnly.body.code, 'email_code_required');

    mailSeq = smtp.messages.length;
    const req = await server.api(cookie, 'POST', '/api/auth/change-password/request-code', {});
    assert.equal(req.status, 200, JSON.stringify(req.body));
    const codeMail = await smtp.waitForMessage(mailSeq + 1);
    const emailCode = extractCode(codeMail);

    const emailOnly = await changePassword({ currentPassword: 'admin', newPassword: 'pw-both-1', emailCode });
    assert.equal(emailOnly.status, 400);
    assert.equal(emailOnly.body.code, 'totp_required');

    mailSeq = smtp.messages.length;
    const ok = await changePassword({ currentPassword: 'admin', newPassword: 'pw-both-1', totpCode: totpToken(secret), emailCode });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.notifiedByEmail, true);
    assert.equal(ok.body.rollbackUrl, undefined, 'link must travel by email only');

    const notify = await smtp.waitForMessage(mailSeq + 1);
    assert.match(notify, /您的 Zephyr 账号密码刚刚被修改。/);
    assert.match(notify, /Your Zephyr account password was just changed\./);
    assert.match(notify, /链接有效期至/);
    assert.match(notify, /Link valid until/);
    assert.match(notify, /IP 地址/);
    const url = extractRollbackUrl(notify);
    const token = new URL(`http://x${url}`).searchParams.get('token');

    const rb = await rollback(token);
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    cookie = await loginFull('admin', 'admin', secret);
});

test('email-only (TOTP disabled): email code required, code single-use', async () => {
    const secret = globalThis.__totpSecret;
    const disable = await server.api(cookie, 'POST', '/api/security/totp/disable', { currentPassword: 'admin', code: totpToken(secret) });
    assert.equal(disable.status, 200, JSON.stringify(disable.body));

    const missing = await changePassword({ currentPassword: 'admin', newPassword: 'pw-mail-1' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'email_code_required');

    mailSeq = smtp.messages.length;
    await server.api(cookie, 'POST', '/api/auth/change-password/request-code', {});
    const codeMail = await smtp.waitForMessage(mailSeq + 1);
    const emailCode = extractCode(codeMail);

    const wrong = await changePassword({ currentPassword: 'admin', newPassword: 'pw-mail-1', emailCode: 'wrong-code' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'email_code_invalid');

    const ok = await changePassword({ currentPassword: 'admin', newPassword: 'pw-mail-1', emailCode });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.notifiedByEmail, true);

    /* The used code must not authorise a second change. */
    const reuse = await changePassword({ currentPassword: 'pw-mail-1', newPassword: 'pw-mail-2', emailCode });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.code, 'email_code_invalid');

    /* Clean up: roll back so later flows start from 'admin' again. The change
     * above already awaited its notification mail, so read the last capture. */
    const notify = decodeMail(smtp.messages[smtp.messages.length - 1]);
    const token = new URL(`http://x${extractRollbackUrl(notify)}`).searchParams.get('token');
    const rb = await rollback(token);
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    cookie = await loginFull('admin', 'admin');
});

test('rollback landing page is served publicly', async () => {
    const res = await fetch(server.url('/password-rollback?token=abc'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    const html = await res.text();
    assert.match(html, /password-rollback\.js/);
    assert.match(html, /data-i18n="恢复之前的密码"/);
});

test('rollback endpoint is rate-limited per IP', async () => {
    const isolated = new TestServer();
    await isolated.start();
    try {
        for (let i = 0; i < 10; i++) {
            const r = await isolated.api(null, 'POST', '/api/auth/password-rollback', { token: `bad-${i}` });
            assert.equal(r.status, 400, `attempt ${i + 1}`);
        }
        const blocked = await isolated.api(null, 'POST', '/api/auth/password-rollback', { token: 'bad-final' });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.body.code, 'rollback_rate_limited');
    } finally {
        await isolated.cleanup();
    }
});
