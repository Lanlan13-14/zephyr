/*
 * Zephyr SQLite driver selection.
 *
 * Desktop keeps better-sqlite3. Android Node cannot load its Linux native
 * addon, and Zephyr One sets ZEPHYR_ONE_USE_BUILTIN_SQLITE=1 on every
 * platform, so the built-in binding must be a faithful drop-in for the
 * better-sqlite3 surface storage.js / session-store.js / user-service.js use.
 *
 * Named-parameter binding diverges in BOTH directions, verified against both
 * drivers on Node 22:
 *
 *   case            node:sqlite (raw)   better-sqlite3
 *   complete        ok                  ok
 *   extra key       THROWS              ok (ignores extras)
 *   missing key     silently binds NULL THROWS
 *
 * The `extra key` row is what crashed the core: storage.updateUser() passes a
 * whole row object into a statement naming a subset of columns, so
 * `POST /api/auth/change-password` threw `Unknown named parameter 'createdAt'`,
 * and with no Express error handler that rejection killed the process.
 *
 * The `missing key` row is the more dangerous one: a typo'd or absent field
 * writes NULL instead of failing, where better-sqlite3 would have thrown. Both
 * rows are closed here by binding only declared parameters and requiring all of
 * them to be present, so the built-in driver matches better-sqlite3 exactly.
 */
'use strict';

function shouldUseBuiltin(options = {}) {
    return options.forceBuiltin === true
        || process.platform === 'android'
        || process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE === '1';
}

/**
 * Collect the named parameters declared by a SQL statement.
 *
 * SQLite accepts `@name`, `:name` and `$name`. Quoted regions must be skipped
 * or an email literal, a `--` comment or a `"quoted @ident"` would register as
 * a parameter.
 *
 * A missed parameter only degrades to the driver's own lenient behaviour, while
 * a falsely detected one would break a working query — so the accompanying test
 * asserts zero false positives across every real statement in the repo.
 *
 * @param {string} sql
 * @returns {Set<string>}
 */
function declaredNamedParams(sql) {
    const text = String(sql || '');
    const found = new Set();
    const isNameStart = (ch) => /[A-Za-z_]/.test(ch);
    const isNameChar = (ch) => /[A-Za-z0-9_]/.test(ch);

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        // ── skip quoted / commented regions ──
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            i += 1;
            while (i < text.length) {
                if (text[i] === quote) {
                    if (text[i + 1] === quote) { i += 2; continue; } // '' escape
                    break;
                }
                i += 1;
            }
            continue;
        }
        if (ch === '[') {
            while (i < text.length && text[i] !== ']') i += 1;
            continue;
        }
        if (ch === '-' && text[i + 1] === '-') {
            while (i < text.length && text[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
            i += 1;
            continue;
        }

        // ── parameter sigils ──
        if (ch === '@' || ch === ':' || ch === '$') {
            // `::` is not a SQLite parameter; skip the pair outright.
            if (ch === ':' && text[i + 1] === ':') { i += 1; continue; }
            let j = i + 1;
            if (j < text.length && isNameStart(text[j])) {
                let name = '';
                while (j < text.length && isNameChar(text[j])) { name += text[j]; j += 1; }
                found.add(name);
                i = j - 1;
            }
        }
    }
    return found;
}

/**
 * Give a node:sqlite statement better-sqlite3's named-parameter semantics:
 * extra keys ignored, missing keys rejected.
 *
 * Array/positional binding and zero-parameter statements pass through
 * untouched.
 *
 * @param {object} statement node:sqlite StatementSync
 * @param {string} sql the statement's source, for parameter discovery
 */
function alignNamedParams(statement, sql) {
    const declared = declaredNamedParams(sql);
    if (!declared.size) return statement;

    /* Extra keys are dropped by filtering rather than by
     * setAllowUnknownNamedParameters(true): that flag also suppresses the
     * missing-key error, which is the divergence being closed here. */
    const normalise = (args) => args.map((arg) => {
        const isPlainObject = arg
            && typeof arg === 'object'
            && !Array.isArray(arg)
            && !Buffer.isBuffer(arg)
            && !(arg instanceof Uint8Array);
        if (!isPlainObject) return arg;

        const bound = {};
        const missing = [];
        for (const name of declared) {
            if (Object.prototype.hasOwnProperty.call(arg, name)) bound[name] = arg[name];
            else missing.push(name);
        }
        if (missing.length) {
            throw new RangeError(
                `Missing named parameter${missing.length > 1 ? 's' : ''} "${missing.join('", "')}"`,
            );
        }
        return bound;
    });

    for (const method of ['run', 'get', 'all', 'iterate']) {
        const original = statement[method];
        if (typeof original !== 'function') continue;
        statement[method] = (...args) => original.apply(statement, normalise(args));
    }
    return statement;
}

function attachBetterSqliteHelpers(db) {
    let transactionDepth = 0;

    /* Wrapping prepare() covers every statement in the product, including
     * those built straight off storage.rawDb() by server.js, session-store.js
     * and user-service.js. */
    const nativePrepare = db.prepare.bind(db);
    db.prepare = (sql) => alignNamedParams(nativePrepare(sql), sql);

    /* better-sqlite3's pragma() returns rows; exec() returns undefined, which
     * silently breaks read pragmas such as `PRAGMA journal_mode`. Prepared
     * execution returns real rows for every pragma this product issues
     * (journal_mode, secure_delete, wal_checkpoint), with exec() kept as the
     * fallback for any pragma SQLite refuses to prepare. */
    db.pragma = (source) => {
        const sql = String(source || '').trim();
        if (!sql) return undefined;
        try {
            return nativePrepare(`PRAGMA ${sql}`).all();
        } catch {
            return db.exec(`PRAGMA ${sql}`);
        }
    };

    db.transaction = (fn) => {
        if (typeof fn !== 'function') throw new TypeError('transaction callback must be a function');
        return (...args) => {
            const savepoint = `zephyr_tx_${transactionDepth}`;
            const outermost = transactionDepth === 0;
            transactionDepth += 1;
            db.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
            try {
                const value = fn(...args);
                db.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
                return value;
            } catch (error) {
                try {
                    db.exec(outermost
                        ? 'ROLLBACK'
                        : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
                } catch {}
                throw error;
            } finally {
                transactionDepth -= 1;
            }
        };
    };
    return db;
}

function createDatabase(filename, options = {}) {
    if (shouldUseBuiltin(options)) {
        const { DatabaseSync } = require('node:sqlite');
        return attachBetterSqliteHelpers(new DatabaseSync(filename));
    }
    const Database = require('better-sqlite3');
    return new Database(filename);
}

module.exports = { createDatabase, shouldUseBuiltin, declaredNamedParams };
