import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import journalModule from '../database-import-install-journal.js';

const {
    CLEANUP_NAME,
    JOURNAL_AUTH_KEY_NAME,
    JOURNAL_NAME,
    acquireImportCleanupLease,
    beginImportInstall,
    cleanupImportOrphans,
    commitImportInstall,
    installPreparedImport,
    recoverImportInstall,
} = journalModule;

const ROOT = path.resolve(import.meta.dirname, '..');
const LEASE_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'database-import-cleanup-lease-child.cjs');

function fixture() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-journal-security-'));
    const databaseFile = path.join(dataDir, 'zephyr.db');
    const candidateDatabaseFile = path.join(dataDir, 'candidate.db');
    fs.writeFileSync(databaseFile, 'old-generation', { mode: 0o600 });
    fs.writeFileSync(candidateDatabaseFile, 'new-generation', { mode: 0o600 });
    return { dataDir, databaseFile, candidateDatabaseFile };
}

function observeLeaseChild(mode, files) {
    const child = spawn(process.execPath, [LEASE_FIXTURE, mode, files.dataDir], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const messages = [];
    const waiters = [];
    let stdout = '';
    let stderr = '';
    const deliver = (message) => {
        messages.push(message);
        for (const waiter of [...waiters]) {
            if (!waiter.predicate(message)) continue;
            clearTimeout(waiter.timer);
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
        }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline).trim();
            stdout = stdout.slice(newline + 1);
            if (!line) continue;
            deliver(JSON.parse(line));
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return {
        child,
        waitFor(predicate, timeoutMs = 15_000) {
            const previous = messages.find(predicate);
            if (previous) return Promise.resolve(previous);
            return new Promise((resolve, reject) => {
                const waiter = { predicate, resolve, timer: null };
                waiter.timer = setTimeout(() => {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    reject(new Error(`cleanup lease child did not respond:\n${stdout}\n${stderr}`));
                }, timeoutMs);
                waiters.push(waiter);
            });
        },
    };
}

async function terminateLeaseChild(observed) {
    const { child } = observed;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
}

function leaveCommittedJournal(files) {
    const transaction = beginImportInstall({ ...files, keyChanged: false });
    installPreparedImport(transaction);
    assert.throws(
        () => commitImportInstall(transaction, {
            faultInjector(stage) {
                if (stage === 'after_journal_committed') throw new Error('leave committed journal');
            },
        }),
        /leave committed journal/,
    );
    const journalFile = path.join(files.dataDir, JOURNAL_NAME);
    return {
        journalFile,
        original: fs.readFileSync(journalFile, 'utf8'),
        parsed: JSON.parse(fs.readFileSync(journalFile, 'utf8')),
        transaction,
    };
}

test('journal HMAC rejects same-length state downgrade and every recovery-bearing identity field', () => {
    const files = fixture();
    try {
        const { journalFile, original, parsed } = leaveCommittedJournal(files);
        assert.equal(parsed.state, 'COMMITTED');
        assert.equal(parsed.state.length, 'INSTALLED'.length);

        const mutations = [
            ['state', (row) => { row.state = 'INSTALLED'; }],
            ['id', (row) => { row.id = `${row.id[0] === 'a' ? 'b' : 'a'}${row.id.slice(1)}`; }],
            ['nonce', (row) => { row.nonce = `${row.nonce[0] === 'A' ? 'B' : 'A'}${row.nonce.slice(1)}`; }],
            ['path', (row) => { row.databaseTarget = path.join(files.dataDir, 'other.db'); }],
            ['old hash', (row) => { row.databaseOldSha256 = `${row.databaseOldSha256[0] === 'a' ? 'b' : 'a'}${row.databaseOldSha256.slice(1)}`; }],
            ['new hash', (row) => { row.databaseNewSha256 = `${row.databaseNewSha256[0] === 'a' ? 'b' : 'a'}${row.databaseNewSha256.slice(1)}`; }],
        ];
        for (const [label, mutate] of mutations) {
            const row = JSON.parse(original);
            mutate(row);
            fs.writeFileSync(journalFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
            assert.throws(
                () => recoverImportInstall(files),
                (error) => error?.code === 'database_import_recovery_failed',
                label,
            );
            assert.equal(fs.readFileSync(files.databaseFile, 'utf8'), 'new-generation', label);
        }
        fs.writeFileSync(journalFile, original, { mode: 0o600 });
        assert.deepEqual(recoverImportInstall(files), { recovered: true, generation: 'new' });
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('transaction handles are bound to the authenticated cleanup nonce', () => {
    const files = fixture();
    try {
        const transaction = beginImportInstall({ ...files, keyChanged: false });
        assert.throws(
            () => installPreparedImport({ ...transaction, nonce: 'A'.repeat(43) }),
            /not in the prepared state/,
        );
        installPreparedImport(transaction);
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('a live cleanup lease blocks a concurrent import in the same data directory', () => {
    const files = fixture();
    try {
        acquireImportCleanupLease(files);
        assert.throws(
            () => acquireImportCleanupLease(files),
            /cleanup lease is already active/,
        );
        cleanupImportOrphans(files);
        acquireImportCleanupLease(files);
        cleanupImportOrphans(files);
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('a terminal journal retries transient cleanup under the same held lease', () => {
    const files = fixture();
    try {
        const transaction = beginImportInstall({ ...files, keyChanged: false });
        installPreparedImport(transaction);
        let injectOnce = true;
        const deferred = commitImportInstall(transaction, {
            faultInjector(stage) {
                if (injectOnce && stage === 'import:sensitive_cleanup:scrubbed') {
                    injectOnce = false;
                    throw new Error('transient snapshot cleanup failure');
                }
            },
        });
        assert.match(deferred.cleanupError?.message || '', /artifact cleanup failed/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(files.dataDir, JOURNAL_NAME), 'utf8')).state, 'COMMITTED');
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), true);
        assert.throws(() => acquireImportCleanupLease(files), /cleanup lease is already active/);

        const retried = commitImportInstall(transaction);
        assert.equal(retried.cleanupError, null);
        assert.equal(fs.existsSync(path.join(files.dataDir, JOURNAL_NAME)), false);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), true);
        cleanupImportOrphans(files);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), false);
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('two independent child processes race for one exclusive cleanup lease', async () => {
    const files = fixture();
    const first = observeLeaseChild('race', files);
    const second = observeLeaseChild('race', files);
    try {
        await Promise.all([
            first.waitFor((message) => message.event === 'ready'),
            second.waitFor((message) => message.event === 'ready'),
        ]);
        fs.writeFileSync(path.join(files.dataDir, '.zephyr-import-cleanup-race-go'), 'go\n', { mode: 0o600 });
        const [firstResult, secondResult] = await Promise.all([
            first.waitFor((message) => message.event === 'result'),
            second.waitFor((message) => message.event === 'result'),
        ]);
        const winners = [
            [first, firstResult],
            [second, secondResult],
        ].filter(([, result]) => result.ok);
        assert.equal(winners.length, 1, JSON.stringify([firstResult, secondResult]));
        assert.match(
            [firstResult, secondResult].find((result) => !result.ok)?.message || '',
            /cleanup lease is already active/,
        );

        const marker = JSON.parse(fs.readFileSync(path.join(files.dataDir, CLEANUP_NAME), 'utf8'));
        assert.equal(marker.nonce, winners[0][1].lease.nonce);
        assert.throws(() => cleanupImportOrphans(files), /cleanup lease is already active/);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(files.dataDir, CLEANUP_NAME), 'utf8')).nonce,
            winners[0][1].lease.nonce,
        );
    } finally {
        await terminateLeaseChild(first);
        await terminateLeaseChild(second);
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('publish-racing child processes never observe a partial cleanup marker', async () => {
    for (let round = 0; round < 8; round += 1) {
        const files = fixture();
        const first = observeLeaseChild('publish-race', files);
        const second = observeLeaseChild('publish-race', files);
        try {
            await Promise.all([
                first.waitFor((message) => message.event === 'publish_ready'),
                second.waitFor((message) => message.event === 'publish_ready'),
            ]);
            fs.writeFileSync(path.join(files.dataDir, '.zephyr-import-cleanup-publish-go'), 'go\n', { mode: 0o600 });
            const [firstResult, secondResult] = await Promise.all([
                first.waitFor((message) => message.event === 'result'),
                second.waitFor((message) => message.event === 'result'),
            ]);
            const results = [firstResult, secondResult];
            const winner = results.find((result) => result.ok);
            const loser = results.find((result) => !result.ok);
            assert.ok(winner, `round ${round}: ${JSON.stringify(results)}`);
            assert.equal(results.filter((result) => result.ok).length, 1, `round ${round}`);
            assert.match(loser?.message || '', /cleanup lease is already active/, `round ${round}`);
            assert.doesNotThrow(() => JSON.parse(
                fs.readFileSync(path.join(files.dataDir, CLEANUP_NAME), 'utf8'),
            ));
            assert.equal(
                JSON.parse(fs.readFileSync(path.join(files.dataDir, CLEANUP_NAME), 'utf8')).nonce,
                winner.lease.nonce,
                `round ${round}`,
            );
        } finally {
            await terminateLeaseChild(first);
            await terminateLeaseChild(second);
            cleanupImportOrphans(files);
            assert.deepEqual(
                fs.readdirSync(files.dataDir).filter((name) => /\.zephyr-import-cleanup.*\.tmp$/i.test(name)),
                [],
                `round ${round}: private publication temps must be removed`,
            );
            fs.rmSync(files.dataDir, { recursive: true, force: true });
        }
    }
});

test('a killed child lease holder is recovered once, and a stale nonce cannot clear its winner', async () => {
    const files = fixture();
    const holder = observeLeaseChild('hold', files);
    try {
        const held = await holder.waitFor((message) => message.event === 'result' && message.ok);
        const archive = path.join(files.dataDir, '.zephyr-import-archive-holder.zip');
        fs.writeFileSync(archive, 'credential-bearing-archive', { mode: 0o600 });
        assert.throws(() => cleanupImportOrphans(files), /cleanup lease is already active/);
        assert.equal(fs.existsSync(archive), true);

        await terminateLeaseChild(holder);
        const winner = acquireImportCleanupLease(files);
        assert.notEqual(winner.nonce, held.lease.nonce);
        assert.equal(fs.existsSync(archive), false, 'the recovered holder owns archive cleanup');
        assert.throws(
            () => cleanupImportOrphans({ ...files, cleanupLease: held.lease }),
            /cleanup lease is unavailable/,
        );
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(files.dataDir, CLEANUP_NAME), 'utf8')).nonce,
            winner.nonce,
            'a losing stale holder must not delete the winner marker',
        );
        cleanupImportOrphans(files);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), false);
    } finally {
        await terminateLeaseChild(holder);
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('stale recovery uses process creation identity, not a wall-clock age', async () => {
    const files = fixture();
    const liveProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
    });
    try {
        await new Promise((resolve, reject) => {
            liveProcess.once('spawn', resolve);
            liveProcess.once('error', reject);
        });
        const stale = {
            version: 1,
            id: crypto.randomUUID(),
            nonce: crypto.randomBytes(32).toString('base64url'),
            ownerPid: liveProcess.pid,
            ownerStartToken: 'recycled.process-start-token',
            createdAt: Date.now() + 365 * 24 * 60 * 60 * 1_000,
        };
        fs.writeFileSync(path.join(files.dataDir, CLEANUP_NAME), `${JSON.stringify(stale)}\n`, { mode: 0o600 });
        const winner = acquireImportCleanupLease(files);
        assert.notEqual(winner.nonce, stale.nonce);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(files.dataDir, CLEANUP_NAME), 'utf8')).nonce,
            winner.nonce,
        );
        cleanupImportOrphans(files);
    } finally {
        if (liveProcess.exitCode === null) liveProcess.kill('SIGKILL');
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('POSIX cleanup ownership refuses unsafe marker permissions', {
    skip: process.platform === 'win32',
}, () => {
    const files = fixture();
    try {
        acquireImportCleanupLease(files);
        const marker = path.join(files.dataDir, CLEANUP_NAME);
        fs.chmodSync(marker, 0o644);
        assert.throws(() => cleanupImportOrphans(files), /permissions are unsafe/);
        assert.equal(fs.existsSync(marker), true);
        fs.chmodSync(marker, 0o600);
        cleanupImportOrphans(files);
    } finally {
        try { fs.chmodSync(path.join(files.dataDir, CLEANUP_NAME), 0o600); } catch {}
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('Windows keeps cleanup marker creation exclusive', {
    skip: process.platform !== 'win32',
}, () => {
    const files = fixture();
    try {
        acquireImportCleanupLease(files);
        assert.throws(
            () => fs.openSync(path.join(files.dataDir, CLEANUP_NAME), 'wx'),
            (error) => error?.code === 'EEXIST',
        );
        cleanupImportOrphans(files);
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('a missing machine-local authentication key is never regenerated around an active journal', () => {
    const files = fixture();
    try {
        leaveCommittedJournal(files);
        const authKeyFile = path.join(files.dataDir, JOURNAL_AUTH_KEY_NAME);
        assert.equal(fs.statSync(authKeyFile).size, 32);
        fs.unlinkSync(authKeyFile);
        fs.writeFileSync(path.join(files.dataDir, '.zephyr-import-archive-forged.zip'), Buffer.alloc(32, 7));
        assert.throws(
            () => recoverImportInstall(files),
            (error) => error?.code === 'database_import_recovery_failed'
                && /authentication key is unavailable/.test(error.message),
        );
        assert.equal(fs.existsSync(authKeyFile), false);
        assert.equal(fs.readFileSync(files.databaseFile, 'utf8'), 'new-generation');
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('unsafe authentication-key permissions fail closed on POSIX', {
    skip: process.platform === 'win32',
}, () => {
    const files = fixture();
    try {
        recoverImportInstall(files);
        const authKeyFile = path.join(files.dataDir, JOURNAL_AUTH_KEY_NAME);
        fs.chmodSync(authKeyFile, 0o644);
        assert.throws(
            () => recoverImportInstall(files),
            (error) => error?.code === 'database_import_recovery_failed'
                && /permissions are unsafe/.test(error.message),
        );
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('recursive cleanup removes nested database, key, WAL and temp residues', () => {
    const files = fixture();
    try {
        acquireImportCleanupLease(files);
        const candidateDir = path.join(files.dataDir, '.zephyr-import-validation-recursive');
        const cryptoDir = path.join(candidateDir, 'crypto');
        const nestedDir = path.join(candidateDir, 'nested', 'deeper');
        fs.mkdirSync(cryptoDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(nestedDir, { recursive: true, mode: 0o700 });
        for (const [file, contents] of [
            [path.join(candidateDir, 'zephyr.db'), 'candidate-database'],
            [path.join(candidateDir, 'zephyr.db-wal'), 'candidate-wal'],
            [path.join(candidateDir, 'zephyr.db-shm'), 'candidate-shm'],
            [path.join(cryptoDir, 'ml-kem-768-keypair.json'), 'candidate-key'],
            [path.join(nestedDir, '.candidate.atomic.tmp'), 'candidate-temp'],
        ]) {
            fs.writeFileSync(file, contents, { mode: 0o600 });
        }

        cleanupImportOrphans(files);
        assert.equal(fs.existsSync(candidateDir), false);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), false);
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('recursive cleanup scrubs nested candidates and never follows symlinks', (t) => {
    const files = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-cleanup-outside-'));
    try {
        acquireImportCleanupLease(files);
        const candidateDir = path.join(files.dataDir, '.zephyr-import-validation-symlink');
        const nested = path.join(candidateDir, 'nested');
        fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(nested, 'zephyr.db-wal'), 'credential-bearing-wal', { mode: 0o600 });
        const outsideSecret = path.join(outside, 'outside-secret');
        fs.writeFileSync(outsideSecret, 'must-survive', { mode: 0o600 });
        try {
            fs.symlinkSync(
                outside,
                path.join(candidateDir, 'outside-link'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        } catch (error) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
                t.skip(`symlink creation unavailable: ${error.code}`);
                return;
            }
            throw error;
        }

        if (process.platform === 'win32') {
            assert.throws(
                () => cleanupImportOrphans(files),
                (error) => error instanceof AggregateError
                    && error.errors.some((item) => /must not be a Windows reparse point/.test(item?.message)),
            );
            assert.equal(fs.readFileSync(outsideSecret, 'utf8'), 'must-survive');
            assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), true);
            fs.rmdirSync(path.join(candidateDir, 'outside-link'));
        }
        cleanupImportOrphans(files);
        assert.equal(fs.existsSync(candidateDir), false);
        assert.equal(fs.readFileSync(outsideSecret, 'utf8'), 'must-survive');
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), false);
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('a real permission failure retains pending cleanup and a later retry removes every residue', {
    skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
}, () => {
    const files = fixture();
    try {
        acquireImportCleanupLease(files);
        const candidateDir = path.join(files.dataDir, '.zephyr-import-validation-permission');
        const secretFile = path.join(candidateDir, 'zephyr.db');
        fs.mkdirSync(candidateDir, { mode: 0o700 });
        fs.writeFileSync(secretFile, 'candidate-secret', { mode: 0o600 });
        fs.chmodSync(secretFile, 0o400);

        assert.throws(() => cleanupImportOrphans(files), /could not be removed/);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), true);
        assert.equal(fs.existsSync(secretFile), true);

        fs.chmodSync(secretFile, 0o600);
        cleanupImportOrphans(files);
        assert.equal(fs.existsSync(candidateDir), false);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), false);
    } finally {
        try { fs.chmodSync(path.join(files.dataDir, '.zephyr-import-validation-permission', 'zephyr.db'), 0o600); } catch {}
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('a real Windows exclusive lock retains pending cleanup until the next retry', {
    skip: process.platform !== 'win32',
}, async () => {
    const files = fixture();
    let locker = null;
    try {
        acquireImportCleanupLease(files);
        const archiveFile = path.join(files.dataDir, '.zephyr-import-archive-lock.zip');
        fs.writeFileSync(archiveFile, 'decrypted-archive-secret', { mode: 0o600 });
        const script = [
            '$stream = [System.IO.File]::Open($env:ZEPHYR_IMPORT_LOCK_FILE, [System.IO.FileMode]::Open,',
            '[System.IO.FileAccess]::Read, [System.IO.FileShare]::None);',
            '[Console]::Out.WriteLine("ready");',
            '[Console]::Out.Flush();',
            'Start-Sleep -Seconds 30',
        ].join(' ');
        locker = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
            env: { ...process.env, ZEPHYR_IMPORT_LOCK_FILE: archiveFile },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        await new Promise((resolve, reject) => {
            let stdout = '';
            const timer = setTimeout(() => reject(new Error('exclusive-lock helper did not start')), 10_000);
            locker.once('error', reject);
            locker.stdout.on('data', (chunk) => {
                stdout += chunk;
                if (stdout.includes('ready')) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });

        assert.throws(() => cleanupImportOrphans(files), /could not be removed/);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), true);
        assert.equal(fs.existsSync(archiveFile), true);

        locker.kill('SIGKILL');
        await new Promise((resolve) => locker.once('exit', resolve));
        locker = null;
        cleanupImportOrphans(files);
        assert.equal(fs.existsSync(archiveFile), false);
        assert.equal(fs.existsSync(path.join(files.dataDir, CLEANUP_NAME)), false);
    } finally {
        if (locker?.exitCode === null) locker.kill('SIGKILL');
        fs.rmSync(files.dataDir, { recursive: true, force: true });
    }
});

test('journal and cleanup symlinks fail closed without touching their targets', (t) => {
    const files = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-journal-link-'));
    try {
        recoverImportInstall(files);
        const outsideFile = path.join(outside, 'target');
        fs.writeFileSync(outsideFile, '{}\n', { mode: 0o600 });
        const journalFile = path.join(files.dataDir, JOURNAL_NAME);
        try {
            fs.symlinkSync(outsideFile, journalFile, 'file');
        } catch (error) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
                t.skip(`symlink creation unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        assert.throws(() => recoverImportInstall(files), /journal file is invalid/);
        assert.equal(fs.readFileSync(outsideFile, 'utf8'), '{}\n');
    } finally {
        fs.rmSync(files.dataDir, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
