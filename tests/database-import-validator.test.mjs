import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import validatorModule from '../database-import-validator.js';
import sqliteModule from '../sqlite-driver.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const { assertCompleteWalCheckpoint, validateDatabaseCandidate } = validatorModule;
const { createDatabase } = sqliteModule;
const VALIDATOR_ENV = { ...process.env, ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1' };

function setupLiveFixture() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-source-'));
    const keyFile = path.join(dataDir, 'crypto', 'key.json');
    const script = `
      const storage = require('./storage');
      storage.init({ hashPassword: () => 'fixture-hash' });
      storage.updateUser('admin', { totpEnabled: true, totpSecret: 'fixture-totp-secret' });
      storage.rawDb().pragma('wal_checkpoint(TRUNCATE)');
      storage.close();
    `;
    const fixtureEnv = {
        ...process.env,
        ZEPHYR_DATA_DIR: dataDir,
        ZEPHYR_DATA_MLKEM768_KEY_FILE: keyFile,
        ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
    };
    delete fixtureEnv.ZEPHYR_DATA_MLKEM768_PUBLIC_KEY_B64;
    delete fixtureEnv.ZEPHYR_DATA_MLKEM768_SECRET_KEY_B64;
    delete fixtureEnv.DATA_MLKEM768_PUBLIC_KEY_B64;
    delete fixtureEnv.DATA_MLKEM768_SECRET_KEY_B64;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: fixtureEnv,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return {
        dataDir,
        database: fs.readFileSync(path.join(dataDir, 'zephyr.db')),
        key: fs.readFileSync(keyFile),
    };
}

function candidateFrom(database) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-candidate-'));
    fs.writeFileSync(path.join(dir, 'zephyr.db'), database, { mode: 0o600 });
    return dir;
}

function unrelatedKeyBuffer() {
    const publicKey = crypto.randomBytes(1184).toString('base64');
    const secretKey = crypto.randomBytes(2400).toString('base64');
    return Buffer.from(JSON.stringify({ publicKey, secretKey }));
}

function swapDirectoryFromChild(directory, replacementTarget) {
    const moved = `${directory}.moved-${crypto.randomUUID()}`;
    const script = `
      const fs = require('fs');
      const [directory, moved, target, type] = process.argv.slice(1);
      fs.renameSync(directory, moved);
      fs.symlinkSync(target, directory, type);
    `;
    const result = spawnSync(process.execPath, [
        '-e', script, directory, moved, replacementTarget,
        process.platform === 'win32' ? 'junction' : 'dir',
    ], { encoding: 'utf8', windowsHide: true });
    return { moved, result };
}

function removeDirectoryLink(link) {
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(link);
        else fs.unlinkSync(link);
        return;
    }
    fs.rmSync(link, { recursive: true, force: true });
}

test('WAL checkpoint results must be one complete non-busy integer row', () => {
    assert.deepEqual(
        assertCompleteWalCheckpoint([{ busy: 0, log: 7, checkpointed: 7 }]),
        { busy: 0, log: 7, checkpointed: 7 },
    );
    const malformed = [
        undefined,
        [],
        [{ busy: 0, log: 0, checkpointed: 0 }, { busy: 0, log: 0, checkpointed: 0 }],
        [null],
        [{ busy: '0', log: 0, checkpointed: 0 }],
        [{ busy: 0, log: Number.NaN, checkpointed: 0 }],
        [{ busy: 0, log: Number.POSITIVE_INFINITY, checkpointed: 0 }],
        [{ busy: 0, log: -1, checkpointed: -1 }],
        [{ busy: 0, log: 1.5, checkpointed: 1.5 }],
        [{ busy: 0, log: Number.MAX_SAFE_INTEGER + 1, checkpointed: 0 }],
        [Object.create({ busy: 0, log: 0, checkpointed: 0 })],
    ];
    for (const result of malformed) {
        assert.throws(
            () => assertCompleteWalCheckpoint(result),
            (error) => error?.code === 'import_validation_failed' && /invalid result/i.test(error.message),
        );
    }
    assert.throws(
        () => assertCompleteWalCheckpoint([{ busy: 1, log: 1, checkpointed: 0 }]),
        (error) => error?.code === 'import_validation_failed' && /busy/i.test(error.message),
    );
    assert.throws(
        () => assertCompleteWalCheckpoint([{ busy: 0, log: 2, checkpointed: 1 }]),
        (error) => error?.code === 'import_validation_failed' && /incomplete/i.test(error.message),
    );
});

test('isolated validation runs real storage migrations and verifies encrypted fields', async () => {
    const fixture = setupLiveFixture();
    const validDir = candidateFrom(fixture.database);
    const wrongKeyDir = candidateFrom(fixture.database);
    try {
        let result;
        try {
            result = await validateDatabaseCandidate({
                candidateDir: validDir,
                keyBuffer: fixture.key,
                env: VALIDATOR_ENV,
            });
        } catch (error) {
            assert.fail(`correct-key candidate failed: ${error.detail || error.code}`);
        }
        assert.equal(result.databaseFile, path.join(validDir, 'zephyr.db'));

        await assert.rejects(
            validateDatabaseCandidate({
                candidateDir: wrongKeyDir,
                keyBuffer: unrelatedKeyBuffer(),
                env: VALIDATOR_ENV,
            }),
            (error) => error?.code === 'import_validation_failed',
        );
    } finally {
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
        fs.rmSync(validDir, { recursive: true, force: true });
        fs.rmSync(wrongKeyDir, { recursive: true, force: true });
    }
});

test('a structurally valid SQLite file with an incompatible schema fails before live maintenance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-incompatible-'));
    const databaseFile = path.join(dir, 'zephyr.db');
    const db = createDatabase(databaseFile, { forceBuiltin: true });
    db.exec('CREATE TABLE users (username TEXT PRIMARY KEY); INSERT INTO users(username) VALUES (\'admin\');');
    db.close();
    try {
        await assert.rejects(
            validateDatabaseCandidate({ candidateDir: dir, env: VALIDATOR_ENV }),
            (error) => error?.code === 'import_validation_failed',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a busy WAL checkpoint rejects the candidate before installation', async () => {
    const fixture = setupLiveFixture();
    const candidate = candidateFrom(fixture.database);
    const databaseFile = path.join(candidate, 'zephyr.db');
    const reader = createDatabase(databaseFile, { forceBuiltin: true });
    const writer = createDatabase(databaseFile, { forceBuiltin: true });
    try {
        writer.pragma('journal_mode = WAL');
        writer.exec('CREATE TABLE checkpoint_busy_probe (value INTEGER NOT NULL); INSERT INTO checkpoint_busy_probe VALUES (1)');
        reader.exec('BEGIN');
        reader.prepare('SELECT COUNT(*) AS count FROM checkpoint_busy_probe').get();
        writer.exec('INSERT INTO checkpoint_busy_probe VALUES (2)');

        await assert.rejects(
            validateDatabaseCandidate({
                candidateDir: candidate,
                keyBuffer: fixture.key,
                env: VALIDATOR_ENV,
            }),
            (error) => error?.code === 'import_validation_failed'
                && /checkpoint.*busy/i.test(String(error.detail || '')),
        );
        assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM checkpoint_busy_probe').get().count, 1);
    } finally {
        try { reader.exec('ROLLBACK'); } catch {}
        reader.close();
        writer.close();
        fs.rmSync(candidate, { recursive: true, force: true });
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
});

test('validation refuses candidate-directory junctions and database symbolic links', async (t) => {
    const fixture = setupLiveFixture();
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-link-'));
    const linkedCandidate = path.join(linkRoot, 'candidate');
    const fileLinkCandidate = candidateFrom(fixture.database);
    try {
        fs.symlinkSync(fixture.dataDir, linkedCandidate, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(
            validateDatabaseCandidate({ candidateDir: linkedCandidate, env: VALIDATOR_ENV }),
            /validation directory is invalid/i,
        );

        fs.rmSync(path.join(fileLinkCandidate, 'zephyr.db'));
        try {
            fs.symlinkSync(path.join(fixture.dataDir, 'zephyr.db'), path.join(fileLinkCandidate, 'zephyr.db'), 'file');
        } catch (error) {
            if (process.platform === 'win32' && error?.code === 'EPERM') {
                t.diagnostic('file symlink creation requires Developer Mode; junction rejection remains covered');
                return;
            }
            throw error;
        }
        await assert.rejects(
            validateDatabaseCandidate({ candidateDir: fileLinkCandidate, env: VALIDATOR_ENV }),
            /backup database is missing/i,
        );
    } finally {
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
        fs.rmSync(linkRoot, { recursive: true, force: true });
        fs.rmSync(fileLinkCandidate, { recursive: true, force: true });
    }
});

test('a child-process candidate swap is rejected before the isolated validator is released', async (t) => {
    const fixture = setupLiveFixture();
    const candidate = candidateFrom(fixture.database);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-race-outside-'));
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-data', { mode: 0o600 });
    let attack = null;
    try {
        const validation = validateDatabaseCandidate({
            candidateDir: candidate,
            keyBuffer: fixture.key,
            env: VALIDATOR_ENV,
            afterSpawn() {
                attack = swapDirectoryFromChild(candidate, outside);
            },
        });
        if (!attack || attack.result.status !== 0) {
            await assert.rejects(validation);
            t.skip(`the platform denied the competing rename: ${attack?.result.stderr || 'not attempted'}`);
            return;
        }
        await assert.rejects(
            validation,
            /validation directory changed before isolated validation/i,
        );
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-data');
        assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
    } finally {
        try { removeDirectoryLink(candidate); } catch {}
        if (attack?.moved) fs.rmSync(attack.moved, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
});
