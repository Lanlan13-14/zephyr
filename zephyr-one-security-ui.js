/*
 * zephyr-one-security-ui.js - Zephyr One's security panel and reveal gate.
 *
 * Zephyr One only. Injected into app.html by zephyr-one-embed-surface.js and
 * served by the core at /zephyr-one-security-ui.js in embedded mode.
 *
 * Two halves, both of which have to exist for either to be honest:
 *
 * 1. THE PANEL. `zephyr-one-embed-surface.js` replaces the browser-era Security
 *    panel body with one switch (#oneRevealRequiresUnlock). This file gives it
 *    behaviour: read the current policy, show what this platform's authenticator
 *    can actually do, and refuse to arm a gate the platform cannot satisfy.
 *
 * 2. THE GATE. It installs `window.__zephyrOneUnlock`, which `app.js`
 *    `requestSensitiveSecret()` calls instead of prompting for a password. When
 *    the switch is off it returns '' - no challenge, because the user asked for
 *    none. When on it runs a real OS unlock and returns the resulting grant.
 *
 * Why the OS authenticator instead of the account password:
 *   One's local account is auto-adopted by the shell and its password is a
 *   generated value the user never chose. Prompting for it protects nothing and
 *   teaches the user to type a meaningless secret. Windows Hello / Touch ID /
 *   the device PIN is a credential the user actually holds.
 *
 * Why a polled handoff instead of a Tauri invoke:
 *   The WebView is on the loopback core's origin, which Tauri treats as remote,
 *   so this page cannot invoke a command. Granting IPC to a loopback origin
 *   would hand it to any process that can bind a local port. Same shape as the
 *   RDP folder picker: file a request, the shell claims it and runs the prompt.
 */
'use strict';

(function () {
    var POLL_MS = 250;
    /* The OS prompt is modal and a human has to react to it. Long enough for a
     * fingerprint retry, short enough that an abandoned prompt does not leave
     * the page spinning forever. Matches UNLOCK_TTL_MS server-side. */
    var POLL_TIMEOUT_MS = 90000;

    function $(sel) { return document.querySelector(sel); }

    function api(path, options) {
        var opts = options || {};
        return fetch(path, {
            method: opts.method || 'GET',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: opts.body
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) {
                    var err = new Error(data && data.error ? data.error : 'HTTP ' + res.status);
                    err.code = data && data.code ? data.code : '';
                    throw err;
                }
                return data;
            });
        });
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /* ---------------------------------------------------------------- unlock */

    /**
     * Run one system unlock end to end and return the grant.
     *
     * Rejects on cancel, failure, unavailability and timeout. Every caller in
     * app.js is inside a try/catch that toasts the message, so a rejection is
     * reported to the user rather than swallowed.
     */
    async function runSystemUnlock(reason) {
        var filed = await api('/api/one/security/unlock', {
            method: 'POST',
            body: JSON.stringify({ reason: reason || '' })
        });
        var id = filed && filed.id;
        if (!id) throw new Error('\u65e0\u6cd5\u53d1\u8d77\u7cfb\u7edf\u89e3\u9501');

        var deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(POLL_MS);
            var polled = await api('/api/one/security/unlock/' + encodeURIComponent(id));
            if (polled.status === 'unknown') {
                /* The request expired or was already consumed. Reported as its
                 * own message rather than as a generic failure: retrying is the
                 * right action here, unlike a refusal. */
                throw new Error('\u7cfb\u7edf\u89e3\u9501\u8bf7\u6c42\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u8bd5');
            }
            if (polled.status !== 'done') continue;
            if (!polled.unlocked) throw new Error(polled.error || '\u7cfb\u7edf\u89e3\u9501\u5931\u8d25\u6216\u5df2\u53d6\u6d88');
            return polled.grant;
        }
        throw new Error('\u7cfb\u7edf\u89e3\u9501\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5');
    }

    /**
     * What app.js calls in place of the password prompt.
     *
     * Returns '' when the switch is off. That empty string is not a bypass: the
     * server reads its own copy of the policy, so a page that lies about the
     * switch being off still gets a 403 from the reveal route.
     */
    async function acquire(actionText) {
        var policy = await api('/api/one/security/policy');
        if (!policy.revealRequiresUnlock) return '';
        return runSystemUnlock(actionText || '\u67e5\u770b\u5df2\u4fdd\u5b58\u7684\u5bc6\u7801\u6216\u5bc6\u94a5');
    }

    window.__zephyrOneUnlock = { acquire: acquire, runSystemUnlock: runSystemUnlock };

    /* ----------------------------------------------------------------- panel */

    function describe(nativeUnlock) {
        var caps = nativeUnlock || {};
        if (!caps.known) return '\u6b63\u5728\u68c0\u6d4b\u7cfb\u7edf\u89e3\u9501\u80fd\u529b\u2026';
        if (caps.available) {
            return caps.reason
                ? '\u53ef\u7528\uff1a' + caps.reason
                : '\u7cfb\u7edf\u89e3\u9501\u53ef\u7528';
        }
        return '\u4e0d\u53ef\u7528\uff1a' + (caps.reason || '\u672c\u5e73\u53f0\u6ca1\u6709\u7cfb\u7edf\u89e3\u9501');
    }

    function paint(policy) {
        var toggle = $('#oneRevealRequiresUnlock');
        var hint = $('#oneSecurityUnlockHint');
        var status = $('#oneSecurityStatus');
        var caps = (policy && policy.nativeUnlock) || {};

        if (toggle) {
            toggle.checked = !!(policy && policy.revealRequiresUnlock);
            /* Disabled only when the shell has *told* us the platform has no
             * authenticator. While capabilities are still unknown the control
             * stays live: the arm path verifies before saving anyway, so a slow
             * shell must not look like an unsupported platform. */
            toggle.disabled = caps.known === true && caps.available !== true;
        }
        if (hint) {
            hint.textContent = '\u5f00\u542f\u540e\uff0c\u67e5\u770b\u5df2\u4fdd\u5b58\u7684\u8fde\u63a5\u5bc6\u7801\u3001SSH \u79c1\u94a5\u7b49\u654f\u611f\u4fe1\u606f\u524d\u9700\u5148\u901a\u8fc7\u7cfb\u7edf\u89e3\u9501\uff08Windows Hello / Touch ID / \u8bbe\u5907 PIN\uff09\u3002\u5173\u95ed\u65f6\u4e0d\u4f1a\u505a\u4efb\u4f55\u9a8c\u8bc1\u3002';
        }
        if (status) status.textContent = describe(caps);
    }

    async function refresh() {
        try {
            paint(await api('/api/one/security/policy'));
        } catch (err) {
            var status = $('#oneSecurityStatus');
            if (status) status.textContent = '\u65e0\u6cd5\u8bfb\u53d6\u5b89\u5168\u8bbe\u7f6e\uff1a' + (err.message || err);
        }
    }

    async function onToggle(event) {
        var toggle = event.target;
        var want = !!toggle.checked;
        var status = $('#oneSecurityStatus');
        toggle.disabled = true;
        try {
            var payload = { revealRequiresUnlock: want };
            if (want) {
                /* Prove the unlock works before arming it. Without this a user
                 * could enable a challenge their platform cannot satisfy and
                 * then be locked out of their own stored keys with no way back
                 * except editing JSON on disk. */
                if (status) status.textContent = '\u8bf7\u5b8c\u6210\u7cfb\u7edf\u89e3\u9501\u4ee5\u542f\u7528\u6b64\u9009\u9879\u2026';
                payload.unlockGrant = await runSystemUnlock('\u542f\u7528\u201c\u67e5\u770b\u5bc6\u7801\u4e0e\u5bc6\u94a5\u524d\u9700\u8981\u7cfb\u7edf\u89e3\u9501\u201d');
            }
            var saved = await api('/api/one/security/policy', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            paint(saved);
            if (status) {
                status.textContent = saved.revealRequiresUnlock
                    ? '\u5df2\u5f00\u542f\uff1a\u67e5\u770b\u5bc6\u7801\u4e0e\u5bc6\u94a5\u524d\u9700\u8981\u7cfb\u7edf\u89e3\u9501'
                    : '\u5df2\u5173\u95ed\uff1a\u67e5\u770b\u5df2\u4fdd\u5b58\u4fe1\u606f\u65f6\u4e0d\u505a\u9a8c\u8bc1';
            }
        } catch (err) {
            /* Revert the visible state to the server's truth rather than to the
             * value we hoped for: the switch must never show "on" when the
             * server says off. */
            await refresh();
            if (status) status.textContent = err.message || String(err);
        } finally {
            toggle.disabled = false;
        }
    }

    async function onTest() {
        var status = $('#oneSecurityStatus');
        var btn = $('#oneSecurityTestUnlock');
        if (btn) btn.disabled = true;
        try {
            await runSystemUnlock('\u6d4b\u8bd5 Zephyr One \u7cfb\u7edf\u89e3\u9501');
            if (status) status.textContent = '\u7cfb\u7edf\u89e3\u9501\u6d4b\u8bd5\u901a\u8fc7';
        } catch (err) {
            if (status) status.textContent = '\u6d4b\u8bd5\u5931\u8d25\uff1a' + (err.message || err);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function bind() {
        var toggle = $('#oneRevealRequiresUnlock');
        if (!toggle || toggle.dataset.oneBound === '1') return;
        toggle.dataset.oneBound = '1';
        toggle.addEventListener('change', function (event) { onToggle(event); });
        $('#oneSecurityTestUnlock')?.addEventListener('click', function () { onTest(); });
        refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
