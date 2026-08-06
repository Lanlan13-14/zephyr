/*
 * Zephyr SQLite driver selection.
 *
 * Desktop keeps better-sqlite3. Android Node 24 cannot load its Linux native
 * addon, so it uses Node's built-in synchronous SQLite binding instead.
 * The adapter supplies the two better-sqlite3 helpers storage.js relies on.
 */
'use strict';

function shouldUseBuiltin(options = {}) {
    return options.forceBuiltin === true
        || process.platform === 'android'
        || process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE === '1';
}

function attachBetterSqliteHelpers(db) {
    let transactionDepth = 0;
    db.pragma = (source) => {
        const sql = String(source || '').trim();
        if (!sql) return undefined;
        return db.exec(`PRAGMA ${sql}`);
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

module.exports = { createDatabase, shouldUseBuiltin };
