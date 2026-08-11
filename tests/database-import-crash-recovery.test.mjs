import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'database-import-crash-child.cjs');
const SIDECAR_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'database-import-sidecar-crash-child.cjs');

function runFixture(args, { expectCrash = false, fixture = FIXTURE } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fixture, ...args], {
            cwd: ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (expectCrash) {
                if (code === 0 && signal === null) {
                    reject(new Error(`fixture did not crash:\n${stdout}\n${stderr}`));
                    return;
                }
                resolve({ code, signal, stdout, stderr });
                return;
            }
            if (code !== 0) {
                reject(new Error(`fixture failed (${code || signal}):\n${stdout}\n${stderr}`));
                return;
            }
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function crashAndRecover(mode, stage, expectedGeneration) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-crash-'));
    try {
        await runFixture(['setup', directory]);
        await runFixture([mode, directory, stage], { expectCrash: true });
        const recovered = await runFixture(['recover', directory]);
        const line = recovered.stdout.trim().split(/\r?\n/).at(-1);
        const result = JSON.parse(line);
        assert.equal(result.database.generation, expectedGeneration, stage);
        assert.equal(
            result.plaintext,
            expectedGeneration === 'new' ? 'new-generation-readable' : 'old-generation-readable',
            `${stage}: database and key must recover as one readable generation`,
        );
        assert.equal(result.database.archivedCredential, null, `${stage}: archived credentials must not replay`);
        assert.equal(result.archivedCredentialStatus, 401, `${stage}: prepared archived credential must be unauthorized`);
        if (expectedGeneration === 'new') assert.equal(result.database.candidatePrepared, true);
        assert.equal(fs.existsSync(path.join(directory, '.zephyr-import-journal.v1.json')), false);
        const residues = [];
        const visit = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory() && !entry.isSymbolicLink()) visit(full);
                else if ((/^\.zephyr-import-/.test(entry.name)
                    && entry.name !== '.zephyr-import-journal-auth.v1.key')
                    || /^\.\.zephyr-import-journal\.v1\.json\.journal-[0-9a-z-]+\.tmp$/i.test(entry.name)
                    || /^\.(?:zephyr\.db|key\.json)\.(?:import-old|import-new|key|restore-key)-\d+-[0-9a-f-]{36}\.tmp$/i.test(entry.name)) {
                    residues.push(path.relative(directory, full));
                }
            }
        };
        visit(directory);
        assert.deepEqual(residues, [], `${stage}: recovery must remove journal and rollback secrets`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('hard kills throughout candidate, key, database and journal installation recover the old generation', async () => {
    const stages = [
        'after_candidate_prepared',
        'import:snapshot:old_database:written',
        'import:snapshot:old_database:fsynced',
        'import:snapshot:old_database:directory_fsynced',
        'import:snapshot:new_database:written',
        'import:snapshot:new_database:fsynced',
        'import:snapshot:new_database:directory_fsynced',
        'import:snapshot:old_key:written',
        'import:snapshot:old_key:fsynced',
        'import:snapshot:old_key:directory_fsynced',
        'import:snapshot:new_key:written',
        'import:snapshot:new_key:fsynced',
        'import:snapshot:new_key:directory_fsynced',
        'import:journal:prepared:temp_written',
        'import:journal:prepared:temp_fsynced',
        'import:journal:prepared:renamed',
        'import:journal:prepared:target_fsynced',
        'import:journal:prepared:directory_fsynced',
        'after_journal_prepared',
        'import:journal:installing:temp_written',
        'import:journal:installing:temp_fsynced',
        'import:journal:installing:renamed',
        'import:journal:installing:target_fsynced',
        'import:journal:installing:directory_fsynced',
        'after_journal_installing',
        'install:new:key:temp_written',
        'install:new:key:temp_fsynced',
        'install:new:key:renamed',
        'install:new:key:target_fsynced',
        'install:new:key:directory_fsynced',
        'after_new_key_install',
        'install:new:database:temp_written',
        'install:new:database:temp_fsynced',
        'install:new:database:renamed',
        'install:new:database:target_fsynced',
        'install:new:database:directory_fsynced',
        'after_new_database_install',
        'import:journal:installed:temp_written',
        'import:journal:installed:temp_fsynced',
        'import:journal:installed:renamed',
        'import:journal:installed:target_fsynced',
        'import:journal:installed:directory_fsynced',
        'after_journal_installed',
    ];
    for (const stage of stages) await crashAndRecover('crash-install', stage, 'old');
});

test('a durable commit survives hard kill before or during journal cleanup', async () => {
    for (const stage of [
        'import:journal:committed:renamed',
        'import:journal:committed:target_fsynced',
        'import:journal:committed:directory_fsynced',
        'after_journal_committed',
        'import:journal:finalize:unlinked',
        'import:journal:finalize:directory_fsynced',
        'after_journal_removed',
    ]) {
        await crashAndRecover('crash-install', stage, 'new');
    }
});

test('a hard kill before the committed journal rename rolls back the installed generation', async () => {
    for (const stage of [
        'import:journal:committed:temp_written',
        'import:journal:committed:temp_fsynced',
    ]) {
        await crashAndRecover('crash-install', stage, 'old');
    }
});

test('journal sibling temp files are scrubbed after a pre-rename hard kill', async () => {
    await crashAndRecover(
        'crash-install',
        'import:journal:prepared:temp_written',
        'old',
    );
});

test('a committed journal never falls back to the credential-bearing old generation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-committed-corrupt-'));
    try {
        await runFixture(['setup', directory]);
        await runFixture(['crash-install', directory, 'after_journal_committed'], { expectCrash: true });
        const journalFile = path.join(directory, '.zephyr-import-journal.v1.json');
        const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
        assert.equal(journal.state, 'COMMITTED');
        fs.writeFileSync(path.join(directory, 'zephyr.db'), 'corrupt-committed-live-database');
        fs.writeFileSync(
            path.join(directory, `.zephyr-import-${journal.id}.new.db`),
            'corrupt-committed-new-snapshot',
        );

        const failed = await runFixture(['recover', directory], { expectCrash: true });
        assert.match(failed.stderr, /database import new generation cannot be recovered/);
        assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'COMMITTED');
        assert.notEqual(
            fs.readFileSync(path.join(directory, 'zephyr.db'), 'utf8'),
            fs.readFileSync(path.join(directory, `.zephyr-import-${journal.id}.old.db`), 'utf8'),
            'recovery must not reinstall the old database after the commit boundary',
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('commit requires the live database and key, not merely recoverable new snapshots', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-commit-target-'));
    try {
        await runFixture(['setup', directory]);
        await runFixture(['crash-install', directory, 'after_journal_installed'], { expectCrash: true });
        const journalFile = path.join(directory, '.zephyr-import-journal.v1.json');
        const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
        assert.equal(journal.state, 'INSTALLED');
        fs.copyFileSync(
            path.join(directory, `.zephyr-import-${journal.id}.old.db`),
            path.join(directory, 'zephyr.db'),
        );
        const failed = await runFixture(['commit-existing', directory], { expectCrash: true });
        assert.match(failed.stderr, /installed database import generation is incomplete/);
        assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'INSTALLED');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('hard kills throughout rollback resume the old database and key generation', async () => {
    const stages = [
        'after_journal_rolling_back',
        'import:journal:rolling_back:temp_written',
        'import:journal:rolling_back:temp_fsynced',
        'import:journal:rolling_back:renamed',
        'import:journal:rolling_back:target_fsynced',
        'import:journal:rolling_back:directory_fsynced',
        'install:old:key:temp_written',
        'install:old:key:temp_fsynced',
        'install:old:key:renamed',
        'install:old:key:target_fsynced',
        'install:old:key:directory_fsynced',
        'after_old_key_install',
        'install:old:database:temp_written',
        'install:old:database:temp_fsynced',
        'install:old:database:renamed',
        'install:old:database:target_fsynced',
        'install:old:database:directory_fsynced',
        'after_old_database_install',
        'import:journal:rolled_back:temp_written',
        'import:journal:rolled_back:temp_fsynced',
        'import:journal:rolled_back:renamed',
        'import:journal:rolled_back:target_fsynced',
        'import:journal:rolled_back:directory_fsynced',
        'after_journal_rolled_back',
    ];
    for (const stage of stages) await crashAndRecover('crash-rollback', stage, 'old');
});

test('real SQLite WAL and SHM deletion resumes before a recovered generation is opened', async () => {
    for (const stage of [
        'import:database_sidecar-wal:unlinked',
        'import:database_sidecar-wal:directory_fsynced',
        'import:database_sidecar-shm:unlinked',
        'import:database_sidecar-shm:directory_fsynced',
    ]) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-sidecar-crash-'));
        try {
            await runFixture(['setup', directory].map(String), { fixture: SIDECAR_FIXTURE });
            assert.equal(fs.existsSync(path.join(directory, 'zephyr.db-wal')), true);
            assert.equal(fs.existsSync(path.join(directory, 'zephyr.db-shm')), true);
            await runFixture(['crash', directory, stage].map(String), { expectCrash: true, fixture: SIDECAR_FIXTURE });
            const recovered = await runFixture(['recover', directory].map(String), { fixture: SIDECAR_FIXTURE });
            const result = JSON.parse(recovered.stdout.trim().split(/\r?\n/).at(-1));
            assert.equal(result.marker, 'old', stage);
            assert.equal(result.integrity.toLowerCase(), 'ok', stage);
            assert.equal(result.walExists, false, stage);
            assert.equal(result.shmExists, false, stage);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
});
