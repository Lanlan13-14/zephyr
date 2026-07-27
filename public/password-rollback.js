/**
 * /password-rollback — one-time rollback link landing page.
 *
 * The link arrives in the password-change notification email (or is shown
 * in-app when the account has no mailbox). The token in the query string is
 * the only capability: this page just confirms intent and POSTs it.
 * States: confirm → working → done | error (invalid/expired/missing token).
 */

import { t, initI18n } from './i18n/runtime.js?v=20260727-ai-rdp-vision1';

const el = {
    warning: document.getElementById('rollbackWarning'),
    error: document.getElementById('rollbackError'),
    success: document.getElementById('rollbackSuccess'),
    actions: document.getElementById('rollbackActions'),
    confirmBtn: document.getElementById('rollbackConfirmBtn'),
};

const token = new URLSearchParams(location.search).get('token') || '';

function showError(message) {
    el.error.textContent = message;
    el.error.classList.add('show');
    el.success.classList.remove('show');
}

function showInvalid(message) {
    el.warning.style.display = 'none';
    el.confirmBtn.style.display = 'none';
    showError(message);
}

async function main() {
    await initI18n();
    if (!token) {
        showInvalid(t('恢复链接无效、已使用或已过期。如需要，请重新修改密码。'));
        return;
    }
    el.confirmBtn.addEventListener('click', async () => {
        el.error.classList.remove('show');
        el.confirmBtn.disabled = true;
        el.confirmBtn.textContent = t('正在恢复…');
        try {
            const res = await fetch('/api/auth/password-rollback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ token }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || t('恢复失败，请稍后再试'));
            el.warning.style.display = 'none';
            el.confirmBtn.style.display = 'none';
            el.success.textContent = t('密码已恢复：所有会话已退出，请使用之前的密码重新登录。');
            el.success.classList.add('show');
        } catch (err) {
            el.confirmBtn.disabled = false;
            el.confirmBtn.textContent = t('恢复密码');
            showError(err.message || t('恢复失败，请稍后再试'));
        }
    });
}

main();
