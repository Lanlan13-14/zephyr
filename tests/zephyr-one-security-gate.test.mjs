// Zephyr One security surface: the reveal gate and its native-unlock handoff.
//
// What this locks down, and why each part is worth a test:
//
//   The gate replaces a challenge that was theatre. Hosted Zephyr asks for the
//   account password or a TOTP code before revealing a stored secret. In One the
//   local account is auto-adopted by the desktop shell and its password is a
//   generated value the user never chose, so that prompt proves nothing. The
//   switch here decides instead: on -> a real OS authenticator, off -> nothing.
//
//   A grant is a capability, so its failure modes matter more than its happy
//   path. Forgery, replay after expiry, cross-account use and namespace confusion
//   are all asserted below, because "the HMAC is checked" is not the same claim
//   as "only the right HMAC opens the right door".
//
//   Arming the switch requires passing the unlock first. Without that a user on a
//   platform with no authenticator -- Linux, or Windows with Hello unconfigured --
//   could arm a challenge they cannot satisfy and lock themselves out of their own
//   stored keys with no way back except editing JSON on disk.
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
    mountRoutes,
    SecurityPrefStore,
    CapabilityCache,
    UnlockQueue,
    GrantStore,
    ShellRequestAuthenticator,
    signedShellMessage,
    GRANT_NAMESPACE,
} = require(path.join(root, 'zephyr-one-security.js'));

const crypto = require('node:crypto');
const SHELL_SECRET = '0123456789abcdef'.repeat(4);
const SHELL_INSTANCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const SERVER_JS = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const UI_JS = fs.readFileSync(path.join(root, 'zephyr-one-security-ui.js'), 'utf8');
const BRIDGE_RS = fs.readFileSync(
    path.join(root, 'zephyr_one/src-tauri/src/unlock_bridge/mod.rs'),
    'utf8',
);
const COMMANDS_RS = fs.readFileSync(
    path.join(root, 'zephyr_one/src-tauri/src/commands/mod.rs'),
    'utf8',
);
const LIB_RS = fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/src/lib.rs'), 'utf8');
const RUNTIME_RS = fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/src/runtime/mod.rs'), 'utf8');

/** A fake Express that records handlers so they can be invoked directly. */
function fakeApp() {
    const routes = new Map();
    const record = (method) => (route, ...rest) => {
        routes.set(method + ' ' + route, rest[rest.length - 1]);
    };
    return {
        get: record('GET'),
        put: record('PUT'),
        post: record('POST'),
        routes,
        call(key, req = {}) {
            const handler = routes.get(key);
            assert.ok(handler, 'no handler registered for ' + key);
            let payload;
            let status = 200;
            const res = {
                status(code) { status = code; return res; },
                json(value) { payload = value; return res; },
            };
            handler({ get: () => '', params: {}, body: {}, ...req }, res);
            return { status, body: payload };
        },
    };
}

function mount({ dataDir } = {}) {
    const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'one-sec-'));
    const app = fakeApp();
    const api = mountRoutes(app, {
        requireUser: (req, res, next) => next(),
        getSessionUser: (req) => req.user || { username: 'local' },
        dataDir: dir,
        logger: { info() {}, warn() {} },
        shellSecret: SHELL_SECRET,
        shellInstance: SHELL_INSTANCE,
    });
    return { app, api, dir };
}

function shellRequest(action, fields, req = {}, {
    secret = SHELL_SECRET,
    shellInstance = SHELL_INSTANCE,
    timestamp = String(Date.now()),
    nonce = crypto.randomBytes(20).toString('hex'),
} = {}) {
    const message = signedShellMessage(action, timestamp, nonce, shellInstance, fields);
    const mac = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
    const headers = {
        'x-zephyr-one-shell-instance': shellInstance,
        'x-zephyr-one-shell-timestamp': timestamp,
        'x-zephyr-one-shell-nonce': nonce,
        'x-zephyr-one-shell-mac': mac,
    };
    return {
        ...req,
        headers,
        get(name) { return headers[String(name).toLowerCase()] || ''; },
    };
}

function claimThroughShell(app) {
    return app.call(
        'GET /api/one/security/unlock-queue',
        shellRequest('unlock.claim', []),
    );
}

function resolveThroughShell(app, claim, verdict) {
    const body = {
        username: claim.username,
        purpose: claim.purpose,
        ok: verdict.ok === true,
        method: verdict.method || '',
        error: verdict.error || '',
    };
    const fields = [
        claim.id,
        body.username,
        body.purpose,
        body.ok ? '1' : '0',
        body.method,
        body.error,
    ];
    return app.call(
        'POST /api/one/security/unlock-queue/:id',
        shellRequest('unlock.resolve', fields, { params: { id: claim.id }, body }),
    );
}

test('a fresh install asks for nothing', () => {
    /* Defaulting the gate ON would be worse than useless: on a platform whose
     * authenticator is unavailable it makes the user's own stored keys
     * unreadable, before they have expressed any preference at all. */
    const { app } = mount();
    const res = app.call('GET /api/one/security/policy');
    assert.equal(res.status, 200);
    assert.equal(res.body.revealRequiresUnlock, false);
});

test('the reveal gate is transparent while the switch is off', () => {
    const { api } = mount();
    // null means "One is not asking for anything", which is what lets the
    // caller fall through rather than inventing a challenge.
    assert.equal(api.assertRevealAllowed({ get: () => '', body: {} }), null);
});

test('a valid grant opens the gate and names how it was earned', () => {
    const { api } = mount();
    api.prefs.set(true);
    const grant = api.grants.mint({ username: 'local', method: 'windows_hello' });
    const allowed = api.assertRevealAllowed({ get: () => '', body: { unlockGrant: grant } });
    assert.equal(allowed.method, 'system_unlock:windows_hello');
});

test('the armed gate refuses every way of not having a grant', () => {
    const { api } = mount();
    api.prefs.set(true);

    const reasons = {};
    for (const [label, body] of Object.entries({
        nothing: {},
        empty: { unlockGrant: '' },
        garbage: { unlockGrant: 'not-a-token' },
        halfToken: { unlockGrant: 'onlyonepart' },
    })) {
        try {
            api.assertRevealAllowed({ get: () => '', body });
            assert.fail('gate must refuse: ' + label);
        } catch (err) {
            assert.equal(err.status, 403, label);
            assert.equal(err.code, 'one_unlock_required', label);
            reasons[label] = err.reason;
        }
    }
    // The account password is precisely what must NOT work here: it is the
    // credential One's user never chose.
    try {
        api.assertRevealAllowed({ get: () => '', body: { secret: 'the-account-password' } });
        assert.fail('an account password must not open One\u2019s gate');
    } catch (err) {
        assert.equal(err.code, 'one_unlock_required');
    }
    assert.equal(reasons.nothing, 'malformed');
});

test('a forged grant does not open the gate', () => {
    /* The page is untrusted: it runs on a loopback origin any local process can
     * talk to. A grant it can mint itself would make the switch decorative. */
    const store = new GrantStore();
    const other = new GrantStore(); // different per-process key
    const foreign = other.mint({ username: 'local', method: 'windows_hello' });
    assert.deepEqual(store.open(foreign, { username: 'local' }), {
        ok: false,
        reason: 'bad_signature',
    });

    // Tampering with the claim body invalidates the MAC over it.
    const real = store.mint({ username: 'local', method: 'windows_hello' });
    const [body, mac] = real.split('.');
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claim.expiresAt += 3600_000;
    const forged = Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url') + '.' + mac;
    assert.equal(store.open(forged, { username: 'local' }).ok, false);
});

test('a grant expires, and expiry is checked against the clock not the caller', () => {
    let now = 1_000_000;
    const store = new GrantStore({ ttlMs: 1000, now: () => now });
    const grant = store.mint({ username: 'local', method: 'pin' });
    assert.equal(store.open(grant, { username: 'local' }).ok, true);
    now += 1001;
    assert.deepEqual(store.open(grant, { username: 'local' }), { ok: false, reason: 'expired' });
});

test('a grant is bound to the account it was minted for', () => {
    const store = new GrantStore();
    const grant = store.mint({ username: 'alice', method: 'pin' });
    assert.equal(store.open(grant, { username: 'alice' }).ok, true);
    assert.deepEqual(store.open(grant, { username: 'bob' }), { ok: false, reason: 'wrong_account' });
});

test('a token from another namespace is refused', () => {
    /* Namespace separation is what stops some other HMAC'd artefact from being
     * replayed here if this key is ever shared with another feature. */
    const store = new GrantStore();
    const crypto = require('node:crypto');
    const body = Buffer.from(JSON.stringify({
        ns: 'some-other-feature',
        username: 'local',
        method: 'pin',
        expiresAt: Date.now() + 60_000,
    }), 'utf8');
    const mac = crypto.createHmac('sha256', store.key).update(body).digest();
    const token = body.toString('base64url') + '.' + mac.toString('base64url');
    assert.deepEqual(store.open(token, { username: 'local' }), {
        ok: false,
        reason: 'wrong_namespace',
    });
    assert.equal(GRANT_NAMESPACE, 'one-reveal-unlock-v1');
});

test('arming the switch requires passing the unlock first', () => {
    /* The lockout this prevents is concrete: Linux reports no authenticator, so
     * a user who armed the gate there could never reveal a key again. */
    const { app, api } = mount();
    const refused = app.call('PUT /api/one/security/policy', {
        body: { revealRequiresUnlock: true },
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'unlock_proof_required');
    assert.equal(api.prefs.get().revealRequiresUnlock, false, 'must not have been stored');

    const grant = api.grants.mint({ username: 'local', method: 'windows_hello' });
    const armed = app.call('PUT /api/one/security/policy', {
        body: { revealRequiresUnlock: true, unlockGrant: grant },
    });
    assert.equal(armed.status, 200);
    assert.equal(armed.body.revealRequiresUnlock, true);
});

test('disarming needs no proof, so a broken authenticator is not a lockout', () => {
    const { app, api } = mount();
    api.prefs.set(true);
    const off = app.call('PUT /api/one/security/policy', {
        body: { revealRequiresUnlock: false },
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.revealRequiresUnlock, false);
});

test('the switch survives a core restart', () => {
    const { api, dir } = mount();
    api.prefs.set(true);
    // A new store over the same data dir is what a restart looks like.
    const reopened = new SecurityPrefStore({ filePath: path.join(dir, 'one-security.json') });
    assert.equal(reopened.get().revealRequiresUnlock, true);
});

test('grants do NOT survive a core restart', () => {
    /* The signing key is per-process and never persisted, so a grant captured
     * from one run cannot be replayed into the next. */
    const first = new GrantStore();
    const grant = first.mint({ username: 'local', method: 'pin' });
    const second = new GrantStore();
    assert.equal(second.open(grant, { username: 'local' }).ok, false);
});

test('an unlock request is claimed once, resolved once, and read once', () => {
    const queue = new UnlockQueue();
    const id = queue.request({ username: 'local', reason: 'reveal a key' });

    const claim = queue.claim({ shellInstance: 'shell-a' });
    assert.equal(claim.id, id);
    assert.equal(claim.reason, 'reveal a key');
    assert.equal(claim.purpose, 'reveal_secret');
    // A second shell must not claim the same request and show a second prompt.
    assert.equal(queue.claim({ shellInstance: 'shell-b' }), null);

    assert.equal(queue.poll(id, { username: 'local' }).status, 'pending');
    assert.equal(queue.resolve(id, {
        username: 'local', purpose: 'reveal_secret', ok: true, method: 'windows_hello',
    }, { shellInstance: 'shell-a' }), true);
    assert.equal(queue.resolve(id, {
        username: 'local', purpose: 'reveal_secret', ok: false, error: 'overwrite',
    }, { shellInstance: 'shell-a' }), false, 'a resolved request is one-shot');

    const done = queue.poll(id, { username: 'local' });
    assert.equal(done.ok, true);
    assert.equal(done.method, 'windows_hello');
    // Single-shot: a captured id cannot be polled again to mint a second grant
    // from one OS prompt.
    assert.equal(queue.poll(id, { username: 'local' }).status, 'unknown');
});

test('resolve requires its claim and is bound to shell, user, and purpose', () => {
    const queue = new UnlockQueue();
    const id = queue.request({ username: 'alice', purpose: 'reveal_key', reason: 'r' });
    const verdict = {
        username: 'alice', purpose: 'reveal_key', ok: true, method: 'pin',
    };

    assert.equal(
        queue.resolve(id, verdict, { shellInstance: 'shell-a' }),
        false,
        'pending requests cannot be resolved without an OS prompt claimant',
    );
    assert.equal(queue.claim({ shellInstance: 'shell-a' }).id, id);
    assert.equal(queue.resolve(id, verdict, { shellInstance: 'shell-b' }), false);
    assert.equal(queue.resolve(id, { ...verdict, username: 'bob' }, { shellInstance: 'shell-a' }), false);
    assert.equal(queue.resolve(id, { ...verdict, purpose: 'enable_policy' }, { shellInstance: 'shell-a' }), false);
    assert.equal(queue.resolve(id, verdict, { shellInstance: 'shell-a' }), true);
    assert.equal(queue.resolve(id, verdict, { shellInstance: 'shell-a' }), false, 'resolve replay is refused');
});

test('a WebView user session has no access to the shell queue', () => {
    const { app } = mount();
    const filed = app.call('POST /api/one/security/unlock', {
        body: { purpose: 'reveal_key', reason: 'r' },
    });

    const forgedClaim = app.call('GET /api/one/security/unlock-queue', {
        user: { username: 'local' },
    });
    assert.equal(forgedClaim.status, 403);
    assert.equal(forgedClaim.body.code, 'shell_auth_required');

    const claim = claimThroughShell(app).body;
    assert.equal(claim.id, filed.body.id, 'the denied WebView request must not consume the claim');
    const forgedResolve = app.call('POST /api/one/security/unlock-queue/:id', {
        user: { username: 'local' },
        params: { id: claim.id },
        body: {
            username: claim.username,
            purpose: claim.purpose,
            ok: true,
            method: 'forged',
            error: '',
        },
    });
    assert.equal(forgedResolve.status, 403);
    assert.equal(resolveThroughShell(app, claim, { ok: true, method: 'pin' }).body.ok, true);
});

test('shell MAC forgery and nonce replay cannot publish capabilities', () => {
    const { app, api } = mount();
    const body = { available: true, biometry: true, reason: 'Windows Hello' };
    const fields = ['1', '1', body.reason];
    const forged = app.call(
        'POST /api/one/security/capabilities',
        shellRequest('capabilities', fields, { body }, { secret: 'f'.repeat(64) }),
    );
    assert.equal(forged.status, 403);
    assert.equal(api.capabilities.get().known, false);

    const signed = shellRequest('capabilities', fields, { body });
    assert.equal(app.call('POST /api/one/security/capabilities', signed).status, 200);
    const replay = app.call('POST /api/one/security/capabilities', signed);
    assert.equal(replay.status, 403);
    assert.equal(replay.body.code, 'shell_auth_required');
});

test('a signed resolve cannot be changed from failure to success', () => {
    const { app } = mount();
    app.call('POST /api/one/security/unlock', { body: { reason: 'r' } });
    const claim = claimThroughShell(app).body;
    const signedFields = [claim.id, claim.username, claim.purpose, '0', '', 'cancelled'];
    const forged = app.call(
        'POST /api/one/security/unlock-queue/:id',
        shellRequest('unlock.resolve', signedFields, {
            params: { id: claim.id },
            body: {
                username: claim.username,
                purpose: claim.purpose,
                ok: true,
                method: 'forged',
                error: '',
            },
        }),
    );
    assert.equal(forged.status, 403);
    assert.equal(resolveThroughShell(app, claim, { ok: false, error: 'cancelled' }).body.ok, true);
});

test('an unlock request cannot be polled across users', () => {
    const { app } = mount();
    const filed = app.call('POST /api/one/security/unlock', {
        user: { username: 'alice' },
        body: { reason: 'r' },
    });
    const denied = app.call('GET /api/one/security/unlock/:id', {
        user: { username: 'bob' },
        params: { id: filed.body.id },
    });
    assert.equal(denied.status, 403);
    const owner = app.call('GET /api/one/security/unlock/:id', {
        user: { username: 'alice' },
        params: { id: filed.body.id },
    });
    assert.equal(owner.body.status, 'pending');
});

test('shell authentication rejects a stale or wrong-instance request', () => {
    let now = 1_700_000_000_000;
    const auth = new ShellRequestAuthenticator({
        secret: SHELL_SECRET,
        shellInstance: SHELL_INSTANCE,
        now: () => now,
        maxSkewMs: 1000,
    });
    const stale = shellRequest('unlock.claim', [], {}, { timestamp: String(now - 1001) });
    assert.equal(auth.verify(stale, 'unlock.claim', []).reason, 'stale');
    const wrong = shellRequest('unlock.claim', [], {}, { shellInstance: 'b'.repeat(32), timestamp: String(now) });
    assert.equal(auth.verify(wrong, 'unlock.claim', []).reason, 'wrong_instance');
});

test('a future-dated nonce stays consumed for its full acceptance window', () => {
    let now = 1_700_000_000_000;
    const auth = new ShellRequestAuthenticator({
        secret: SHELL_SECRET,
        shellInstance: SHELL_INSTANCE,
        now: () => now,
        maxSkewMs: 1000,
    });
    const signed = shellRequest('unlock.claim', [], {}, { timestamp: String(now + 1000) });
    assert.equal(auth.verify(signed, 'unlock.claim', []).ok, true);
    now += 1001;
    assert.equal(auth.verify(signed, 'unlock.claim', []).reason, 'replayed');
});

test('an abandoned unlock request is swept instead of waiting forever', () => {
    let now = 5_000;
    const queue = new UnlockQueue({ ttlMs: 1000, now: () => now });
    const id = queue.request({ username: 'local', reason: 'x' });
    now += 1001;
    assert.equal(queue.poll(id, { username: 'local' }).status, 'unknown');
    assert.equal(queue.claim({ shellInstance: 'shell-a' }), null, 'a swept request must not be claimable');
});

test('a cancelled unlock yields no grant', () => {
    const { app, api } = mount();
    const filed = app.call('POST /api/one/security/unlock', { body: { reason: 'r' } });
    const claim = claimThroughShell(app).body;
    assert.equal(resolveThroughShell(app, claim, { ok: false, error: 'cancelled' }).body.ok, true);
    const polled = app.call('GET /api/one/security/unlock/:id', { params: { id: filed.body.id } });
    assert.equal(polled.body.unlocked, false);
    assert.equal(polled.body.grant, undefined, 'a refusal must not carry a grant');
});

test('a successful unlock yields a grant that actually opens the gate', () => {
    const { app, api } = mount();
    api.prefs.set(true);
    const filed = app.call('POST /api/one/security/unlock', { body: { reason: 'r' } });
    const claim = claimThroughShell(app).body;
    assert.equal(resolveThroughShell(app, claim, { ok: true, method: 'windows_hello' }).body.ok, true);
    const polled = app.call('GET /api/one/security/unlock/:id', { params: { id: filed.body.id } });
    assert.equal(polled.body.unlocked, true);
    // End to end: the grant the page receives is the one the gate accepts.
    const allowed = api.assertRevealAllowed({ get: () => '', body: { secret: polled.body.grant } });
    assert.equal(allowed.method, 'system_unlock:windows_hello');
});

test('a platform with no authenticator refuses instead of hanging', () => {
    /* Queueing a request nothing can claim would spin the page until the TTL
     * expired and then report a timeout, which reads as a bug rather than as
     * "this platform has no system unlock". */
    const { app, api } = mount();
    api.capabilities.publish({ available: false, biometry: false, reason: 'Linux' });
    const res = app.call('POST /api/one/security/unlock', { body: {} });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'native_unlock_unavailable');
});

test('capabilities start unknown rather than unavailable', () => {
    /* "the shell has not reported yet" and "this platform cannot" lead to
     * different UI; conflating them shows a Linux error on Windows at startup. */
    const cache = new CapabilityCache();
    assert.equal(cache.get().known, false);
    assert.equal(cache.get().available, false);
    cache.publish({ available: true, biometry: true, reason: 'Windows Hello' });
    assert.equal(cache.get().known, true);
    assert.equal(cache.get().available, true);
});

test('server.js routes every reveal through One\u2019s gate before the password path', () => {
    /* One function, so no reveal route can implement only one of the two
     * products' challenges. Ordering matters: One's gate is consulted first, or
     * a One user would have to satisfy a password check that proves nothing. */
    assert.match(SERVER_JS, /function verifySensitiveAccess\(req, secretInput\) \{/);
    const fn = SERVER_JS.slice(SERVER_JS.indexOf('function verifySensitiveAccess(req, secretInput) {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const onePath = body.indexOf('oneSecurity.assertRevealAllowed(req)');
    const passwordPath = body.indexOf('verifyPassword(');
    assert.ok(onePath > 0, 'One\u2019s gate must be consulted');
    assert.ok(passwordPath > onePath, 'the password path must remain the fallback, not the first ask');

    /* The guard itself, not just the call.
     *
     * Ordering alone is satisfied by a branch that never runs: replacing
     * `if (oneSecurity)` with `if (false)` leaves the body text - and therefore
     * the ordering - untouched while silently sending every One reveal down the
     * password path. Pinning the condition is what makes that mutation fail. */
    assert.match(
        body,
        /if \(oneSecurity\) \{/,
        'the One branch must be guarded by oneSecurity itself, or a dead branch passes the ordering check',
    );
    const guardAt = body.search(/if \(oneSecurity\) \{/);
    assert.ok(guardAt >= 0 && guardAt < onePath, 'the guard must enclose the call it protects');
    assert.ok(guardAt < passwordPath, 'the guard must come before the password fallback');

    // Mounted only in embedded mode: on hosted Zephyr the account password and
    // TOTP are real credentials and must stay the gate.
    /* Newline-agnostic: server.js is checked out with CRLF on Windows, so a
     * pattern hard-coding \n would fail for a reason unrelated to the claim. */
    assert.match(SERVER_JS, /if \(ZEPHYR_ONE_EMBEDDED\) \{\r?\n {4}\/\* One/);
    assert.match(SERVER_JS, /oneSecurity = mountOneSecurity\(app, \{/);
});

test('the browser product keeps its password prompt', () => {
    /* The One branch keys off a global the overlay installs, and that overlay is
     * served only in embedded mode, so a browser client never takes it. */
    assert.match(APP_JS, /window\.__zephyrOneUnlock/);
    const fn = APP_JS.slice(APP_JS.indexOf('async function requestSensitiveSecret('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /prompt\(message\)/, 'the browser path must still prompt');
    assert.match(body, /securityStatus\.user\?\.totpEnabled/);
    assert.match(SERVER_JS, /app\.get\('\/zephyr-one-security-ui\.js'/);
    assert.match(SERVER_JS, /if \(!ZEPHYR_ONE_EMBEDDED\) return next\(\);/);
});

test('every reveal call site awaits the now-async challenge', () => {
    /* Making the helper async without awaiting it would send the string
     * "[object Promise]" as the secret and fail every reveal with a confusing
     * error rather than a challenge. */
    const calls = [...APP_JS.matchAll(/(await )?requestSensitiveSecret\(/g)];
    const unawaited = calls.filter(([whole, awaited]) => !awaited && !whole.startsWith('function'));
    // The declaration itself is the only unawaited occurrence.
    const declarations = [...APP_JS.matchAll(/async function requestSensitiveSecret\(/g)];
    assert.equal(declarations.length, 1);
    assert.equal(
        unawaited.length,
        declarations.length,
        'unawaited reveal call sites: ' + unawaited.map(([w]) => w).join(', '),
    );
    assert.ok(calls.length > 10, 'expected the full set of reveal call sites, saw ' + calls.length);
});

test('the shell watcher is wired and publishes what the platform can do', () => {
    /* auth/mod.rs has implemented Windows Hello / Touch ID since the first
     * desktop build, but nothing in the product UI could reach it: the WebView
     * is on a remote origin and cannot invoke a command. This is that bridge. */
    assert.match(LIB_RS, /mod unlock_bridge;/);
    assert.match(COMMANDS_RS, /unlock_bridge::spawn_unlock_watcher\(&watcher_app\);/);
    assert.match(BRIDGE_RS, /api\/one\/security\/unlock-queue/);
    assert.match(BRIDGE_RS, /api\/one\/security\/capabilities/);
    assert.match(BRIDGE_RS, /crate::auth::unlock\(&app, &reason\)/);
    assert.match(BRIDGE_RS, /crate::auth::capabilities\(app\)/);
    assert.match(BRIDGE_RS, /X-Zephyr-One-Shell-Mac/);
    assert.match(BRIDGE_RS, /X-Zephyr-One-Shell-Nonce/);
    assert.match(RUNTIME_RS, /unlock_bridge::shell_identity_env\(\)/);
    assert.match(RUNTIME_RS, /\.env\("ZEPHYR_ONE_SHELL_SECRET", shell_secret\)/);
    assert.match(RUNTIME_RS, /\.env\("ZEPHYR_ONE_SHELL_INSTANCE", shell_instance\)/);
    assert.match(SERVER_JS, /delete process\.env\.ZEPHYR_ONE_SHELL_SECRET/);
    // Idempotent, or a retried runtime_start would race two watchers for one id.
    assert.match(BRIDGE_RS, /WATCHER_STARTED\.swap\(true, Ordering::SeqCst\)/);
});

test('the overlay refuses to report success it did not get', () => {
    // A page that returned '' on failure would look like "switch off" and
    // silently reveal the secret.
    assert.match(UI_JS, /if \(!polled\.unlocked\) throw new Error/);
    assert.match(UI_JS, /window\.__zephyrOneUnlock = \{ acquire: acquire/);
    // Arming from the UI proves the unlock first, matching the server check.
    assert.match(UI_JS, /payload\.unlockGrant = await runSystemUnlock\(/);
});

test('the stage stylesheet no longer hides the panel One now uses', () => {
    const stage = fs.readFileSync(
        path.join(root, 'zephyr_one/scripts/stage-zephyr-core.sh'),
        'utf8',
    );
    const block = fs.readFileSync(path.join(root, 'zephyr-one-embed.css'), 'utf8');
    assert.match(stage, /cp "\$ROOT\/zephyr-one-embed\.css" "\$OUT\/public\/zephyr-one-embed\.css"/);
    assert.equal(
        block.includes('#settings-security'),
        false,
        'hiding it would hide the one security setting One can enforce',
    );
    // The tabs that are still browser-only must stay hidden.
    for (const key of ['admin', 'mail', 'beian']) {
        assert.ok(block.includes(key), key + ' is browser-only and must stay hidden');
    }
});
