/*
 * zephyr-one-security.js - Zephyr One's own security surface.
 *
 * Two things live here, and they only make sense together.
 *
 * 1. THE ONE SECURITY SETTING
 *
 * Browser Zephyr's Settings > Security panel is an account-management surface:
 * change password, TOTP, passkeys, login mail, IP allow-list, CAPTCHA. None of
 * that applies to One, which is a single local account whose credential is the
 * desktop session itself, so `zephyr-one-embed-surface.js` removes the tab.
 *
 * Removing it left One with no security settings at all. This module gives it
 * exactly one switch:
 *
 *     revealRequiresUnlock - when on, viewing a stored password or private key
 *     requires a system unlock first. When off, no challenge is asked.
 *
 * That is deliberately the whole panel. Anything else One could offer here is
 * either the OS's job (disk encryption, screen lock) or the main end's job
 * (account password, TOTP), and a switch One cannot actually enforce is worse
 * than no switch.
 *
 * 2. WHY A NATIVE UNLOCK RATHER THAN A PASSWORD PROMPT
 *
 * Hosted Zephyr gates a reveal on `verifySensitiveAccess`, which asks for the
 * account password or a TOTP code. In One that check is theatre: the local
 * account is auto-adopted, the password is a generated local secret the user
 * never chose, and there is no second factor to fall back on. Asking for it
 * would train the user to type a password that protects nothing.
 *
 * The OS authenticator is the honest challenge. Windows Hello / Touch ID / the
 * device PIN is a credential the user actually holds and One cannot forge, and
 * `src-tauri/src/auth/mod.rs` already implements it - it was simply never
 * reachable from the product UI, only from the Tauri shell's own boot screen.
 *
 * 3. WHY A POLLED HANDOFF RATHER THAN A TAURI INVOKE
 *
 * The WebView navigates to the loopback core, so to Tauri the product page is a
 * *remote* origin and cannot invoke a command. Granting IPC to a loopback
 * origin would hand it to any process that can bind a local port. So the page
 * files a request, the Rust shell claims it, runs the OS prompt, and posts the
 * result back - the same shape the colour-scheme watcher and the RDP folder
 * picker already use.
 *
 * 4. WHAT A SUCCESSFUL UNLOCK BUYS
 *
 * A short-lived grant, HMAC'd with a per-process key and bound to the account
 * and to the fact that an unlock happened. It is not a session upgrade and not a
 * bearer token for anything else: `openGrant` checks the namespace, the account
 * and the expiry, and the reveal routes are the only callers. The key is
 * generated per process and never persisted, so every core restart invalidates
 * every outstanding grant.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* One unlock covers a short burst of reveals - opening a connection, checking
 * its key, checking the proxy behind it - without re-prompting for each. Long
 * enough to be usable, short enough that a walk-away does not leave the gate
 * open. */
const GRANT_TTL_MS = 2 * 60 * 1000;

/* The shell polls every 300ms, matching the RDP picker. A request older than
 * this was abandoned (window closed, shell not running) and must not sit in the
 * queue forever waiting to be claimed. */
const UNLOCK_TTL_MS = 90 * 1000;

const GRANT_NAMESPACE = 'one-reveal-unlock-v1';

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

/**
 * The single One security preference, persisted in One's own data dir.
 *
 * Not in the shared `settings` table on purpose: this is a property of *this
 * desktop install*, not of the account. Syncing it to a phone or to a hosted
 * Zephyr would mean one device's OS-authenticator availability silently
 * deciding another device's gate.
 */
class SecurityPrefStore {
    constructor({ filePath, now = () => Date.now() } = {}) {
        this.filePath = filePath;
        this.now = now;
        this.state = { revealRequiresUnlock: false, updatedAt: 0 };
        this.load();
    }

    load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            this.state = {
                revealRequiresUnlock: raw.revealRequiresUnlock === true,
                updatedAt: Number(raw.updatedAt) || 0,
            };
        } catch {
            /* Missing or corrupt file means "never configured". Defaulting to
             * false rather than true is the honest default: a gate the user has
             * not opted into, on a platform whose authenticator may not even be
             * available, would lock them out of their own stored keys. */
            this.state = { revealRequiresUnlock: false, updatedAt: 0 };
        }
    }

    get() {
        return { ...this.state };
    }

    set(revealRequiresUnlock) {
        this.state = {
            revealRequiresUnlock: revealRequiresUnlock === true,
            updatedAt: this.now(),
        };
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
        } catch {
            /* A read-only data dir must not crash the core. The in-memory value
             * still applies for this run, and the next read reports the truth
             * rather than a value that was never stored. */
        }
        return this.get();
    }
}

/**
 * Native-unlock capabilities as reported by the shell.
 *
 * Starts unknown rather than unavailable: "the shell has not told us yet" and
 * "this platform has no authenticator" lead to different UI, and conflating
 * them would show a Linux error message on Windows during startup.
 */
class CapabilityCache {
    constructor({ now = () => Date.now() } = {}) {
        this.now = now;
        this.value = { known: false, available: false, biometry: false, reason: '', reportedAt: 0 };
    }

    publish({ available, biometry, reason }) {
        this.value = {
            known: true,
            available: available === true,
            biometry: biometry === true,
            reason: String(reason || ''),
            reportedAt: this.now(),
        };
        return this.get();
    }

    get() {
        return { ...this.value };
    }
}

/**
 * Page-to-shell unlock handoff.
 *
 * Same request/claim/resolve/poll shape as `PickerQueue` in
 * zephyr-one-rdp-storage.js. `claim` marks an entry so two shell instances
 * cannot both prompt for the same request.
 */
class UnlockQueue {
    constructor({ ttlMs = UNLOCK_TTL_MS, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.pending = new Map();
        this.seq = 0;
    }

    request({ username, reason }) {
        this.sweep();
        this.seq += 1;
        const id = 'unlock-' + this.now() + '-' + this.seq;
        this.pending.set(id, {
            id,
            username: String(username || ''),
            reason: String(reason || '').slice(0, 200),
            createdAt: this.now(),
            state: 'pending',
            ok: false,
            method: '',
            error: '',
        });
        return id;
    }

    claim() {
        this.sweep();
        for (const entry of this.pending.values()) {
            if (entry.state === 'pending') {
                entry.state = 'claimed';
                return { id: entry.id, username: entry.username, reason: entry.reason };
            }
        }
        return null;
    }

    resolve(id, { ok, method, error }) {
        const entry = this.pending.get(String(id));
        if (!entry) return false;
        entry.state = 'done';
        entry.ok = ok === true;
        entry.method = String(method || '');
        entry.error = String(error || '');
        return true;
    }

    poll(id) {
        this.sweep();
        const entry = this.pending.get(String(id));
        if (!entry) return { status: 'unknown', ok: false, method: '', error: '', username: '' };
        if (entry.state !== 'done') {
            return { status: 'pending', ok: false, method: '', error: '', username: entry.username };
        }
        /* Single-shot: the result is consumed on read so a captured id cannot be
         * polled again to re-mint a second grant from one OS prompt. */
        this.pending.delete(entry.id);
        return {
            status: 'done',
            ok: entry.ok,
            method: entry.method,
            error: entry.error,
            username: entry.username,
        };
    }

    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, entry] of this.pending) {
            if (entry.createdAt < cutoff) this.pending.delete(id);
        }
    }
}

/**
 * Short-lived proof that a system unlock succeeded.
 *
 * HMAC over a per-process key, so a grant cannot be forged by the page and does
 * not survive a core restart. Bound to the account: a grant minted for one
 * username must not authorise a reveal for another, which matters as soon as a
 * hosted Zephyr and a local One share this code path.
 */
class GrantStore {
    constructor({ ttlMs = GRANT_TTL_MS, now = () => Date.now() } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.key = crypto.randomBytes(32);
    }

    mint({ username, method }) {
        const body = Buffer.from(JSON.stringify({
            ns: GRANT_NAMESPACE,
            username: String(username || ''),
            method: String(method || ''),
            expiresAt: this.now() + this.ttlMs,
        }), 'utf8');
        const mac = crypto.createHmac('sha256', this.key).update(body).digest();
        return b64url(body) + '.' + b64url(mac);
    }

    /**
     * @returns {{ok: true, method: string}|{ok: false, reason: string}}
     * Never throws: the caller turns this into the product's own error shape,
     * and a malformed token is a client bug rather than a server fault.
     */
    open(token, { username } = {}) {
        const parts = String(token || '').split('.');
        if (parts.length !== 2) return { ok: false, reason: 'malformed' };
        const body = Buffer.from(parts[0], 'base64url');
        const given = Buffer.from(parts[1], 'base64url');
        const expected = crypto.createHmac('sha256', this.key).update(body).digest();
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            return { ok: false, reason: 'bad_signature' };
        }
        let claim;
        try {
            claim = JSON.parse(body.toString('utf8'));
        } catch {
            return { ok: false, reason: 'malformed' };
        }
        if (String(claim.ns) !== GRANT_NAMESPACE) return { ok: false, reason: 'wrong_namespace' };
        if (Number(claim.expiresAt) <= this.now()) return { ok: false, reason: 'expired' };
        if (username != null && String(claim.username) !== String(username)) {
            return { ok: false, reason: 'wrong_account' };
        }
        return { ok: true, method: String(claim.method || '') };
    }
}

/**
 * Mounts One's security routes and returns the pieces server.js needs.
 *
 * `requireUser` is applied to every route, including the two the shell calls:
 * the shell rides the same adopted local session as the WebView because
 * `adoptEmbeddedLocalSession` is global middleware, so a cookieless loopback
 * request authenticates as the local account.
 */
function mountRoutes(app, { requireUser, getSessionUser, dataDir, logger = console } = {}) {
    const prefs = new SecurityPrefStore({
        filePath: path.join(dataDir, 'one-security.json'),
    });
    const capabilities = new CapabilityCache();
    const unlocks = new UnlockQueue();
    const grants = new GrantStore();

    const nameOf = (req) => {
        const user = getSessionUser ? getSessionUser(req) : null;
        return String((user && (user.username || user.userId)) || '');
    };

    app.get('/api/one/security/policy', requireUser, (req, res) => {
        res.json({
            ok: true,
            ...prefs.get(),
            nativeUnlock: capabilities.get(),
        });
    });

    app.put('/api/one/security/policy', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const want = body.revealRequiresUnlock === true;

        if (want) {
            /* Turning the gate ON requires passing it once, right now.
             *
             * Without this a user could enable a challenge their platform
             * cannot satisfy - Linux has no portable authenticator, and Windows
             * Hello may be unconfigured - and then be unable to read their own
             * stored keys with no way back except editing JSON on disk. Proving
             * the unlock works before arming it makes that impossible. */
            const proof = grants.open(body.unlockGrant, { username: nameOf(req) });
            if (!proof.ok) {
                return res.status(403).json({
                    ok: false,
                    error: '\u8bf7\u5148\u5b8c\u6210\u4e00\u6b21\u7cfb\u7edf\u89e3\u9501\u9a8c\u8bc1\u540e\u518d\u5f00\u542f',
                    code: 'unlock_proof_required',
                    reason: proof.reason,
                });
            }
        }

        /* Turning it OFF deliberately needs no proof. The gate protects secrets
         * from someone at an unlocked desktop; a user who can already reach this
         * setting is that user. Requiring an unlock to disable it would strand
         * anyone whose authenticator broke after they armed it. */
        const saved = prefs.set(want);
        logger.info?.('[one-security] reveal policy updated', {
            revealRequiresUnlock: saved.revealRequiresUnlock,
        });
        return res.json({ ok: true, ...saved, nativeUnlock: capabilities.get() });
    });

    app.post('/api/one/security/unlock', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const caps = capabilities.get();
        if (caps.known && !caps.available) {
            /* Refuse rather than queue a request nothing will ever claim: the
             * page would otherwise spin until the TTL expired and then report a
             * timeout, which reads as a bug rather than as "this platform has no
             * system unlock". */
            return res.status(503).json({
                ok: false,
                code: 'native_unlock_unavailable',
                error: caps.reason || '\u5f53\u524d\u5e73\u53f0\u6ca1\u6709\u53ef\u7528\u7684\u7cfb\u7edf\u89e3\u9501',
            });
        }
        const id = unlocks.request({ username: nameOf(req), reason: body.reason });
        return res.json({ ok: true, id });
    });

    app.get('/api/one/security/unlock/:id', requireUser, (req, res) => {
        const result = unlocks.poll(req.params.id);
        if (result.status !== 'done') {
            return res.json({ ok: true, status: result.status });
        }
        if (!result.ok) {
            return res.json({
                ok: true,
                status: 'done',
                unlocked: false,
                error: result.error || '\u7cfb\u7edf\u89e3\u9501\u5931\u8d25\u6216\u5df2\u53d6\u6d88',
            });
        }
        /* The grant is bound to the account that filed the request, not to
         * whoever polls: on a single-account One these are the same, and pinning
         * the requester is what keeps that true if they ever diverge. */
        return res.json({
            ok: true,
            status: 'done',
            unlocked: true,
            method: result.method,
            grant: grants.mint({ username: result.username, method: result.method }),
            expiresInMs: GRANT_TTL_MS,
        });
    });

    /* -- shell side ------------------------------------------------------- */

    app.post('/api/one/security/capabilities', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const published = capabilities.publish({
            available: body.available,
            biometry: body.biometry,
            reason: body.reason,
        });
        return res.json({ ok: true, nativeUnlock: published });
    });

    app.get('/api/one/security/unlock-queue', requireUser, (req, res) => {
        res.json(unlocks.claim() || { id: '', username: '', reason: '' });
    });

    app.post('/api/one/security/unlock-queue/:id', requireUser, (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const ok = unlocks.resolve(req.params.id, {
            ok: body.ok,
            method: body.method,
            error: body.error,
        });
        if (!ok) logger.warn?.('[one-security] unlock result for unknown id', { id: req.params.id });
        res.json({ ok });
    });

    /**
     * The gate the reveal routes consult.
     *
     * Returns null when One is not asking for anything, so the caller can fall
     * through to whatever it did before. Throws with a `status` so the existing
     * `handleServiceError` shape carries it unchanged.
     */
    function assertRevealAllowed(req) {
        if (!prefs.get().revealRequiresUnlock) return null;
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        /* Three places, one reason each.
         *
         * `unlockGrant` is the explicit field a purpose-built caller uses.
         * `x-zephyr-one-unlock` lets a caller that cannot shape the body carry
         * it. `secret` is the one that makes this work without touching eleven
         * call sites: app.js funnels every reveal through
         * requestSensitiveSecret(), whose return value becomes `body.secret`,
         * so One's overlay returns the grant there and the existing callers are
         * unchanged. It is not a weakening - a grant is verified by HMAC,
         * namespace, account and expiry regardless of which field carried it,
         * and an account password would fail all four checks. */
        const token = body.unlockGrant || req.get('x-zephyr-one-unlock') || body.secret || '';
        const proof = grants.open(token, { username: nameOf(req) });
        if (!proof.ok) {
            const err = new Error('\u67e5\u770b\u5bc6\u94a5\u9700\u8981\u5148\u901a\u8fc7\u7cfb\u7edf\u89e3\u9501');
            err.status = 403;
            err.code = 'one_unlock_required';
            err.reason = proof.reason;
            throw err;
        }
        return { method: 'system_unlock:' + proof.method };
    }

    return { prefs, capabilities, unlocks, grants, assertRevealAllowed };
}

module.exports = {
    mountRoutes,
    SecurityPrefStore,
    CapabilityCache,
    UnlockQueue,
    GrantStore,
    GRANT_TTL_MS,
    UNLOCK_TTL_MS,
    GRANT_NAMESPACE,
};
