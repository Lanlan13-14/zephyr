import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDatabase, shouldUseBuiltin } = require('../sqlite-driver.js');

test('Android selects Node built-in SQLite and keeps storage helpers', () => {
    assert.equal(shouldUseBuiltin({ forceBuiltin: true }), true);
    assert.equal(shouldUseBuiltin(), process.platform === 'android');
    const oldFlag = process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
    process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = '1';
    assert.equal(shouldUseBuiltin(), true);
    if (oldFlag === undefined) delete process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
    else process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = oldFlag;
    const db = createDatabase(':memory:', { forceBuiltin: true });
    db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const add = db.prepare('INSERT INTO records(value) VALUES (@value)');
    db.transaction((value) => add.run({ value }))('first');
    assert.deepEqual({ ...db.prepare('SELECT value FROM records').get() }, { value: 'first' });
    assert.doesNotThrow(() => db.pragma('journal_mode = WAL'));
    assert.throws(() => db.transaction(() => {
        add.run({ value: 'rolled-back' });
        throw new Error('intentional rollback');
    })(), /intentional rollback/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM records').get().count, 1);
    db.transaction(() => {
        add.run({ value: 'outer' });
        db.transaction(() => add.run({ value: 'inner' }))();
    })();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM records').get().count, 3);
    db.close();
});

test('desktop selection remains native unless built-in is explicitly requested', () => {
    if (process.platform === 'android') return;
    assert.equal(shouldUseBuiltin(), false);
});
