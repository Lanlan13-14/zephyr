import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Named-parameter parity between Node's built-in SQLite and better-sqlite3.
 *
 * Zephyr One sets ZEPHYR_ONE_USE_BUILTIN_SQLITE=1 on *every* platform (the env
 * is set in the shared block of runtime/mod.rs, not the Android-only one), so
 * Windows / macOS / Linux all run the built-in binding. It diverges from
 * better-sqlite3 in both directions:
 *
 *   case          node:sqlite (raw)     better-sqlite3
 *   complete      ok                    ok
 *   extra key     THROWS                ok (ignores extras)
 *   missing key   silently binds NULL   THROWS
 *
 * `extra key` crashed the core: storage.updateUser() passes a whole row object
 * into a statement naming a subset of columns, so POST /api/auth/change-password
 * threw `Unknown named parameter 'createdAt'` and killed the process.
 * `missing key` is the quieter hazard — a typo'd field writes NULL where
 * better-sqlite3 would have thrown.
 */

const require = createRequire(import.meta.url);
const { createDatabase, declaredNamedParams } = require('../sqlite-driver.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** better-sqlite3's native binding is absent unless npm ran its build step. */
function nativeDriver() {
    try {
        return require('better-sqlite3');
    } catch {
        return null;
    }
}

function seedUsers(db) {
    db.exec(`CREATE TABLE users (
        username TEXT PRIMARY KEY,
        passwordHash TEXT NOT NULL,
        defaultPassword INTEGER DEFAULT 0,
        createdAt INTEGER,
        updatedAt INTEGER,
        email TEXT
    )`);
    db.prepare('INSERT INTO users (username,passwordHash,defaultPassword,createdAt,updatedAt,email) VALUES (?,?,?,?,?,?)')
        .run('admin', 'h0', 1, 1, 1, '');
    return db;
}

/** The exact shape storage.updateUser() builds: full row, subset statement. */
const UPDATE_SQL = 'UPDATE users SET passwordHash=@passwordHash, defaultPassword=@defaultPassword, updatedAt=@updatedAt, email=@email WHERE username=@username';
const FULL_ROW = {
    username: 'admin',
    passwordHash: 'h1',
    defaultPassword: 0,
    createdAt: 1,       // ← not named by the statement; the crash trigger
    updatedAt: 2,
    email: '',
    userId: 'u-1',      // ← also unnamed
    role: 'admin',
    status: 'active',
};

test('extra keys in a bind object are ignored, matching better-sqlite3', () => {
    const db = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    assert.doesNotThrow(() => db.prepare(UPDATE_SQL).run(FULL_ROW));
    const row = db.prepare('SELECT passwordHash, updatedAt FROM users WHERE username=@username')
        .get({ username: 'admin', createdAt: 999 });
    assert.equal(row.passwordHash, 'h1');
    assert.equal(row.updatedAt, 2);
    db.close();
});

test('extra-key tolerance covers get() and all(), not only run()', () => {
    const db = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    const noise = { username: 'admin', role: 'admin', createdAt: 1, nested: { a: 1 } };
    assert.equal(db.prepare('SELECT username FROM users WHERE username=@username').get(noise).username, 'admin');
    assert.equal(db.prepare('SELECT username FROM users WHERE username=@username').all(noise).length, 1);
    db.close();
});

test('a genuinely missing parameter still fails loudly', () => {
    const db = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    // Raw node:sqlite would silently bind NULL here. better-sqlite3 throws, so
    // the adapter must throw too, or a typo'd field name corrupts data.
    assert.throws(
        () => db.prepare(UPDATE_SQL).run({ username: 'admin', passwordHash: 'h2', defaultPassword: 0, updatedAt: 3 }),
        /Missing named parameter/,
    );
    assert.equal(db.prepare('SELECT passwordHash FROM users').get().passwordHash, 'h0');
    db.close();
});

test('positional binding is unaffected', () => {
    const db = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    assert.doesNotThrow(() => db.prepare('UPDATE users SET passwordHash=? WHERE username=?').run('h9', 'admin'));
    assert.equal(db.prepare('SELECT passwordHash FROM users').get().passwordHash, 'h9');
    db.close();
});

test('statements built off rawDb().prepare() get the same semantics', () => {
    // server.js, session-store.js and user-service.js all prepare directly off
    // storage.rawDb(), so the fix must live on the db object, not in storage.js.
    const db = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    assert.doesNotThrow(() => db.prepare('UPDATE users SET updatedAt=@updatedAt WHERE username=@username')
        .run({ username: 'admin', updatedAt: 5, createdAt: 1, role: 'admin' }));
    assert.equal(db.prepare('SELECT updatedAt FROM users').get().updatedAt, 5);
    db.close();
});

test('pragma() returns rows so read pragmas work', () => {
    // exec() returns undefined; storage.init() and the WAL checkpoint paths
    // both rely on pragma() behaving like better-sqlite3's.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-pragma-'));
    const db = createDatabase(path.join(dir, 'p.db'), { forceBuiltin: true });
    // node:sqlite rows are null-prototype, so compare on own enumerable keys.
    assert.deepEqual(db.pragma('journal_mode = WAL').map((r) => ({ ...r })), [{ journal_mode: 'wal' }]);
    assert.deepEqual(db.pragma('journal_mode').map((r) => ({ ...r })), [{ journal_mode: 'wal' }]);
    assert.equal(Array.isArray(db.pragma('wal_checkpoint(FULL)')), true);
    assert.doesNotThrow(() => db.pragma('secure_delete = ON'));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('both drivers agree on the exact call that crashed change-password', () => {
    const Native = nativeDriver();
    assert.ok(Native, 'better-sqlite3 binding must be built for this parity assertion');

    const builtin = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    const native = seedUsers(new Native(':memory:'));
    for (const db of [builtin, native]) db.prepare(UPDATE_SQL).run(FULL_ROW);

    const read = (db) => ({ ...db.prepare('SELECT passwordHash, defaultPassword, updatedAt FROM users').get() });
    assert.deepEqual(read(builtin), read(native));

    // And they agree on rejecting a missing parameter.
    const partial = { username: 'admin', passwordHash: 'h2', defaultPassword: 0, updatedAt: 3 };
    assert.throws(() => builtin.prepare(UPDATE_SQL).run(partial), /Missing named parameter/);
    assert.throws(() => native.prepare(UPDATE_SQL).run(partial), /Missing named parameter/);

    builtin.close();
    native.close();
});

// ── parameter parser ──────────────────────────────────────────────────────
// A falsely *detected* parameter breaks a working query, so the parser is
// pinned by both hand-written edge cases and a sweep of every real statement.

test('row prototype divergence is accepted and bounded', () => {
    /* node:sqlite returns null-prototype rows; better-sqlite3 returns ordinary
     * objects. This is a deliberate NON-fix: normalising every row costs ~25%
     * on reads (measured: 269ms -> 335ms per 200k rows via setPrototypeOf,
     * 562ms via spread), and the only pattern it breaks is `row.hasOwnProperty()`
     * — which eslint's no-prototype-builtins forbids and which appears nowhere
     * server-side. Everything the product actually does to a row keeps working.
     *
     * This test exists so the divergence stays bounded: if a future row-handling
     * need exceeds what is asserted here, this fails instead of misbehaving in
     * production. */
    const db = seedUsers(createDatabase(':memory:', { forceBuiltin: true }));
    const row = db.prepare('SELECT username, email FROM users').get();

    // Every access pattern the product relies on.
    assert.deepEqual(Object.keys(row), ['username', 'email']);
    assert.equal(row.username, 'admin');
    assert.equal('username' in row, true);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'username'), true);
    assert.deepEqual({ ...row }, { username: 'admin', email: '' });
    assert.equal(JSON.stringify(row), '{"username":"admin","email":""}');
    assert.equal(Object.entries(row).length, 2);

    // The one pattern that does NOT survive, asserted so it cannot regress silently.
    assert.equal(Object.getPrototypeOf(row), null);
    assert.equal(typeof row.hasOwnProperty, 'undefined');
    db.close();
});

test('parameter parser handles quoting, comments and JS interpolation', () => {
    const cases = [
        // storage.js builds this with a template literal; `${where}` must not
        // register as a parameter named `where`.
        ['SELECT * FROM activities ${where} ORDER BY time DESC LIMIT @limit', ['limit']],
        ['SELECT ${cols} FROM t', []],
        ['SELECT CAST(x AS TEXT)::text FROM t WHERE id=@id', ['id']],
        ["SELECT * FROM t WHERE email='a@b.c' AND id=@id", ['id']],
        ['SELECT "weird@col" FROM t WHERE id=@id', ['id']],
        ['SELECT @a, -- @b\n @c FROM t', ['a', 'c']],
        ['SELECT @a, /* @b */ @c FROM t', ['a', 'c']],
        ['SELECT [odd@name] FROM t WHERE id=@id', ['id']],
        ['INSERT INTO t VALUES ($one, :two, @three)', ['one', 'two', 'three']],
        ["SELECT * FROM t WHERE a='it''s @x' AND id=@id", ['id']],
        ['SELECT * FROM t WHERE a=? AND b=?', []],
    ];
    for (const [sql, want] of cases) {
        assert.deepEqual([...declaredNamedParams(sql)].sort(), [...want].sort(), sql);
    }
});

test('parameter parser is exact across every prepare() literal in the repo', () => {
    const Native = nativeDriver();
    assert.ok(Native, 'better-sqlite3 binding must be built for this sweep');

    // Real schema, so statements can actually be prepared.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-schema-'));
    const priorDataDir = process.env.ZEPHYR_DATA_DIR;
    process.env.ZEPHYR_DATA_DIR = dir;
    let schema = [];
    try {
        const storage = require('../storage.js');
        storage.init({ hashPassword: (p) => `h:${p}` });
        schema = storage.rawDb()
            .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index')")
            .all()
            .map((r) => r.sql);
        storage.close?.();
    } finally {
        if (priorDataDir === undefined) delete process.env.ZEPHYR_DATA_DIR;
        else process.env.ZEPHYR_DATA_DIR = priorDataDir;
    }
    assert.ok(schema.length > 5, 'expected a real schema dump');

    const oracle = new Native(':memory:');
    const probe = createDatabase(':memory:', { forceBuiltin: true });
    for (const stmt of schema) {
        for (const db of [oracle, probe]) {
            try { db.exec(stmt); } catch {}
        }
    }

    // Harvest prepare('…') / prepare("…") / prepare(`…`) literals, including
    // multi-line backtick statements (session-store.js, notes-service.js).
    const files = fs.readdirSync(root)
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(root, f));
    const statements = new Set();
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        const re = /\.prepare\(\s*(['"`])([\s\S]*?)\1\s*\)/g;
        let m;
        while ((m = re.exec(src)) !== null) statements.add(m[2]);
    }
    assert.ok(statements.size > 150, `expected a broad sweep, harvested ${statements.size}`);

    let checked = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const sql of statements) {
        const declared = [...declaredNamedParams(sql)];
        if (!declared.length) continue;
        if (sql.includes('${')) continue; // runtime-interpolated, not preparable as-is

        let nativeStmt;
        let probeStmt;
        try {
            nativeStmt = oracle.prepare(sql);
            probeStmt = probe.prepare(sql);
        } catch {
            continue; // table created at runtime by a service module
        }
        checked += 1;

        const bind = Object.fromEntries(declared.map((n) => [n, null]));

        // A falsely detected parameter surfaces as "Unknown named parameter"
        // from raw node:sqlite, which rejects extras.
        try {
            probeStmt.run(bind);
        } catch (err) {
            if (/Unknown named parameter/.test(String(err.message))) falsePositives += 1;
        }
        // A missed parameter surfaces as better-sqlite3's "Missing named
        // parameter", since it rejects an incomplete bind.
        try {
            nativeStmt.run(bind);
        } catch (err) {
            if (/Missing named parameter/.test(String(err.message))) falseNegatives += 1;
        }
    }

    assert.ok(checked > 20, `expected to verify a meaningful sample, checked ${checked}`);
    assert.equal(falsePositives, 0, 'parser must never invent a parameter');
    assert.equal(falseNegatives, 0, 'parser must never miss a parameter');

    oracle.close();
    probe.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
